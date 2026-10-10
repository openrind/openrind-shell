use crate::cache::{
    CachedLookup, DirtyCache, InodeState, MetadataCache, MAX_DIRTY_GLOBAL, MAX_DIRTY_PER_INODE,
};
use crate::diagnostics::Diagnostics;
use crate::error::{Error, Result};
use crate::model::{now_ns, ns_to_system_time, Node, NodeKind, BLOCK_SIZE};
use crate::runtime::RuntimeState;
use crate::store::PgStore;
use dashmap::DashMap;
use fuser::{
    AccessFlags, BsdFileFlags, Errno, FileAttr, FileHandle, FileType, Filesystem, FopenFlags,
    Generation, INodeNo, InitFlags, KernelConfig, LockOwner, OpenFlags, RenameFlags, ReplyAttr,
    ReplyCreate, ReplyData, ReplyDirectory, ReplyEmpty, ReplyEntry, ReplyOpen, ReplyStatfs,
    ReplyWrite, Request, TimeOrNow, WriteFlags,
};
use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// FUSE inode generation. The kernel treats a changed generation for the same
/// nodeid as inode reuse and marks the cached inode bad, failing every open
/// descriptor with EIO. Node ids are never reused (`fs_nodes.node_id` is an
/// identity column), so the generation is a constant; `fs_nodes.generation` is a
/// metadata version, not a FUSE generation.
const FUSE_GENERATION: u64 = 0;

/// Synthetic free capacity reported by `statfs`: 2^30 blocks of 4 KiB (4 TiB) and 2^30 inodes.
const STATFS_FREE_BLOCKS: u64 = 1 << 30;
const STATFS_FREE_FILES: u64 = 1 << 30;

/// The mounted volume has exactly one lease-owning writer, and supported
/// mutations all pass through this daemon. A longer kernel metadata TTL is
/// therefore safe while eliminating a PostgreSQL round trip for every repeated
/// Claude startup lookup. Recreated mounts start with an empty kernel cache.
const TTL: Duration = Duration::from_secs(300);
const DATABASE_WAIT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy)]
struct OpenHandle {
    node_id: i64,
    truncate_rewrite: bool,
}

pub struct FilesystemCore {
    runtime_handle: tokio::runtime::Handle,
    runtime: Arc<RuntimeState>,
    cache: DirtyCache,
    metadata: MetadataCache,
    handles: DashMap<u64, OpenHandle>,
    next_handle: AtomicU64,
    diagnostics: Diagnostics,
}

impl FilesystemCore {
    #[must_use]
    pub fn new(runtime_handle: tokio::runtime::Handle, runtime: Arc<RuntimeState>) -> Arc<Self> {
        Arc::new(Self {
            runtime_handle,
            runtime,
            cache: DirtyCache::default(),
            metadata: MetadataCache::default(),
            handles: DashMap::new(),
            next_handle: AtomicU64::new(1),
            diagnostics: Diagnostics::default(),
        })
    }

    fn store(&self) -> Result<Arc<PgStore>> {
        self.runtime.wait_store(DATABASE_WAIT)
    }

    fn block<T>(&self, future: impl std::future::Future<Output = Result<T>>) -> Result<T> {
        let result = self.runtime_handle.block_on(future);
        if matches!(result, Err(Error::Fenced)) {
            self.runtime
                .fence("filesystem mutation observed a stale writer lease");
        }
        result
    }

    fn node_for_inode(&self, store: &PgStore, inode: INodeNo) -> Result<Node> {
        let node_id = store.db_node_id(inode.into())?;
        if let Some(node) = self.metadata.node(node_id) {
            return Ok(node);
        }
        let generation = self.metadata.generation();
        let node = self.block(store.get_node(node_id))?;
        self.metadata.remember_node(generation, node.clone());
        Ok(node)
    }

    fn lookup_node(&self, store: &PgStore, parent_id: i64, name: &[u8]) -> Result<Node> {
        if let Some(cached) = self.metadata.lookup(parent_id, name) {
            return match cached {
                CachedLookup::Found(node) => Ok(node),
                CachedLookup::Missing => Err(Error::NotFound),
            };
        }

        // Populate the complete directory in one remote query. Claude probes a
        // set of optional project/config names synchronously; one authoritative
        // listing makes every subsequent hit *and miss* local instead of paying
        // a PostgreSQL round trip for each name.
        let generation = self.metadata.generation();
        let entries = Arc::new(self.block(store.list_directory(parent_id))?);
        let found = entries
            .iter()
            .find(|entry| entry.name.as_slice() == name)
            .map(|entry| entry.node.clone());
        self.metadata
            .remember_directory(generation, parent_id, Arc::clone(&entries));
        found.ok_or(Error::NotFound)
    }

    fn directory_entries(
        &self,
        store: &PgStore,
        node_id: i64,
    ) -> Result<Arc<Vec<crate::model::DirectoryEntry>>> {
        if let Some(entries) = self.metadata.directory(node_id) {
            return Ok(entries);
        }
        let generation = self.metadata.generation();
        let entries = Arc::new(self.block(store.list_directory(node_id))?);
        self.metadata
            .remember_directory(generation, node_id, Arc::clone(&entries));
        Ok(entries)
    }

    fn parent_id(&self, store: &PgStore, node_id: i64) -> Result<i64> {
        if let Some(parent_id) = self.metadata.parent(node_id) {
            return Ok(parent_id);
        }
        let generation = self.metadata.generation();
        let parent_id = self.block(store.parent_of(node_id))?;
        self.metadata
            .remember_parent(generation, node_id, parent_id);
        Ok(parent_id)
    }

    fn attr(&self, store: &PgStore, mut node: Node) -> FileAttr {
        if let Some(state) = self.cache.existing(node.node_id) {
            node.size = state.size();
            if state.has_dirty_data() {
                node.mtime_ns = state.mtime_ns();
            }
        }
        let size = node.size.max(0) as u64;
        FileAttr {
            ino: INodeNo(store.fuse_inode(node.node_id)),
            size,
            blocks: size.div_ceil(u64::from(BLOCK_SIZE)),
            atime: ns_to_system_time(node.atime_ns),
            mtime: ns_to_system_time(node.mtime_ns),
            ctime: ns_to_system_time(node.ctime_ns),
            crtime: ns_to_system_time(node.ctime_ns),
            kind: file_type(node.kind),
            perm: node.mode as u16 & 0o7777,
            nlink: node.nlink.max(0) as u32,
            uid: node.uid.max(0) as u32,
            gid: node.gid.max(0) as u32,
            rdev: 0,
            blksize: BLOCK_SIZE,
            flags: 0,
        }
    }

    fn allocate_handle(&self, node_id: i64, truncate_rewrite: bool) -> FileHandle {
        let handle = self.next_handle.fetch_add(1, Ordering::Relaxed);
        self.handles.insert(
            handle,
            OpenHandle {
                node_id,
                truncate_rewrite,
            },
        );
        FileHandle(handle)
    }

    fn handle(&self, handle: FileHandle) -> Result<OpenHandle> {
        self.handles
            .get(&u64::from(handle))
            .map(|entry| *entry.value())
            .ok_or_else(|| Error::Invalid("unknown file handle".into()))
    }

    pub async fn flush_inode_async(&self, state: Arc<InodeState>) -> Result<()> {
        let _guard = state.lock_writeback().await;
        self.flush_inode_locked(&state).await
    }

    async fn flush_inode_locked(&self, state: &Arc<InodeState>) -> Result<()> {
        let Some(snapshot) = state.snapshot() else {
            if let Some(error) = state.writeback_error() {
                return Err(Error::Internal(format!("prior writeback failed: {error}")));
            }
            return Ok(());
        };
        let Some(store) = self.runtime.ready_store() else {
            return Err(Error::Initializing);
        };
        match store.flush_snapshot(&snapshot).await {
            Ok(()) => {
                state.committed(&snapshot);
                self.metadata
                    .patch_file_state(snapshot.node_id, snapshot.size, snapshot.mtime_ns);
                Ok(())
            }
            Err(error) => {
                state.record_error(&error);
                if matches!(error, Error::Fenced) {
                    self.runtime.fence(&error);
                }
                Err(error)
            }
        }
    }

    fn flush_inode(&self, state: Arc<InodeState>) -> Result<()> {
        self.block(self.flush_inode_async(state))
    }

    pub async fn flush_all_async(&self) -> Result<()> {
        for state in self.cache.states() {
            self.flush_inode_async(state).await?;
        }
        if let Some(error) = self.cache.first_error() {
            return Err(Error::Internal(format!("writeback error: {error}")));
        }
        Ok(())
    }

    pub fn health_json(&self) -> serde_json::Value {
        let error = self.cache.first_error();
        let mut health = self
            .runtime
            .health_json(self.cache.dirty_bytes(), error.as_deref());
        health["diagnostics"] = self.diagnostics.snapshot();
        health
    }

    pub fn discard_dirty_for_fence(&self, reason: &str) {
        self.cache.discard_all_as_error(reason);
    }

    pub async fn run_background_writeback(self: Arc<Self>) {
        let mut ticker = tokio::time::interval(Duration::from_millis(250));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            for state in self.cache.states() {
                if state.dirty_bytes() > 0 {
                    let _ = self.flush_inode_async(state).await;
                }
            }
        }
    }

    fn open_count(&self, node_id: i64) -> usize {
        self.handles
            .iter()
            .filter(|entry| entry.node_id == node_id)
            .count()
    }

    fn flush_for_capacity(&self, state: &Arc<InodeState>) -> Result<()> {
        if state.dirty_bytes() >= MAX_DIRTY_PER_INODE
            || self.cache.dirty_bytes() >= MAX_DIRTY_GLOBAL
        {
            self.flush_inode(Arc::clone(state))?;
        }
        Ok(())
    }
}

pub struct OpeneralFilesystem {
    core: Arc<FilesystemCore>,
}

impl OpeneralFilesystem {
    #[must_use]
    pub fn new(core: Arc<FilesystemCore>) -> Self {
        Self { core }
    }

    fn reply_error<T>(&self, reply: T, error: Error)
    where
        T: ErrorReply,
    {
        self.core.diagnostics.error();
        tracing::debug!(error = %error, "FUSE request failed");
        reply.send_error(error.errno());
    }
}

trait ErrorReply {
    fn send_error(self, errno: Errno);
}

macro_rules! impl_error_reply {
    ($($ty:ty),+ $(,)?) => {
        $(impl ErrorReply for $ty {
            fn send_error(self, errno: Errno) { self.error(errno); }
        })+
    };
}

impl_error_reply!(
    ReplyAttr,
    ReplyCreate,
    ReplyData,
    ReplyDirectory,
    ReplyEmpty,
    ReplyEntry,
    ReplyOpen,
    ReplyStatfs,
    ReplyWrite,
);

impl Filesystem for OpeneralFilesystem {
    fn init(&mut self, _request: &Request, config: &mut KernelConfig) -> std::io::Result<()> {
        let _ = config.add_capabilities(InitFlags::FUSE_ATOMIC_O_TRUNC);
        let _ = config.add_capabilities(InitFlags::FUSE_ASYNC_READ);
        Ok(())
    }

    fn lookup(&self, _request: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
        let _timer = self.core.diagnostics.request();
        let result = (|| {
            let store = self.core.store()?;
            let parent_id = store.db_node_id(parent.into())?;
            let node = self.core.lookup_node(&store, parent_id, name.as_bytes())?;
            Ok((store, node))
        })();
        match result {
            Ok((store, node)) => {
                let attr = self.core.attr(&store, node.clone());
                reply.entry(&TTL, &attr, Generation(FUSE_GENERATION));
            }
            Err(error) => self.reply_error(reply, error),
        }
    }

    fn getattr(&self, _request: &Request, ino: INodeNo, _fh: Option<FileHandle>, reply: ReplyAttr) {
        let _timer = self.core.diagnostics.request();
        let result = (|| {
            let store = self.core.store()?;
            let node = self.core.node_for_inode(&store, ino)?;
            Ok((store, node))
        })();
        match result {
            Ok((store, node)) => reply.attr(&TTL, &self.core.attr(&store, node)),
            Err(error) => self.reply_error(reply, error),
        }
    }

    fn setattr(
        &self,
        _request: &Request,
        ino: INodeNo,
        mode: Option<u32>,
        uid: Option<u32>,
        gid: Option<u32>,
        size: Option<u64>,
        atime: Option<TimeOrNow>,
        mtime: Option<TimeOrNow>,
        _ctime: Option<SystemTime>,
        _fh: Option<FileHandle>,
        _crtime: Option<SystemTime>,
        _chgtime: Option<SystemTime>,
        _bkuptime: Option<SystemTime>,
        _flags: Option<BsdFileFlags>,
        reply: ReplyAttr,
    ) {
        let _timer = self.core.diagnostics.request();
        let result = (|| {
            let store = self.core.store()?;
            let node_id = store.db_node_id(ino.into())?;
            let mut node = self.core.node_for_inode(&store, ino)?;
            if let Some(new_size) = size {
                let state = self.core.cache.state_for(&node);
                node = self.core.block(async {
                    let _guard = state.lock_writeback().await;
                    let node = store.truncate(node_id, new_size as i64).await?;
                    state.truncate_local(new_size as i64);
                    Ok(node)
                })?;
            }
            if mode.is_some()
                || uid.is_some()
                || gid.is_some()
                || atime.is_some()
                || mtime.is_some()
            {
                node = self.core.block(store.update_attributes(
                    node_id,
                    mode,
                    uid,
                    gid,
                    atime.map(time_or_now_ns),
                    mtime.map(time_or_now_ns),
                ))?;
            }
            self.core.metadata.replace_node(node.clone());
            Ok((store, node))
        })();
        match result {
            Ok((store, node)) => reply.attr(&TTL, &self.core.attr(&store, node)),
            Err(error) => self.reply_error(reply, error),
        }
    }

    fn readlink(&self, _request: &Request, ino: INodeNo, reply: ReplyData) {
        let _timer = self.core.diagnostics.request();
        let result = (|| {
            let store = self.core.store()?;
            let node = self.core.node_for_inode(&store, ino)?;
            if node.kind != NodeKind::Symlink {
                return Err(Error::Invalid("readlink target is not a symlink".into()));
            }
            node.symlink_target
                .ok_or_else(|| Error::Internal("symlink target is absent".into()))
        })();
        match result {
            Ok(target) => reply.data(&target),
            Err(error) => self.reply_error(reply, error),
        }
    }

    fn mkdir(
        &self,
        request: &Request,
        parent: INodeNo,
        name: &OsStr,
        mode: u32,
        umask: u32,
        reply: ReplyEntry,
    ) {
        let _timer = self.core.diagnostics.request();
        let result = (|| {
            let store = self.core.store()?;
            let parent_id = store.db_node_id(parent.into())?;
            let node = self.core.block(store.create_node(
                parent_id,
                name.as_bytes(),
                NodeKind::Directory,
                mode & !umask,
                request.uid(),
                request.gid(),
                None,
            ))?;
            self.core.metadata.invalidate();
            self.core.metadata.replace_node(node.clone());
            Ok((store, node))
        })();
        match result {
            Ok((store, node)) => {
                let attr = self.core.attr(&store, node.clone());
                reply.entry(&TTL, &attr, Generation(FUSE_GENERATION));
            }
            Err(error) => self.reply_error(reply, error),
        }
    }

    fn unlink(&self, _request: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let _timer = self.core.diagnostics.request();
        let result = (|| {
            let store = self.core.store()?;
            let parent_id = store.db_node_id(parent.into())?;
            let node_id = self
                .core
                .block(store.remove(parent_id, name.as_bytes(), false))?;
            if self.core.open_count(node_id) == 0 {
                self.core.block(store.collect_deleted_node(node_id))?;
            }
            self.core.metadata.invalidate();
            Ok(())
        })();
        match result {
            Ok(()) => reply.ok(),
            Err(error) => self.reply_error(reply, error),
        }
    }

    fn rmdir(&self, _request: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let _timer = self.core.diagnostics.request();
        let result = (|| {
            let store = self.core.store()?;
            let parent_id = store.db_node_id(parent.into())?;
            let node_id = self
                .core
                .block(store.remove(parent_id, name.as_bytes(), true))?;
            self.core.block(store.collect_deleted_node(node_id))?;
            self.core.metadata.invalidate();
            Ok(())
        })();
        match result {
            Ok(()) => reply.ok(),
            Err(error) => self.reply_error(reply, error),
        }
    }

    fn symlink(
        &self,
        request: &Request,
        parent: INodeNo,
        link_name: &OsStr,
        target: &Path,
        reply: ReplyEntry,
    ) {
        let _timer = self.core.diagnostics.request();
        let result = (|| {
            let store = self.core.store()?;
            let parent_id = store.db_node_id(parent.into())?;
            let node = self.core.block(store.create_node(
                parent_id,
                link_name.as_bytes(),
                NodeKind::Symlink,
                0o777,
                request.uid(),
                request.gid(),
                Some(target.as_os_str().as_bytes()),
            ))?;
            self.core.metadata.invalidate();
            self.core.metadata.replace_node(node.clone());
            Ok((store, node))
        })();
        match result {
            Ok((store, node)) => {
                let attr = self.core.attr(&store, node.clone());
                reply.entry(&TTL, &attr, Generation(FUSE_GENERATION));
            }
            Err(error) => self.reply_error(reply, error),
        }
    }

    fn rename(
        &self,
        _request: &Request,
        parent: INodeNo,
        name: &OsStr,
        newparent: INodeNo,
        newname: &OsStr,
        flags: RenameFlags,
        reply: ReplyEmpty,
    ) {
        let _timer = self.core.diagnostics.request();
        let result = (|| {
            if flags.bits() & !libc::RENAME_NOREPLACE != 0 {
                return Err(Error::Unsupported);
            }
            let store = self.core.store()?;
            let parent_id = store.db_node_id(parent.into())?;
            let new_parent_id = store.db_node_id(newparent.into())?;
            let source = self.core.lookup_node(&store, parent_id, name.as_bytes())?;
            let state = self.core.cache.existing(source.node_id);
            if let Some(state) = state.as_ref() {
                if let Some(error) = state.writeback_error() {
                    return Err(Error::Internal(format!("prior writeback failed: {error}")));
                }
            }
            self.core.block(async {
                if let Some(state) = state {
                    let _guard = state.lock_writeback().await;
                    let snapshot = state.snapshot();
                    store
                        .rename(
                            parent_id,
                            name.as_bytes(),
                            new_parent_id,
                            newname.as_bytes(),
                            flags.contains(RenameFlags::RENAME_NOREPLACE),
                            snapshot.as_ref(),
                        )
                        .await?;
                    if let Some(snapshot) = snapshot.as_ref() {
                        state.committed(snapshot);
                    }
                } else {
                    store
                        .rename(
                            parent_id,
                            name.as_bytes(),
                            new_parent_id,
                            newname.as_bytes(),
                            flags.contains(RenameFlags::RENAME_NOREPLACE),
                            None,
                        )
                        .await?;
                }
                Ok(())
            })?;
            self.core.metadata.invalidate();
            Ok(())
        })();
        match result {
            Ok(()) => reply.ok(),
            Err(error) => self.reply_error(reply, error),
        }
    }

    fn open(&self, _request: &Request, ino: INodeNo, flags: OpenFlags, reply: ReplyOpen) {
        let _timer = self.core.diagnostics.request();
        let result = (|| {
            let store = self.core.store()?;
            let mut node = self.core.node_for_inode(&store, ino)?;
            if node.kind == NodeKind::Directory {
                return Err(Error::IsDirectory);
            }
            let truncate = flags.0 & libc::O_TRUNC != 0;
            if truncate {
                let state = self.core.cache.state_for(&node);
                node = self.core.block(async {
                    let _guard = state.lock_writeback().await;
                    let node = store.truncate(node.node_id, 0).await?;
                    state.truncate_local(0);
                    Ok(node)
                })?;
                self.core.metadata.replace_node(node.clone());
            }
            // Pin file metadata in the per-mount inode cache for the lifetime
            // of the open handle. Reads and writes can then avoid a PostgreSQL
            // metadata lookup on every FUSE request.
            self.core.cache.state_for(&node);
            Ok(self.core.allocate_handle(node.node_id, truncate))
        })();
        match result {
            Ok(handle) => reply.opened(handle, FopenFlags::empty()),
            Err(error) => self.reply_error(reply, error),
        }
    }

    fn read(
        &self,
        _request: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        size: u32,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        reply: ReplyData,
    ) {
        let _timer = self.core.diagnostics.request();
        let result = (|| {
            let handle = self.core.handle(fh)?;
            let store = self.core.store()?;
            let state = self
                .core
                .cache
                .existing(handle.node_id)
                .ok_or_else(|| Error::Internal("open file is missing inode state".into()))?;
            self.core.block(state.read(&store, offset, size))
        })();
        match result {
            Ok(data) => reply.data(&data),
            Err(error) => self.reply_error(reply, error),
        }
    }

    fn write(
        &self,
        _request: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        data: &[u8],
        _write_flags: WriteFlags,
        flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        reply: ReplyWrite,
    ) {
        let _timer = self.core.diagnostics.request();
        let result = (|| {
            let handle = self.core.handle(fh)?;
            let store = self.core.store()?;
            let state = self
                .core
                .cache
                .existing(handle.node_id)
                .ok_or_else(|| Error::Internal("open file is missing inode state".into()))?;
            self.core.flush_for_capacity(&state)?;
            // Prepare and copy under the inode writeback lock: a concurrent flush
            // that commits between the two steps drops every chunk at or below the
            // committed sequence, including freshly prepared placeholders, and the
            // write would fail with "write chunk was not prepared".
            self.core.block(async {
                let _guard = state.lock_writeback().await;
                state.prepare_chunks(&store, offset, data.len()).await?;
                state.write(offset, data).map(|_| ())
            })?;
            if state.dirty_bytes() > MAX_DIRTY_PER_INODE
                || self.core.cache.dirty_bytes() > MAX_DIRTY_GLOBAL
                || flags.0 & (libc::O_SYNC | libc::O_DSYNC) != 0
            {
                self.core.flush_inode(state)?;
            }
            Ok(data.len() as u32)
        })();
        match result {
            Ok(count) => reply.written(count),
            Err(error) => self.reply_error(reply, error),
        }
    }

    fn flush(
        &self,
        _request: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        _lock_owner: LockOwner,
        reply: ReplyEmpty,
    ) {
        let _timer = self.core.diagnostics.request();
        let result = (|| {
            let handle = self.core.handle(fh)?;
            let Some(state) = self.core.cache.existing(handle.node_id) else {
                return Ok(());
            };
            // Persisting all FLUSH requests is stronger than POSIX requires and
            // also supplies the narrow O_TRUNC close barrier.
            if handle.truncate_rewrite
                || state.dirty_bytes() > 0
                || state.writeback_error().is_some()
            {
                self.core.flush_inode(state)
            } else {
                Ok(())
            }
        })();
        match result {
            Ok(()) => reply.ok(),
            Err(error) => self.reply_error(reply, error),
        }
    }

    fn release(
        &self,
        _request: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        _flush: bool,
        reply: ReplyEmpty,
    ) {
        let _timer = self.core.diagnostics.request();
        let handle_id = u64::from(fh);
        let Some((_, handle)) = self.core.handles.remove(&handle_id) else {
            self.core.diagnostics.error();
            reply.error(Errno::EBADF);
            return;
        };
        let result = (|| {
            if let Some(state) = self.core.cache.existing(handle.node_id) {
                // release errors are not reliably observable, but preserve the
                // first error for subsequent barriers and management health.
                let _ = self.core.flush_inode(state);
            }
            if self.core.open_count(handle.node_id) == 0 {
                let store = self.core.store()?;
                if self
                    .core
                    .block(store.get_node(handle.node_id))
                    .is_ok_and(|node| node.deleted)
                {
                    self.core
                        .block(store.collect_deleted_node(handle.node_id))?;
                }
            }
            Ok(())
        })();
        match result {
            Ok(()) => reply.ok(),
            Err(error) => self.reply_error(reply, error),
        }
    }

    fn fsync(
        &self,
        _request: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        _datasync: bool,
        reply: ReplyEmpty,
    ) {
        let _timer = self.core.diagnostics.request();
        let result = (|| {
            let handle = self.core.handle(fh)?;
            match self.core.cache.existing(handle.node_id) {
                Some(state) => self.core.flush_inode(state),
                None => Ok(()),
            }
        })();
        match result {
            Ok(()) => reply.ok(),
            Err(error) => self.reply_error(reply, error),
        }
    }

    fn opendir(&self, _request: &Request, ino: INodeNo, _flags: OpenFlags, reply: ReplyOpen) {
        let _timer = self.core.diagnostics.request();
        let result = (|| {
            let store = self.core.store()?;
            let node = self.core.node_for_inode(&store, ino)?;
            if node.kind != NodeKind::Directory {
                return Err(Error::NotDirectory);
            }
            Ok(self.core.allocate_handle(node.node_id, false))
        })();
        match result {
            Ok(handle) => reply.opened(handle, FopenFlags::empty()),
            Err(error) => self.reply_error(reply, error),
        }
    }

    fn readdir(
        &self,
        _request: &Request,
        ino: INodeNo,
        _fh: FileHandle,
        offset: u64,
        mut reply: ReplyDirectory,
    ) {
        let _timer = self.core.diagnostics.request();
        let result = (|| {
            let store = self.core.store()?;
            let node_id = store.db_node_id(ino.into())?;
            let parent = self.core.parent_id(&store, node_id)?;
            let entries = self.core.directory_entries(&store, node_id)?;
            Ok((store, parent, entries))
        })();
        let (store, parent, entries) = match result {
            Ok(value) => value,
            Err(error) => {
                self.reply_error(reply, error);
                return;
            }
        };
        let mut all = Vec::with_capacity(entries.len() + 2);
        all.push((
            INodeNo(store.fuse_inode(store.db_node_id(ino.into()).unwrap_or_default())),
            FileType::Directory,
            b".".to_vec(),
        ));
        all.push((
            INodeNo(store.fuse_inode(parent)),
            FileType::Directory,
            b"..".to_vec(),
        ));
        all.extend(entries.iter().map(|entry| {
            (
                INodeNo(store.fuse_inode(entry.node.node_id)),
                file_type(entry.node.kind),
                entry.name.clone(),
            )
        }));
        for (index, (entry_ino, kind, name)) in all.into_iter().enumerate().skip(offset as usize) {
            if reply.add(entry_ino, index as u64 + 1, kind, OsStr::from_bytes(&name)) {
                break;
            }
        }
        reply.ok();
    }

    fn releasedir(
        &self,
        _request: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        _flags: OpenFlags,
        reply: ReplyEmpty,
    ) {
        let _timer = self.core.diagnostics.request();
        self.core.handles.remove(&u64::from(fh));
        reply.ok();
    }

    fn fsyncdir(
        &self,
        _request: &Request,
        _ino: INodeNo,
        _fh: FileHandle,
        _datasync: bool,
        reply: ReplyEmpty,
    ) {
        let _timer = self.core.diagnostics.request();
        // Namespace mutations commit synchronously before their replies.
        reply.ok();
    }

    fn statfs(&self, _request: &Request, _ino: INodeNo, reply: ReplyStatfs) {
        let _timer = self.core.diagnostics.request();
        let result = (|| {
            let store = self.core.store()?;
            self.core.block(store.statfs())
        })();
        match result {
            Ok((bytes, files)) => {
                // PostgreSQL has no fixed capacity to report. Present used space
                // plus a large synthetic free pool so `f_blocks >= f_bfree` and
                // `df`/free-space checks see sane numbers.
                let used_blocks = bytes.div_ceil(u64::from(BLOCK_SIZE));
                let free_blocks = STATFS_FREE_BLOCKS;
                let free_files = STATFS_FREE_FILES;
                reply.statfs(
                    used_blocks.saturating_add(free_blocks),
                    free_blocks,
                    free_blocks,
                    files.saturating_add(free_files),
                    free_files,
                    BLOCK_SIZE,
                    255,
                    BLOCK_SIZE,
                );
            }
            Err(error) => self.reply_error(reply, error),
        }
    }

    fn access(&self, _request: &Request, ino: INodeNo, _mask: AccessFlags, reply: ReplyEmpty) {
        let _timer = self.core.diagnostics.request();
        let result = (|| {
            let store = self.core.store()?;
            self.core.node_for_inode(&store, ino).map(|_| ())
        })();
        match result {
            Ok(()) => reply.ok(),
            Err(error) => self.reply_error(reply, error),
        }
    }

    fn create(
        &self,
        request: &Request,
        parent: INodeNo,
        name: &OsStr,
        mode: u32,
        umask: u32,
        _flags: i32,
        reply: ReplyCreate,
    ) {
        let _timer = self.core.diagnostics.request();
        let result = (|| {
            let store = self.core.store()?;
            let parent_id = store.db_node_id(parent.into())?;
            let node = self.core.block(store.create_node(
                parent_id,
                name.as_bytes(),
                NodeKind::File,
                mode & !umask,
                request.uid(),
                request.gid(),
                None,
            ))?;
            self.core.metadata.invalidate();
            self.core.metadata.replace_node(node.clone());
            self.core.cache.state_for(&node);
            let handle = self.core.allocate_handle(node.node_id, false);
            Ok((store, node, handle))
        })();
        match result {
            Ok((store, node, handle)) => {
                let attr = self.core.attr(&store, node.clone());
                reply.created(
                    &TTL,
                    &attr,
                    Generation(FUSE_GENERATION),
                    handle,
                    FopenFlags::empty(),
                );
            }
            Err(error) => self.reply_error(reply, error),
        }
    }
}

fn file_type(kind: NodeKind) -> FileType {
    match kind {
        NodeKind::File => FileType::RegularFile,
        NodeKind::Directory => FileType::Directory,
        NodeKind::Symlink => FileType::Symlink,
    }
}

fn time_or_now_ns(value: TimeOrNow) -> i64 {
    match value {
        TimeOrNow::Now => now_ns(),
        TimeOrNow::SpecificTime(time) => time
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .try_into()
            .unwrap_or(i64::MAX),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_attributes_preserve_stable_inode_and_type() {
        assert_eq!(crate::model::FUSE_ROOT_INODE, 1);
        assert_eq!(file_type(NodeKind::Directory), FileType::Directory);
    }
}

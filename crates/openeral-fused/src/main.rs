mod cache;
mod connect;
mod diagnostics;
mod error;
mod fs;
mod management;
mod model;
mod runtime;
mod store;

use crate::error::{Error, Result};
use crate::fs::{FilesystemCore, OpeneralFilesystem};
use crate::runtime::{coordinate_database, RuntimeState, DEFAULT_RUNTIME_DIR};
use fuser::{Config, MountOption, Session, SessionACL};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    if let Err(error) = run().await {
        tracing::error!(error = %error, "openrind-shell-fused failed");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("serve") => serve().await,
        Some("health") => management_command("health").await,
        Some("flush-all") => management_command("flush-all").await,
        _ => Err(Error::Invalid(
            "usage: openrind-shell-fused <serve|health|flush-all>".into(),
        )),
    }
}

async fn management_command(command: &str) -> Result<()> {
    let value = management::client(&management_socket(), command).await?;
    println!("{}", serde_json::to_string(&value)?);
    if value.get("ok") == Some(&serde_json::Value::Bool(false)) {
        return Err(Error::Internal(
            value
                .get("error")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("management command failed")
                .to_string(),
        ));
    }
    Ok(())
}

async fn serve() -> Result<()> {
    let fuse_fd = claim_inherited_fd("OPENSHELL_FUSE_FD_0")?;
    let readiness_fd = claim_inherited_fd("OPENSHELL_FUSE_FD_1")?;
    let runtime = RuntimeState::from_environment();
    tokio::spawn(coordinate_database(Arc::clone(&runtime)));
    let core = FilesystemCore::new(tokio::runtime::Handle::current(), Arc::clone(&runtime));

    let mut config = Config::default();
    config.mount_options = vec![
        MountOption::FSName("openrind-shell".into()),
        MountOption::Subtype("openrind-shell".into()),
        MountOption::DefaultPermissions,
    ];
    config.acl = SessionACL::Owner;
    let session = Session::from_fd(
        OpeneralFilesystem::new(Arc::clone(&core)),
        fuse_fd,
        SessionACL::Owner,
        config,
    )?;
    let background = session.spawn()?;
    signal_ready(&readiness_fd)?;
    drop(readiness_fd);

    let management = tokio::spawn(management::serve(Arc::clone(&core), management_socket()));
    let writeback = tokio::spawn(Arc::clone(&core).run_background_writeback());
    let session_join = tokio::task::spawn_blocking(move || background.join());

    tokio::select! {
        () = runtime.wait_fatal() => {
            core.discard_dirty_for_fence("writer lease or datasource identity was fenced");
            tokio::time::sleep(Duration::from_millis(200)).await;
            management.abort();
            writeback.abort();
            terminate_fuse_process(1, "writer lease or datasource identity was fenced");
        }
        joined = session_join => {
            management.abort();
            writeback.abort();
            let result = joined.map_err(|error| Error::Internal(format!("FUSE thread panicked: {error}")))?;
            result?;
            Err(Error::Internal("FUSE request loop exited".into()))
        }
        signal = shutdown_signal() => {
            tracing::info!(signal, "FUSE daemon is shutting down");
            match tokio::time::timeout(Duration::from_secs(10), core.flush_all_async()).await {
                Ok(Ok(())) => tracing::info!("final FUSE flush completed"),
                Ok(Err(error)) => tracing::error!(error = %error, "final FUSE flush failed"),
                Err(_) => tracing::error!("final FUSE flush timed out after 10 seconds"),
            }
            management.abort();
            writeback.abort();
            terminate_fuse_process(0, "shutdown signal handled");
        }
    }
}

/// Exit instead of unwinding the Tokio runtime after a terminal FUSE event.
///
/// `BackgroundSession::join` is a blocking task and the supervisor's TSYNC
/// seccomp prelude prevents an in-process unmount. Returning from `serve` would
/// therefore hang runtime shutdown forever. A process exit closes `/dev/fuse`;
/// the supervisor observes the critical daemon exit and rebuilds the mount
/// namespace through the container restart policy.
fn terminate_fuse_process(code: i32, reason: &str) -> ! {
    tracing::info!(code, reason, "terminating FUSE daemon process");
    std::process::exit(code)
}

fn management_socket() -> PathBuf {
    std::env::var_os("OPENRIND_SHELL_FUSED_SOCKET")
        .or_else(|| std::env::var_os("OPENERAL_FUSED_SOCKET"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_RUNTIME_DIR).join("fused.sock"))
}

fn claim_inherited_fd(key: &str) -> Result<OwnedFd> {
    let value = std::env::var(key)
        .map_err(|_| Error::Invalid(format!("supervisor did not supply {key}")))?;
    std::env::remove_var(key);
    let fd: i32 = value
        .parse()
        .map_err(|_| Error::Invalid(format!("{key} is not a descriptor number")))?;
    if fd < 64 {
        return Err(Error::Invalid(format!(
            "{key} is below the reserved fd floor"
        )));
    }
    #[allow(unsafe_code)]
    let valid = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if valid < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    #[allow(unsafe_code)]
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn signal_ready(fd: &OwnedFd) -> Result<()> {
    let byte = [1_u8];
    #[allow(unsafe_code)]
    let written = unsafe { libc::write(fd.as_raw_fd(), byte.as_ptr().cast(), 1) };
    if written != 1 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

async fn shutdown_signal() -> &'static str {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM listener");
        let mut interrupt =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
                .expect("install SIGINT listener");
        tokio::select! {
            _ = term.recv() => "SIGTERM",
            _ = interrupt.recv() => "SIGINT",
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await.ok();
        "Ctrl-C"
    }
}

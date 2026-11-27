/**
 * Workspace change capture for the primary FUSE runtime.
 *
 * Reads the normalized `_openeral.fs_*` tables (owned by the TypeScript
 * migrations; the Rust daemon only validates them) and produces:
 *
 *   snapshotWorkspace  ordered (path, content_hash) entries plus a single
 *                      merkle-style root hash over the whole workspace
 *   diffWorkspaces     added/modified/deleted files between two snapshots,
 *                      rendered as unified-diff text where content allows
 *   emitWorkspacePatch content-addressed upload of the diff to the Haloop
 *                      collector (/artifacts) plus an artifact.recorded
 *                      evidence event (kind=model_patch)
 *
 * The collector's artifact.recorded schema only allows
 * patch_basis "base_commit" | "initial_workspace"; a FUSE-journal patch is
 * based on the workspace start state, so "initial_workspace" is used.
 */

import { createHash } from 'node:crypto';
import type { DbPool } from './db/pool.js';

export const WORKSPACE_MANIFEST_VERSION = 1;
/** Root hash of a workspace with no files: sha256 of the empty byte string. */
export const EMPTY_WORKSPACE_ROOT = createHash('sha256').update('').digest('hex');

const KIND_FILE = 1;
const KIND_DIRECTORY = 2;
const KIND_SYMLINK = 3;
const MAX_INLINE_ARTIFACT_BYTES = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const MAX_DIFF_MID_LINES = 2000;
const DIFF_CONTEXT_LINES = 3;
const HTTP_TIMEOUT_MS = 15_000;

export interface WorkspaceManifestEntry {
  path: string;
  kind: 'file' | 'symlink';
  /** sha256 hex of the content bytes (or the symlink target). */
  contentHash: string;
  size: number;
  /** Present when the snapshot was taken with includeContent. */
  content?: Buffer;
}

export interface WorkspaceSnapshot {
  version: number;
  workspaceId: string;
  volumeId: string | null;
  takenAt: string;
  rootHash: string;
  entries: WorkspaceManifestEntry[];
}

export interface WorkspaceDiffChange {
  path: string;
  contentHash: string;
  size: number;
}

export interface WorkspaceDiffModification {
  path: string;
  beforeHash: string;
  afterHash: string;
  size: number;
}

export interface WorkspaceDiff {
  workspaceId: string;
  startRootHash: string;
  endRootHash: string;
  added: WorkspaceDiffChange[];
  modified: WorkspaceDiffModification[];
  deleted: WorkspaceDiffChange[];
  patchText: string;
}

export interface WorkspaceCaptureConfig {
  collectorUrl: string;
  token: string;
  project: string;
  enabled: boolean;
}

function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value ?? ''), 'utf8');
}

function sanitizeIdentifier(value: string, fallback: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.:@/-]/g, '-').replace(/^[^A-Za-z0-9]+/, '');
  return (cleaned || fallback).slice(0, 128);
}

/**
 * Merkle-style root over the ordered entries: leaf = sha256(path NUL hash),
 * parents = sha256(left || right); an odd node is promoted unchanged.
 */
function merkleRoot(entries: WorkspaceManifestEntry[]): string {
  if (entries.length === 0) return EMPTY_WORKSPACE_ROOT;
  let level: Buffer[] = entries.map((entry) =>
    createHash('sha256').update(`${entry.path}\0${entry.contentHash}`, 'utf8').digest(),
  );
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : null;
      next.push(right ? createHash('sha256').update(Buffer.concat([left, right])).digest() : left);
    }
    level = next;
  }
  return level[0].toString('hex');
}

/**
 * Read the FUSE volume for a workspace into an ordered manifest. A workspace
 * whose volume does not exist yet (fresh sandbox) snapshots as empty.
 */
export async function snapshotWorkspace(
  db: DbPool,
  workspaceId: string,
  options: { includeContent?: boolean } = {},
): Promise<WorkspaceSnapshot> {
  const includeContent = options.includeContent !== false;
  const takenAt = new Date().toISOString();
  const { rows: volumes } = await db.query(
    `SELECT volume_id, root_node_id FROM _openeral.fs_volumes WHERE workspace_id = $1`,
    [workspaceId],
  );
  if (volumes.length === 0) {
    return {
      version: WORKSPACE_MANIFEST_VERSION,
      workspaceId,
      volumeId: null,
      takenAt,
      rootHash: EMPTY_WORKSPACE_ROOT,
      entries: [],
    };
  }
  const volumeId = String(volumes[0].volume_id);
  const rootNodeId = String(volumes[0].root_node_id);

  const { rows: nodeRows } = await db.query(
    `SELECT node_id, kind, symlink_target FROM _openeral.fs_nodes
      WHERE volume_id = $1 AND NOT deleted`,
    [volumeId],
  );
  const { rows: direntRows } = await db.query(
    `SELECT parent_node_id, name, child_node_id FROM _openeral.fs_dirents WHERE volume_id = $1`,
    [volumeId],
  );
  const { rows: chunkRows } = await db.query(
    `SELECT node_id, data FROM _openeral.fs_chunks
      WHERE volume_id = $1 ORDER BY node_id, chunk_index`,
    [volumeId],
  );

  const nodes = new Map<string, { kind: number; symlinkTarget: Buffer | null }>();
  for (const row of nodeRows) {
    nodes.set(String(row.node_id), {
      kind: Number(row.kind),
      symlinkTarget: row.symlink_target != null ? toBuffer(row.symlink_target) : null,
    });
  }
  const children = new Map<string, Array<{ name: string; child: string }>>();
  for (const row of direntRows) {
    const parent = String(row.parent_node_id);
    const list = children.get(parent) ?? [];
    list.push({ name: toBuffer(row.name).toString('utf8'), child: String(row.child_node_id) });
    children.set(parent, list);
  }
  const contents = new Map<string, Buffer>();
  for (const row of chunkRows) {
    const id = String(row.node_id);
    const data = toBuffer(row.data);
    const prior = contents.get(id);
    contents.set(id, prior ? Buffer.concat([prior, data]) : data);
  }

  const entries: WorkspaceManifestEntry[] = [];
  const visited = new Set<string>([rootNodeId]);
  const walk = (nodeId: string, prefix: string): void => {
    for (const { name, child } of children.get(nodeId) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      const node = nodes.get(child);
      if (!node) continue;
      const path = `${prefix}/${name}`;
      if (node.kind === KIND_DIRECTORY) {
        walk(child, path);
      } else if (node.kind === KIND_FILE) {
        const content = contents.get(child) ?? Buffer.alloc(0);
        entries.push({
          path,
          kind: 'file',
          contentHash: sha256Hex(content),
          size: content.length,
          ...(includeContent ? { content } : {}),
        });
      } else if (node.kind === KIND_SYMLINK) {
        const target = node.symlinkTarget ?? Buffer.alloc(0);
        entries.push({
          path,
          kind: 'symlink',
          contentHash: sha256Hex(target),
          size: target.length,
          ...(includeContent ? { content: target } : {}),
        });
      }
    }
  };
  walk(rootNodeId, '');

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    version: WORKSPACE_MANIFEST_VERSION,
    workspaceId,
    volumeId,
    takenAt,
    rootHash: merkleRoot(entries),
    entries,
  };
}

function isBinary(content: Buffer): boolean {
  return content.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

function splitLines(content: Buffer): string[] {
  const text = content.toString('utf8');
  const lines = text.split('\n');
  // A trailing newline terminates the last line; do not emit a phantom line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Render one unified-diff hunk pair for two text versions. Returns null when
 * the changed region is too large to render line-by-line.
 */
function unifiedHunks(
  oldLines: string[],
  newLines: string[],
): { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] } | null {
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const oldMid = oldLines.slice(start, oldEnd);
  const newMid = newLines.slice(start, newEnd);
  if (oldMid.length > MAX_DIFF_MID_LINES || newMid.length > MAX_DIFF_MID_LINES) return null;

  // LCS over the changed region (bounded by MAX_DIFF_MID_LINES).
  const m = oldMid.length;
  const n = newMid.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = oldMid[i] === newMid[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldMid[i] === newMid[j]) { ops.push(` ${oldMid[i]}`); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(`-${oldMid[i]}`); i++; }
    else { ops.push(`+${newMid[j]}`); j++; }
  }
  while (i < m) ops.push(`-${oldMid[i++]}`);
  while (j < n) ops.push(`+${newMid[j++]}`);

  const before = Math.min(DIFF_CONTEXT_LINES, start);
  const after = Math.min(DIFF_CONTEXT_LINES, oldLines.length - oldEnd);
  const lines = [
    ...oldLines.slice(start - before, start).map((line) => ` ${line}`),
    ...ops,
    ...oldLines.slice(oldEnd, oldEnd + after).map((line) => ` ${line}`),
  ];
  return {
    oldStart: start - before + 1,
    oldCount: before + (oldEnd - start) + after,
    newStart: start - before + 1,
    newCount: before + (newEnd - start) + after,
    lines,
  };
}

function renderTextDiff(path: string, before: Buffer | null, after: Buffer | null, beforeHash: string, afterHash: string): string {
  const label = path.replace(/^\/+/, '');
  const beforeBinary = before != null && isBinary(before);
  const afterBinary = after != null && isBinary(after);
  if (beforeBinary || afterBinary || (before == null && after == null)) {
    return `Binary files a/${label} and b/${label} differ (sha256 ${beforeHash} -> ${afterHash})\n`;
  }
  if (before == null) {
    const lines = splitLines(after as Buffer);
    return `--- /dev/null\n+++ b/${label}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`;
  }
  if (after == null) {
    const lines = splitLines(before);
    return `--- a/${label}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n${lines.map((line) => `-${line}`).join('\n')}\n`;
  }
  const hunk = unifiedHunks(splitLines(before), splitLines(after));
  if (!hunk) {
    return `Files a/${label} and b/${label} differ (change too large to render; sha256 ${beforeHash} -> ${afterHash})\n`;
  }
  const header = hunk.oldCount === 0
    ? `@@ -0,0 +${hunk.newStart},${hunk.newCount} @@`
    : hunk.newCount === 0
      ? `@@ -${hunk.oldStart},${hunk.oldCount} +0,0 @@`
      : `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
  return `--- a/${label}\n+++ b/${label}\n${header}\n${hunk.lines.join('\n')}\n`;
}

/** Compute the added/modified/deleted sets and a unified-diff rendering. */
export function diffWorkspaces(start: WorkspaceSnapshot, end: WorkspaceSnapshot): WorkspaceDiff {
  const before = new Map(start.entries.map((entry) => [entry.path, entry]));
  const after = new Map(end.entries.map((entry) => [entry.path, entry]));
  const added: WorkspaceDiffChange[] = [];
  const modified: WorkspaceDiffModification[] = [];
  const deleted: WorkspaceDiffChange[] = [];
  const parts: string[] = [];

  for (const [path, entry] of after) {
    const prior = before.get(path);
    if (!prior) {
      added.push({ path, contentHash: entry.contentHash, size: entry.size });
      parts.push(renderTextDiff(path, null, entry.content ?? null, entry.contentHash, entry.contentHash));
    } else if (prior.contentHash !== entry.contentHash || prior.kind !== entry.kind) {
      modified.push({ path, beforeHash: prior.contentHash, afterHash: entry.contentHash, size: entry.size });
      parts.push(renderTextDiff(path, prior.content ?? null, entry.content ?? null, prior.contentHash, entry.contentHash));
    }
  }
  for (const [path, entry] of before) {
    if (!after.has(path)) {
      deleted.push({ path, contentHash: entry.contentHash, size: entry.size });
      parts.push(renderTextDiff(path, entry.content ?? null, null, entry.contentHash, entry.contentHash));
    }
  }

  return {
    workspaceId: end.workspaceId,
    startRootHash: start.rootHash,
    endRootHash: end.rootHash,
    added,
    modified,
    deleted,
    patchText: parts.join(''),
  };
}

/** Collector config for workspace evidence (same env conventions as the proxy). */
export function resolveWorkspaceCaptureConfig(env: NodeJS.ProcessEnv = process.env): WorkspaceCaptureConfig {
  let collectorUrl = (env.HALOOP_COLLECTOR_URL || env.W8_COLLECTOR_URL || '').trim().replace(/\/+$/, '');
  if (!collectorUrl) {
    const gateway = (env.HALOOP_GATEWAY_URL || env.W8_GATEWAY_URL || env.HALOOP_UPSTREAM_URL || '').trim();
    if (gateway) {
      try {
        const u = new URL(gateway);
        u.port = '8788';
        u.pathname = '';
        u.search = '';
        u.hash = '';
        collectorUrl = u.origin;
      } catch {
        // malformed gateway URL: leave collectorUrl empty
      }
    }
  }
  const token = (env.W8_CAPTURE_PRODUCER_TOKEN || env.HALOOP_CAPTURE_TOKEN || env.ADMIN_TOKEN || '').trim();
  const project = (env.OPENRIND_CAPTURE_PROJECT || 'openrind-shell').trim();
  return { collectorUrl, token, project, enabled: Boolean(collectorUrl && token) };
}

/**
 * Upload the diff as a content-addressed artifact and record a model_patch
 * evidence event. Throws on HTTP failure; callers decide how loud to be.
 */
export async function emitWorkspacePatch(options: {
  collectorUrl: string;
  token: string;
  project: string;
  sessionId: string;
  diff: WorkspaceDiff;
  fetchImpl?: typeof fetch;
}): Promise<{ artifactId: string; sha256: string; inlineEvent: boolean }> {
  const { diff } = options;
  const fetcher = options.fetchImpl ?? fetch;
  const patch = diff.patchText;
  const sha256 = sha256Hex(patch);
  const artifactId = sanitizeIdentifier(`ws-patch-${options.sessionId}`, `ws-patch-${Date.now()}`);

  const upload = await fetcher(`${options.collectorUrl}/artifacts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}` },
    body: JSON.stringify({
      artifact_id: artifactId,
      sha256,
      content: Buffer.from(patch, 'utf8').toString('base64'),
      content_type: 'text/x-diff',
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!upload.ok) {
    const text = await upload.text().catch(() => '');
    throw new Error(`artifact upload HTTP ${upload.status}: ${text.slice(0, 300)}`);
  }

  let inlineEvent = false;
  if (Buffer.byteLength(patch, 'utf8') <= MAX_INLINE_ARTIFACT_BYTES) {
    const event = {
      schema_version: 1,
      project: options.project,
      session_id: options.sessionId,
      event_id: sanitizeIdentifier(`evt-${options.sessionId}-workspace-patch`, `evt-${Date.now()}-ws`),
      occurred_at: new Date().toISOString(),
      producer_version: 'openrind-shell-workspace-manifest/1.0.0',
      data: {
        type: 'artifact.recorded',
        artifact_id: artifactId,
        kind: 'model_patch',
        content: patch,
        content_type: 'text/x-diff',
        sha256,
        boundary: 'final',
        // The collector schema allows only base_commit | initial_workspace;
        // a FUSE-journal patch is relative to the workspace start state.
        patch_basis: 'initial_workspace',
      },
    };
    const res = await fetcher(`${options.collectorUrl}/internal/capture/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}` },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`artifact.recorded HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    inlineEvent = true;
  }
  return { artifactId, sha256, inlineEvent };
}

/** Serialize a snapshot (content as base64) for storage between CLI runs. */
export function serializeSnapshot(snapshot: WorkspaceSnapshot): string {
  return JSON.stringify({
    ...snapshot,
    entries: snapshot.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      contentHash: entry.contentHash,
      size: entry.size,
      content: entry.content ? entry.content.toString('base64') : null,
    })),
  });
}

/** Revive a snapshot stored by serializeSnapshot. Throws on invalid input. */
export function parseSnapshot(json: string): WorkspaceSnapshot {
  const raw = JSON.parse(json) as Record<string, unknown>;
  if (raw?.version !== WORKSPACE_MANIFEST_VERSION || !Array.isArray(raw.entries) || typeof raw.rootHash !== 'string') {
    throw new Error('invalid workspace snapshot file');
  }
  const entries: WorkspaceManifestEntry[] = raw.entries.map((entry: Record<string, unknown>) => {
    if (typeof entry?.path !== 'string' || typeof entry?.contentHash !== 'string') {
      throw new Error('invalid workspace snapshot entry');
    }
    return {
      path: entry.path,
      kind: entry.kind === 'symlink' ? 'symlink' : 'file',
      contentHash: entry.contentHash,
      size: Number(entry.size) || 0,
      ...(typeof entry.content === 'string' ? { content: Buffer.from(entry.content, 'base64') } : {}),
    };
  });
  return {
    version: WORKSPACE_MANIFEST_VERSION,
    workspaceId: String(raw.workspaceId ?? ''),
    volumeId: raw.volumeId == null ? null : String(raw.volumeId),
    takenAt: String(raw.takenAt ?? ''),
    rootHash: raw.rootHash,
    entries,
  };
}

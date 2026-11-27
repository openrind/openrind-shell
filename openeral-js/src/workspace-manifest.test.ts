import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { getDatabaseConnection, stopEmbeddedDatabase } from './db/embedded.js';
import { runMigrations } from './db/migrations.js';
import {
  EMPTY_WORKSPACE_ROOT,
  diffWorkspaces,
  emitWorkspacePatch,
  parseSnapshot,
  serializeSnapshot,
  snapshotWorkspace,
} from './workspace-manifest.js';

const originalDataDir = process.env.OPENERAL_DATA_DIR;
const originalDatabaseUrl = process.env.DATABASE_URL;
let temporaryRoot = '';
let pool: pg.Pool;

// One embedded PostgreSQL for the whole file; each test uses its own
// workspace id, so no state leaks between tests.
beforeAll(async () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), 'openrind-ws-manifest-'));
  delete process.env.DATABASE_URL;
  process.env.OPENERAL_DATA_DIR = join(temporaryRoot, 'pglite');
  const connection = await getDatabaseConnection();
  pool = connection.pool;
  await runMigrations(pool);
}, 60_000);

afterAll(async () => {
  await stopEmbeddedDatabase();
  if (originalDataDir === undefined) delete process.env.OPENERAL_DATA_DIR;
  else process.env.OPENERAL_DATA_DIR = originalDataDir;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
});

type Client = pg.PoolClient;

async function insertFile(client: Client, volumeId: string, parentNodeId: string, path: string, content: Buffer): Promise<string> {
  const segments = path.split('/').filter(Boolean);
  let parent = parentNodeId;
  for (const dir of segments.slice(0, -1)) {
    const existing = await client.query(
      `SELECT child_node_id FROM _openeral.fs_dirents WHERE volume_id = $1 AND parent_node_id = $2 AND name = $3`,
      [volumeId, parent, Buffer.from(dir)],
    );
    if (existing.rows.length > 0) {
      parent = String(existing.rows[0].child_node_id);
      continue;
    }
    const dirNode = await client.query(
      `INSERT INTO _openeral.fs_nodes (volume_id, kind, mode, uid, gid, size, nlink, atime_ns, mtime_ns, ctime_ns)
       VALUES ($1, 2, 493, 1000, 1000, 0, 2, 0, 0, 0) RETURNING node_id`,
      [volumeId],
    );
    const dirId = String(dirNode.rows[0].node_id);
    await client.query(
      `INSERT INTO _openeral.fs_dirents (volume_id, parent_node_id, name, child_node_id) VALUES ($1, $2, $3, $4)`,
      [volumeId, parent, Buffer.from(dir), dirId],
    );
    parent = dirId;
  }
  const name = segments[segments.length - 1];
  const node = await client.query(
    `INSERT INTO _openeral.fs_nodes (volume_id, kind, mode, uid, gid, size, nlink, atime_ns, mtime_ns, ctime_ns)
     VALUES ($1, 1, 420, 1000, 1000, $2, 1, 0, 0, 0) RETURNING node_id`,
    [volumeId, content.length],
  );
  const nodeId = String(node.rows[0].node_id);
  await client.query(
    `INSERT INTO _openeral.fs_dirents (volume_id, parent_node_id, name, child_node_id) VALUES ($1, $2, $3, $4)`,
    [volumeId, parent, Buffer.from(name), nodeId],
  );
  if (content.length > 0) {
    await client.query(
      `INSERT INTO _openeral.fs_chunks (volume_id, node_id, chunk_index, data) VALUES ($1, $2, 0, $3)`,
      [volumeId, nodeId, content],
    );
  }
  return nodeId;
}

async function seedVolume(pool: pg.Pool, workspaceId: string, files: Record<string, string>): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rootNode = await client.query(
      `INSERT INTO _openeral.fs_nodes (volume_id, kind, mode, uid, gid, size, nlink, atime_ns, mtime_ns, ctime_ns)
       VALUES ($1, 2, 493, 1000, 1000, 0, 2, 0, 0, 0) RETURNING node_id`,
      [`vol-${workspaceId}`],
    );
    const rootId = String(rootNode.rows[0].node_id);
    await client.query(
      `INSERT INTO _openeral.fs_volumes (volume_id, workspace_id, root_node_id) VALUES ($1, $2, $3)`,
      [`vol-${workspaceId}`, workspaceId, rootId],
    );
    for (const [path, content] of Object.entries(files)) {
      await insertFile(client, `vol-${workspaceId}`, rootId, path, Buffer.from(content, 'utf8'));
    }
    await client.query('COMMIT');
    return `vol-${workspaceId}`;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function rewriteFile(pool: pg.Pool, volumeId: string, path: string, content: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const name = path.split('/').filter(Boolean).pop()!;
    const node = await client.query(
      `SELECT d.child_node_id FROM _openeral.fs_dirents d
        WHERE d.volume_id = $1 AND d.name = $2`,
      [volumeId, Buffer.from(name)],
    );
    const nodeId = String(node.rows[0].child_node_id);
    await client.query(`DELETE FROM _openeral.fs_chunks WHERE volume_id = $1 AND node_id = $2`, [volumeId, nodeId]);
    if (content.length > 0) {
      await client.query(
        `INSERT INTO _openeral.fs_chunks (volume_id, node_id, chunk_index, data) VALUES ($1, $2, 0, $3)`,
        [volumeId, nodeId, Buffer.from(content, 'utf8')],
      );
    }
    await client.query(`UPDATE _openeral.fs_nodes SET size = $3 WHERE volume_id = $1 AND node_id = $2`, [volumeId, nodeId, content.length]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function removeFile(pool: pg.Pool, volumeId: string, path: string): Promise<void> {
  const name = path.split('/').filter(Boolean).pop()!;
  await pool.query(
    `DELETE FROM _openeral.fs_nodes WHERE volume_id = $1
       AND node_id IN (SELECT child_node_id FROM _openeral.fs_dirents WHERE volume_id = $1 AND name = $2)`,
    [volumeId, Buffer.from(name)],
  );
}

describe('workspace-manifest', () => {
  it('snapshots a missing volume as the empty workspace', async () => {
    const snapshot = await snapshotWorkspace(pool, 'ws-absent');
    expect(snapshot.volumeId).toBeNull();
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.rootHash).toBe(EMPTY_WORKSPACE_ROOT);
  });

  it('hashes files in path order and produces a stable root', async () => {
    await seedVolume(pool, 'ws-a', {
      '/src/app.ts': 'console.log(1)\n',
      '/hello.txt': 'hello world\n',
    });
    const first = await snapshotWorkspace(pool, 'ws-a');
    const second = await snapshotWorkspace(pool, 'ws-a');
    expect(first.entries.map((e) => e.path)).toEqual(['/hello.txt', '/src/app.ts']);
    expect(first.entries[0].contentHash).toBe(createHash('sha256').update('hello world\n').digest('hex'));
    expect(first.entries[0].content?.toString('utf8')).toBe('hello world\n');
    expect(first.rootHash).toBe(second.rootHash);
    expect(first.rootHash).not.toBe(EMPTY_WORKSPACE_ROOT);
  });

  it('diffs added, modified, and deleted files as unified text', async () => {
    const volumeId = await seedVolume(pool, 'ws-b', {
      '/hello.txt': 'hello world\n',
      '/src/app.ts': 'console.log(1)\n',
    });
    const start = await snapshotWorkspace(pool, 'ws-b');

    await rewriteFile(pool, volumeId, '/hello.txt', 'hello there\n');
    await removeFile(pool, volumeId, '/src/app.ts');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const root = await client.query(`SELECT root_node_id FROM _openeral.fs_volumes WHERE volume_id = $1`, [volumeId]);
      await insertFile(client, volumeId, String(root.rows[0].root_node_id), '/new.txt', Buffer.from('fresh\n', 'utf8'));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const end = await snapshotWorkspace(pool, 'ws-b');
    const diff = diffWorkspaces(start, end);
    expect(diff.added.map((c) => c.path)).toEqual(['/new.txt']);
    expect(diff.modified.map((c) => c.path)).toEqual(['/hello.txt']);
    expect(diff.deleted.map((c) => c.path)).toEqual(['/src/app.ts']);
    expect(diff.startRootHash).toBe(start.rootHash);
    expect(diff.endRootHash).toBe(end.rootHash);
    expect(diff.startRootHash).not.toBe(diff.endRootHash);
    expect(diff.patchText).toContain('--- a/hello.txt');
    expect(diff.patchText).toContain('+++ b/hello.txt');
    expect(diff.patchText).toContain('-hello world');
    expect(diff.patchText).toContain('+hello there');
    expect(diff.patchText).toContain('--- /dev/null');
    expect(diff.patchText).toContain('+++ b/new.txt');
    expect(diff.patchText).toContain('+fresh');
    expect(diff.patchText).toContain('--- a/src/app.ts');
    expect(diff.patchText).toContain('+++ /dev/null');
  });

  it('marks binary changes instead of rendering them', async () => {
    const volumeId = await seedVolume(pool, 'ws-c', { '/bin.dat': 'abc' });
    const start = await snapshotWorkspace(pool, 'ws-c');
    await rewriteFile(pool, volumeId, '/bin.dat', 'ab\0c');
    const end = await snapshotWorkspace(pool, 'ws-c');
    const diff = diffWorkspaces(start, end);
    expect(diff.modified.map((c) => c.path)).toEqual(['/bin.dat']);
    expect(diff.patchText).toContain('Binary files a/bin.dat and b/bin.dat differ');
  });

  it('round-trips a snapshot through serialize/parse', async () => {
    await seedVolume(pool, 'ws-d', { '/hello.txt': 'hello world\n' });
    const snapshot = await snapshotWorkspace(pool, 'ws-d');
    const revived = parseSnapshot(serializeSnapshot(snapshot));
    expect(revived.rootHash).toBe(snapshot.rootHash);
    expect(revived.entries[0].content?.toString('utf8')).toBe('hello world\n');
    expect(() => parseSnapshot('{"version":2}')).toThrow('invalid workspace snapshot');
  });

  it('emits the patch as a content-addressed artifact plus a model_patch event', async () => {
    const requests: { url: string; auth: string | undefined; body: any }[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        requests.push({
          url: req.url || '',
          auth: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('{"stored":true}');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const volumeId = await seedVolume(pool, 'ws-e', { '/hello.txt': 'hello world\n' });
    const start = await snapshotWorkspace(pool, 'ws-e');
    await rewriteFile(pool, volumeId, '/hello.txt', 'hello there\n');
    const end = await snapshotWorkspace(pool, 'ws-e');
    const diff = diffWorkspaces(start, end);

    try {
      const result = await emitWorkspacePatch({
        collectorUrl: origin,
        token: 'producer-token',
        project: 'openrind-shell',
        sessionId: 'ws-e',
        diff,
      });
      expect(result.inlineEvent).toBe(true);
      expect(requests.map((r) => r.url)).toEqual(['/artifacts', '/internal/capture/events']);

      const artifact = requests[0];
      expect(artifact.auth).toBe('Bearer producer-token');
      expect(artifact.body.artifact_id).toBe(result.artifactId);
      expect(artifact.body.sha256).toBe(result.sha256);
      expect(Buffer.from(artifact.body.content, 'base64').toString('utf8')).toBe(diff.patchText);
      expect(artifact.body.content_type).toBe('text/x-diff');

      const event = requests[1];
      expect(event.auth).toBe('Bearer producer-token');
      expect(event.body.schema_version).toBe(1);
      expect(event.body.project).toBe('openrind-shell');
      expect(event.body.session_id).toBe('ws-e');
      expect(event.body.data.type).toBe('artifact.recorded');
      expect(event.body.data.kind).toBe('model_patch');
      expect(event.body.data.patch_basis).toBe('initial_workspace');
      expect(event.body.data.boundary).toBe('final');
      expect(event.body.data.sha256).toBe(result.sha256);
      expect(event.body.data.content).toBe(diff.patchText);
    } finally {
      server.close();
    }
  });

  it('fails loudly when the collector rejects the upload', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"boom"}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const diff = diffWorkspaces(
      { version: 1, workspaceId: 'ws-f', volumeId: null, takenAt: '', rootHash: EMPTY_WORKSPACE_ROOT, entries: [] },
      { version: 1, workspaceId: 'ws-f', volumeId: null, takenAt: '', rootHash: EMPTY_WORKSPACE_ROOT, entries: [] },
    );
    try {
      await expect(emitWorkspacePatch({
        collectorUrl: origin,
        token: 't',
        project: 'openrind-shell',
        sessionId: 'ws-f',
        diff,
      })).rejects.toThrow('HTTP 500');
    } finally {
      server.close();
    }
  });
});

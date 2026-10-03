import { open, readFile, writeFile, rename, unlink, mkdir, realpath, lstat } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute, basename, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { BrowserFault, LIMITS } from '@openrind/browser-contract';

export function assertPathBeneath(workspaceRoot, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath) {
    throw new BrowserFault('INVALID_ARGUMENT');
  }
  if (/[\\:\x00-\x1f\x7f]/.test(relativePath) || relativePath.startsWith('/')) {
    throw new BrowserFault('INVALID_ARGUMENT');
  }

  const parts = relativePath.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) {
    throw new BrowserFault('INVALID_ARGUMENT');
  }

  const resolved = resolve(workspaceRoot, relativePath);
  const normalizedRoot = resolve(workspaceRoot);
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep;

  if (!resolved.startsWith(prefix) && resolved !== normalizedRoot) {
    throw new BrowserFault('POLICY_DENIED');
  }

  return resolved;
}

export async function verifyNoSymlinkEscape(workspaceRoot, targetPath) {
  try {
    const realRoot = await realpath(workspaceRoot);
    const realTarget = await realpath(targetPath);
    const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (!realTarget.startsWith(prefix) && realTarget !== realRoot) {
      throw new BrowserFault('POLICY_DENIED');
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return; // New file destination
    throw error;
  }
}

export function createLocalTransfers({ workspaceRoot, artifacts, owner }) {
  if (!workspaceRoot || !isAbsolute(workspaceRoot)) {
    throw new Error('Absolute workspaceRoot required');
  }

  return async function localTransfers(name, args) {
    if (name === 'browser_import_file') {
      const fullPath = assertPathBeneath(workspaceRoot, args.path);
      await verifyNoSymlinkEscape(workspaceRoot, fullPath);

      let stat;
      try {
        stat = await lstat(fullPath);
      } catch {
        throw new BrowserFault('INVALID_ARGUMENT');
      }

      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new BrowserFault('INVALID_ARGUMENT');
      }

      if (stat.size > LIMITS.artifactBytes) {
        throw new BrowserFault('RATE_LIMITED');
      }

      const bytes = await readFile(fullPath);
      const sha256 = createHash('sha256').update(bytes).digest('hex');

      const staged = await artifacts.stage(owner, args.sessionId, bytes, {
        filename: basename(args.path),
        expectedSha256: sha256,
        maxBytes: LIMITS.artifactBytes,
      });

      return {
        ok: true,
        sessionId: args.sessionId,
        sessionEpoch: args.sessionEpoch,
        operationId: args.operationId,
        data: {
          artifactId: staged.id,
          byteCount: staged.byteCount,
          sha256: staged.sha256,
        },
        warnings: [],
      };
    }

    if (name === 'browser_save_artifact') {
      const fullPath = assertPathBeneath(workspaceRoot, args.destination);
      const targetDir = dirname(fullPath);

      // Verify parent directory exists beneath workspace
      await verifyNoSymlinkEscape(workspaceRoot, targetDir);

      let exists = false;
      try {
        await lstat(fullPath);
        exists = true;
      } catch {}

      if (exists && !args.overwrite) {
        throw new BrowserFault('POLICY_DENIED');
      }

      const record = await artifacts.get(owner, args.artifactId);
      if (!record || !record.buffer) {
        throw new BrowserFault('ARTIFACT_EXPIRED');
      }

      // Check SHA-256 match
      const computedSha = createHash('sha256').update(record.buffer).digest('hex');
      if (computedSha !== record.sha256) {
        throw new BrowserFault('BACKEND_UNAVAILABLE');
      }

      await mkdir(targetDir, { recursive: true });

      // Atomic save via temp file in the same directory
      const tempPath = join(targetDir, `.tmp_art_${randomBytes(8).toString('hex')}`);
      let fileHandle;
      try {
        fileHandle = await open(tempPath, 'wx', 0o600);
        await fileHandle.writeFile(record.buffer);
        await fileHandle.sync();
        await fileHandle.close();
        fileHandle = null;

        await rename(tempPath, fullPath);

        // Fsync parent directory if supported
        let dirHandle;
        try {
          dirHandle = await open(targetDir, 'r');
          await dirHandle.sync();
        } catch {}
        finally {
          if (dirHandle) await dirHandle.close().catch(() => {});
        }
      } catch (err) {
        if (fileHandle) await fileHandle.close().catch(() => {});
        await unlink(tempPath).catch(() => {});
        throw err;
      }

      return {
        ok: true,
        sessionId: args.sessionId,
        sessionEpoch: args.sessionEpoch,
        operationId: args.operationId,
        data: {
          saved: true,
          destination: args.destination,
          byteCount: record.byteCount,
          sha256: record.sha256,
        },
        warnings: [],
      };
    }

    throw new BrowserFault('INVALID_ARGUMENT');
  };
}

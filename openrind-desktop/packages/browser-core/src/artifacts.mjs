import { openSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { readFile, writeFile, unlink, mkdir, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { BrowserFault, LIMITS } from '@openrind/browser-contract';
import { newId } from './security.mjs';

const MAX_OWNER_QUOTA = 1024 * 1024 * 1024; // 1 GiB per owner

export class ArtifactsManager {
  constructor({ stagingDir, clock = Date.now, maxQuota = MAX_OWNER_QUOTA }) {
    if (!stagingDir || !isAbsolute(stagingDir)) throw new Error('Absolute stagingDir required');
    this.stagingDir = stagingDir;
    this.clock = clock;
    this.maxQuota = maxQuota;
    this.artifacts = new Map(); // artifactId -> artifactRecord
    this.ownerUsage = new Map(); // owner -> totalBytes
    this.downloads = new Map(); // `${owner}:${sessionId}` -> Array<artifactRecord>

    mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  }

  async stage(owner, sessionId, data, options = {}) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const byteCount = buffer.length;
    const maxBytes = options.maxBytes || LIMITS.artifactBytes;

    if (byteCount > maxBytes) {
      throw new BrowserFault('RATE_LIMITED');
    }

    const currentUsage = this.ownerUsage.get(owner) || 0;
    if (currentUsage + byteCount > this.maxQuota) {
      throw new BrowserFault('RATE_LIMITED');
    }

    const id = newId('art');
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    if (options.expectedSha256 && options.expectedSha256 !== sha256) {
      throw new BrowserFault('INVALID_ARGUMENT');
    }

    const filename = options.filename || `${id}.bin`;
    const mimeType = options.mimeType || 'application/octet-stream';
    const filePath = join(this.stagingDir, `${id}.dat`);

    // Write file with exclusive mode
    await writeFile(filePath, buffer, { flag: 'wx', mode: 0o600 });

    const now = this.clock();
    const ttlMs = options.ttlMs || LIMITS.idleMs;
    const record = {
      id,
      owner,
      sessionId,
      filename,
      mimeType,
      byteCount,
      sha256,
      filePath,
      createdAt: now,
      expiresAt: now + ttlMs,
    };

    this.artifacts.set(id, record);
    this.ownerUsage.set(owner, currentUsage + byteCount);

    if (options.isDownload) {
      const key = `${owner}:${sessionId}`;
      const list = this.downloads.get(key) || [];
      list.push(record);
      this.downloads.set(key, list);
    }

    return record;
  }

  async get(owner, artifactId) {
    const record = this.artifacts.get(artifactId);
    if (!record || record.owner !== owner) {
      throw new BrowserFault('ARTIFACT_EXPIRED');
    }
    if (record.expiresAt <= this.clock()) {
      await this.delete(owner, artifactId);
      throw new BrowserFault('ARTIFACT_EXPIRED');
    }

    const buffer = await readFile(record.filePath);
    return {
      ...record,
      buffer,
    };
  }

  listDownloads(owner, sessionId) {
    const key = `${owner}:${sessionId}`;
    const list = this.downloads.get(key) || [];
    const now = this.clock();
    return list
      .filter(r => r.expiresAt > now)
      .map(r => ({
        artifactId: r.id,
        filename: r.filename,
        byteCount: r.byteCount,
        sha256: r.sha256,
        downloadedAt: r.createdAt,
      }));
  }

  async delete(owner, artifactId) {
    const record = this.artifacts.get(artifactId);
    if (!record || record.owner !== owner) return;

    this.artifacts.delete(artifactId);
    const usage = this.ownerUsage.get(owner) || 0;
    this.ownerUsage.set(owner, Math.max(0, usage - record.byteCount));

    try {
      await unlink(record.filePath);
    } catch {}
  }

  async sweep() {
    const now = this.clock();
    const expired = [];
    for (const [id, record] of this.artifacts) {
      if (record.expiresAt <= now) expired.push(record);
    }
    for (const record of expired) {
      await this.delete(record.owner, record.id);
    }
  }

  async close() {
    try {
      await rm(this.stagingDir, { recursive: true, force: true });
    } catch {}
  }
}

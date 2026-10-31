// Content-addressed artifact management (Section 7.2 & 13.3)
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

export function sha256Hex(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""), "utf8");
  return createHash("sha256").update(buf).digest("hex");
}

export class ArtifactStore {
  constructor() {
    this.artifacts = new Map();
  }

  record(name, content, mediaType = "text/plain") {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""), "utf8");
    const hash = sha256Hex(buf);
    if (!this.artifacts.has(hash)) {
      this.artifacts.set(hash, {
        hash,
        size: buf.length,
        mediaType,
        originalName: name,
        buffer: buf,
      });
    }
    return hash;
  }

  recordFile(filePath, mediaType = null) {
    if (!filePath || !existsSync(filePath)) return null;
    try {
      const buf = readFileSync(filePath);
      const name = basename(filePath);
      const inferredMediaType = mediaType || (filePath.endsWith(".png") ? "image/png" : "application/octet-stream");
      return this.record(name, buf, inferredMediaType);
    } catch {
      return null;
    }
  }

  get(hash) {
    return this.artifacts.get(hash) || null;
  }

  getManifest() {
    const manifest = {};
    for (const [hash, item] of this.artifacts.entries()) {
      manifest[hash] = {
        hash: item.hash,
        size: item.size,
        mediaType: item.mediaType,
        originalName: item.originalName,
      };
    }
    return manifest;
  }

  toZipFiles(prefix = "tracepack/artifacts") {
    const files = [
      {
        path: `${prefix}/manifest.json`,
        content: JSON.stringify(this.getManifest(), null, 2),
      },
    ];
    for (const [hash, item] of this.artifacts.entries()) {
      files.push({
        path: `${prefix}/${hash}`,
        content: item.buffer,
      });
    }
    return files;
  }
}

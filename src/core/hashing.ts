import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { QuickXorHash } from './quickxorhash.js';

export interface FileHashes {
  size: number;
  quickXorHash: string; // base64
  sha1Hash: string; // hex, upper-case like Graph
}

/**
 * Streams a file once and computes QuickXorHash + SHA-1.
 * SHA-1 is only used as an extra check when OneDrive provides it (personal accounts); QuickXorHash
 * is the primary comparison key on both account types.
 */
export async function hashFile(path: string, signal?: AbortSignal): Promise<FileHashes> {
  const qx = new QuickXorHash();
  const sha1 = createHash('sha1');
  let size = 0;
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024, signal });
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    qx.update(buf);
    sha1.update(buf);
    size += buf.length;
  }
  return { size, quickXorHash: qx.digestBase64(), sha1Hash: sha1.digest('hex').toUpperCase() };
}

export interface HashCacheEntry extends FileHashes {
  mtimeMs: number;
  ino: number;
}

/**
 * In-memory hash cache keyed by absolute path; an entry is valid only when size, mtime and inode match.
 * Persisted by the host (Electron main) as JSON between runs so unchanged files are not re-read.
 */
export class HashCache {
  private readonly map: Map<string, HashCacheEntry>;
  private dirty = false;

  constructor(initial?: Record<string, HashCacheEntry>) {
    this.map = new Map(Object.entries(initial ?? {}));
  }

  get(path: string, size: number, mtimeMs: number, ino: number): FileHashes | undefined {
    const e = this.map.get(path);
    if (!e) return undefined;
    if (e.size !== size || e.mtimeMs !== mtimeMs || e.ino !== ino) return undefined;
    return e;
  }

  set(path: string, size: number, mtimeMs: number, ino: number, hashes: FileHashes): void {
    this.map.set(path, { ...hashes, mtimeMs, ino });
    this.dirty = true;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  toJSON(): Record<string, HashCacheEntry> {
    this.dirty = false;
    return Object.fromEntries(this.map);
  }

  /** Drop entries for paths that are no longer under any of the given roots (keeps the cache bounded). */
  prune(keepPaths: Set<string>): void {
    for (const k of this.map.keys()) if (!keepPaths.has(k)) this.map.delete(k);
    this.dirty = true;
  }
}

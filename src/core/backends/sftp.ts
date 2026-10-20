import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import type { Stats } from 'ssh2';
import {
  type DeleteFolderResult,
  type DeleteResult,
  DestinationError,
  type DestinationBackend,
  type DestinationInfo,
  RESERVED_NAMES,
  type RemoteRef,
  type UploadReceipt,
  type VerifiedHashes,
} from '../backend.js';
import { CancelledError, isAbortError } from '../graph/errors.js';
import { joinRel } from '../names.js';
import type { Issue, LocalEntry, RemoteEntry, RemoteInventory } from '../types.js';
import { SftpConnection, type SftpConnectionSettings, SftpError, isWindowsPath, joinSftp, toNativePath, toSftpPath } from './sftpConnection.js';

export const MARKER_NAME = '.mirror-destination.json';
export const MANIFEST_NAME = '.mirror-manifest.json';
export const PART_SUFFIX = '.mirror-part';

export type HashCommand = 'powershell' | 'sha1sum' | 'none';

export interface SftpTarget {
  connection: SftpConnectionSettings;
  /** Root folder on the remote disk, as entered by the user (Windows or POSIX path). */
  rootPath: string;
  /** Expected id stored in the root marker file. */
  rootId: string;
  destinationName: string;
  hashCommand: HashCommand;
}

export interface SftpMarker {
  mirrorRootId: string;
  createdAt: string;
  createdBy: string;
  note: string;
}

interface ManifestEntry {
  size: number;
  mtime: number; // seconds
  sha1: string; // upper-case hex
}

interface Manifest {
  version: 1;
  files: Record<string, ManifestEntry>;
}

/**
 * Remote disk over SFTP (e.g. an external drive on an always-on Windows PC reachable via Tailscale).
 *
 * Identity: a marker file in the root folder holds a UUID chosen when the root was configured; a
 * run refuses to proceed if the marker is missing or different (unmounted disk, wrong machine).
 * Content: SHA-1 computed on the remote machine in batches (PowerShell `Get-FileHash` on Windows,
 * `sha1sum` on POSIX), cached in a manifest inside the destination keyed by size + mtime.
 * Preconditions: deletions compare size + mtime with the inventory; folders must be empty.
 */
export class SftpBackend implements DestinationBackend {
  readonly kind = 'sftp' as const;
  readonly label: string;
  private conn: SftpConnection | undefined;
  private readonly rootPath: string;
  private readonly destPath: string;
  private manifest: Manifest = { version: 1, files: {} };
  private manifestDirty = false;
  private hashingAvailable: boolean;
  private readonly warnings: Issue[] = [];

  constructor(
    private readonly target: SftpTarget,
    private readonly maxPathLength = 240,
  ) {
    this.rootPath = toSftpPath(target.rootPath);
    this.destPath = joinSftp(this.rootPath, target.destinationName);
    this.label = `${target.connection.host}:${toNativePath(this.destPath)}`;
    this.hashingAvailable = target.hashCommand !== 'none';
  }

  /** Fingerprint presented by the server (for trust-on-first-use persistence). */
  get hostKeyFingerprint(): string | undefined {
    return this.conn?.hostKeyFingerprint;
  }

  private async connection(signal?: AbortSignal): Promise<SftpConnection> {
    if (!this.conn) this.conn = await SftpConnection.connect(this.target.connection, signal);
    return this.conn;
  }

  /* ------------------------------ identity ------------------------------ */

  async verifyDestination(signal?: AbortSignal): Promise<DestinationInfo> {
    let c: SftpConnection;
    try {
      c = await this.connection(signal);
    } catch (err) {
      if (isAbortError(err)) throw err;
      const e = err as SftpError;
      throw new DestinationError(`destination.${e.code === 'hostKeyMismatch' ? 'hostKeyMismatch' : 'unreachable'}`, e.message);
    }
    const rootStat = await c.stat(this.rootPath);
    if (!rootStat) throw new DestinationError('destination.rootMissing', `The remote root folder ${toNativePath(this.rootPath)} does not exist. Is the external disk connected to the remote machine?`);
    if (!rootStat.isDirectory()) throw new DestinationError('destination.rootMissing', `${toNativePath(this.rootPath)} is not a folder.`);
    const marker = await readMarker(c, this.rootPath);
    if (!marker) {
      throw new DestinationError('destination.markerMissing', `The remote root folder ${toNativePath(this.rootPath)} has no Mirror marker file (${MARKER_NAME}). This is not the disk Mirror was configured with (or it is not mounted). Nothing was changed.`);
    }
    if (marker.mirrorRootId !== this.target.rootId) {
      throw new DestinationError('destination.markerMismatch', `The marker in ${toNativePath(this.rootPath)} identifies a different Mirror root (${marker.mirrorRootId}). Nothing was changed. Re-select the remote root in Settings if this is intended.`);
    }
    const destStat = await c.stat(this.destPath);
    if (!destStat) throw new DestinationError('destination.missing', `The destination folder "${this.target.destinationName}" no longer exists under ${toNativePath(this.rootPath)}. Edit the pair to recreate it.`);
    if (!destStat.isDirectory()) throw new DestinationError('destination.missing', `"${this.target.destinationName}" under the remote root is not a folder.`);

    const windows = isWindowsPath(this.destPath);
    return {
      destinationPrefixLength: toNativePath(this.destPath).length,
      maxPathLength: windows ? this.maxPathLength : 4000,
      hashAlgorithm: this.hashingAvailable ? 'sha1Hash' : 'none',
    };
  }

  /* ------------------------------ inventory ----------------------------- */

  async list(signal?: AbortSignal, onProgress?: (folders: number, items: number) => void): Promise<RemoteInventory> {
    const c = await this.connection(signal);
    this.manifest = (await readManifest(c, this.destPath)) ?? { version: 1, files: {} };
    this.manifestDirty = false;
    const entries = new Map<string, RemoteEntry>();
    const queue: Array<{ path: string; rel: string }> = [{ path: this.destPath, rel: '' }];
    let folders = 0;
    const seenInManifest = new Set<string>();
    while (queue.length > 0) {
      if (signal?.aborted) throw new CancelledError();
      const { path: dir, rel } = queue.shift()!;
      const children = await c.readdir(dir);
      folders++;
      for (const ch of children) {
        if (RESERVED_NAMES.has(ch.name)) continue;
        const childRel = joinRel(rel, ch.name);
        const childPath = joinSftp(dir, ch.name);
        const attrs = ch.attrs;
        const isDir = attrs.isDirectory();
        const entry: RemoteEntry = {
          id: childPath,
          relPath: childRel,
          name: ch.name,
          kind: isDir ? 'folder' : 'file',
          size: isDir ? 0 : attrs.size,
          mtimeMs: attrs.mtime * 1000,
          parentId: dir,
        };
        if (!isDir) {
          const m = this.manifest.files[childRel];
          if (m && m.size === attrs.size && m.mtime === attrs.mtime) {
            entry.sha1Hash = m.sha1;
            seenInManifest.add(childRel);
          }
        }
        entries.set(childRel, entry);
        if (isDir) queue.push({ path: childPath, rel: childRel });
      }
      onProgress?.(folders, entries.size);
    }
    // Drop manifest rows for files that disappeared or changed.
    for (const k of Object.keys(this.manifest.files)) {
      if (!seenInManifest.has(k)) {
        delete this.manifest.files[k];
        this.manifestDirty = true;
      }
    }
    return { driveId: `sftp:${this.target.connection.host}`, destinationId: this.destPath, entries, listedAt: Date.now() };
  }

  async fillRemoteHashes(entries: RemoteEntry[], signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<void> {
    if (!this.hashingAvailable || entries.length === 0) return;
    const byPath = new Map(entries.map((e) => [e.id, e]));
    let results: Map<string, { sha1?: string; size: number }>;
    try {
      results = await this.hashRemote([...byPath.keys()], signal, onProgress);
    } catch (err) {
      if (isAbortError(err)) throw err;
      this.hashingUnavailable(err);
      return;
    }
    for (const [p, r] of results) {
      const e = byPath.get(p);
      if (!e || !r.sha1 || r.size !== e.size) continue;
      e.sha1Hash = r.sha1;
      if (e.mtimeMs !== undefined) {
        this.manifest.files[e.relPath] = { size: e.size, mtime: Math.floor(e.mtimeMs / 1000), sha1: r.sha1 };
        this.manifestDirty = true;
      }
    }
  }

  rootRef(): RemoteRef {
    return this.destPath;
  }

  /* ------------------------------ mutations ----------------------------- */

  async mkdir(parentRef: RemoteRef, name: string, _relPath: string, signal?: AbortSignal): Promise<RemoteRef> {
    const c = await this.connection(signal);
    const p = joinSftp(parentRef, name);
    const st = await c.stat(p);
    if (st?.isDirectory()) return p; // appeared concurrently
    if (st) throw new DestinationError('remote.conflict', 'an item with this name appeared at the destination during the run');
    await c.mkdir(p);
    return p;
  }

  async uploadFile(parentRef: RemoteRef, local: LocalEntry, abs: string, signal?: AbortSignal, onBytes?: (n: number) => void): Promise<UploadReceipt> {
    const c = await this.connection(signal);
    const finalPath = joinSftp(parentRef, local.name);
    const partPath = finalPath + PART_SUFFIX;

    // Resume a previous interrupted transfer of the same file when the partial data is plausible.
    // Only when remote hashing is available: verification then catches a stale partial file.
    let start = 0;
    const part = await c.stat(partPath);
    if (this.hashingAvailable && part && part.isFile() && part.size > 0 && part.size < local.size) start = part.size;

    if (local.size > 0) {
      let written = start;
      const reader = createReadStream(abs, { start, highWaterMark: 1024 * 1024, signal });
      reader.on('data', (chunk) => {
        written += (chunk as Buffer).length;
        onBytes?.(written);
      });
      await c.guard(pipeline(reader, c.createWriteStream(partPath, start)));
    } else {
      await c.writeFile(partPath, Buffer.alloc(0));
    }
    const mtimeSeconds = Math.floor(local.mtimeMs / 1000);
    await c.utimes(partPath, mtimeSeconds);
    await c.renameReplace(partPath, finalPath);
    onBytes?.(local.size);
    return { relPath: local.relPath, size: local.size, ref: finalPath };
  }

  async verifyUploads(receipts: UploadReceipt[], signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<Map<string, VerifiedHashes>> {
    const c = await this.connection(signal);
    const out = new Map<string, VerifiedHashes>();
    const byPath = new Map(receipts.map((r) => [r.ref, r]));
    let hashed = new Map<string, { sha1?: string; size: number }>();
    if (this.hashingAvailable) {
      try {
        hashed = await this.hashRemote([...byPath.keys()], signal, onProgress);
      } catch (err) {
        if (isAbortError(err)) throw err;
        this.hashingUnavailable(err);
      }
    }
    let done = 0;
    for (const r of receipts) {
      const h = hashed.get(r.ref);
      const st: Stats | undefined = h ? undefined : await c.stat(r.ref);
      const size = h ? h.size : (st?.size ?? -1);
      out.set(r.relPath, { size, sha1Hash: h?.sha1 });
      if (h?.sha1 && size === r.size) {
        const stat2 = st ?? (await c.stat(r.ref));
        if (stat2) {
          this.manifest.files[r.relPath] = { size, mtime: stat2.mtime, sha1: h.sha1 };
          this.manifestDirty = true;
        }
      }
      if (!this.hashingAvailable) onProgress?.(++done, receipts.length);
    }
    return out;
  }

  async move(entry: RemoteEntry, newParentRef: RemoteRef, newName: string, newRelPath: string, signal?: AbortSignal): Promise<RemoteRef> {
    const c = await this.connection(signal);
    await this.checkPrecondition(c, entry);
    const to = joinSftp(newParentRef, newName);
    if (await c.stat(to)) throw new Error('target path already exists');
    await c.rename(entry.id, to);
    const m = this.manifest.files[entry.relPath];
    if (m) {
      delete this.manifest.files[entry.relPath];
      this.manifest.files[newRelPath] = m;
      this.manifestDirty = true;
    }
    return to;
  }

  async deleteFile(entry: RemoteEntry, signal?: AbortSignal): Promise<DeleteResult> {
    const c = await this.connection(signal);
    const st = await c.stat(entry.id);
    if (!st) return 'notFound';
    if (!preconditionHolds(st, entry)) return 'preconditionFailed';
    const r = await c.unlink(entry.id);
    if (r === 'deleted' && this.manifest.files[entry.relPath]) {
      delete this.manifest.files[entry.relPath];
      this.manifestDirty = true;
    }
    return r;
  }

  async deleteFolder(entry: RemoteEntry, signal?: AbortSignal): Promise<DeleteFolderResult> {
    const c = await this.connection(signal);
    const st = await c.stat(entry.id);
    if (!st) return 'notFound';
    if (!st.isDirectory()) return 'preconditionFailed';
    const children = (await c.readdir(entry.id)).filter((ch) => !RESERVED_NAMES.has(ch.name));
    if (children.length > 0) return 'notEmpty';
    // Remove bookkeeping files we may have left inside (only ours).
    for (const ch of await c.readdir(entry.id)) if (RESERVED_NAMES.has(ch.name)) await c.unlink(joinSftp(entry.id, ch.name));
    await c.rmdir(entry.id);
    return 'deleted';
  }

  async deleteConflicting(entry: RemoteEntry, signal?: AbortSignal): Promise<DeleteResult> {
    const c = await this.connection(signal);
    const st = await c.stat(entry.id);
    if (!st) return 'notFound';
    if (entry.kind === 'file') {
      if (!preconditionHolds(st, entry)) return 'preconditionFailed';
      return c.unlink(entry.id);
    }
    if (!st.isDirectory()) return 'preconditionFailed';
    await this.removeTree(c, entry.id, signal);
    for (const k of Object.keys(this.manifest.files)) {
      if (k === entry.relPath || k.startsWith(entry.relPath + '/')) {
        delete this.manifest.files[k];
        this.manifestDirty = true;
      }
    }
    return 'deleted';
  }

  private async removeTree(c: SftpConnection, dir: string, signal?: AbortSignal): Promise<void> {
    for (const ch of await c.readdir(dir)) {
      if (signal?.aborted) throw new CancelledError();
      const p = joinSftp(dir, ch.name);
      if (ch.attrs.isDirectory()) await this.removeTree(c, p, signal);
      else await c.unlink(p);
    }
    await c.rmdir(dir);
  }

  async finalize(signal?: AbortSignal): Promise<void> {
    if (!this.manifestDirty || !this.conn) return;
    const c = await this.connection(signal);
    await writeManifest(c, this.destPath, this.manifest);
    this.manifestDirty = false;
  }

  private hashingUnavailable(err: unknown): void {
    if (!this.hashingAvailable) return;
    this.hashingAvailable = false;
    this.warnings.push({
      severity: 'warning',
      code: 'remote.hashingUnavailable',
      message: `content hashing on the remote machine is unavailable (${err instanceof Error ? err.message : String(err)}); files are compared by size only and re-uploaded when in doubt. Check the "Remote hash command" setting.`,
    });
  }

  drainWarnings(): Issue[] {
    return this.warnings.splice(0);
  }

  isQuotaError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /no space|ENOSPC|disk full|not enough space|quota/i.test(msg);
  }

  async close(): Promise<void> {
    await this.conn?.close();
    this.conn = undefined;
  }

  /* -------------------------- remote hashing --------------------------- */

  private async checkPrecondition(c: SftpConnection, entry: RemoteEntry): Promise<void> {
    const st = await c.stat(entry.id);
    if (!st) throw new Error('item no longer exists');
    if (!preconditionHolds(st, entry)) throw new Error('item changed at the destination since the inventory');
  }

  /** Hashes remote files in batches on the remote machine. Keys of the result are SFTP paths. */
  async hashRemote(paths: string[], signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<Map<string, { sha1?: string; size: number }>> {
    const c = await this.connection(signal);
    const out = new Map<string, { sha1?: string; size: number }>();
    const batchSize = 400;
    for (let i = 0; i < paths.length; i += batchSize) {
      if (signal?.aborted) throw new CancelledError();
      const batch = paths.slice(i, i + batchSize);
      const stdin = batch.map((p) => Buffer.from(toNativePath(p), 'utf8').toString('base64')).join('\n') + '\n';
      const command = this.target.hashCommand === 'powershell' ? powershellHashCommand() : posixHashCommand();
      const res = await c.exec(command, stdin, signal);
      if (res.code !== 0 && res.stdout.trim() === '') {
        // Hashing tool unavailable (e.g. no PowerShell): callers degrade to size-only verification with a warning.
        throw new SftpError(`remote hashing failed (exit ${res.code}): ${res.stderr.trim().slice(0, 300) || 'no output'}`, 'hashTool');
      }
      const decoded = new Map<string, string>();
      for (const p of batch) decoded.set(Buffer.from(toNativePath(p), 'utf8').toString('base64'), p);
      for (const line of res.stdout.split(/\r?\n/)) {
        const [b64, hash, size] = line.split('\t');
        if (!b64 || !hash) continue;
        const p = decoded.get(b64.trim());
        if (!p) continue;
        if (hash === 'MISSING' || hash === 'ERROR') out.set(p, { size: -1 });
        else out.set(p, { sha1: hash.trim().toUpperCase(), size: Number(size) });
      }
      onProgress?.(Math.min(paths.length, i + batch.length), paths.length);
    }
    return out;
  }
}

function preconditionHolds(st: Stats, entry: RemoteEntry): boolean {
  if (entry.kind === 'folder') return st.isDirectory();
  if (!st.isFile()) return false;
  if (st.size !== entry.size) return false;
  if (entry.mtimeMs !== undefined && st.mtime * 1000 !== entry.mtimeMs) return false;
  return true;
}

/* ------------------------------ scripts ------------------------------ */

const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
foreach ($line in $input) {
  $line = "$line".Trim()
  if (-not $line) { continue }
  $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
  $item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
  if ($null -eq $item -or $item.PSIsContainer) { "$line\`tMISSING\`t0"; continue }
  $h = Get-FileHash -LiteralPath $p -Algorithm SHA1 -ErrorAction SilentlyContinue
  if ($null -eq $h) { "$line\`tERROR\`t0" } else { "$line\`t$($h.Hash)\`t$($item.Length)" }
}
`;

export function powershellHashCommand(): string {
  const encoded = Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64');
  return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

export function posixHashCommand(): string {
  const script = [
    'while IFS= read -r l; do',
    '  [ -z "$l" ] && continue',
    '  p=$(printf %s "$l" | base64 -d 2>/dev/null)',
    '  if [ -f "$p" ]; then',
    '    h=$(sha1sum -- "$p" | cut -d" " -f1 | tr a-f A-F); s=$(wc -c < "$p" | tr -d " ")',
    '    printf "%s\\t%s\\t%s\\n" "$l" "$h" "$s"',
    '  else printf "%s\\tMISSING\\t0\\n" "$l"; fi',
    'done',
  ].join('\n');
  return `sh -c '${script.replace(/'/g, `'\\''`)}'`;
}

/* -------------------------- marker & manifest ------------------------- */

export async function readMarker(c: SftpConnection, rootPath: string): Promise<SftpMarker | undefined> {
  const buf = await c.readFile(joinSftp(rootPath, MARKER_NAME), 1024 * 1024);
  if (!buf) return undefined;
  try {
    const j = JSON.parse(buf.toString('utf8')) as Partial<SftpMarker>;
    if (typeof j.mirrorRootId !== 'string') return undefined;
    return j as SftpMarker;
  } catch {
    return undefined;
  }
}

export async function writeMarker(c: SftpConnection, rootPath: string, id: string = randomUUID()): Promise<SftpMarker> {
  const marker: SftpMarker = {
    mirrorRootId: id,
    createdAt: new Date().toISOString(),
    createdBy: 'Mirror',
    note: 'Identifies this folder as a Mirror root. Do not delete or move: Mirror refuses to run when it is missing.',
  };
  await c.writeFile(joinSftp(rootPath, MARKER_NAME), Buffer.from(JSON.stringify(marker, null, 2), 'utf8'));
  return marker;
}

async function readManifest(c: SftpConnection, destPath: string): Promise<Manifest | undefined> {
  const buf = await c.readFile(joinSftp(destPath, MANIFEST_NAME));
  if (!buf) return undefined;
  try {
    const j = JSON.parse(buf.toString('utf8')) as Manifest;
    if (j.version !== 1 || typeof j.files !== 'object') return undefined;
    return j;
  } catch {
    return undefined;
  }
}

async function writeManifest(c: SftpConnection, destPath: string, manifest: Manifest): Promise<void> {
  const tmp = joinSftp(destPath, MANIFEST_NAME + PART_SUFFIX);
  await c.writeFile(tmp, Buffer.from(JSON.stringify(manifest), 'utf8'));
  await c.renameReplace(tmp, joinSftp(destPath, MANIFEST_NAME));
}

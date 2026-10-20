import { promises as fs, type Dirent } from 'node:fs';
import * as path from 'node:path';
import type { EngineOptions, LocalEntry, LocalInventory, LocalProblem } from './types.js';
import { RESERVED_NAMES } from './backend.js';
import { collisionKey, joinRel, validateOneDriveName } from './names.js';

export class ScanError extends Error {
  constructor(
    message: string,
    public readonly code: 'missing' | 'notDirectory' | 'permissionDenied' | 'ioError' | 'cancelled',
    public readonly relPath?: string,
  ) {
    super(message);
    this.name = 'ScanError';
  }
}

export interface ScanOptions {
  excludeNames: Set<string>;
  excludePrefixes: string[];
  /** Length of the destination path prefix on OneDrive (e.g. "/Mirror/Documents"), to enforce maxPathLength. */
  destinationPrefixLength: number;
  maxPathLength: number;
  signal?: AbortSignal;
  onProgress?: (filesSeen: number, dirsSeen: number) => void;
}

export function scanOptionsFrom(opts: EngineOptions, destinationPrefixLength: number, signal?: AbortSignal): ScanOptions {
  return {
    excludeNames: new Set(opts.excludeNames),
    excludePrefixes: opts.excludePrefixes,
    destinationPrefixLength,
    maxPathLength: opts.maxPathLength,
    signal,
  };
}

/**
 * Builds a complete inventory of a source folder.
 *
 * Strictness is deliberate: any failure to enumerate a directory throws a ScanError and the
 * caller must abort the pair. A partial listing must never be mistaken for "the files are gone".
 * Problems with individual items (symlinks, invalid names, …) do not abort the scan but are
 * returned so that the planner can protect the corresponding remote paths and report them.
 */
export async function scanLocal(rootPath: string, options: ScanOptions): Promise<LocalInventory> {
  const { signal } = options;
  let rootStat;
  try {
    rootStat = await fs.stat(rootPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new ScanError(`Source folder not found: ${rootPath}`, 'missing');
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new ScanError(`Permission denied reading source folder: ${rootPath}`, 'permissionDenied');
    }
    throw new ScanError(`Cannot access source folder ${rootPath}: ${String(err)}`, 'ioError');
  }
  if (!rootStat.isDirectory()) throw new ScanError(`Source is not a folder: ${rootPath}`, 'notDirectory');

  // Readability probe: an unreadable root must abort, not look empty.
  try {
    await fs.access(rootPath, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new ScanError(`Permission denied reading source folder: ${rootPath}`, 'permissionDenied');
  }

  const inventory: LocalInventory = {
    rootPath,
    entries: new Map(),
    problems: [],
    excluded: [],
    scannedAt: Date.now(),
  };
  let filesSeen = 0;
  let dirsSeen = 0;

  const walk = async (dirAbs: string, dirRel: string): Promise<void> => {
    if (signal?.aborted) throw new ScanError('Scan cancelled', 'cancelled');
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const kind = code === 'EACCES' || code === 'EPERM' ? 'permissionDenied' : 'ioError';
      throw new ScanError(`Cannot list folder "${dirRel || '.'}": ${code ?? String(err)}`, kind, dirRel);
    }

    const keys = new Map<string, string>(); // collisionKey -> first name
    const collided = new Set<string>();

    for (const d of dirents) {
      const name = d.name;
      const rel = joinRel(dirRel, name);

      if (RESERVED_NAMES.has(name) || options.excludeNames.has(name) || options.excludePrefixes.some((p) => name.startsWith(p))) {
        inventory.excluded.push(rel);
        continue;
      }

      // Sibling collision detection (case / Unicode normalization).
      const key = collisionKey(name);
      const first = keys.get(key);
      if (first !== undefined) {
        collided.add(first);
        collided.add(name);
      } else {
        keys.set(key, name);
      }

      let st;
      try {
        st = await fs.lstat(path.join(dirAbs, name));
      } catch (err) {
        inventory.problems.push({ kind: 'unreadable', relPath: rel, detail: `lstat failed: ${(err as NodeJS.ErrnoException).code ?? String(err)}` });
        continue;
      }

      if (st.isSymbolicLink()) {
        inventory.problems.push({ kind: 'symlink', relPath: rel, detail: 'symbolic links are not followed and not mirrored' });
        continue;
      }
      if (!st.isFile() && !st.isDirectory()) {
        inventory.problems.push({ kind: 'special', relPath: rel, detail: 'not a regular file or folder' });
        continue;
      }

      if (st.isFile() && /^\..+\.icloud$/.test(name)) {
        inventory.problems.push({ kind: 'cloudPlaceholder', relPath: rel, detail: 'cloud-only placeholder; download the file locally first' });
        continue;
      }

      const v = name.endsWith('.mirror-part') ? { ok: false, reason: 'suffix ".mirror-part" is reserved by Mirror' } : validateOneDriveName(name);
      if (!v.ok) {
        inventory.problems.push({ kind: 'invalidName', relPath: rel, detail: v.reason ?? 'invalid name' });
        // A folder with an invalid name cannot exist remotely; do not descend.
        continue;
      }

      if (options.destinationPrefixLength + 1 + rel.length > options.maxPathLength) {
        inventory.problems.push({ kind: 'pathTooLong', relPath: rel, detail: `path exceeds ${options.maxPathLength} characters on OneDrive` });
        continue;
      }

      if (st.isDirectory()) {
        dirsSeen++;
        inventory.entries.set(rel, { relPath: rel, name, kind: 'dir', size: 0, mtimeMs: st.mtimeMs, ino: st.ino });
        await walk(path.join(dirAbs, name), rel);
      } else {
        filesSeen++;
        const entry: LocalEntry = { relPath: rel, name, kind: 'file', size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
        if (st.size > 0 && st.blocks === 0) entry.possiblyDataless = true;
        inventory.entries.set(rel, entry);
      }
      if ((filesSeen + dirsSeen) % 200 === 0) options.onProgress?.(filesSeen, dirsSeen);
    }

    for (const name of collided) {
      const rel = joinRel(dirRel, name);
      const problem: LocalProblem = {
        kind: 'caseCollision',
        relPath: rel,
        detail: 'another item in the same folder has the same name ignoring case/normalization; OneDrive cannot store both',
      };
      inventory.problems.push(problem);
      // Remove the colliding entries (and their descendants) from the mirrorable set.
      for (const k of [...inventory.entries.keys()]) {
        if (k === rel || k.startsWith(rel + '/')) inventory.entries.delete(k);
      }
    }
  };

  await walk(rootPath, '');
  options.onProgress?.(filesSeen, dirsSeen);
  return inventory;
}

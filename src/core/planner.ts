import type { FileHashes } from './hashing.js';
import { depthOf, pathKey } from './names.js';
import type { Issue, LocalEntry, LocalInventory, Plan, PlanOp, PlanStats, RemoteEntry, RemoteInventory } from './types.js';

export class PlanAbort extends Error {
  constructor(message: string, public readonly code: 'emptySource') {
    super(message);
    this.name = 'PlanAbort';
  }
}

export interface PlannerInput {
  local: LocalInventory;
  remote: RemoteInventory;
  /** Hashes for local files, keyed by relPath. Must cover every path returned by `hashCandidates`. */
  hashes: Map<string, FileHashes>;
  allowEmptySourceToWipeDestination: boolean;
}

export interface PlannerOutput {
  plan: Plan;
  issues: Issue[];
}

/** Index of remote entries by normalized path key. */
function indexRemote(remote: RemoteInventory): Map<string, RemoteEntry> {
  const m = new Map<string, RemoteEntry>();
  for (const e of remote.entries.values()) m.set(pathKey(e.relPath), e);
  return m;
}

/**
 * Returns local file paths whose hash is needed to build the plan:
 *  - same path exists remotely as a file with the same size (identical vs changed),
 *  - local-only files whose size matches a remote-only file (rename/move detection).
 */
export function hashCandidates(local: LocalInventory, remote: RemoteInventory): string[] {
  const remoteByKey = indexRemote(remote);
  const localKeys = new Set<string>();
  for (const e of local.entries.values()) localKeys.add(pathKey(e.relPath));

  const remoteOnlySizes = new Set<number>();
  for (const r of remote.entries.values()) {
    if (r.kind === 'file' && !localKeys.has(pathKey(r.relPath))) remoteOnlySizes.add(r.size);
  }

  const out: string[] = [];
  for (const e of local.entries.values()) {
    if (e.kind !== 'file' || e.size === 0) continue;
    const r = remoteByKey.get(pathKey(e.relPath));
    if (r) {
      if (r.kind === 'file' && r.size === e.size) out.push(e.relPath);
    } else if (remoteOnlySizes.has(e.size)) {
      out.push(e.relPath);
    }
  }
  return out;
}

/** Protects a readable-but-empty source from wiping a non-empty destination (e.g. unmounted volume). */
export function checkEmptySourceGuard(local: LocalInventory, remote: RemoteInventory, allow: boolean): void {
  if (local.entries.size === 0 && local.problems.length === 0 && remote.entries.size > 0 && !allow) {
    throw new PlanAbort(
      `The source folder is empty while the destination contains ${remote.entries.size} item(s). ` +
        'Mirror refuses to empty the destination. If this is intended, enable "Allow an empty source to empty its destination" in Settings.',
      'emptySource',
    );
  }
}

export function buildPlan(input: PlannerInput): PlannerOutput {
  const { local, remote, hashes } = input;
  checkEmptySourceGuard(local, remote, input.allowEmptySourceToWipeDestination);

  const issues: Issue[] = [];
  const ops: PlanOp[] = [];
  const stats: PlanStats = {
    mkdirs: 0,
    uploadsNew: 0,
    uploadsChanged: 0,
    moves: 0,
    deletesFiles: 0,
    deletesFolders: 0,
    typeReplacements: 0,
    unchanged: 0,
    bytesToUpload: 0,
  };
  const skippedIdentical: string[] = [];

  const remoteByKey = indexRemote(remote);
  const localByKey = new Map<string, LocalEntry>();
  for (const e of local.entries.values()) localByKey.set(pathKey(e.relPath), e);

  // Remote paths that must never be deleted: anything at or below a local problem path, plus
  // their ancestors (a folder containing a protected item cannot be removed either).
  const protectedKeys = new Set<string>();
  const protectedPrefixes: string[] = [];
  for (const p of local.problems) {
    const k = pathKey(p.relPath);
    protectedPrefixes.push(k + '/');
    let cur = k;
    for (;;) {
      protectedKeys.add(cur);
      const i = cur.lastIndexOf('/');
      if (i < 0) break;
      cur = cur.slice(0, i);
    }
    issues.push({
      severity: 'error',
      code: `local.${p.kind}`,
      relPath: p.relPath,
      message: `${p.detail} — not mirrored; any OneDrive item at this path is left untouched`,
    });
  }
  const isProtected = (key: string): boolean => protectedKeys.has(key) || protectedPrefixes.some((pre) => key.startsWith(pre));

  // ---- Pass 1: local entries → mkdir / upload / replaceType / unchanged
  const localSorted = [...local.entries.values()].sort((a, b) => depthOf(a.relPath) - depthOf(b.relPath) || a.relPath.localeCompare(b.relPath));
  const localOnlyFiles: LocalEntry[] = [];
  const matchedRemoteIds = new Set<string>();
  // Remote folders replaced by a local file are deleted recursively; their children need no own deletion.
  const replacedFolderPrefixes: string[] = [];

  for (const e of localSorted) {
    const key = pathKey(e.relPath);
    const r = remoteByKey.get(key);
    if (!r) {
      if (e.kind === 'dir') {
        ops.push({ type: 'mkdir', relPath: e.relPath, reason: 'missing' });
        stats.mkdirs++;
      } else {
        localOnlyFiles.push(e);
      }
      continue;
    }
    matchedRemoteIds.add(r.id);
    if (e.name !== r.name) {
      issues.push({
        severity: 'warning',
        code: 'name.caseDiffers',
        relPath: e.relPath,
        message: `OneDrive item is named "${r.name}"; names differ only by case/normalization and are treated as the same item`,
      });
    }
    if (e.kind === 'dir') {
      if (r.kind === 'folder') continue; // folder exists
      ops.push({ type: 'replaceType', relPath: e.relPath, remote: r, localKind: 'dir' });
      stats.typeReplacements++;
      ops.push({ type: 'mkdir', relPath: e.relPath, reason: 'missing' });
      stats.mkdirs++;
      continue;
    }
    // local file
    if (r.kind === 'folder') {
      replacedFolderPrefixes.push(pathKey(e.relPath) + '/');
      ops.push({ type: 'replaceType', relPath: e.relPath, remote: r, localKind: 'file' });
      stats.typeReplacements++;
      ops.push({ type: 'upload', relPath: e.relPath, local: e, reason: 'new' });
      stats.uploadsNew++;
      stats.bytesToUpload += e.size;
      continue;
    }
    const verdict = compareFile(e, r, hashes.get(e.relPath));
    if (verdict === 'identical') {
      stats.unchanged++;
      skippedIdentical.push(e.relPath);
    } else {
      ops.push({ type: 'upload', relPath: e.relPath, local: e, reason: verdict === 'changed' ? 'changed' : 'unverifiable', remote: r });
      stats.uploadsChanged++;
      stats.bytesToUpload += e.size;
      if (verdict === 'unverifiable') {
        issues.push({ severity: 'warning', code: 'remote.noHash', relPath: e.relPath, message: 'OneDrive did not report a content hash; file re-uploaded to be safe' });
      }
    }
  }

  // ---- Pass 2: remote-only entries → delete (or move when content matches a local-only file)
  const remoteOnly: RemoteEntry[] = [];
  for (const r of remote.entries.values()) {
    if (matchedRemoteIds.has(r.id)) continue;
    const k = pathKey(r.relPath);
    if (replacedFolderPrefixes.some((pre) => k.startsWith(pre))) continue;
    remoteOnly.push(r);
  }

  // Rename/move detection: unique size+hash correspondence between a remote-only file and a local-only file.
  const movedRemoteIds = new Set<string>();
  const movedLocalPaths = new Set<string>();
  {
    const remoteBySig = new Map<string, RemoteEntry[]>();
    for (const r of remoteOnly) {
      if (r.kind !== 'file' || r.size === 0 || isProtected(pathKey(r.relPath))) continue;
      const sig = remoteSignature(r);
      if (!sig) continue;
      const arr = remoteBySig.get(sig) ?? [];
      arr.push(r);
      remoteBySig.set(sig, arr);
    }
    const localBySig = new Map<string, LocalEntry[]>();
    for (const e of localOnlyFiles) {
      const h = hashes.get(e.relPath);
      if (!h || e.size === 0) continue;
      // Index under both signatures so that either kind of remote hash can match.
      for (const sig of [`${e.size}|qx:${h.quickXorHash}`, `${e.size}|sha1:${h.sha1Hash.toUpperCase()}`]) {
        const arr = localBySig.get(sig) ?? [];
        arr.push(e);
        localBySig.set(sig, arr);
      }
    }
    for (const [sig, remotes] of remoteBySig) {
      const locals = localBySig.get(sig);
      if (!locals || remotes.length !== 1 || locals.length !== 1) continue;
      const r = remotes[0]!;
      const e = locals[0]!;
      if (movedRemoteIds.has(r.id) || movedLocalPaths.has(e.relPath)) continue;
      ops.push({ type: 'move', fromRelPath: r.relPath, toRelPath: e.relPath, remote: r, local: e });
      stats.moves++;
      movedRemoteIds.add(r.id);
      movedLocalPaths.add(e.relPath);
    }
  }

  for (const e of localOnlyFiles) {
    if (movedLocalPaths.has(e.relPath)) continue;
    ops.push({ type: 'upload', relPath: e.relPath, local: e, reason: 'new' });
    stats.uploadsNew++;
    stats.bytesToUpload += e.size;
  }

  const deleteFiles: PlanOp[] = [];
  const deleteFolders: PlanOp[] = [];
  for (const r of remoteOnly) {
    if (movedRemoteIds.has(r.id)) continue;
    const key = pathKey(r.relPath);
    if (isProtected(key)) {
      issues.push({ severity: 'warning', code: 'remote.protected', relPath: r.relPath, message: 'kept on OneDrive because a local item at this path could not be mirrored' });
      continue;
    }
    // Children of a remote-only folder are remote-only too; we delete files first, then folders bottom-up.
    if (r.kind === 'file') {
      deleteFiles.push({ type: 'deleteFile', relPath: r.relPath, remote: r });
      stats.deletesFiles++;
    } else {
      deleteFolders.push({ type: 'deleteFolder', relPath: r.relPath, remote: r });
      stats.deletesFolders++;
    }
  }
  deleteFiles.sort((a, b) => (a as { relPath: string }).relPath.localeCompare((b as { relPath: string }).relPath));
  deleteFolders.sort((a, b) => depthOf((b as { relPath: string }).relPath) - depthOf((a as { relPath: string }).relPath));

  // Final ordering: replaceType deletions → mkdirs (shallow first) → moves → uploads → deletes.
  const order: Record<PlanOp['type'], number> = { replaceType: 0, mkdir: 1, move: 2, upload: 3, deleteFile: 4, deleteFolder: 5 };
  const main = ops.filter((o) => o.type !== 'deleteFile' && o.type !== 'deleteFolder');
  main.sort((a, b) => {
    const d = order[a.type] - order[b.type];
    if (d !== 0) return d;
    if (a.type === 'mkdir' && b.type === 'mkdir') return depthOf(a.relPath) - depthOf(b.relPath) || a.relPath.localeCompare(b.relPath);
    const pa = 'relPath' in a ? a.relPath : a.toRelPath;
    const pb = 'relPath' in b ? b.relPath : b.toRelPath;
    return pa.localeCompare(pb);
  });

  return { plan: { ops: [...main, ...deleteFiles, ...deleteFolders], stats, skippedIdentical }, issues };
}

/** Content signature of a remote file for rename detection (size + the hash the destination provides). */
export function remoteSignature(r: RemoteEntry): string | undefined {
  if (r.quickXorHash) return `${r.size}|qx:${r.quickXorHash}`;
  if (r.sha1Hash) return `${r.size}|sha1:${r.sha1Hash.toUpperCase()}`;
  return undefined;
}

/**
 * Remote files whose hash the planner would need but the destination did not report. Backends that
 * can hash server-side (SFTP) fill these in before planning; others leave them (→ re-upload).
 */
export function remoteHashCandidates(local: LocalInventory, remote: RemoteInventory): RemoteEntry[] {
  const localByKey = new Map<string, LocalEntry>();
  for (const e of local.entries.values()) localByKey.set(pathKey(e.relPath), e);
  const remoteKeys = new Set<string>();
  for (const r of remote.entries.values()) remoteKeys.add(pathKey(r.relPath));
  const localOnlySizes = new Set<number>();
  for (const e of local.entries.values()) {
    if (e.kind === 'file' && e.size > 0 && !remoteKeys.has(pathKey(e.relPath))) localOnlySizes.add(e.size);
  }
  const out: RemoteEntry[] = [];
  for (const r of remote.entries.values()) {
    if (r.kind !== 'file' || r.size === 0 || r.quickXorHash || r.sha1Hash) continue;
    const l = localByKey.get(pathKey(r.relPath));
    if (l) {
      if (l.kind === 'file' && l.size === r.size) out.push(r);
    } else if (localOnlySizes.has(r.size)) {
      out.push(r);
    }
  }
  return out;
}

export type FileVerdict = 'identical' | 'changed' | 'unverifiable';

export function compareFile(local: LocalEntry, remote: RemoteEntry, localHashes: FileHashes | undefined): FileVerdict {
  if (local.size !== remote.size) return 'changed';
  if (local.size === 0) return 'identical';
  if (!localHashes) return 'unverifiable';
  if (remote.quickXorHash) return remote.quickXorHash === localHashes.quickXorHash ? 'identical' : 'changed';
  if (remote.sha1Hash) return remote.sha1Hash.toUpperCase() === localHashes.sha1Hash.toUpperCase() ? 'identical' : 'changed';
  return 'unverifiable';
}

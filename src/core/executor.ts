import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { DestinationBackend, RemoteRef, UploadReceipt } from './backend.js';
import { CancelledError, describeError, isAbortError } from './graph/errors.js';
import { type FileHashes, type HashCache, hashFile } from './hashing.js';
import { baseName, parentOf } from './names.js';
import { QuickXorHash } from './quickxorhash.js';
import type { EngineOptions, Issue, LocalEntry, LocalInventory, PairRunResult, PairSpec, Plan, PlanOp, Progress, ProgressListener, RemoteInventory } from './types.js';

export interface ExecutorContext {
  backend: DestinationBackend;
  pair: PairSpec;
  local: LocalInventory;
  remote: RemoteInventory;
  plan: Plan;
  hashes: Map<string, FileHashes>;
  hashCache: HashCache;
  options: EngineOptions;
  signal?: AbortSignal;
  onProgress?: ProgressListener;
  progressBase: Pick<Progress, 'pairIndex' | 'pairCount' | 'pairId' | 'pairLabel'>;
  /** Re-scan the source at the end to detect changes made during the run. */
  rescan: () => Promise<LocalInventory>;
  /** Issues collected before execution (planner / inventory). */
  initialIssues: Issue[];
  startedAt: number;
  log?: (m: string) => void;
}

type ItemPath = { relPath: string };

/**
 * Executes a plan for one pair against a destination backend.
 *
 * Order: type replacements → folder creation → moves → uploads → verification → deletions (only
 * when every copy succeeded and verified, and the run was not cancelled) → local re-scan.
 */
export async function executePlan(ctx: ExecutorContext): Promise<PairRunResult> {
  const { backend, pair, plan, options, signal } = ctx;
  const log = ctx.log ?? (() => {});
  const issues: Issue[] = [...ctx.initialIssues];
  const counters: PairRunResult['counters'] = {
    foldersCreated: 0,
    filesUploaded: 0,
    bytesUploaded: 0,
    moves: 0,
    filesDeleted: 0,
    foldersDeleted: 0,
    unchanged: plan.stats.unchanged,
    failed: 0,
  };
  let cancelled = false;
  let copyFailures = 0;
  let deletionsExecuted = false;

  // relPath ('' = destination) → folder ref
  const folderRefs = new Map<string, RemoteRef>([['', backend.rootRef()]]);
  for (const r of ctx.remote.entries.values()) if (r.kind === 'folder') folderRefs.set(r.relPath, r.id);
  // Paths whose remote counterpart failed to be removed/created: dependents must be skipped.
  const blockedPaths = new Set<string>();
  const isBlocked = (rel: string): boolean => {
    let cur = rel;
    for (;;) {
      if (blockedPaths.has(cur)) return true;
      if (cur === '') return false;
      cur = parentOf(cur);
    }
  };

  const totalItems = plan.ops.length;
  let itemsDone = 0;
  let bytesDone = 0;
  const bytesTotal = plan.stats.bytesToUpload;
  const emit = (phase: Progress['phase'], message?: string, currentPath?: string): void => {
    ctx.onProgress?.({ ...ctx.progressBase, phase, message, currentPath, itemsDone, itemsTotal: totalItems, bytesDone, bytesTotal });
  };
  const checkCancel = (): void => {
    if (signal?.aborted) throw new CancelledError();
  };
  const fail = (code: string, relPath: string | undefined, message: string): void => {
    counters.failed++;
    issues.push({ severity: 'error', code, relPath, message });
  };

  const extraDeletes: PlanOp[] = [];
  const receipts: Array<{ receipt: UploadReceipt; local: LocalEntry; expected: FileHashes; stat: { size: number; mtimeMs: number; ino: number } }> = [];

  try {
    // ---------------- Type replacements (remote file ↔ folder mismatch)
    for (const op of plan.ops) {
      if (op.type !== 'replaceType') continue;
      checkCancel();
      emit('creatingFolders', 'Replacing mismatched item', op.relPath);
      try {
        const r = await backend.deleteConflicting(op.remote, signal);
        if (r === 'preconditionFailed') {
          fail('remote.changed', op.relPath, 'destination item changed after inventory; not replaced (re-evaluated on the next Clone)');
          blockedPaths.add(op.relPath);
          copyFailures++;
        } else {
          folderRefs.delete(op.relPath);
          if (op.remote.kind === 'folder') counters.foldersDeleted++;
          else counters.filesDeleted++;
        }
      } catch (err) {
        if (isAbortError(err)) throw err;
        fail('remote.replaceFailed', op.relPath, describeError(err));
        blockedPaths.add(op.relPath);
        copyFailures++;
      }
      itemsDone++;
    }

    // ---------------- Folders (shallow first)
    for (const op of plan.ops) {
      if (op.type !== 'mkdir') continue;
      checkCancel();
      emit('creatingFolders', 'Creating folders', op.relPath);
      if (isBlocked(op.relPath)) {
        fail('skipped.parentFailed', op.relPath, 'skipped because a parent operation failed');
        copyFailures++;
        itemsDone++;
        continue;
      }
      const parentRef = folderRefs.get(parentOf(op.relPath));
      if (!parentRef) {
        fail('skipped.parentMissing', op.relPath, 'parent folder was not created');
        blockedPaths.add(op.relPath);
        copyFailures++;
        itemsDone++;
        continue;
      }
      try {
        const ref = await backend.mkdir(parentRef, baseName(op.relPath), op.relPath, signal);
        folderRefs.set(op.relPath, ref);
        counters.foldersCreated++;
      } catch (err) {
        if (isAbortError(err)) throw err;
        fail('remote.mkdirFailed', op.relPath, describeError(err));
        blockedPaths.add(op.relPath);
        copyFailures++;
      }
      itemsDone++;
    }

    // ---------------- Moves / renames
    for (const op of plan.ops) {
      if (op.type !== 'move') continue;
      checkCancel();
      emit('uploading', 'Moving renamed files', op.toRelPath);
      const parentRef = folderRefs.get(parentOf(op.toRelPath));
      let moved = false;
      if (parentRef && !isBlocked(op.toRelPath)) {
        try {
          await backend.move(op.remote, parentRef, baseName(op.toRelPath), op.toRelPath, signal);
          moved = true;
          counters.moves++;
          log(`moved ${op.fromRelPath} → ${op.toRelPath}`);
        } catch (err) {
          if (isAbortError(err)) throw err;
          log(`move failed for ${op.fromRelPath} → ${op.toRelPath}: ${describeError(err)}; falling back to upload + delete`);
        }
      }
      if (!moved) {
        plan.ops.push({ type: 'upload', relPath: op.toRelPath, local: op.local, reason: 'new' });
        extraDeletes.push({ type: 'deleteFile', relPath: op.fromRelPath, remote: op.remote });
      }
      itemsDone++;
    }

    // ---------------- Uploads (bounded concurrency)
    const uploads = plan.ops.filter((o): o is Extract<PlanOp, { type: 'upload' }> => o.type === 'upload');
    emit('uploading', 'Uploading files');
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(8, options.uploadConcurrency)) }, async () => {
      for (;;) {
        checkCancel();
        const op = uploads[next++];
        if (!op) return;
        if (isBlocked(op.relPath)) {
          fail('skipped.parentFailed', op.relPath, 'skipped because a parent operation failed');
          copyFailures++;
          itemsDone++;
          continue;
        }
        const parentRef = folderRefs.get(parentOf(op.relPath));
        if (!parentRef) {
          fail('skipped.parentMissing', op.relPath, 'parent folder was not created');
          copyFailures++;
          itemsDone++;
          continue;
        }
        emit('uploading', 'Uploading files', op.relPath);
        try {
          const done = await uploadOne(ctx, op.local, parentRef, (delta) => {
            bytesDone += delta;
            emit('uploading', 'Uploading files', op.relPath);
          });
          receipts.push(done);
          counters.filesUploaded++;
          counters.bytesUploaded += op.local.size;
        } catch (err) {
          if (isAbortError(err)) throw err;
          if (backend.isQuotaError(err)) {
            fail('remote.quotaExceeded', op.relPath, 'destination storage is full');
            copyFailures++;
            throw new QuotaExceeded();
          }
          fail('upload.failed', op.relPath, describeError(err));
          copyFailures++;
        }
        itemsDone++;
      }
    });
    try {
      await Promise.all(workers);
    } catch (err) {
      if (err instanceof QuotaExceeded) {
        issues.push({ severity: 'error', code: 'run.stoppedQuota', message: 'Run stopped: the destination storage is full. Deletions were not executed.' });
      } else {
        throw err;
      }
    }

    // ---------------- Verification of uploads
    if (receipts.length > 0) {
      checkCancel();
      emit('verifying', `Verifying ${receipts.length} uploaded file(s)`);
      const verified = await backend.verifyUploads(
        receipts.map((r) => r.receipt),
        signal,
        (d, t) => emit('verifying', `Verifying uploaded files (${d}/${t})`),
      );
      for (const r of receipts) {
        const v = verified.get(r.receipt.relPath);
        const abs = path.join(ctx.local.rootPath, ...r.local.relPath.split('/'));
        if (!v || v.size !== r.local.size) {
          fail('verify.sizeMismatch', r.local.relPath, `verification failed: destination reports ${v?.size ?? 'no'} bytes, local file has ${r.local.size}`);
          copyFailures++;
          counters.filesUploaded--;
          continue;
        }
        let compared = false;
        let mismatch = false;
        if (v.quickXorHash) {
          compared = true;
          mismatch = v.quickXorHash !== r.expected.quickXorHash;
        } else if (v.sha1Hash && r.expected.sha1Hash) {
          compared = true;
          mismatch = v.sha1Hash.toUpperCase() !== r.expected.sha1Hash.toUpperCase();
        }
        if (compared) {
          if (mismatch) {
            fail('verify.hashMismatch', r.local.relPath, 'verification failed: content hash at the destination differs from the local file');
            copyFailures++;
            counters.filesUploaded--;
            continue;
          }
          ctx.hashCache.set(abs, r.stat.size, r.stat.mtimeMs, r.stat.ino, r.expected);
        } else {
          issues.push({ severity: 'warning', code: 'verify.noHash', relPath: r.local.relPath, message: 'the destination did not provide a content hash after upload; verified by size only' });
        }
      }
    }

    // ---------------- Deletions (only when every copy succeeded)
    const deletes = [...plan.ops.filter((o) => o.type === 'deleteFile'), ...extraDeletes, ...plan.ops.filter((o) => o.type === 'deleteFolder')];
    if (deletes.length > 0) {
      if (copyFailures > 0) {
        issues.push({
          severity: 'warning',
          code: 'deletions.skipped',
          message: `${deletes.length} deletion(s) skipped because ${copyFailures} copy operation(s) failed; nothing was removed from the destination`,
        });
      } else {
        checkCancel();
        deletionsExecuted = true;
        for (const op of deletes) {
          checkCancel();
          const rel = (op as ItemPath).relPath;
          emit('deleting', 'Removing items no longer in the source', rel);
          try {
            if (op.type === 'deleteFile') {
              const r = await backend.deleteFile(op.remote, signal);
              if (r === 'preconditionFailed') fail('remote.changed', rel, 'destination file changed after inventory; not deleted (re-evaluated on the next Clone)');
              else if (r === 'deleted') counters.filesDeleted++;
            } else if (op.type === 'deleteFolder') {
              const r = await backend.deleteFolder(op.remote, signal);
              if (r === 'notEmpty') fail('remote.folderNotEmpty', rel, 'folder still contains items that appeared at the destination or could not be removed; not deleted');
              else if (r === 'preconditionFailed') fail('remote.changed', rel, 'destination folder changed after inventory; not deleted');
              else if (r === 'deleted') counters.foldersDeleted++;
            }
          } catch (err) {
            if (isAbortError(err)) throw err;
            fail('delete.failed', rel, describeError(err));
          }
          itemsDone++;
        }
      }
    }

    // ---------------- Detect local changes during the run
    emit('finalizing', 'Checking the source for changes made during the run');
    try {
      const after = await ctx.rescan();
      const changed = diffInventories(ctx.local, after);
      if (changed.length > 0) {
        issues.push({
          severity: 'error',
          code: 'local.changedDuringRun',
          message: `${changed.length} local item(s) changed while Mirror was running (e.g. ${changed.slice(0, 3).join(', ')}); the mirror is not guaranteed to be consistent. Run Clone again.`,
        });
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      issues.push({ severity: 'warning', code: 'local.rescanFailed', message: `could not re-check the source after the run: ${describeError(err)}` });
    }
  } catch (err) {
    if (isAbortError(err)) {
      cancelled = true;
      issues.push({ severity: 'warning', code: 'run.cancelled', message: 'Cancelled by the user. No deletions were executed after the cancellation.' });
    } else {
      fail('run.error', undefined, describeError(err));
    }
  }

  try {
    await backend.finalize?.(signal?.aborted ? undefined : signal);
  } catch (err) {
    issues.push({ severity: 'warning', code: 'remote.finalizeFailed', message: `could not save destination bookkeeping: ${describeError(err)}` });
  }

  issues.push(...(backend.drainWarnings?.() ?? []));

  const hasErrors = issues.some((i) => i.severity === 'error');
  const hasWarnings = issues.some((i) => i.severity === 'warning');
  const outcome: PairRunResult['outcome'] = cancelled ? 'cancelled' : hasErrors ? 'incomplete' : hasWarnings ? 'completedWithWarnings' : 'completed';
  return { pairId: pair.id, outcome, startedAt: ctx.startedAt, finishedAt: Date.now(), issues, counters, deletionsExecuted };
}

class QuotaExceeded extends Error {
  constructor() {
    super('quota exceeded');
    this.name = 'QuotaExceeded';
  }
}

/* -------------------------------------------------------------------- */

async function uploadOne(
  ctx: ExecutorContext,
  local: LocalEntry,
  parentRef: RemoteRef,
  onBytes: (delta: number) => void,
): Promise<{ receipt: UploadReceipt; local: LocalEntry; expected: FileHashes; stat: { size: number; mtimeMs: number; ino: number } }> {
  const { backend, options, signal } = ctx;
  const abs = path.join(ctx.local.rootPath, ...local.relPath.split('/'));

  // Detect pre-upload local changes (size/mtime) relative to the inventory.
  const st = await fs.stat(abs);
  if (st.size !== local.size || st.mtimeMs !== local.mtimeMs) {
    throw new Error('file changed after the inventory was taken; skipped this run');
  }

  // Expected content hashes: from the planner, the cache, or computed now (one streaming pass).
  let expected = ctx.hashes.get(local.relPath) ?? ctx.hashCache.get(abs, st.size, st.mtimeMs, st.ino);
  if (!expected) {
    if (local.size < options.largeFileThreshold) {
      const data = await fs.readFile(abs, { signal } as { signal?: AbortSignal });
      if (data.length !== local.size) throw new Error('file changed while reading');
      expected = { size: data.length, quickXorHash: QuickXorHash.ofBuffer(data), sha1Hash: createHash('sha1').update(data).digest('hex').toUpperCase() };
    } else {
      expected = await hashFile(abs, signal);
    }
  }

  let last = 0;
  const receipt = await backend.uploadFile(parentRef, local, abs, signal, (n) => {
    onBytes(n - last);
    last = n;
  });
  if (last < local.size) onBytes(local.size - last);
  return { receipt, local, expected, stat: { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino } };
}

/** Returns relPaths whose presence, type, size or mtime differ between two scans. */
export function diffInventories(before: LocalInventory, after: LocalInventory): string[] {
  const changed: string[] = [];
  for (const [rel, a] of before.entries) {
    const b = after.entries.get(rel);
    if (!b || b.kind !== a.kind || (a.kind === 'file' && (b.size !== a.size || b.mtimeMs !== a.mtimeMs))) changed.push(rel);
  }
  for (const rel of after.entries.keys()) if (!before.entries.has(rel)) changed.push(rel);
  return changed;
}

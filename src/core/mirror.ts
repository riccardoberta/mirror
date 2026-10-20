import * as path from 'node:path';
import { type DestinationBackend, DestinationError } from './backend.js';
import { executePlan } from './executor.js';
import { CancelledError, describeError, isAbortError } from './graph/errors.js';
import { type FileHashes, HashCache, hashFile } from './hashing.js';
import { PlanAbort, buildPlan, hashCandidates, remoteHashCandidates } from './planner.js';
import { ScanError, scanLocal, scanOptionsFrom } from './scanner.js';
import type { EngineOptions, Issue, PairRunResult, PairSpec, Progress, ProgressListener, RunResult } from './types.js';

export interface MirrorRunInput {
  pairs: PairSpec[];
  /** Creates the destination backend for a pair. Called once per pair; the backend is closed afterwards. */
  backendFor: (pair: PairSpec) => Promise<DestinationBackend>;
  /** Run-level check executed once before any pair (e.g. the signed-in account matches the configuration). */
  preflight?: (signal?: AbortSignal) => Promise<void>;
  options: EngineOptions;
  hashCache: HashCache;
  signal?: AbortSignal;
  onProgress?: ProgressListener;
  log?: (m: string) => void;
}

/**
 * Runs every pair sequentially. Each pair is independent: a failure in one never affects the
 * destination of another, and no destination change happens for a pair before its local and remote
 * inventories are complete and a plan has been built.
 */
export async function runMirror(input: MirrorRunInput): Promise<RunResult> {
  const startedAt = Date.now();
  const log = input.log ?? (() => {});
  const issues: Issue[] = [];
  const results: PairRunResult[] = [];
  const { signal } = input;

  const emitRun = (phase: Progress['phase'], message?: string): void =>
    input.onProgress?.({ phase, message, itemsDone: 0, itemsTotal: 0, bytesDone: 0, bytesTotal: 0, pairIndex: 0, pairCount: input.pairs.length });

  let cancelled = false;
  try {
    emitRun('preparing', 'Checking account');
    await input.preflight?.(signal);

    for (let i = 0; i < input.pairs.length; i++) {
      const pair = input.pairs[i]!;
      if (signal?.aborted) throw new CancelledError();
      const r = await runPair({ ...input, pair, pairIndex: i, log });
      results.push(r);
      if (r.outcome === 'cancelled') {
        cancelled = true;
        break;
      }
    }
  } catch (err) {
    if (isAbortError(err)) {
      cancelled = true;
    } else {
      issues.push({ severity: 'error', code: 'run.failed', message: describeError(err) });
    }
  }

  const finishedAt = Date.now();
  emitRun('done');
  const anyError = issues.some((i) => i.severity === 'error') || results.some((r) => r.outcome === 'incomplete' || r.outcome === 'aborted');
  const anyWarning = results.some((r) => r.outcome === 'completedWithWarnings');
  let outcome: RunResult['outcome'];
  if (cancelled) outcome = 'cancelled';
  else if (issues.some((i) => i.code === 'run.failed') && results.length === 0) outcome = 'failed';
  else if (anyError) outcome = 'incomplete';
  else if (anyWarning) outcome = 'completedWithWarnings';
  else outcome = 'completed';
  return { startedAt, finishedAt, outcome, pairs: results, issues };
}

interface PairRunInput extends MirrorRunInput {
  pair: PairSpec;
  pairIndex: number;
  log: (m: string) => void;
}

async function runPair(input: PairRunInput): Promise<PairRunResult> {
  const { pair, options, signal, hashCache, log } = input;
  const startedAt = Date.now();
  const base = { pairIndex: input.pairIndex, pairCount: input.pairs.length, pairId: pair.id, pairLabel: pair.label };
  const emit = (phase: Progress['phase'], message?: string, currentPath?: string): void =>
    input.onProgress?.({ ...base, phase, message, currentPath, itemsDone: 0, itemsTotal: 0, bytesDone: 0, bytesTotal: 0 });
  const abort = (code: string, message: string, outcome: PairRunResult['outcome'] = 'aborted'): PairRunResult => ({
    pairId: pair.id,
    outcome,
    startedAt,
    finishedAt: Date.now(),
    issues: [{ severity: 'error', code, message }],
    counters: { foldersCreated: 0, filesUploaded: 0, bytesUploaded: 0, moves: 0, filesDeleted: 0, foldersDeleted: 0, unchanged: 0, failed: 0 },
    deletionsExecuted: false,
  });

  let backend: DestinationBackend | undefined;
  try {
    emit('preparing', 'Connecting to the destination');
    backend = await input.backendFor(pair);

    // ---- 1. Destination identity.
    emit('preparing', 'Verifying destination');
    let info;
    try {
      info = await backend.verifyDestination(signal);
    } catch (err) {
      if (err instanceof DestinationError) return abort(err.code, err.message);
      throw err;
    }

    // ---- 2. Local inventory (strict).
    emit('scanningLocal', 'Scanning local folder');
    const scanOpts = scanOptionsFrom({ ...options, maxPathLength: info.maxPathLength }, info.destinationPrefixLength, signal);
    scanOpts.onProgress = (files, dirs) => emit('scanningLocal', `Scanning local folder (${files} files, ${dirs} folders)`);
    let local;
    try {
      local = await scanLocal(pair.sourcePath, scanOpts);
    } catch (err) {
      if (err instanceof ScanError) {
        if (err.code === 'cancelled') throw new CancelledError();
        return abort(`source.${err.code}`, `${err.message}. The pair was skipped and nothing was deleted at the destination.`);
      }
      throw err;
    }

    // ---- 3. Remote inventory (complete).
    emit('listingRemote', 'Listing destination');
    const remote = await backend.list(signal, (folders, items) => emit('listingRemote', `Listing destination (${folders} folders, ${items} items)`));

    // ---- 3b. Remote hashes the planner needs, when the backend can compute them server-side.
    if (backend.fillRemoteHashes) {
      const need = remoteHashCandidates(local, remote);
      if (need.length > 0) {
        emit('hashing', `Hashing ${need.length} file(s) at the destination`);
        await backend.fillRemoteHashes(need, signal, (d, t) => emit('hashing', `Hashing files at the destination (${d}/${t})`));
      }
    }

    // ---- 4. Local hashes needed by the plan (cached by size+mtime+inode).
    const candidates = hashCandidates(local, remote);
    const hashes = new Map<string, FileHashes>();
    let n = 0;
    for (const rel of candidates) {
      if (signal?.aborted) throw new CancelledError();
      const entry = local.entries.get(rel)!;
      const abs = path.join(pair.sourcePath, ...rel.split('/'));
      let h = hashCache.get(abs, entry.size, entry.mtimeMs, entry.ino);
      if (!h) {
        emit('hashing', `Comparing file contents (${n + 1}/${candidates.length})`, rel);
        try {
          h = await hashFile(abs, signal);
          if (h.size === entry.size) hashCache.set(abs, entry.size, entry.mtimeMs, entry.ino, h);
        } catch (err) {
          if (isAbortError(err)) throw new CancelledError();
          // Unreadable file: treat as a local problem so that its remote copy is protected.
          local.problems.push({ kind: 'unreadable', relPath: rel, detail: `cannot read file: ${describeError(err)}` });
          local.entries.delete(rel);
          continue;
        }
      }
      hashes.set(rel, h);
      n++;
    }

    // ---- 5. Plan.
    emit('planning', 'Building the operation plan');
    let planned;
    try {
      planned = buildPlan({ local, remote, hashes, allowEmptySourceToWipeDestination: options.allowEmptySourceToWipeDestination });
    } catch (err) {
      if (err instanceof PlanAbort) return abort(`plan.${err.code}`, err.message);
      throw err;
    }
    const s = planned.plan.stats;
    log(
      `[${pair.label} → ${backend.label}] plan: ${s.mkdirs} folders, ${s.uploadsNew} new, ${s.uploadsChanged} changed, ${s.moves} moves, ` +
        `${s.deletesFiles}+${s.deletesFolders} deletions, ${s.typeReplacements} type replacements, ${s.unchanged} unchanged`,
    );

    // ---- 6. Execute.
    return await executePlan({
      backend,
      pair,
      local,
      remote,
      plan: planned.plan,
      hashes,
      hashCache,
      options,
      signal,
      onProgress: input.onProgress,
      progressBase: base,
      rescan: () => scanLocal(pair.sourcePath, scanOptionsFrom({ ...options, maxPathLength: info.maxPathLength }, info.destinationPrefixLength, signal)),
      initialIssues: planned.issues,
      startedAt,
      log,
    });
  } catch (err) {
    if (isAbortError(err)) return abort('run.cancelled', 'Cancelled by the user before any change to this destination.', 'cancelled');
    return abort('pair.failed', `${describeError(err)}. Nothing was deleted at the destination for this pair.`);
  } finally {
    await backend?.close().catch(() => {});
  }
}

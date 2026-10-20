import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { DestinationBackend } from '../core/backend.js';
import { OneDriveBackend } from '../core/backends/onedrive.js';
import { SftpBackend } from '../core/backends/sftp.js';
import type { GraphClient } from '../core/graph/client.js';
import { HashCache, type HashCacheEntry } from '../core/hashing.js';
import { runMirror } from '../core/mirror.js';
import { DEFAULT_ENGINE_OPTIONS, type EngineOptions, type PairRunResult, type PairSpec, type Progress, type RunResult } from '../core/types.js';
import { type PersistedConfig, sftpReady } from './config.js';
import { connectionSettings } from './sftpSetup.js';
import type { Logger } from './log.js';
import type { RunSummary } from '../shared/ipc.js';

export interface RunDeps {
  client: GraphClient;
  config: PersistedConfig;
  hashCacheFile: string;
  log: Logger;
  onProgress: (p: Progress) => void;
}

/**
 * Owns the single in-flight Clone run. A run starts only from `start()`, which is called
 * exclusively by the renderer's Clone button through IPC — never on launch, timers or file events.
 */
export class RunController {
  private controller: AbortController | undefined;
  private current: Promise<RunSummary> | undefined;

  get running(): boolean {
    return this.current !== undefined;
  }

  async start(deps: RunDeps): Promise<RunSummary> {
    if (this.current) throw new Error('A Clone is already running.');
    const controller = new AbortController();
    this.controller = controller;
    this.current = this.execute(deps, controller.signal).finally(() => {
      this.current = undefined;
      this.controller = undefined;
    });
    return this.current;
  }

  cancel(): void {
    this.controller?.abort();
  }

  private async execute(deps: RunDeps, signal: AbortSignal): Promise<RunSummary> {
    const { client, config, log } = deps;
    const pairs = config.pairs.filter((p) => p.enabled);
    if (pairs.length === 0) throw new Error('No enabled folder pairs.');
    const usesOneDrive = pairs.some((p) => p.target === 'onedrive');
    const usesSftp = pairs.some((p) => p.target === 'sftp');
    if (usesOneDrive && (!config.account || !config.root)) throw new Error('Connect OneDrive and choose a root folder first.');
    if (usesSftp && !sftpReady(config)) throw new Error('Set up the remote disk first (Settings → Remote disk → Test connection and Set up root).');

    const specs: PairSpec[] = pairs.map((p) => ({
      id: p.id,
      label: path.basename(p.sourcePath) || p.sourcePath,
      sourcePath: p.sourcePath,
      destinationName: p.destinationName,
      target:
        p.target === 'onedrive'
          ? { kind: 'onedrive', driveId: config.root!.driveId, destinationId: p.destinationId, rootId: config.root!.id }
          : { kind: 'sftp', destinationName: p.destinationName },
    }));
    const sftpConn = usesSftp ? await connectionSettings(config.sftp!) : undefined;
    const options: EngineOptions = {
      ...DEFAULT_ENGINE_OPTIONS,
      excludeNames: config.settings.excludeNames,
      excludePrefixes: config.settings.excludePrefixes,
      allowEmptySourceToWipeDestination: config.settings.allowEmptySourceToWipeDestination,
      uploadConcurrency: config.settings.uploadConcurrency,
    };

    const hashCache = await loadHashCache(deps.hashCacheFile, log);
    log.info(`Clone started: ${specs.length} pair(s)${usesOneDrive ? `, OneDrive ${config.account!.username} root "${config.root!.name}"` : ''}${usesSftp ? `, remote disk ${config.sftp!.host}:${config.sftp!.rootPath}` : ''}`);
    let lastEmit = 0;
    const expectedUserId = config.account?.userId;
    const result: RunResult = await runMirror({
      pairs: specs,
      backendFor: async (pair): Promise<DestinationBackend> => {
        if (pair.target.kind === 'onedrive') return new OneDriveBackend(client, { ...pair.target, destinationName: pair.destinationName }, options);
        const s = config.sftp!;
        return new SftpBackend({ connection: sftpConn!, rootPath: s.rootPath, rootId: s.rootId!, destinationName: pair.destinationName, hashCommand: s.hashCommand });
      },
      preflight: usesOneDrive
        ? async (sig) => {
            const me = await client.getMe(sig);
            if (me.id !== expectedUserId) {
              throw new Error(`The signed-in Microsoft account (${me.userPrincipalName ?? me.id}) is not the account Mirror was configured with. Reconnect OneDrive or reconfigure the destinations.`);
            }
          }
        : undefined,
      options,
      hashCache,
      signal,
      log: (m) => log.info(m),
      onProgress: (p) => {
        const now = Date.now();
        if (p.phase === 'done' || now - lastEmit > 80) {
          lastEmit = now;
          deps.onProgress(p);
        }
      },
    });
    await saveHashCache(deps.hashCacheFile, hashCache, specs, log);

    const summary = summarize(result, specs);
    log.info(`Clone finished: ${summary.outcome} — ${summary.summary}`);
    for (const issue of summary.issues) log[issue.severity === 'error' ? 'error' : 'warn'](`[${issue.pairLabel ?? 'run'}] ${issue.code}${issue.relPath ? ` ${issue.relPath}` : ''}: ${issue.message}`);
    return summary;
  }
}

export function summarize(result: RunResult, specs: PairSpec[]): RunSummary {
  const labels = new Map(specs.map((s) => [s.id, s.label]));
  const issues: RunSummary['issues'] = result.issues.map((i) => ({ ...i }));
  const pairs: RunSummary['pairs'] = [];
  let up = 0;
  let del = 0;
  let unchanged = 0;
  for (const p of result.pairs) {
    const label = labels.get(p.pairId) ?? p.pairId;
    for (const i of p.issues) issues.push({ ...i, pairId: p.pairId, pairLabel: label });
    up += p.counters.filesUploaded;
    del += p.counters.filesDeleted + p.counters.foldersDeleted;
    unchanged += p.counters.unchanged;
    pairs.push({ pairId: p.pairId, label, outcome: p.outcome, summary: pairSummary(p) });
  }
  const errors = issues.filter((i) => i.severity === 'error').length;
  const parts = [`${up} uploaded`, `${del} removed`, `${unchanged} unchanged`];
  if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  return { startedAt: result.startedAt, finishedAt: result.finishedAt, outcome: result.outcome, summary: parts.join(' · '), issues, pairs };
}

export function pairSummary(p: PairRunResult): string {
  const c = p.counters;
  const bits: string[] = [];
  if (c.filesUploaded) bits.push(`${c.filesUploaded} uploaded`);
  if (c.moves) bits.push(`${c.moves} moved`);
  if (c.foldersCreated) bits.push(`${c.foldersCreated} folders created`);
  if (c.filesDeleted + c.foldersDeleted) bits.push(`${c.filesDeleted + c.foldersDeleted} removed`);
  if (c.unchanged) bits.push(`${c.unchanged} unchanged`);
  if (c.failed) bits.push(`${c.failed} failed`);
  if (p.outcome === 'aborted') return p.issues[0]?.message ?? 'aborted';
  if (p.outcome === 'cancelled') return 'cancelled';
  return bits.join(' · ') || 'nothing to do';
}

async function loadHashCache(file: string, log: Logger): Promise<HashCache> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return new HashCache(JSON.parse(raw) as Record<string, HashCacheEntry>);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`hash cache unreadable, starting empty: ${(err as Error).message}`);
    return new HashCache();
  }
}

async function saveHashCache(file: string, cache: HashCache, specs: PairSpec[], log: Logger): Promise<void> {
  try {
    const data = cache.toJSON();
    // Keep only entries under configured sources.
    const roots = specs.map((s) => s.sourcePath.replace(/[\\/]+$/, '') + path.sep);
    for (const k of Object.keys(data)) if (!roots.some((r) => k.startsWith(r))) delete data[k];
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, JSON.stringify(data), 'utf8');
    await fs.rename(`${file}.tmp`, file);
  } catch (err) {
    log.warn(`could not save hash cache: ${(err as Error).message}`);
  }
}

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OneDriveBackend } from '../src/core/backends/onedrive.js';
import { GraphClient } from '../src/core/graph/client.js';
import { HashCache } from '../src/core/hashing.js';
import { runMirror } from '../src/core/mirror.js';
import { DEFAULT_ENGINE_OPTIONS, type EngineOptions, type PairSpec, type RunResult } from '../src/core/types.js';
import { FakeGraph, type FakeGraphOptions } from './fakeGraph.js';

export type Tree = Record<string, string | null>; // relPath → content, or null for an empty folder

export async function makeTempDir(tree: Tree = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirror-test-'));
  await writeTree(dir, tree);
  return dir;
}

export async function writeTree(dir: string, tree: Tree): Promise<void> {
  for (const [rel, content] of Object.entries(tree)) {
    const abs = path.join(dir, ...rel.split('/'));
    if (content === null) {
      await fs.mkdir(abs, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    }
  }
}

export interface Harness {
  fake: FakeGraph;
  client: GraphClient;
  sleeps: number[];
  logs: string[];
  rootId: string;
  hashCache: HashCache;
  options: EngineOptions;
  pair: (sourcePath: string, destName?: string) => Promise<PairSpec>;
  run: (pairs: PairSpec[], extra?: { signal?: AbortSignal; expectedUserId?: string; options?: Partial<EngineOptions> }) => Promise<RunResult>;
}

export function makeHarness(fakeOpts: FakeGraphOptions = {}, optionOverrides: Partial<EngineOptions> = {}): Harness {
  const fake = new FakeGraph(fakeOpts);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const client = new GraphClient({
    tokenProvider: { getAccessToken: async () => 'good-token' },
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (m) => logs.push(m),
    maxAttempts: 4,
  });
  const root = fake.mkdir(fake.rootId, 'Mirror');
  const hashCache = new HashCache();
  const options: EngineOptions = { ...DEFAULT_ENGINE_OPTIONS, uploadConcurrency: 2, ...optionOverrides };
  let n = 0;
  return {
    fake,
    client,
    sleeps,
    logs,
    rootId: root.id,
    hashCache,
    options,
    pair: async (sourcePath, destName) => {
      const name = destName ?? path.basename(sourcePath);
      const dest = fake.childByName(root.id, name) ?? fake.mkdir(root.id, name);
      return { id: `pair-${++n}`, label: name, sourcePath, destinationName: name, target: { kind: 'onedrive', driveId: fake.driveId, destinationId: dest.id, rootId: root.id } };
    },
    run: (pairs, extra = {}) => {
      const opts = { ...options, ...(extra.options ?? {}) };
      return runMirror({
        pairs,
        backendFor: async (pair) => {
          if (pair.target.kind !== 'onedrive') throw new Error('test harness: onedrive pairs only');
          return new OneDriveBackend(client, { ...pair.target, destinationName: pair.destinationName }, opts);
        },
        preflight: extra.expectedUserId
          ? async (signal) => {
              const me = await client.getMe(signal);
              if (me.id !== extra.expectedUserId) throw new Error(`The signed-in Microsoft account (${me.userPrincipalName ?? me.id}) is not the account Mirror was configured with.`);
            }
          : undefined,
        options: opts,
        hashCache,
        signal: extra.signal,
        log: (m) => logs.push(m),
      });
    },
  };
}

export function requestsMatching(fake: FakeGraph, method: string, pattern: RegExp): number {
  return fake.requests.filter((r) => r.method === method && pattern.test(r.url)).length;
}

export function treeOf(fake: FakeGraph, folderId: string): Record<string, string | null> {
  return Object.fromEntries(fake.tree(folderId));
}

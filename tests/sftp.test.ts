/**
 * SFTP backend tests against the in-process ssh2 server (tests/sftpServer.ts) — SIMULATED remote
 * machine over the real SFTP protocol. See docs/TESTING.md for the real-machine checklist.
 */
import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SftpBackend, type SftpTarget, writeMarker } from '../src/core/backends/sftp.js';
import { SftpConnection, toNativePath, toSftpPath } from '../src/core/backends/sftpConnection.js';
import { HashCache } from '../src/core/hashing.js';
import { runMirror } from '../src/core/mirror.js';
import { DEFAULT_ENGINE_OPTIONS, type EngineOptions, type PairSpec, type RunResult } from '../src/core/types.js';
import { makeTempDir } from './helpers.js';
import { SftpTestServer } from './sftpServer.js';

const ROOT = 'D:\\Backup\\Mirror';
const ROOT_SFTP = toSftpPath(ROOT); // "/D:/Backup/Mirror"

let server: SftpTestServer;
let rootId: string;

function target(server: SftpTestServer, destinationName: string, overrides: Partial<SftpTarget> = {}): SftpTarget {
  return {
    connection: { host: '127.0.0.1', port: server.port, username: 'tester', privateKey: server.clientPrivateKey, hostKeyFingerprint: server.hostKeyFingerprint },
    rootPath: ROOT,
    rootId,
    destinationName,
    hashCommand: 'powershell',
    ...overrides,
  };
}

async function setupRoot(s: SftpTestServer): Promise<string> {
  const c = await SftpConnection.connect({ host: '127.0.0.1', port: s.port, username: 'tester', privateKey: s.clientPrivateKey });
  await c.mkdirp(ROOT_SFTP);
  const marker = await writeMarker(c, ROOT_SFTP);
  await c.close();
  return marker.mirrorRootId;
}

async function pairFor(sourcePath: string, name: string): Promise<PairSpec> {
  await fs.mkdir(server.local(`${ROOT_SFTP}/${name}`), { recursive: true });
  return { id: `p-${name}`, label: name, sourcePath, destinationName: name, target: { kind: 'sftp', destinationName: name } };
}

const hashCache = new HashCache();
function run(pairs: PairSpec[], opts: Partial<EngineOptions> = {}, targetOverrides: Partial<SftpTarget> = {}, signal?: AbortSignal): Promise<RunResult> {
  const options = { ...DEFAULT_ENGINE_OPTIONS, uploadConcurrency: 2, ...opts };
  return runMirror({
    pairs,
    backendFor: async (pair) => new SftpBackend(target(server, pair.destinationName, targetOverrides)),
    options,
    hashCache,
    signal,
  });
}

const dest = (name: string) => `${ROOT_SFTP}/${name}`;
const writes = () => server.ops.filter((o) => o.op === 'OPEN' && o.detail !== 'r' && !/\.mirror-(manifest|destination)\.json/.test(o.path)).length;

beforeEach(async () => {
  server = await SftpTestServer.start();
  rootId = await setupRoot(server);
  // Sentinels outside the destination: a file in the root and a sibling folder.
  await fs.writeFile(server.local(`${ROOT_SFTP}/OUTSIDE.txt`), 'outside');
  await fs.mkdir(server.local(`${ROOT_SFTP}/OtherPair`));
  await fs.writeFile(server.local(`${ROOT_SFTP}/OtherPair/keep.txt`), 'keep');
  await fs.writeFile(server.local('/D:/Backup/elsewhere.txt'), 'elsewhere');
});
afterEach(async () => {
  await server.stop();
});

function sentinelsIntact(): void {
  expect(server.tree(ROOT_SFTP)['OUTSIDE.txt']).toBe('outside');
  expect(server.tree(ROOT_SFTP)['OtherPair/keep.txt']).toBe('keep');
  expect(server.tree('/D:/Backup')['elsewhere.txt']).toBe('elsewhere');
}

describe('path helpers', () => {
  it('converts Windows and POSIX roots', () => {
    expect(toSftpPath('D:\\Backup\\Mirror')).toBe('/D:/Backup/Mirror');
    expect(toSftpPath('D:/Backup/')).toBe('/D:/Backup');
    expect(toSftpPath('/mnt/backup/')).toBe('/mnt/backup');
    expect(toNativePath('/D:/Backup/Mirror/a b/c.txt')).toBe('D:\\Backup\\Mirror\\a b\\c.txt');
    expect(toNativePath('/mnt/backup/x')).toBe('/mnt/backup/x');
    expect(() => toSftpPath('relative/path')).toThrow();
  });
});

describe('SFTP mirror (simulated Windows OpenSSH)', () => {
  it('first copy: folders (incl. empty), files, large file, manifest, mtimes; sentinels untouched', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 11, 7);
    const src = await makeTempDir({ 'a.txt': 'A', 'docs/b.txt': 'BB', 'docs/deep/c.txt': 'CCC', empty: null });
    await fs.writeFile(path.join(src, 'big.bin'), big);
    const pair = await pairFor(src, 'Docs');
    const res = await run([pair]);
    expect(res.outcome, JSON.stringify(res.pairs[0]?.issues)).toBe('completed');
    expect(res.pairs[0]?.counters).toMatchObject({ foldersCreated: 3, filesUploaded: 4, filesDeleted: 0 });
    expect(server.tree(dest('Docs'))).toMatchObject({ 'a.txt': 'A', docs: null, 'docs/b.txt': 'BB', 'docs/deep': null, 'docs/deep/c.txt': 'CCC', empty: null });
    expect((await fs.readFile(server.local(`${dest('Docs')}/big.bin`))).equals(big)).toBe(true);
    // mtime preserved (second precision)
    const localM = Math.floor((await fs.stat(path.join(src, 'a.txt'))).mtimeMs / 1000);
    const remoteM = Math.floor((await fs.stat(server.local(`${dest('Docs')}/a.txt`))).mtimeMs / 1000);
    expect(remoteM).toBe(localM);
    const manifest = JSON.parse(await fs.readFile(server.local(`${dest('Docs')}/.mirror-manifest.json`), 'utf8'));
    expect(Object.keys(manifest.files).sort()).toEqual(['a.txt', 'big.bin', 'docs/b.txt', 'docs/deep/c.txt']);
    expect(manifest.files['a.txt'].sha1).toMatch(/^[0-9A-F]{40}$/);
    // no leftover part files
    expect(Object.keys(server.tree(dest('Docs'))).some((k) => k.endsWith('.mirror-part'))).toBe(false);
    sentinelsIntact();
  });

  it('second run: nothing uploaded, no remote hashing needed thanks to the manifest', async () => {
    const src = await makeTempDir({ 'a.txt': 'A', 'docs/b.txt': 'BB', empty: null });
    const pair = await pairFor(src, 'Docs');
    await run([pair]);
    server.ops.length = 0;
    const res = await run([pair]);
    expect(res.outcome).toBe('completed');
    expect(res.pairs[0]?.counters).toMatchObject({ filesUploaded: 0, filesDeleted: 0, foldersDeleted: 0, unchanged: 2 });
    expect(writes()).toBe(0);
    expect(server.ops.filter((o) => o.op === 'EXEC').length).toBe(0);
  });

  it('update: same-size change detected via hash, re-uploaded atomically', async () => {
    const src = await makeTempDir({ 'same.txt': 'hello', 'changed.txt': 'hello' });
    const pair = await pairFor(src, 'Docs');
    await run([pair]);
    await fs.writeFile(path.join(src, 'changed.txt'), 'hellp');
    server.ops.length = 0;
    const res = await run([pair]);
    expect(res.outcome).toBe('completed');
    expect(res.pairs[0]?.counters.filesUploaded).toBe(1);
    expect(server.tree(dest('Docs'))).toEqual({ 'same.txt': 'hello', 'changed.txt': 'hellp' });
    // uploaded through a .mirror-part then renamed over the target (unlink + rename on servers without posix-rename)
    expect(server.ops.some((o) => o.op === 'RENAME' && o.path.endsWith('changed.txt.mirror-part'))).toBe(true);
  });

  it('delete: files then folders bottom-up; nothing outside the destination', async () => {
    const src = await makeTempDir({ 'keep.txt': 'k', 'old.txt': 'o', 'dir/sub/x.txt': 'x', 'dir/y.txt': 'y', emptydir: null });
    const pair = await pairFor(src, 'Docs');
    await run([pair]);
    await fs.rm(path.join(src, 'old.txt'));
    await fs.rm(path.join(src, 'dir'), { recursive: true });
    await fs.rmdir(path.join(src, 'emptydir'));
    const res = await run([pair]);
    expect(res.outcome).toBe('completed');
    expect(res.pairs[0]?.counters).toMatchObject({ filesDeleted: 3, foldersDeleted: 3 });
    expect(server.tree(dest('Docs'))).toEqual({ 'keep.txt': 'k' });
    sentinelsIntact();
  });

  it('rename/move uses RENAME without re-uploading', async () => {
    const src = await makeTempDir({ 'report.pdf': 'PDF-UNIQUE-CONTENT', 'notes.txt': 'n' });
    const pair = await pairFor(src, 'Docs');
    await run([pair]);
    await fs.mkdir(path.join(src, 'archive/2023'), { recursive: true });
    await fs.rename(path.join(src, 'report.pdf'), path.join(src, 'archive/2023/final.pdf'));
    server.ops.length = 0;
    const res = await run([pair]);
    expect(res.outcome).toBe('completed');
    expect(res.pairs[0]?.counters).toMatchObject({ moves: 1, filesUploaded: 0, filesDeleted: 0, foldersCreated: 2 });
    expect(writes()).toBe(0);
    expect(server.tree(dest('Docs'))).toEqual({ archive: null, 'archive/2023': null, 'archive/2023/final.pdf': 'PDF-UNIQUE-CONTENT', 'notes.txt': 'n' });
  });

  it('adopts an existing identical backup without manifest by hashing remotely (no re-upload)', async () => {
    const src = await makeTempDir({ 'a.txt': 'alpha', 'b.txt': 'beta!' });
    const pair = await pairFor(src, 'Docs');
    await fs.writeFile(server.local(`${dest('Docs')}/a.txt`), 'alpha');
    await fs.writeFile(server.local(`${dest('Docs')}/b.txt`), 'BETA!'); // same size, different content
    const res = await run([pair]);
    expect(res.outcome).toBe('completed');
    expect(res.pairs[0]?.counters).toMatchObject({ filesUploaded: 1, unchanged: 1 });
    expect(server.ops.filter((o) => o.op === 'EXEC').length).toBeGreaterThan(0);
    expect(server.tree(dest('Docs'))).toEqual({ 'a.txt': 'alpha', 'b.txt': 'beta!' });
  });

  it('remote edits are reverted and remote extras removed (Mac authoritative)', async () => {
    const src = await makeTempDir({ 'a.txt': 'local' });
    const pair = await pairFor(src, 'Docs');
    await run([pair]);
    await fs.writeFile(server.local(`${dest('Docs')}/a.txt`), 'edited remotely');
    await fs.writeFile(server.local(`${dest('Docs')}/extra.txt`), 'extra');
    const res = await run([pair]);
    expect(res.outcome).toBe('completed');
    expect(server.tree(dest('Docs'))).toEqual({ 'a.txt': 'local' });
  });
});

describe('SFTP safety boundaries', () => {
  it('missing marker (disk not mounted / wrong folder) aborts without changes', async () => {
    const src = await makeTempDir({ 'a.txt': 'A' });
    const pair = await pairFor(src, 'Docs');
    await run([pair]);
    await fs.rm(server.local(`${ROOT_SFTP}/.mirror-destination.json`));
    await fs.rm(path.join(src, 'a.txt'));
    const res = await run([pair]);
    expect(res.pairs[0]?.outcome).toBe('aborted');
    expect(res.pairs[0]?.issues[0]?.code).toBe('destination.markerMissing');
    expect(server.tree(dest('Docs'))).toEqual({ 'a.txt': 'A' });
  });

  it('marker with a different id aborts', async () => {
    const src = await makeTempDir({ 'a.txt': 'A' });
    const pair = await pairFor(src, 'Docs');
    const res = await run([pair], {}, { rootId: 'another-root-id' });
    expect(res.pairs[0]?.outcome).toBe('aborted');
    expect(res.pairs[0]?.issues[0]?.code).toBe('destination.markerMismatch');
    expect(server.tree(dest('Docs'))).toEqual({});
  });

  it('missing root folder (disk unplugged) aborts', async () => {
    const src = await makeTempDir({ 'a.txt': 'A' });
    const pair = await pairFor(src, 'Docs');
    await fs.rename(server.local(ROOT_SFTP), server.local('/D:/Backup/Mirror-unplugged'));
    const res = await run([pair]);
    expect(res.pairs[0]?.outcome).toBe('aborted');
    expect(res.pairs[0]?.issues[0]?.code).toBe('destination.rootMissing');
  });

  it('destination folder removed on the remote machine aborts the pair', async () => {
    const src = await makeTempDir({ 'a.txt': 'A' });
    const pair = await pairFor(src, 'Docs');
    await fs.rmdir(server.local(dest('Docs')));
    const res = await run([pair]);
    expect(res.pairs[0]?.outcome).toBe('aborted');
    expect(res.pairs[0]?.issues[0]?.code).toBe('destination.missing');
  });

  it('a remote file modified after the inventory is not deleted (size+mtime precondition)', async () => {
    const src = await makeTempDir({ 'a.txt': 'A', 'gone.txt': 'g' });
    const pair = await pairFor(src, 'Docs');
    await run([pair]);
    await fs.rm(path.join(src, 'gone.txt'));
    const remoteGone = server.local(`${dest('Docs')}/gone.txt`);
    server.onOp = (op, p) => {
      if (op === 'STAT' && p.endsWith('gone.txt') && server.ops.filter((o) => o.op === 'OPENDIR').length > 0) {
        // Edited remotely right before Mirror checks and deletes it.
        fsSync.writeFileSync(remoteGone, 'edited on the remote machine');
        const t = new Date(Date.now() - 3600_000);
        fsSync.utimesSync(remoteGone, t, t);
        server.onOp = undefined;
      }
    };
    const res = await run([pair]);
    expect(res.outcome).toBe('incomplete');
    expect(res.pairs[0]?.issues.some((i) => i.code === 'remote.changed')).toBe(true);
    expect((await fs.readFile(remoteGone)).toString()).toBe('edited on the remote machine');
  });

  it('a folder that received new remote content is not deleted', async () => {
    const src = await makeTempDir({ 'keep.txt': 'k', 'dir/x.txt': 'x' });
    const pair = await pairFor(src, 'Docs');
    await run([pair]);
    await fs.rm(path.join(src, 'dir'), { recursive: true });
    server.onOp = (op, p) => {
      if (op === 'REMOVE' && p.endsWith('dir/x.txt')) {
        fsSync.writeFileSync(server.local(`${dest('Docs')}/dir/added.txt`), 'web');
      }
    };
    const res = await run([pair]);
    expect(res.pairs[0]?.issues.some((i) => i.code === 'remote.folderNotEmpty')).toBe(true);
    expect(server.tree(dest('Docs'))).toEqual({ 'keep.txt': 'k', dir: null, 'dir/added.txt': 'web' });
  });

  it('interrupted upload leaves a .mirror-part file; the next run resumes from it and verifies the hash', async () => {
    const big = Buffer.alloc(4 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 13) & 0xff;
    const src = await makeTempDir({ 'small.txt': 's' });
    await fs.writeFile(path.join(src, 'big.bin'), big);
    const pair = await pairFor(src, 'Docs');
    let writesSeen = 0;
    server.onOp = (op, _p, _d, conn) => {
      if (op === 'WRITE' && ++writesSeen === 3) conn.end(); // drop the connection mid-transfer
    };
    const res1 = await run([pair]);
    expect(res1.outcome).toBe('incomplete');
    expect(res1.pairs[0]?.deletionsExecuted).toBe(false);
    server.onOp = undefined;
    const partSize = (await fs.stat(server.local(`${dest('Docs')}/big.bin.mirror-part`))).size;
    expect(partSize).toBeGreaterThan(0);
    expect(partSize).toBeLessThan(big.length);

    server.ops.length = 0;
    const res2 = await run([pair]);
    expect(res2.outcome, JSON.stringify(res2.pairs[0]?.issues)).toBe('completed');
    expect(server.ops.some((o) => o.op === 'OPEN' && o.path.endsWith('big.bin.mirror-part') && o.detail === 'r+')).toBe(true);
    expect((await fs.readFile(server.local(`${dest('Docs')}/big.bin`))).equals(big)).toBe(true);
    expect(Object.keys(server.tree(dest('Docs'))).some((k) => k.endsWith('.mirror-part'))).toBe(false);
  });

  it('without a working hash tool the run completes with a warning and compares by size only', async () => {
    const src = await makeTempDir({ 'a.txt': 'alpha' });
    const pair = await pairFor(src, 'Docs');
    server.hashToolBroken = true;
    const res = await run([pair]);
    expect(res.outcome).toBe('completedWithWarnings');
    expect(res.pairs[0]?.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['remote.hashingUnavailable', 'verify.noHash']));
    expect(server.tree(dest('Docs'))).toEqual({ 'a.txt': 'alpha' });
    // Same-size file cannot be verified → re-uploaded, with a warning, never silently skipped.
    const res2 = await run([pair]);
    expect(res2.pairs[0]?.counters.filesUploaded).toBe(1);
    expect(res2.pairs[0]?.issues.some((i) => i.code === 'remote.noHash')).toBe(true);
  });

  it('host key mismatch and authentication failure abort before any change', async () => {
    const src = await makeTempDir({ 'a.txt': 'A' });
    const pair = await pairFor(src, 'Docs');
    const bad = await run([pair], {}, { connection: { host: '127.0.0.1', port: server.port, username: 'tester', privateKey: server.clientPrivateKey, hostKeyFingerprint: 'SHA256:not-the-right-one' } });
    expect(bad.pairs[0]?.outcome).toBe('aborted');
    expect(bad.pairs[0]?.issues[0]?.code).toBe('destination.hostKeyMismatch');
    server.rejectAuth = true;
    const auth = await run([pair]);
    expect(auth.pairs[0]?.outcome).toBe('aborted');
    expect(auth.pairs[0]?.issues[0]?.code).toBe('destination.unreachable');
    expect(auth.pairs[0]?.issues[0]?.message).toMatch(/Authentication failed/);
    expect(server.tree(dest('Docs'))).toEqual({});
  });

  it('reports the host fingerprint on first connection (trust on first use)', async () => {
    const b = new SftpBackend(target(server, 'Docs', { connection: { host: '127.0.0.1', port: server.port, username: 'tester', privateKey: server.clientPrivateKey } }));
    await fs.mkdir(server.local(dest('Docs')), { recursive: true });
    await b.verifyDestination();
    expect(b.hostKeyFingerprint).toBe(server.hostKeyFingerprint);
    await b.close();
  });

  it('cancellation stops the run and skips deletions', async () => {
    const src = await makeTempDir({ 'a.txt': 'A', 'old.txt': 'o' });
    const pair = await pairFor(src, 'Docs');
    await run([pair]);
    await fs.rm(path.join(src, 'old.txt'));
    await fs.writeFile(path.join(src, 'a.txt'), 'A2');
    const ac = new AbortController();
    server.onOp = (op) => {
      if (op === 'WRITE') ac.abort();
    };
    const res = await run([pair], {}, {}, ac.signal);
    expect(res.outcome).toBe('cancelled');
    expect(server.tree(dest('Docs'))['old.txt']).toBe('o');
  });
});

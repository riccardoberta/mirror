/**
 * End-to-end tests of the engine against the SIMULATED Graph backend (tests/fakeGraph.ts).
 * Real-OneDrive verification is a separate, manual script: see docs/TESTING.md.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PairSpec } from '../src/core/types.js';
import { makeHarness, makeTempDir, requestsMatching, treeOf } from './helpers.js';

const destId = (p: PairSpec): string => (p.target.kind === 'onedrive' ? p.target.destinationId : '');

const SENTINELS = (h: ReturnType<typeof makeHarness>) => {
  // Files outside the managed destinations that must never be touched.
  const outsideRoot = h.fake.put(h.fake.rootId, 'outside-root.txt', 'outside');
  const sibling = h.fake.mkdir(h.rootId, 'OtherPair');
  const siblingFile = h.fake.put(sibling.id, 'keep.txt', 'keep');
  const personal = h.fake.mkdir(h.fake.rootId, 'Personal');
  const personalFile = h.fake.put(personal.id, 'photo.jpg', 'jpg');
  return () => {
    expect(h.fake.items.get(outsideRoot.id)?.content.toString()).toBe('outside');
    expect(h.fake.items.get(siblingFile.id)?.content.toString()).toBe('keep');
    expect(h.fake.items.get(personalFile.id)?.content.toString()).toBe('jpg');
    expect(h.fake.items.has(sibling.id)).toBe(true);
    expect(h.fake.items.has(personal.id)).toBe(true);
  };
};

describe('mirror run (simulated Graph)', () => {
  it('first copy: creates folders (including empty ones) and uploads files; files outside the destination are untouched', async () => {
    const h = makeHarness();
    const check = SENTINELS(h);
    const src = await makeTempDir({ 'a.txt': 'A', 'docs/b.txt': 'BB', 'docs/deep/c.txt': 'CCC', 'empty': null, 'docs/empty2': null });
    const pair = await h.pair(src, 'Docs');
    const res = await h.run([pair]);
    expect(res.outcome).toBe('completed');
    expect(res.pairs[0]?.counters).toMatchObject({ foldersCreated: 4, filesUploaded: 3, bytesUploaded: 6, filesDeleted: 0, foldersDeleted: 0 });
    expect(treeOf(h.fake, destId(pair))).toEqual({
      'a.txt': 'A',
      docs: null,
      'docs/b.txt': 'BB',
      'docs/deep': null,
      'docs/deep/c.txt': 'CCC',
      'docs/empty2': null,
      empty: null,
    });
    check();
  });

  it('second run with no changes performs no uploads and no deletions', async () => {
    const h = makeHarness();
    const src = await makeTempDir({ 'a.txt': 'A', 'docs/b.txt': 'BB', 'empty': null });
    const pair = await h.pair(src);
    await h.run([pair]);
    h.fake.requests.length = 0;
    const res = await h.run([pair]);
    expect(res.outcome).toBe('completed');
    expect(res.pairs[0]?.counters).toMatchObject({ filesUploaded: 0, foldersCreated: 0, filesDeleted: 0, foldersDeleted: 0, unchanged: 2 });
    expect(requestsMatching(h.fake, 'PUT', /./)).toBe(0);
    expect(requestsMatching(h.fake, 'DELETE', /./)).toBe(0);
    expect(requestsMatching(h.fake, 'POST', /./)).toBe(0);
  });

  it('update: only files whose content changed are re-uploaded (same size, different bytes included)', async () => {
    const h = makeHarness();
    const src = await makeTempDir({ 'same.txt': 'hello', 'changed.txt': 'hello', 'grown.txt': 'x' });
    const pair = await h.pair(src);
    await h.run([pair]);
    await fs.writeFile(path.join(src, 'changed.txt'), 'hellp'); // same size
    await fs.writeFile(path.join(src, 'grown.txt'), 'xyz');
    h.fake.requests.length = 0;
    const res = await h.run([pair]);
    expect(res.outcome).toBe('completed');
    expect(res.pairs[0]?.counters.filesUploaded).toBe(2);
    expect(requestsMatching(h.fake, 'PUT', /same\.txt/)).toBe(0);
    expect(treeOf(h.fake, destId(pair))).toEqual({ 'same.txt': 'hello', 'changed.txt': 'hellp', 'grown.txt': 'xyz' });
  });

  it('delete: items removed locally are removed remotely (files, then folders bottom-up), nothing else', async () => {
    const h = makeHarness();
    const check = SENTINELS(h);
    const src = await makeTempDir({ 'keep.txt': 'k', 'old.txt': 'o', 'dir/sub/x.txt': 'x', 'dir/y.txt': 'y', 'emptydir': null });
    const pair = await h.pair(src);
    await h.run([pair]);
    await fs.rm(path.join(src, 'old.txt'));
    await fs.rm(path.join(src, 'dir'), { recursive: true });
    await fs.rmdir(path.join(src, 'emptydir'));
    const res = await h.run([pair]);
    expect(res.outcome).toBe('completed');
    expect(res.pairs[0]?.counters).toMatchObject({ filesDeleted: 3, foldersDeleted: 3, filesUploaded: 0 });
    expect(res.pairs[0]?.deletionsExecuted).toBe(true);
    expect(treeOf(h.fake, destId(pair))).toEqual({ 'keep.txt': 'k' });
    check();
  });

  it('rename and move: performed with PATCH, without re-uploading content', async () => {
    const h = makeHarness();
    const src = await makeTempDir({ 'report.pdf': 'PDFDATA-UNIQUE', 'notes.txt': 'notes' });
    const pair = await h.pair(src);
    await h.run([pair]);
    await fs.mkdir(path.join(src, 'archive/2023'), { recursive: true });
    await fs.rename(path.join(src, 'report.pdf'), path.join(src, 'archive/2023/report-final.pdf'));
    h.fake.requests.length = 0;
    const res = await h.run([pair]);
    expect(res.outcome).toBe('completed');
    expect(res.pairs[0]?.counters).toMatchObject({ moves: 1, filesUploaded: 0, filesDeleted: 0, foldersCreated: 2 });
    expect(requestsMatching(h.fake, 'PATCH', /./)).toBe(1);
    expect(requestsMatching(h.fake, 'PUT', /./)).toBe(0);
    expect(treeOf(h.fake, destId(pair))).toEqual({ archive: null, 'archive/2023': null, 'archive/2023/report-final.pdf': 'PDFDATA-UNIQUE', 'notes.txt': 'notes' });
  });

  it('rename falls back to upload + delete when the PATCH fails', async () => {
    const h = makeHarness();
    const src = await makeTempDir({ 'a.txt': 'rename-me-please' });
    const pair = await h.pair(src);
    await h.run([pair]);
    await fs.rename(path.join(src, 'a.txt'), path.join(src, 'b.txt'));
    h.fake.injectFault({ method: 'PATCH', pathPattern: /items\/item-/, status: 400, times: 10 });
    const res = await h.run([pair]);
    expect(res.outcome).toBe('completed');
    expect(res.pairs[0]?.counters).toMatchObject({ moves: 0, filesUploaded: 1, filesDeleted: 1 });
    expect(treeOf(h.fake, destId(pair))).toEqual({ 'b.txt': 'rename-me-please' });
  });

  it('paging: destinations with more items than a page are fully inventoried', async () => {
    const h = makeHarness({ pageSize: 2 });
    const tree: Record<string, string> = {};
    for (let i = 0; i < 7; i++) tree[`f${i}.txt`] = `content ${i}`;
    for (let i = 0; i < 5; i++) tree[`d/g${i}.txt`] = `g ${i}`;
    const src = await makeTempDir(tree);
    const pair = await h.pair(src);
    await h.run([pair]);
    h.fake.requests.length = 0;
    const res = await h.run([pair]);
    expect(res.outcome).toBe('completed');
    expect(res.pairs[0]?.counters.unchanged).toBe(12);
    expect(requestsMatching(h.fake, 'PUT', /./)).toBe(0);
    expect(requestsMatching(h.fake, 'GET', /(\$|%24)skip=/)).toBeGreaterThan(0);
  });
});

describe('safety boundaries (simulated Graph)', () => {
  it('a missing source aborts the pair and deletes nothing remotely', async () => {
    const h = makeHarness();
    const src = await makeTempDir({ 'a.txt': 'A', 'd/b.txt': 'B' });
    const pair = await h.pair(src);
    await h.run([pair]);
    const before = treeOf(h.fake, destId(pair));
    await fs.rm(src, { recursive: true });
    h.fake.requests.length = 0;
    const res = await h.run([pair]);
    expect(res.outcome).toBe('incomplete');
    expect(res.pairs[0]?.outcome).toBe('aborted');
    expect(res.pairs[0]?.issues[0]?.code).toBe('source.missing');
    expect(treeOf(h.fake, destId(pair))).toEqual(before);
    expect(requestsMatching(h.fake, 'DELETE', /./)).toBe(0);
  });

  it('a source that is a file (e.g. mount point replaced) aborts the pair', async () => {
    const h = makeHarness();
    const src = await makeTempDir({ 'a.txt': 'A' });
    const pair = await h.pair(src);
    await h.run([pair]);
    await fs.rm(src, { recursive: true });
    await fs.writeFile(src, 'not a dir');
    const res = await h.run([pair]);
    expect(res.pairs[0]?.outcome).toBe('aborted');
    expect(res.pairs[0]?.issues[0]?.code).toBe('source.notDirectory');
    expect(treeOf(h.fake, destId(pair))).toEqual({ 'a.txt': 'A' });
  });

  it('an empty source with a non-empty destination is refused unless explicitly allowed', async () => {
    const h = makeHarness();
    const src = await makeTempDir({ 'a.txt': 'A' });
    const pair = await h.pair(src);
    await h.run([pair]);
    await fs.rm(path.join(src, 'a.txt'));
    const res = await h.run([pair]);
    expect(res.pairs[0]?.outcome).toBe('aborted');
    expect(res.pairs[0]?.issues[0]?.code).toBe('plan.emptySource');
    expect(treeOf(h.fake, destId(pair))).toEqual({ 'a.txt': 'A' });
    const res2 = await h.run([pair], { options: { allowEmptySourceToWipeDestination: true } });
    expect(res2.outcome).toBe('completed');
    expect(treeOf(h.fake, destId(pair))).toEqual({});
  });

  it('a destination moved out of the root (or renamed) aborts the pair without changes', async () => {
    const h = makeHarness();
    const src = await makeTempDir({ 'a.txt': 'A' });
    const pair = await h.pair(src);
    await h.run([pair]);
    const dest = h.fake.items.get(pair.target.kind === 'onedrive' ? pair.target.destinationId : '')!;
    dest.parentId = h.fake.rootId; // moved to the drive root by a OneDrive user
    await fs.rm(path.join(src, 'a.txt'));
    await fs.writeFile(path.join(src, 'b.txt'), 'B');
    const res = await h.run([pair]);
    expect(res.pairs[0]?.outcome).toBe('aborted');
    expect(res.pairs[0]?.issues[0]?.code).toBe('destination.moved');
    expect(treeOf(h.fake, destId(pair))).toEqual({ 'a.txt': 'A' });

    dest.parentId = h.rootId;
    dest.name = 'Renamed';
    const res2 = await h.run([pair]);
    expect(res2.pairs[0]?.issues[0]?.code).toBe('destination.renamed');
  });

  it('refuses to run when the signed-in account differs from the configured one', async () => {
    const h = makeHarness({ userId: 'someone-else' });
    const src = await makeTempDir({ 'a.txt': 'A' });
    const pair = await h.pair(src);
    const res = await h.run([pair], { expectedUserId: 'user-1' });
    expect(res.outcome).toBe('failed');
    expect(res.issues[0]?.message).toMatch(/not the account Mirror was configured with/);
    expect(treeOf(h.fake, destId(pair))).toEqual({});
  });

  it('network errors are retried; persistent upload failures skip ALL deletions', async () => {
    const h = makeHarness();
    const src = await makeTempDir({ 'a.txt': 'A', 'old.txt': 'old' });
    const pair = await h.pair(src);
    // transient: one network failure while listing → retried transparently
    h.fake.injectFault({ method: 'GET', pathPattern: /children/, network: true });
    const first = await h.run([pair]);
    expect(first.outcome).toBe('completed');
    expect(h.sleeps.length).toBeGreaterThan(0);

    await fs.rm(path.join(src, 'old.txt'));
    await fs.writeFile(path.join(src, 'new.txt'), 'N');
    h.fake.injectFault({ method: 'PUT', pathPattern: /new\.txt/, network: true, times: 50 });
    const res = await h.run([pair]);
    expect(res.outcome).toBe('incomplete');
    expect(res.pairs[0]?.deletionsExecuted).toBe(false);
    expect(res.pairs[0]?.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['upload.failed', 'deletions.skipped']));
    // old.txt is still there because the copy phase was not clean
    expect(treeOf(h.fake, destId(pair))).toEqual({ 'a.txt': 'A', 'old.txt': 'old' });
  });

  it('throttling: Retry-After is honoured and the operation succeeds', async () => {
    const h = makeHarness();
    const src = await makeTempDir({ 'a.txt': 'A' });
    const pair = await h.pair(src);
    h.fake.injectFault({ method: 'PUT', pathPattern: /a\.txt/, status: 429, retryAfter: '3' });
    h.fake.injectFault({ method: 'GET', pathPattern: /children/, status: 503 });
    const res = await h.run([pair]);
    expect(res.outcome).toBe('completed');
    expect(h.sleeps).toContain(3000);
    expect(treeOf(h.fake, destId(pair))).toEqual({ 'a.txt': 'A' });
  });

  it('If-Match: a remote file modified after the inventory is not deleted blindly', async () => {
    const h = makeHarness();
    const src = await makeTempDir({ 'a.txt': 'A', 'gone.txt': 'g' });
    const pair = await h.pair(src);
    await h.run([pair]);
    await fs.rm(path.join(src, 'gone.txt'));
    const gone = h.fake.childByName(destId(pair), 'gone.txt')!;
    // Someone edits gone.txt on OneDrive right before Mirror deletes it.
    h.fake.onRequest = (method, url) => {
      if (method === 'DELETE' && url.includes(gone.id)) h.fake.touch(gone.id, 'edited on the web');
    };
    const res = await h.run([pair]);
    expect(res.outcome).toBe('incomplete');
    expect(res.pairs[0]?.issues.some((i) => i.code === 'remote.changed')).toBe(true);
    expect(h.fake.items.get(gone.id)?.content.toString()).toBe('edited on the web');
  });

  it('a folder that received new remote content while running is not deleted', async () => {
    const h = makeHarness();
    const src = await makeTempDir({ 'keep.txt': 'k', 'dir/x.txt': 'x' });
    const pair = await h.pair(src);
    await h.run([pair]);
    await fs.rm(path.join(src, 'dir'), { recursive: true });
    const dir = h.fake.childByName(destId(pair), 'dir')!;
    h.fake.onRequest = (method, url) => {
      if (method === 'GET' && url.endsWith(`/items/${dir.id}?%24select=` + encodeURIComponent('id,name,size,eTag,cTag,file,folder,package,parentReference,lastModifiedDateTime')) ) {
        h.fake.put(dir.id, 'added-on-web.txt', 'web');
      }
    };
    const res = await h.run([pair]);
    expect(res.pairs[0]?.issues.some((i) => i.code === 'remote.folderNotEmpty')).toBe(true);
    expect(h.fake.items.has(dir.id)).toBe(true);
    expect(treeOf(h.fake, destId(pair))).toEqual({ 'keep.txt': 'k', dir: null, 'dir/added-on-web.txt': 'web' });
  });

  it('local changes during the run are detected and reported as inconsistency', async () => {
    const h = makeHarness();
    const src = await makeTempDir({ 'a.txt': 'A', 'b.txt': 'B' });
    const pair = await h.pair(src);
    h.fake.onRequest = async (method, url) => {
      if (method === 'PUT' && url.includes('a.txt')) {
        await fs.writeFile(path.join(src, 'c.txt'), 'appeared');
      }
    };
    const res = await h.run([pair]);
    expect(res.outcome).toBe('incomplete');
    expect(res.pairs[0]?.issues.some((i) => i.code === 'local.changedDuringRun')).toBe(true);
  });

  it('cancellation stops the run and never executes deletions afterwards', async () => {
    const h = makeHarness();
    const src = await makeTempDir({ 'a.txt': 'A', 'b.txt': 'B', 'old.txt': 'o' });
    const pair = await h.pair(src);
    await h.run([pair]);
    await fs.rm(path.join(src, 'old.txt'));
    await fs.writeFile(path.join(src, 'a.txt'), 'A2');
    const ac = new AbortController();
    h.fake.onRequest = (method, url) => {
      if (method === 'PUT') ac.abort();
    };
    const res = await h.run([pair], { signal: ac.signal });
    expect(res.outcome).toBe('cancelled');
    expect(res.pairs[0]?.deletionsExecuted).toBe(false);
    expect(h.fake.childByName(destId(pair), 'old.txt')).toBeDefined();
  });

  it('quota exhaustion stops the run without deletions', async () => {
    const h = makeHarness({ quotaRemaining: 3 });
    const src = await makeTempDir({ 'a.txt': 'AAAA', 'b.txt': 'BBBB' });
    const pair = await h.pair(src);
    h.fake.put(destId(pair), 'stale.txt', 's');
    const res = await h.run([pair]);
    expect(res.outcome).toBe('incomplete');
    expect(res.pairs[0]?.issues.some((i) => i.code === 'remote.quotaExceeded')).toBe(true);
    expect(res.pairs[0]?.deletionsExecuted).toBe(false);
    expect(h.fake.childByName(destId(pair), 'stale.txt')).toBeDefined();
  });

  it('unsupported local items (symlinks) are reported and their remote counterparts preserved', async () => {
    const h = makeHarness();
    const src = await makeTempDir({ 'ok.txt': 'ok', 'target.txt': 't' });
    const pair = await h.pair(src);
    h.fake.put(destId(pair), 'link.txt', 'remote copy of link');
    await fs.symlink(path.join(src, 'target.txt'), path.join(src, 'link.txt'));
    const res = await h.run([pair]);
    expect(res.outcome).toBe('incomplete');
    expect(res.pairs[0]?.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['local.symlink', 'remote.protected']));
    expect(h.fake.childByName(destId(pair), 'link.txt')?.content.toString()).toBe('remote copy of link');
  });

  it('removing a pair from the configuration does not delete its cloud copy (nothing references it)', async () => {
    const h = makeHarness();
    const src1 = await makeTempDir({ 'a.txt': 'A' });
    const src2 = await makeTempDir({ 'b.txt': 'B' });
    const p1 = await h.pair(src1, 'One');
    const p2 = await h.pair(src2, 'Two');
    await h.run([p1, p2]);
    const res = await h.run([p1]); // pair Two removed from configuration
    expect(res.outcome).toBe('completed');
    expect(treeOf(h.fake, destId(p2))).toEqual({ 'b.txt': 'B' });
  });

  it('two pairs: a failure in one pair does not affect the other', async () => {
    const h = makeHarness();
    const src1 = await makeTempDir({ 'a.txt': 'A' });
    const src2 = await makeTempDir({ 'b.txt': 'B' });
    const p1 = await h.pair(src1, 'One');
    const p2 = await h.pair(src2, 'Two');
    await fs.rm(src1, { recursive: true });
    const res = await h.run([p1, p2]);
    expect(res.pairs.map((p) => p.outcome)).toEqual(['aborted', 'completed']);
    expect(treeOf(h.fake, destId(p2))).toEqual({ 'b.txt': 'B' });
  });
});

describe('large files (simulated upload sessions)', () => {
  const KiB = 1024;
  it('uploads via an upload session in 320 KiB-multiple fragments and verifies the hash', async () => {
    const h = makeHarness({}, { largeFileThreshold: 100 * KiB, uploadChunkSize: 320 * KiB });
    const big = Buffer.alloc(700 * KiB + 123);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    const src = await makeTempDir({});
    await fs.writeFile(path.join(src, 'big.bin'), big);
    const pair = await h.pair(src);
    const res = await h.run([pair]);
    expect(res.outcome).toBe('completed');
    expect(requestsMatching(h.fake, 'POST', /createUploadSession/)).toBe(1);
    expect(requestsMatching(h.fake, 'PUT', /upload\.fake/)).toBe(3);
    expect(h.fake.childByName(destId(pair), 'big.bin')?.content.equals(big)).toBe(true);
  });

  it('resumes an interrupted upload session from nextExpectedRanges', async () => {
    const h = makeHarness({}, { largeFileThreshold: 100 * KiB, uploadChunkSize: 320 * KiB });
    const big = Buffer.alloc(1000 * KiB, 7);
    const src = await makeTempDir({});
    await fs.writeFile(path.join(src, 'big.bin'), big);
    const pair = await h.pair(src);
    // The second fragment keeps failing at network level beyond the per-request retries (4 attempts):
    // the client must query the session status (GET uploadUrl) and resume from nextExpectedRanges.
    let puts = 0;
    h.fake.onRequest = (method, url) => {
      if (method === 'PUT' && url.includes('upload.fake')) {
        puts++;
        if (puts >= 2 && puts <= 5) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      }
    };
    const res = await h.run([pair]);
    expect(res.outcome).toBe('completed');
    expect(requestsMatching(h.fake, 'GET', /upload\.fake/)).toBeGreaterThanOrEqual(1);
    expect(h.fake.childByName(destId(pair), 'big.bin')?.content.equals(big)).toBe(true);
  });

  it('a large file whose content changed is re-uploaded; an identical one is skipped', async () => {
    const h = makeHarness({}, { largeFileThreshold: 100 * KiB, uploadChunkSize: 320 * KiB });
    const src = await makeTempDir({});
    await fs.writeFile(path.join(src, 'big.bin'), Buffer.alloc(400 * KiB, 1));
    const pair = await h.pair(src);
    await h.run([pair]);
    h.fake.requests.length = 0;
    await h.run([pair]);
    expect(requestsMatching(h.fake, 'POST', /createUploadSession/)).toBe(0);
    const changed = Buffer.alloc(400 * KiB, 1);
    changed[12345] = 2; // same size, one byte differs
    await fs.writeFile(path.join(src, 'big.bin'), changed);
    const res = await h.run([pair]);
    expect(res.pairs[0]?.counters.filesUploaded).toBe(1);
    expect(h.fake.childByName(destId(pair), 'big.bin')?.content.equals(changed)).toBe(true);
  });
});

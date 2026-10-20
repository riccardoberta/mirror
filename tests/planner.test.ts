import { describe, expect, it } from 'vitest';
import type { FileHashes } from '../src/core/hashing.js';
import { PlanAbort, buildPlan, compareFile, hashCandidates } from '../src/core/planner.js';
import { QuickXorHash } from '../src/core/quickxorhash.js';
import type { LocalEntry, LocalInventory, LocalProblem, RemoteEntry, RemoteInventory } from '../src/core/types.js';

/* ---------- builders ---------- */

function local(spec: Record<string, string | null>, problems: LocalProblem[] = []): LocalInventory {
  const entries = new Map<string, LocalEntry>();
  for (const [rel, content] of Object.entries(spec)) {
    const name = rel.split('/').pop()!;
    // implicit parents
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      if (!entries.has(p)) entries.set(p, { relPath: p, name: parts[i - 1]!, kind: 'dir', size: 0, mtimeMs: 1, ino: 0 });
    }
    entries.set(rel, content === null ? { relPath: rel, name, kind: 'dir', size: 0, mtimeMs: 1, ino: 0 } : { relPath: rel, name, kind: 'file', size: Buffer.byteLength(content), mtimeMs: 1, ino: 0 });
  }
  return { rootPath: '/src', entries, problems, excluded: [], scannedAt: 0 };
}

function hashesFor(spec: Record<string, string | null>): Map<string, FileHashes> {
  const m = new Map<string, FileHashes>();
  for (const [rel, content] of Object.entries(spec)) {
    if (content === null) continue;
    m.set(rel, { size: Buffer.byteLength(content), quickXorHash: QuickXorHash.ofBuffer(Buffer.from(content)), sha1Hash: '' });
  }
  return m;
}

let nextId = 100;
function remote(spec: Record<string, string | null>, opts: { noHash?: boolean } = {}): RemoteInventory {
  const entries = new Map<string, RemoteEntry>();
  const ids = new Map<string, string>([['', 'dest']]);
  const ensure = (rel: string, content: string | null): void => {
    if (entries.has(rel)) return;
    const parts = rel.split('/');
    const parent = parts.slice(0, -1).join('/');
    if (parent && !entries.has(parent)) ensure(parent, null);
    const id = `r${nextId++}`;
    ids.set(rel, id);
    const name = parts[parts.length - 1]!;
    entries.set(rel, {
      id,
      relPath: rel,
      name,
      kind: content === null ? 'folder' : 'file',
      size: content === null ? 0 : Buffer.byteLength(content),
      eTag: `"e-${id}"`,
      parentId: ids.get(parent)!,
      quickXorHash: content === null || opts.noHash ? undefined : QuickXorHash.ofBuffer(Buffer.from(content)),
    });
  };
  for (const [rel, content] of Object.entries(spec)) ensure(rel, content);
  return { driveId: 'd', destinationId: 'dest', entries, listedAt: 0 };
}

const types = (plan: { ops: Array<{ type: string }> }) => plan.ops.map((o) => o.type);
const build = (l: LocalInventory, r: RemoteInventory, allow = false) => buildPlan({ local: l, remote: r, hashes: hashesFor(specOf(l)), allowEmptySourceToWipeDestination: allow });
function specOf(l: LocalInventory): Record<string, string | null> {
  // Not recoverable from the inventory (no content), so tests pass hashes explicitly where needed.
  return Object.fromEntries([...l.entries.values()].map((e) => [e.relPath, e.kind === 'dir' ? null : '']));
}

/* ---------- tests ---------- */

describe('planner: first copy', () => {
  it('creates folders (shallow first) and uploads everything when the destination is empty', () => {
    const l = local({ 'a.txt': 'A', 'docs/b.txt': 'B', 'docs/deep/c.txt': 'C', 'empty': null });
    const { plan, issues } = buildPlan({ local: l, remote: remote({}), hashes: new Map(), allowEmptySourceToWipeDestination: false });
    expect(issues).toEqual([]);
    expect(types(plan)).toEqual(['mkdir', 'mkdir', 'mkdir', 'upload', 'upload', 'upload']);
    expect(plan.ops.slice(0, 3).map((o) => (o as { relPath: string }).relPath)).toEqual(['docs', 'empty', 'docs/deep']);
    expect(plan.stats).toMatchObject({ mkdirs: 3, uploadsNew: 3, uploadsChanged: 0, deletesFiles: 0, deletesFolders: 0, bytesToUpload: 3 });
  });
});

describe('planner: comparison', () => {
  it('skips identical files (same size and hash) and re-uploads changed ones', () => {
    const spec = { 'same.txt': 'hello', 'changed.txt': 'hellp', 'bigger.txt': 'now longer' };
    const l = local(spec);
    const r = remote({ 'same.txt': 'hello', 'changed.txt': 'hello', 'bigger.txt': 'short' });
    const { plan } = buildPlan({ local: l, remote: r, hashes: hashesFor(spec), allowEmptySourceToWipeDestination: false });
    expect(plan.ops.map((o) => [o.type, (o as { relPath: string }).relPath])).toEqual([
      ['upload', 'bigger.txt'],
      ['upload', 'changed.txt'],
    ]);
    expect(plan.stats.unchanged).toBe(1);
    expect(plan.skippedIdentical).toEqual(['same.txt']);
  });

  it('only asks for hashes where they matter', () => {
    const l = local({ 'same-size.txt': 'aaaa', 'diff-size.txt': 'bb', 'new.txt': 'cccc', 'new2.txt': 'd' });
    const r = remote({ 'same-size.txt': 'zzzz', 'diff-size.txt': 'longer', 'gone.txt': 'cccc' });
    // same-size → needed; diff-size → not needed; new.txt → needed (size matches remote-only gone.txt); new2 → not needed
    expect(hashCandidates(l, r).sort()).toEqual(['new.txt', 'same-size.txt']);
  });

  it('treats size-only equality as unverifiable when OneDrive gives no hash → re-upload with warning', () => {
    const spec = { 'f.txt': 'abcd' };
    const l = local(spec);
    const r = remote({ 'f.txt': 'abcd' }, { noHash: true });
    const { plan, issues } = buildPlan({ local: l, remote: r, hashes: hashesFor(spec), allowEmptySourceToWipeDestination: false });
    expect(types(plan)).toEqual(['upload']);
    expect(issues.map((i) => i.code)).toContain('remote.noHash');
  });

  it('compareFile: zero-byte files are identical without hashes; sha1 is used when quickXor is missing', () => {
    const le: LocalEntry = { relPath: 'z', name: 'z', kind: 'file', size: 0, mtimeMs: 0, ino: 0 };
    const re: RemoteEntry = { id: 'x', relPath: 'z', name: 'z', kind: 'file', size: 0, parentId: 'p' };
    expect(compareFile(le, re, undefined)).toBe('identical');
    const le2 = { ...le, size: 3 };
    const re2 = { ...re, size: 3, sha1Hash: 'ABC' };
    expect(compareFile(le2, re2, { size: 3, quickXorHash: 'q', sha1Hash: 'abc' })).toBe('identical');
    expect(compareFile(le2, re2, { size: 3, quickXorHash: 'q', sha1Hash: 'abd' })).toBe('changed');
  });
});

describe('planner: deletions', () => {
  it('deletes remote-only files first, then folders deepest-first', () => {
    const l = local({ 'keep.txt': 'k' });
    const r = remote({ 'keep.txt': 'k', 'old.txt': 'o', 'dir/sub/x.txt': 'x', 'dir/y.txt': 'y', 'emptydir': null });
    const { plan } = buildPlan({ local: l, remote: r, hashes: hashesFor({ 'keep.txt': 'k' }), allowEmptySourceToWipeDestination: false });
    expect(plan.ops.map((o) => [o.type, (o as { relPath: string }).relPath])).toEqual([
      ['deleteFile', 'dir/sub/x.txt'],
      ['deleteFile', 'dir/y.txt'],
      ['deleteFile', 'old.txt'],
      ['deleteFolder', 'dir/sub'],
      ['deleteFolder', 'dir'],
      ['deleteFolder', 'emptydir'],
    ]);
  });

  it('refuses to wipe a non-empty destination from an empty source unless explicitly allowed', () => {
    const l = local({});
    const r = remote({ 'a.txt': 'a' });
    expect(() => build(l, r)).toThrow(PlanAbort);
    const { plan } = build(l, r, true);
    expect(types(plan)).toEqual(['deleteFile']);
  });

  it('never deletes remote items at paths whose local counterpart could not be mirrored (and keeps their ancestors)', () => {
    const problems: LocalProblem[] = [{ kind: 'symlink', relPath: 'dir/link.pdf', detail: 'symlink' }];
    const l = local({ 'dir/ok.txt': 'ok' }, problems);
    const r = remote({ 'dir/ok.txt': 'ok', 'dir/link.pdf': 'old content', 'dir/stale.txt': 's', 'other/old.txt': 'o' });
    const { plan, issues } = buildPlan({ local: l, remote: r, hashes: hashesFor({ 'dir/ok.txt': 'ok' }), allowEmptySourceToWipeDestination: false });
    const deleted = plan.ops.filter((o) => o.type.startsWith('delete')).map((o) => (o as { relPath: string }).relPath);
    expect(deleted.sort()).toEqual(['dir/stale.txt', 'other', 'other/old.txt']);
    expect(issues.find((i) => i.code === 'local.symlink')?.severity).toBe('error');
    expect(issues.find((i) => i.code === 'remote.protected')?.relPath).toBe('dir/link.pdf');
  });

  it('protects the whole subtree below an invalid-name folder', () => {
    const l = local({ 'ok.txt': 'ok' }, [{ kind: 'invalidName', relPath: 'bad*dir', detail: 'char' }]);
    const r = remote({ 'ok.txt': 'ok', 'bad*dir/a.txt': 'a', 'bad*dir/sub/b.txt': 'b' });
    const { plan } = buildPlan({ local: l, remote: r, hashes: hashesFor({ 'ok.txt': 'ok' }), allowEmptySourceToWipeDestination: false });
    expect(plan.ops.filter((o) => o.type.startsWith('delete'))).toEqual([]);
  });
});

describe('planner: renames and moves', () => {
  it('detects a unique rename by size+hash and plans a move instead of upload+delete', () => {
    const spec = { 'new-name.txt': 'same content', 'other.txt': 'o' };
    const l = local(spec);
    const r = remote({ 'old-name.txt': 'same content', 'other.txt': 'o' });
    const { plan } = buildPlan({ local: l, remote: r, hashes: hashesFor(spec), allowEmptySourceToWipeDestination: false });
    expect(plan.ops).toEqual([expect.objectContaining({ type: 'move', fromRelPath: 'old-name.txt', toRelPath: 'new-name.txt' })]);
    expect(plan.stats).toMatchObject({ moves: 1, uploadsNew: 0, deletesFiles: 0 });
  });

  it('detects a move into a new folder (mkdir first, then move)', () => {
    const spec = { 'archive/2023/report.pdf': 'PDFDATA' };
    const l = local(spec);
    const r = remote({ 'report.pdf': 'PDFDATA' });
    const { plan } = buildPlan({ local: l, remote: r, hashes: hashesFor(spec), allowEmptySourceToWipeDestination: false });
    expect(types(plan)).toEqual(['mkdir', 'mkdir', 'move']);
  });

  it('falls back to upload+delete when the match is ambiguous', () => {
    const spec = { 'a-copy.txt': 'dup', 'b-copy.txt': 'dup' };
    const l = local(spec);
    const r = remote({ 'orig.txt': 'dup' });
    const { plan } = buildPlan({ local: l, remote: r, hashes: hashesFor(spec), allowEmptySourceToWipeDestination: false });
    expect(types(plan)).toEqual(['upload', 'upload', 'deleteFile']);
  });
});

describe('planner: type mismatches and case', () => {
  it('replaces a remote file with a folder and vice versa', () => {
    const spec = { 'thing': null, 'other/': null, 'file-now': 'content' };
    const l = local({ thing: null, 'file-now': 'content' });
    const r = remote({ thing: 'was a file', 'file-now/child.txt': 'c' });
    const { plan } = buildPlan({ local: l, remote: r, hashes: hashesFor(spec), allowEmptySourceToWipeDestination: false });
    expect(plan.ops.map((o) => [o.type, (o as { relPath: string }).relPath])).toEqual([
      ['replaceType', 'file-now'],
      ['replaceType', 'thing'],
      ['mkdir', 'thing'],
      ['upload', 'file-now'],
    ]);
    // children of the replaced remote folder are NOT separately deleted (they go with the folder)
    expect(plan.stats.deletesFiles).toBe(0);
  });

  it('treats names differing only by case as the same item (with a warning)', () => {
    const spec = { 'readme.md': 'r' };
    const l = local(spec);
    const r = remote({ 'README.md': 'r' });
    const { plan, issues } = buildPlan({ local: l, remote: r, hashes: hashesFor(spec), allowEmptySourceToWipeDestination: false });
    expect(plan.ops).toEqual([]);
    expect(issues.map((i) => i.code)).toEqual(['name.caseDiffers']);
  });
});

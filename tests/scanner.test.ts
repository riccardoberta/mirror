import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScanError, scanLocal, scanOptionsFrom } from '../src/core/scanner.js';
import { DEFAULT_ENGINE_OPTIONS } from '../src/core/types.js';
import { makeTempDir } from './helpers.js';

const opts = () => scanOptionsFrom(DEFAULT_ENGINE_OPTIONS, 10);

describe('scanLocal', () => {
  it('inventories files, folders and empty folders; excludes macOS noise', async () => {
    const dir = await makeTempDir({
      'a.txt': 'A',
      'sub/b.txt': 'BB',
      'sub/empty': null,
      '.hidden': 'h',
      '.DS_Store': 'x',
      'sub/._b.txt': 'apple-double',
      'Bundle.app/Contents/Info.plist': '<plist/>',
    });
    const inv = await scanLocal(dir, opts());
    expect([...inv.entries.keys()].sort()).toEqual(
      ['.hidden', 'Bundle.app', 'Bundle.app/Contents', 'Bundle.app/Contents/Info.plist', 'a.txt', 'sub', 'sub/b.txt', 'sub/empty'].sort(),
    );
    expect(inv.entries.get('sub/empty')?.kind).toBe('dir');
    expect(inv.entries.get('sub/b.txt')?.size).toBe(2);
    expect(inv.excluded.sort()).toEqual(['.DS_Store', 'sub/._b.txt']);
    expect(inv.problems).toEqual([]);
  });

  it('reports symlinks without following them', async () => {
    const dir = await makeTempDir({ 'real.txt': 'r', 'folder/x.txt': 'x' });
    await fs.symlink(path.join(dir, 'real.txt'), path.join(dir, 'link.txt'));
    await fs.symlink('/etc', path.join(dir, 'etc-link'));
    const inv = await scanLocal(dir, opts());
    expect(inv.entries.has('link.txt')).toBe(false);
    expect(inv.entries.has('etc-link')).toBe(false);
    expect(inv.problems.map((p) => [p.kind, p.relPath]).sort()).toEqual([
      ['symlink', 'etc-link'],
      ['symlink', 'link.txt'],
    ]);
  });

  it('reports invalid names and does not descend into invalid folders', async () => {
    const dir = await makeTempDir({ 'bad:name.txt': 'x', 'bad*dir/inner.txt': 'y', 'ok.txt': 'z', 'CON': 'c', '.photo.jpg.icloud': 'p' });
    const inv = await scanLocal(dir, opts());
    expect([...inv.entries.keys()]).toEqual(['ok.txt']);
    expect(inv.problems.map((p) => p.relPath).sort()).toEqual(['.photo.jpg.icloud', 'CON', 'bad*dir', 'bad:name.txt']);
    expect(inv.problems.find((p) => p.relPath === '.photo.jpg.icloud')?.kind).toBe('cloudPlaceholder');
  });

  it('reports case collisions and removes both siblings from the mirrorable set', async () => {
    const dir = await makeTempDir({ 'Readme.md': '1', 'readme.md': '2', 'other.txt': '3', 'Dir/f.txt': 'f', 'dir/g.txt': 'g' });
    const inv = await scanLocal(dir, opts());
    expect([...inv.entries.keys()]).toEqual(['other.txt']);
    expect(inv.problems.filter((p) => p.kind === 'caseCollision').map((p) => p.relPath).sort()).toEqual(['Dir', 'Readme.md', 'dir', 'readme.md']);
  });

  it('fails loudly on a missing source instead of returning an empty inventory', async () => {
    await expect(scanLocal('/definitely/not/here', opts())).rejects.toBeInstanceOf(ScanError);
    await expect(scanLocal('/definitely/not/here', opts())).rejects.toMatchObject({ code: 'missing' });
  });

  it('fails when the source is a file', async () => {
    const dir = await makeTempDir({ 'f.txt': 'x' });
    await expect(scanLocal(path.join(dir, 'f.txt'), opts())).rejects.toMatchObject({ code: 'notDirectory' });
  });

  it.skipIf(process.getuid?.() === 0)('fails on permission denied (not treated as empty)', async () => {
    const dir = await makeTempDir({ 'locked/secret.txt': 's' });
    await fs.chmod(path.join(dir, 'locked'), 0o000);
    try {
      await expect(scanLocal(dir, opts())).rejects.toMatchObject({ code: 'permissionDenied' });
    } finally {
      await fs.chmod(path.join(dir, 'locked'), 0o755);
    }
  });

  it('enforces the OneDrive path length limit', async () => {
    const long = 'x'.repeat(200);
    const dir = await makeTempDir({ [`${long}/${long}/f.txt`]: 'f' });
    const inv = await scanLocal(dir, scanOptionsFrom(DEFAULT_ENGINE_OPTIONS, 20));
    expect(inv.problems.some((p) => p.kind === 'pathTooLong')).toBe(true);
  });

  it('can be cancelled', async () => {
    const dir = await makeTempDir({ 'a/b/c.txt': 'c' });
    const ac = new AbortController();
    ac.abort();
    await expect(scanLocal(dir, { ...opts(), signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });
});

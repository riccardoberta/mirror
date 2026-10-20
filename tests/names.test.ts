import { describe, expect, it } from 'vitest';
import { collisionKey, depthOf, parentOf, pathKey, validateOneDriveName } from '../src/core/names.js';

describe('validateOneDriveName', () => {
  it('accepts ordinary names, including hidden ones and bundles', () => {
    for (const n of ['Report.pdf', '.gitignore', 'Photos 2024', 'Tesi (bozza) #2.docx', 'Notes.rtfd', 'Ciao — è ok.txt', 'a.b.c']) {
      expect(validateOneDriveName(n).ok, n).toBe(true);
    }
  });
  it('rejects forbidden characters', () => {
    for (const n of ['a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\\b', 'a\u0001b']) {
      expect(validateOneDriveName(n).ok, n).toBe(false);
    }
  });
  it('rejects reserved names and patterns', () => {
    for (const n of ['CON', 'con.txt', 'LPT1', 'NUL', '.lock', 'desktop.ini', '~$doc.docx', 'a_vti_b', '.', '..']) {
      expect(validateOneDriveName(n).ok, n).toBe(false);
    }
  });
  it('rejects leading/trailing whitespace and trailing period', () => {
    expect(validateOneDriveName(' a').ok).toBe(false);
    expect(validateOneDriveName('a ').ok).toBe(false);
    expect(validateOneDriveName('a.').ok).toBe(false);
    expect(validateOneDriveName('x'.repeat(256)).ok).toBe(false);
  });
});

describe('keys', () => {
  it('collision keys ignore case and Unicode normalization', () => {
    expect(collisionKey('Café')).toBe(collisionKey('café'));
    expect(collisionKey('README')).toBe(collisionKey('readme'));
    expect(collisionKey('a')).not.toBe(collisionKey('b'));
  });
  it('path helpers', () => {
    expect(pathKey('Docs/Sub/File.TXT')).toBe('docs/sub/file.txt');
    expect(parentOf('a/b/c')).toBe('a/b');
    expect(parentOf('a')).toBe('');
    expect(depthOf('')).toBe(0);
    expect(depthOf('a/b')).toBe(2);
  });
});

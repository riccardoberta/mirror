/**
 * OneDrive / SharePoint file-name rules (Microsoft: "Restrictions and limitations in OneDrive and SharePoint").
 * We validate names before planning so that unsupported items are reported, never silently skipped.
 */

// eslint-disable-next-line no-control-regex
const INVALID_CHARS = /["*:<>?/\\|\u0000-\u001f\u007f]/;
const RESERVED = new Set([
  '.lock',
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM0', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT0', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  'desktop.ini',
]);

export interface NameValidation {
  ok: boolean;
  reason?: string;
}

export function validateOneDriveName(name: string): NameValidation {
  if (name.length === 0) return { ok: false, reason: 'empty name' };
  if (name === '.' || name === '..') return { ok: false, reason: 'reserved name' };
  if (name.length > 255) return { ok: false, reason: 'name longer than 255 characters' };
  const m = INVALID_CHARS.exec(name);
  if (m) return { ok: false, reason: `contains forbidden character ${describeChar(m[0])}` };
  if (name !== name.trim()) return { ok: false, reason: 'leading or trailing whitespace' };
  if (name.endsWith('.')) return { ok: false, reason: 'ends with a period' };
  if (name.startsWith('~$')) return { ok: false, reason: 'starts with "~$" (Office temporary file)' };
  const stem = (name.split('.')[0] ?? '').toUpperCase();
  if (RESERVED.has(name) || name.toLowerCase() === 'desktop.ini' || /^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/.test(stem)) {
    return { ok: false, reason: 'reserved name' };
  }
  if (name.includes('_vti_')) return { ok: false, reason: 'contains "_vti_"' };
  return { ok: true };
}

function describeChar(c: string): string {
  const code = c.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) return `U+${code.toString(16).padStart(4, '0').toUpperCase()}`;
  return `"${c}"`;
}

/**
 * Key used to detect collisions on a case-insensitive, normalization-insensitive store.
 * Two sibling names with the same key cannot coexist on OneDrive.
 */
export function collisionKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** Normalized key for matching local and remote relative paths. */
export function pathKey(relPath: string): string {
  return relPath
    .split('/')
    .map((s) => collisionKey(s))
    .join('/');
}

export function joinRel(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

export function parentOf(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i < 0 ? '' : relPath.slice(0, i);
}

export function baseName(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i < 0 ? relPath : relPath.slice(i + 1);
}

export function depthOf(relPath: string): number {
  return relPath === '' ? 0 : relPath.split('/').length;
}

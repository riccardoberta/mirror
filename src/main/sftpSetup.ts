import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { safeStorage } from 'electron';
import { MARKER_NAME, powershellHashCommand, posixHashCommand, readMarker, writeMarker } from '../core/backends/sftp.js';
import { SftpConnection, type SftpConnectionSettings, SftpError, isWindowsPath, joinSftp, toNativePath, toSftpPath } from '../core/backends/sftpConnection.js';
import { validateOneDriveName } from '../core/names.js';
import type { SftpTestResult } from '../shared/ipc.js';
import type { PersistedSftp } from './config.js';

/** Configuration-time helpers for the remote disk: credentials, connection test, root provisioning. */

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export async function connectionSettings(s: PersistedSftp): Promise<SftpConnectionSettings> {
  if (!s.host.trim()) throw new Error('Remote disk: enter the host name or Tailscale address of the remote machine.');
  if (!s.username.trim()) throw new Error('Remote disk: enter the user name on the remote machine.');
  let privateKey: string;
  try {
    privateKey = await fs.readFile(expandHome(s.privateKeyPath.trim()), 'utf8');
  } catch (err) {
    throw new Error(`Remote disk: cannot read the private key file "${s.privateKeyPath}" (${(err as NodeJS.ErrnoException).code ?? String(err)}). Generate one with: ssh-keygen -t ed25519`);
  }
  return {
    host: s.host.trim(),
    port: s.port || 22,
    username: s.username.trim(),
    privateKey,
    passphrase: decryptPassphrase(s),
    hostKeyFingerprint: s.hostKeyFingerprint,
  };
}

export function encryptPassphrase(passphrase: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available; cannot store a key passphrase. Use a key without passphrase.');
  return safeStorage.encryptString(passphrase).toString('base64');
}

export function decryptPassphrase(s: PersistedSftp): string | undefined {
  if (!s.passphraseEncrypted) return undefined;
  return safeStorage.decryptString(Buffer.from(s.passphraseEncrypted, 'base64'));
}

/** Connects, inspects root/marker and the hashing tool. Does not change anything on the remote disk. */
export async function testConnection(s: PersistedSftp): Promise<SftpTestResult & { connectionOk: boolean }> {
  let conn: SftpConnection;
  try {
    conn = await SftpConnection.connect(await connectionSettings(s));
  } catch (err) {
    return { ok: false, connectionOk: false, message: err instanceof Error ? err.message : String(err) };
  }
  try {
    const root = toSftpPath(s.rootPath);
    const st = await conn.stat(root);
    const rootExists = Boolean(st?.isDirectory());
    const marker = rootExists ? await readMarker(conn, root) : undefined;
    const markerMatches = marker ? marker.mirrorRootId === s.rootId : undefined;

    // Hash tool probe: hash the marker file itself (or nothing) through the real command.
    let hashToolOk = false;
    let hashToolMessage = '';
    if (s.hashCommand !== 'none') {
      const probePath = rootExists && marker ? joinSftp(root, MARKER_NAME) : undefined;
      const stdin = probePath ? Buffer.from(toNativePath(probePath), 'utf8').toString('base64') + '\n' : '\n';
      const cmd = s.hashCommand === 'powershell' ? powershellHashCommand() : posixHashCommand();
      const res = await conn.exec(cmd, stdin);
      hashToolOk = res.code === 0 && (!probePath || /\t[0-9A-Fa-f]{40}\t/.test(res.stdout));
      hashToolMessage = hashToolOk ? 'remote hashing works' : `remote hashing failed (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 200) || 'no output'}`;
    } else {
      hashToolMessage = 'remote hashing disabled: files are compared by size only';
    }

    const parts = [`Connected to ${s.host} as ${s.username}.`];
    parts.push(rootExists ? (marker ? (markerMatches ? `Root ${toNativePath(root)} found with the expected Mirror marker.` : `Root ${toNativePath(root)} has a marker of a different Mirror root (${marker.mirrorRootId}).`) : `Root ${toNativePath(root)} exists but has no Mirror marker yet.`) : `Root ${toNativePath(root)} does not exist yet (it will be created when you set it up).`);
    if (!isWindowsPath(root) && s.hashCommand === 'powershell') parts.push('Note: the root is a POSIX path but the hash command is PowerShell.');
    parts.push(hashToolMessage);
    return {
      ok: true,
      connectionOk: true,
      message: parts.join(' '),
      hostKeyFingerprint: conn.hostKeyFingerprint,
      rootExists,
      markerId: marker?.mirrorRootId,
      markerMatches,
      hashToolOk,
      hashToolMessage,
    };
  } catch (err) {
    return { ok: false, connectionOk: true, hostKeyFingerprint: conn.hostKeyFingerprint, message: err instanceof Error ? err.message : String(err) };
  } finally {
    await conn.close();
  }
}

/**
 * Creates the root folder if needed and ensures it carries a marker. If a marker already exists its
 * id is adopted (so an existing Mirror root can be re-attached). Returns the root id.
 */
export async function provisionRoot(s: PersistedSftp): Promise<{ rootId: string; adopted: boolean; hostKeyFingerprint?: string }> {
  const conn = await SftpConnection.connect(await connectionSettings(s));
  try {
    const root = toSftpPath(s.rootPath);
    if (/^\/[A-Za-z]:$/.test(root) || root === '/') throw new Error('The root cannot be a drive root; use a folder such as D:\\Mirror.');
    await conn.mkdirp(root);
    const existing = await readMarker(conn, root);
    if (existing) return { rootId: existing.mirrorRootId, adopted: true, hostKeyFingerprint: conn.hostKeyFingerprint };
    const marker = await writeMarker(conn, root);
    return { rootId: marker.mirrorRootId, adopted: false, hostKeyFingerprint: conn.hostKeyFingerprint };
  } finally {
    await conn.close();
  }
}

/** Ensures the destination folder for a pair exists directly under the root. */
export async function provisionDestination(s: PersistedSftp, name: string): Promise<{ existed: boolean; itemCount: number }> {
  const v = validateOneDriveName(name);
  if (!v.ok) throw new Error(`Invalid destination name: ${v.reason}`);
  const conn = await SftpConnection.connect(await connectionSettings(s));
  try {
    const root = toSftpPath(s.rootPath);
    const marker = await readMarker(conn, root);
    if (!marker || marker.mirrorRootId !== s.rootId) throw new SftpError('The remote root marker is missing or different; set up the remote root again before adding folders.', 'marker');
    const dest = joinSftp(root, name);
    const st = await conn.stat(dest);
    if (st && !st.isDirectory()) throw new Error(`"${name}" exists under the remote root but is not a folder.`);
    if (st) {
      const items = (await conn.readdir(dest)).filter((e) => !e.name.startsWith('.mirror-')).length;
      return { existed: true, itemCount: items };
    }
    await conn.mkdir(dest);
    return { existed: false, itemCount: 0 };
  } finally {
    await conn.close();
  }
}

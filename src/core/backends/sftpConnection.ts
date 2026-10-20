import { createHash } from 'node:crypto';
import { Client, type ConnectConfig, type SFTPWrapper, type Stats } from 'ssh2';
import { CancelledError } from '../graph/errors.js';

export interface SftpConnectionSettings {
  host: string;
  port: number;
  username: string;
  /** PEM/OpenSSH private key contents. */
  privateKey: string | Buffer;
  passphrase?: string;
  /** Expected host key fingerprint ("SHA256:…"). When undefined, the first seen key is accepted (TOFU) and reported. */
  hostKeyFingerprint?: string;
  readyTimeoutMs?: number;
}

export class SftpError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SftpError';
  }
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** SFTP status codes (RFC draft-ietf-secsh-filexfer-02). */
const SFTP_NO_SUCH_FILE = 2;
const SFTP_PERMISSION_DENIED = 3;

/**
 * Thin promise wrapper around a single ssh2 connection with one SFTP channel and `exec` support.
 * Requests on one SFTP channel are pipelined, so concurrent operations are fine.
 */
export class SftpConnection {
  private client: Client | undefined;
  private sftp: SFTPWrapper | undefined;
  /** Fingerprint of the host key actually presented by the server. */
  hostKeyFingerprint: string | undefined;
  /** Rejects when the connection drops; never resolves. Used to fail pending operations promptly. */
  readonly whenClosed: Promise<never>;
  private signalClosed: ((err: Error) => void) | undefined;
  private closedError: Error | undefined;

  constructor() {
    this.whenClosed = new Promise<never>((_, reject) => {
      this.signalClosed = (err) => {
        if (!this.closedError) {
          this.closedError = err;
          reject(err);
        }
      };
    });
    this.whenClosed.catch(() => {}); // avoid unhandled rejection when nobody is racing
  }

  /** Races an operation against connection loss. */
  guard<T>(p: Promise<T>): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    return Promise.race([p, this.whenClosed]);
  }

  static async connect(settings: SftpConnectionSettings, signal?: AbortSignal): Promise<SftpConnection> {
    const c = new SftpConnection();
    await c.open(settings, signal);
    return c;
  }

  private open(settings: SftpConnectionSettings, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new CancelledError());
      const client = new Client();
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        client.end();
        reject(err);
      };
      const onAbort = (): void => fail(new CancelledError());
      signal?.addEventListener('abort', onAbort, { once: true });

      const config: ConnectConfig = {
        host: settings.host,
        port: settings.port,
        username: settings.username,
        privateKey: settings.privateKey,
        passphrase: settings.passphrase,
        readyTimeout: settings.readyTimeoutMs ?? 20_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 4,
        hostVerifier: (key: Buffer): boolean => {
          const fp = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
          this.hostKeyFingerprint = fp;
          if (settings.hostKeyFingerprint && settings.hostKeyFingerprint !== fp) return false;
          return true;
        },
      };

      client.on('ready', () => {
        // Many small SFTP requests: disable Nagle's algorithm (otherwise ~40–90 ms per request).
        client.setNoDelay(true);
        client.sftp((err, sftp) => {
          if (err) return fail(new SftpError(`SFTP subsystem unavailable: ${err.message}`, 'sftp', err));
          this.client = client;
          this.sftp = sftp;
          signal?.removeEventListener('abort', onAbort);
          settled = true;
          const lost = (why: string): void => this.signalClosed?.(new SftpError(`Connection to ${settings.host} lost (${why})`, 'connectionLost'));
          client.on('close', () => lost('closed'));
          client.on('end', () => lost('ended'));
          sftp.on('close', () => lost('sftp channel closed'));
          resolve();
        });
      });
      client.on('error', (err: Error & { level?: string; code?: string }) => {
        if (settled) return this.signalClosed?.(new SftpError(`Connection error: ${err.message}`, 'connectionLost', err));
        if (/Host key verification failed|hostVerifier/i.test(err.message) || (this.hostKeyFingerprint && settings.hostKeyFingerprint && this.hostKeyFingerprint !== settings.hostKeyFingerprint)) {
          return fail(new SftpError(`The server's host key (${this.hostKeyFingerprint ?? 'unknown'}) does not match the one recorded for this remote disk. Nothing was changed. If the Windows machine was reinstalled, clear the saved fingerprint in Settings.`, 'hostKeyMismatch', err));
        }
        if (err.level === 'client-authentication') return fail(new SftpError(`Authentication failed for ${settings.username}@${settings.host}: check the private key and authorized_keys on the remote machine.`, 'auth', err));
        if (err.level === 'client-timeout') return fail(new SftpError(`Timed out connecting to ${settings.host}:${settings.port}. Is the machine online and reachable through Tailscale?`, 'timeout', err));
        fail(new SftpError(`Cannot connect to ${settings.host}:${settings.port}: ${err.message}`, err.code ?? 'connect', err));
      });
      client.connect(config);
    });
  }

  private get s(): SFTPWrapper {
    if (!this.sftp) throw new SftpError('Not connected', 'closed');
    return this.sftp;
  }

  async close(): Promise<void> {
    this.sftp?.end();
    this.client?.end();
    this.sftp = undefined;
    this.client = undefined;
  }

  /* ----------------------------- SFTP ops ----------------------------- */

  stat(path: string): Promise<Stats | undefined> {
    return this.guard(new Promise((resolve, reject) => {
      this.s.stat(path, (err, st) => {
        if (err) return isNoSuchFile(err) ? resolve(undefined) : reject(wrap(err, `stat ${path}`));
        resolve(st);
      });
    }));
  }

  lstat(path: string): Promise<Stats | undefined> {
    return this.guard(new Promise((resolve, reject) => {
      this.s.lstat(path, (err, st) => {
        if (err) return isNoSuchFile(err) ? resolve(undefined) : reject(wrap(err, `lstat ${path}`));
        resolve(st);
      });
    }));
  }

  readdir(path: string): Promise<Array<{ name: string; attrs: Stats }>> {
    return this.guard(new Promise((resolve, reject) => {
      this.s.readdir(path, (err, list) => {
        if (err) return reject(wrap(err, `readdir ${path}`));
        resolve(list.filter((e) => e.filename !== '.' && e.filename !== '..').map((e) => ({ name: e.filename, attrs: e.attrs })));
      });
    }));
  }

  mkdir(path: string): Promise<void> {
    return this.guard(new Promise((resolve, reject) => this.s.mkdir(path, (err) => (err ? reject(wrap(err, `mkdir ${path}`)) : resolve()))));
  }

  /** mkdir -p for '/'-separated absolute paths (supports '/D:/…'). */
  async mkdirp(path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      if (/^\/[A-Za-z]:$/.test(cur)) continue; // drive root
      const st = await this.stat(cur);
      if (st?.isDirectory()) continue;
      if (st) throw new SftpError(`"${cur}" exists and is not a folder`, 'notDirectory');
      await this.mkdir(cur);
    }
  }

  rmdir(path: string): Promise<void> {
    return this.guard(new Promise((resolve, reject) => this.s.rmdir(path, (err) => (err ? reject(wrap(err, `rmdir ${path}`)) : resolve()))));
  }

  unlink(path: string): Promise<'deleted' | 'notFound'> {
    return this.guard(new Promise((resolve, reject) =>
      this.s.unlink(path, (err) => {
        if (err) return isNoSuchFile(err) ? resolve('notFound') : reject(wrap(err, `unlink ${path}`));
        resolve('deleted');
      }),
    ));
  }

  rename(from: string, to: string): Promise<void> {
    return this.guard(new Promise((resolve, reject) => this.s.rename(from, to, (err) => (err ? reject(wrap(err, `rename ${from} → ${to}`)) : resolve()))));
  }

  /** Atomic replace when the server supports posix-rename@openssh.com; otherwise unlink + rename. */
  async renameReplace(from: string, to: string): Promise<void> {
    const posix = await new Promise<boolean>((resolve) => {
      try {
        this.s.ext_openssh_rename(from, to, (err) => resolve(!err));
      } catch {
        resolve(false);
      }
    });
    if (posix) return;
    await this.unlink(to);
    await this.rename(from, to);
  }

  utimes(path: string, mtimeSeconds: number): Promise<void> {
    return this.guard(new Promise((resolve, reject) => this.s.utimes(path, mtimeSeconds, mtimeSeconds, (err) => (err ? reject(wrap(err, `utimes ${path}`)) : resolve()))));
  }

  readFile(path: string, maxBytes = 50 * 1024 * 1024): Promise<Buffer | undefined> {
    return this.guard(new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const stream = this.s.createReadStream(path);
      stream.on('data', (c: Buffer) => {
        total += c.length;
        if (total > maxBytes) {
          stream.destroy(new SftpError(`${path} is larger than ${maxBytes} bytes`, 'tooLarge'));
          return;
        }
        chunks.push(c);
      });
      stream.on('error', (err: Error) => (isNoSuchFile(err) ? resolve(undefined) : reject(wrap(err, `read ${path}`))));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    }));
  }

  writeFile(path: string, data: Buffer): Promise<void> {
    return this.guard(new Promise((resolve, reject) => {
      const stream = this.s.createWriteStream(path, { flags: 'w' });
      stream.on('error', (err: Error) => reject(wrap(err, `write ${path}`)));
      stream.on('close', () => resolve());
      stream.end(data);
    }));
  }

  /** Write stream starting at `start` (flags 'r+' when resuming, 'w' otherwise). */
  createWriteStream(path: string, start: number): NodeJS.WritableStream {
    return this.s.createWriteStream(path, { flags: start > 0 ? 'r+' : 'w', start, highWaterMark: 1024 * 1024 } as Parameters<SFTPWrapper['createWriteStream']>[1]);
  }

  /* ------------------------------- exec ------------------------------- */

  exec(command: string, stdin?: string, signal?: AbortSignal): Promise<ExecResult> {
    return this.guard(new Promise((resolve, reject) => {
      if (!this.client) return reject(new SftpError('Not connected', 'closed'));
      this.client.exec(command, (err, stream) => {
        if (err) return reject(wrap(err, 'exec'));
        let stdout = '';
        let stderr = '';
        const onAbort = (): void => {
          stream.close();
          reject(new CancelledError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        stream.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
        stream.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
        stream.on('close', (code: number | null) => {
          signal?.removeEventListener('abort', onAbort);
          resolve({ code, stdout, stderr });
        });
        stream.on('error', (e: Error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(wrap(e, 'exec'));
        });
        if (stdin !== undefined) stream.end(stdin);
        else stream.end();
      });
    }));
  }
}

function isNoSuchFile(err: Error & { code?: number | string }): boolean {
  return err.code === SFTP_NO_SUCH_FILE || err.code === 'ENOENT' || /no such file/i.test(err.message);
}

export function isPermissionDenied(err: unknown): boolean {
  const e = err as Error & { code?: number | string };
  return e?.code === SFTP_PERMISSION_DENIED || e?.code === 'EACCES' || /permission denied/i.test(e?.message ?? '');
}

function wrap(err: Error & { code?: number | string }, what: string): SftpError {
  if (err instanceof SftpError) return err;
  return new SftpError(`${what}: ${err.message}`, typeof err.code === 'number' ? `sftp-${err.code}` : err.code, err);
}

/* --------------------------- path helpers --------------------------- */

/**
 * Converts a user-entered root ("D:\Backup\Mirror", "D:/Backup", "/mnt/backup") to the SFTP
 * form used by OpenSSH ('/D:/Backup/Mirror' on Windows, unchanged POSIX path elsewhere).
 */
export function toSftpPath(input: string): string {
  let p = input.trim().replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(p) || /^[A-Za-z]:$/.test(p)) p = '/' + p;
  if (!p.startsWith('/')) throw new SftpError(`Remote path must be absolute (e.g. D:\\Backup\\Mirror or /mnt/backup): "${input}"`, 'badPath');
  p = p.replace(/\/+/g, '/');
  if (p.length > 1) p = p.replace(/\/$/, '');
  return p;
}

/** Native form for commands executed on the remote machine ('D:\Backup\x' on Windows). */
export function toNativePath(sftpPath: string): string {
  const m = /^\/([A-Za-z]:)(\/.*)?$/.exec(sftpPath);
  if (m) return `${m[1]}${(m[2] ?? '/').replace(/\//g, '\\')}`;
  return sftpPath;
}

export function isWindowsPath(sftpPath: string): boolean {
  return /^\/[A-Za-z]:(\/|$)/.test(sftpPath);
}

export function joinSftp(base: string, ...parts: string[]): string {
  return [base.replace(/\/$/, ''), ...parts].join('/');
}

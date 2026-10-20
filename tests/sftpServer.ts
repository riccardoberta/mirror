/**
 * In-process SSH/SFTP server for tests, backed by a real temporary directory.
 *
 * It speaks the real SFTP protocol (ssh2's Server), so the SftpBackend is exercised on the wire.
 * It emulates a Windows OpenSSH host: paths like "/D:/Mirror/..." map onto the temp directory,
 * `rename` fails when the target exists, and `exec` of the PowerShell / sha1sum hashing command
 * is emulated by hashing the files locally. This is a SIMULATION of the remote machine.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Server, utils, type Connection, type SFTPWrapper, type Attributes } from 'ssh2';

const { STATUS_CODE, flagsToString } = utils.sftp;

export interface SftpTestServerOptions {
  /** Emulated drive letter; client paths "/D:/..." map to the base directory. */
  drive?: string;
  /** When true the hashing command exits with an error (hash tool missing). */
  hashToolBroken?: boolean;
  /** Reject public-key authentication (to test error reporting). */
  rejectAuth?: boolean;
}

export class SftpTestServer {
  readonly baseDir: string;
  readonly port: number;
  readonly clientPrivateKey: string;
  readonly hostKeyFingerprint: string;
  readonly ops: Array<{ op: string; path: string; detail?: string }> = [];
  /** Hook: throw or destroy connection on specific operations. */
  onOp?: (op: string, p: string, detail: string | undefined, conn: Connection) => void;
  private server: Server;
  private readonly drive: string;
  hashToolBroken: boolean;
  rejectAuth: boolean;

  private constructor(baseDir: string, port: number, server: Server, clientKey: string, hostFp: string, opts: SftpTestServerOptions) {
    this.baseDir = baseDir;
    this.port = port;
    this.server = server;
    this.clientPrivateKey = clientKey;
    this.hostKeyFingerprint = hostFp;
    this.drive = opts.drive ?? 'D:';
    this.hashToolBroken = opts.hashToolBroken ?? false;
    this.rejectAuth = opts.rejectAuth ?? false;
  }

  static async start(opts: SftpTestServerOptions = {}): Promise<SftpTestServer> {
    const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mirror-sftp-'));
    const hostKeys = utils.generateKeyPairSync('ed25519');
    const clientKeys = utils.generateKeyPairSync('ed25519');
    const clientPub = utils.parseKey(clientKeys.public);
    if (clientPub instanceof Error) throw clientPub;
    const hostPub = utils.parseKey(hostKeys.public);
    if (hostPub instanceof Error) throw hostPub;
    const hostFp = `SHA256:${createHash('sha256').update(hostPub.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;

    let instance: SftpTestServer;
    const server = new Server({ hostKeys: [hostKeys.private] }, (client) => {
      client.on('authentication', (ctx) => {
        if (ctx.method !== 'publickey') return ctx.reject(['publickey']);
        if (instance.rejectAuth) return ctx.reject();
        if (ctx.key.algo !== clientPub.type || !ctx.key.data.equals(clientPub.getPublicSSH())) return ctx.reject();
        ctx.accept();
      });
      client.on('ready', () => {
        (client as unknown as { setNoDelay(v: boolean): void }).setNoDelay(true);
        client.on('session', (accept) => {
          const session = accept();
          session.on('sftp', (acceptSftp) => instance.serveSftp(acceptSftp(), client));
          session.on('exec', (acceptExec, _reject, info) => instance.serveExec(acceptExec(), info.command));
        });
      });
      client.on('error', () => {
        /* client went away */
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    instance = new SftpTestServer(baseDir, port, server, clientKeys.private, hostFp, opts);
    return instance;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await fs.promises.rm(this.baseDir, { recursive: true, force: true });
  }

  /** Maps an SFTP path ("/D:/x/y" or "/x/y") to a local path inside the base directory. */
  local(p: string): string {
    let rel = p;
    if (rel.startsWith(`/${this.drive}`)) rel = rel.slice(this.drive.length + 1);
    rel = rel.replace(/^\/+/, '');
    const abs = path.resolve(this.baseDir, rel);
    if (!abs.startsWith(this.baseDir)) throw new Error('path escapes base dir');
    return abs;
  }

  /** Native (Windows-looking) path for a file in the base dir, as the hashing command would receive it. */
  private fromNative(native: string): string {
    // "D:\x\y" → local
    const m = /^([A-Za-z]:)(.*)$/.exec(native);
    if (!m) return this.local(native.replace(/\\/g, '/'));
    return this.local(`/${m[1]}${m[2]!.replace(/\\/g, '/')}`);
  }

  /** Convenience for tests: tree of the destination as relPath → content | null. */
  tree(sftpDir: string): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    const walk = (dir: string, rel: string): void => {
      for (const name of fs.readdirSync(dir).sort()) {
        if (name === '.mirror-manifest.json' || name === '.mirror-destination.json') continue;
        const abs = path.join(dir, name);
        const r = rel ? `${rel}/${name}` : name;
        if (fs.statSync(abs).isDirectory()) {
          out[r] = null;
          walk(abs, r);
        } else out[r] = fs.readFileSync(abs).toString();
      }
    };
    walk(this.local(sftpDir), '');
    return out;
  }

  /* ------------------------------ SFTP ------------------------------ */

  private serveSftp(sftp: SFTPWrapper, conn: Connection): void {
    const handles = new Map<number, { fd?: number; entries?: Array<{ filename: string; longname: string; attrs: Attributes }>; done?: boolean }>();
    let nextHandle = 1;
    const mk = (h: number): Buffer => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(h);
      return b;
    };
    const rd = (b: Buffer): number => b.readUInt32BE(0);
    const attrsOf = (st: fs.Stats): Attributes => ({ mode: st.mode, uid: st.uid, gid: st.gid, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) });
    const fail = (reqid: number, err: unknown): void => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE, 'No such file');
      if (code === 'EACCES' || code === 'EPERM') return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED, 'Permission denied');
      sftp.status(reqid, STATUS_CODE.FAILURE, (err as Error).message);
    };
    const hook = (op: string, p: string, detail?: string): void => {
      this.ops.push({ op, path: p, detail });
      this.onOp?.(op, p, detail, conn);
    };

    sftp.on('OPEN', (reqid, filename, pflags) => {
      try {
        const flags = flagsToString(pflags) ?? 'r';
        hook('OPEN', filename, flags);
        const fd = fs.openSync(this.local(filename), flags);
        const h = nextHandle++;
        handles.set(h, { fd });
        sftp.handle(reqid, mk(h));
      } catch (e) {
        fail(reqid, e);
      }
    });
    sftp.on('WRITE', (reqid, handle, offset, data) => {
      const h = handles.get(rd(handle));
      if (!h || h.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);
      try {
        hook('WRITE', String(rd(handle)), String(offset));
        fs.writeSync(h.fd, data, 0, data.length, Number(offset));
        sftp.status(reqid, STATUS_CODE.OK);
      } catch (e) {
        fail(reqid, e);
      }
    });
    sftp.on('READ', (reqid, handle, offset, len) => {
      const h = handles.get(rd(handle));
      if (!h || h.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);
      try {
        const buf = Buffer.alloc(len);
        const n = fs.readSync(h.fd, buf, 0, len, Number(offset));
        if (n === 0) return sftp.status(reqid, STATUS_CODE.EOF);
        sftp.data(reqid, buf.subarray(0, n));
      } catch (e) {
        fail(reqid, e);
      }
    });
    sftp.on('CLOSE', (reqid, handle) => {
      const h = handles.get(rd(handle));
      if (h?.fd !== undefined) fs.closeSync(h.fd);
      handles.delete(rd(handle));
      sftp.status(reqid, STATUS_CODE.OK);
    });
    sftp.on('FSTAT', (reqid, handle) => {
      const h = handles.get(rd(handle));
      if (!h || h.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);
      sftp.attrs(reqid, attrsOf(fs.fstatSync(h.fd)));
    });
    const statHandler = (lstat: boolean) => (reqid: number, p: string) => {
      try {
        hook(lstat ? 'LSTAT' : 'STAT', p);
        const st = lstat ? fs.lstatSync(this.local(p)) : fs.statSync(this.local(p));
        sftp.attrs(reqid, attrsOf(st));
      } catch (e) {
        fail(reqid, e);
      }
    };
    sftp.on('STAT', statHandler(false));
    sftp.on('LSTAT', statHandler(true));
    sftp.on('SETSTAT', (reqid, p, attrs) => {
      try {
        hook('SETSTAT', p);
        if (attrs.mtime !== undefined) fs.utimesSync(this.local(p), attrs.atime ?? attrs.mtime, attrs.mtime);
        sftp.status(reqid, STATUS_CODE.OK);
      } catch (e) {
        fail(reqid, e);
      }
    });
    sftp.on('FSETSTAT', (reqid, handle, attrs) => {
      const h = handles.get(rd(handle));
      if (!h || h.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);
      if (attrs.mtime !== undefined) fs.futimesSync(h.fd, attrs.atime ?? attrs.mtime, attrs.mtime);
      sftp.status(reqid, STATUS_CODE.OK);
    });
    sftp.on('OPENDIR', (reqid, p) => {
      try {
        hook('OPENDIR', p);
        const dir = this.local(p);
        if (!fs.statSync(dir).isDirectory()) return sftp.status(reqid, STATUS_CODE.FAILURE, 'Not a directory');
        const entries = fs.readdirSync(dir).map((name) => {
          const st = fs.lstatSync(path.join(dir, name));
          return { filename: name, longname: name, attrs: attrsOf(st) };
        });
        const h = nextHandle++;
        handles.set(h, { entries, done: false });
        sftp.handle(reqid, mk(h));
      } catch (e) {
        fail(reqid, e);
      }
    });
    sftp.on('READDIR', (reqid, handle) => {
      const h = handles.get(rd(handle));
      if (!h || !h.entries) return sftp.status(reqid, STATUS_CODE.FAILURE);
      if (h.done) return sftp.status(reqid, STATUS_CODE.EOF);
      h.done = true;
      sftp.name(reqid, h.entries);
    });
    sftp.on('MKDIR', (reqid, p) => {
      try {
        hook('MKDIR', p);
        fs.mkdirSync(this.local(p));
        sftp.status(reqid, STATUS_CODE.OK);
      } catch (e) {
        fail(reqid, e);
      }
    });
    sftp.on('RMDIR', (reqid, p) => {
      try {
        hook('RMDIR', p);
        fs.rmdirSync(this.local(p));
        sftp.status(reqid, STATUS_CODE.OK);
      } catch (e) {
        fail(reqid, e);
      }
    });
    sftp.on('REMOVE', (reqid, p) => {
      try {
        hook('REMOVE', p);
        fs.unlinkSync(this.local(p));
        sftp.status(reqid, STATUS_CODE.OK);
      } catch (e) {
        fail(reqid, e);
      }
    });
    sftp.on('RENAME', (reqid, from, to) => {
      try {
        hook('RENAME', from, to);
        if (fs.existsSync(this.local(to))) return sftp.status(reqid, STATUS_CODE.FAILURE, 'Target exists'); // Windows semantics
        fs.renameSync(this.local(from), this.local(to));
        sftp.status(reqid, STATUS_CODE.OK);
      } catch (e) {
        fail(reqid, e);
      }
    });
    sftp.on('REALPATH', (reqid, p) => {
      sftp.name(reqid, [{ filename: p, longname: p, attrs: {} as Attributes }]);
    });
  }

  /* ------------------------------ exec ------------------------------ */

  private serveExec(stream: import('ssh2').ServerChannel, command: string): void {
    const chunks: Buffer[] = [];
    stream.on('data', (d: Buffer) => chunks.push(d));
    stream.on('end', () => {
      this.ops.push({ op: 'EXEC', path: command.slice(0, 40) });
      const isPowershell = /^powershell .*-EncodedCommand /.test(command);
      const isSha1 = /sha1sum/.test(command);
      if (this.hashToolBroken || (!isPowershell && !isSha1)) {
        stream.stderr.write(isPowershell ? "'powershell' is not recognized as an internal or external command\r\n" : 'sh: command not found\n');
        stream.exit(1);
        stream.end();
        return;
      }
      const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/).filter(Boolean);
      const out: string[] = [];
      for (const l of lines) {
        const native = Buffer.from(l, 'base64').toString('utf8');
        try {
          const abs = this.fromNative(native);
          const st = fs.statSync(abs);
          if (st.isDirectory()) {
            out.push(`${l}\tMISSING\t0`);
            continue;
          }
          const sha1 = createHash('sha1').update(fs.readFileSync(abs)).digest('hex').toUpperCase();
          out.push(`${l}\t${sha1}\t${st.size}`);
        } catch {
          out.push(`${l}\tMISSING\t0`);
        }
      }
      stream.write(out.join('\r\n') + '\r\n');
      stream.exit(0);
      stream.end();
    });
  }
}

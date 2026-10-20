/**
 * REAL verification of the remote-disk (SFTP) backend against your actual Windows machine.
 *
 * Works ONLY inside a freshly created folder "Mirror-Test-<timestamp>" under the root you give
 * (it gets its own marker), plus a temporary local folder. Nothing else is read or written.
 * The test folder is deleted at the end unless --keep is passed.
 *
 * Usage (on your Mac, from the project folder):
 *   MIRROR_SFTP_HOST=desktop.tail1234.ts.net MIRROR_SFTP_USER=ricky \
 *   MIRROR_SFTP_KEY=~/.ssh/id_ed25519 MIRROR_SFTP_ROOT='D:\Mirror' npm run test:real:sftp
 * Optional: MIRROR_SFTP_PORT (22), MIRROR_SFTP_PASSPHRASE, MIRROR_SFTP_HASH (powershell|sha1sum|none),
 *           MIRROR_SFTP_FINGERPRINT (SHA256:… — when set, the server key must match).
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SftpBackend, writeMarker, readMarker, type HashCommand } from '../src/core/backends/sftp.js';
import { SftpConnection, joinSftp, toNativePath, toSftpPath } from '../src/core/backends/sftpConnection.js';
import { HashCache } from '../src/core/hashing.js';
import { runMirror } from '../src/core/mirror.js';
import { DEFAULT_ENGINE_OPTIONS, type PairSpec, type RunResult } from '../src/core/types.js';

const KEEP = process.argv.includes('--keep');
const env = (k: string, def?: string): string => {
  const v = process.env[k] ?? def;
  if (v === undefined) {
    console.error(`Missing ${k}`);
    process.exit(2);
  }
  return v;
};

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const host = env('MIRROR_SFTP_HOST');
  const username = env('MIRROR_SFTP_USER');
  const keyPath = env('MIRROR_SFTP_KEY', '~/.ssh/id_ed25519').replace(/^~(?=$|\/)/, os.homedir());
  const rootInput = env('MIRROR_SFTP_ROOT');
  const port = Number(process.env.MIRROR_SFTP_PORT ?? 22);
  const hashCommand = (process.env.MIRROR_SFTP_HASH ?? 'powershell') as HashCommand;
  const connection = {
    host,
    port,
    username,
    privateKey: await fs.readFile(keyPath, 'utf8'),
    passphrase: process.env.MIRROR_SFTP_PASSPHRASE,
    hostKeyFingerprint: process.env.MIRROR_SFTP_FINGERPRINT,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = toSftpPath(rootInput);
  const testRoot = joinSftp(base, `Mirror-Test-${stamp}`);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mirror-real-sftp-'));
  const src = path.join(tmp, 'Source');

  console.log(`Connecting to ${username}@${host}:${port}…`);
  const conn = await SftpConnection.connect(connection);
  console.log(`Host key: ${conn.hostKeyFingerprint}`);
  await conn.mkdirp(testRoot);
  const marker = await writeMarker(conn, testRoot);
  await conn.mkdir(joinSftp(testRoot, 'Source'));
  // Sentinels outside the destination (inside the test root only).
  await conn.writeFile(joinSftp(testRoot, 'OUTSIDE-sentinel.txt'), Buffer.from('must survive'));
  await conn.mkdir(joinSftp(testRoot, 'OtherPair'));
  await conn.writeFile(joinSftp(testRoot, 'OtherPair', 'keep.txt'), Buffer.from('keep'));
  console.log(`Test root created: ${toNativePath(testRoot)} (marker ${marker.mirrorRootId}). Nothing outside it will be touched.`);

  const report: string[] = [
    `# Mirror — REAL remote-disk (SFTP) test report`,
    ``,
    `Date: ${new Date().toISOString()}  `,
    `Machine: ${username}@${host}:${port} (host key ${conn.hostKeyFingerprint})  `,
    `Test root: ${toNativePath(testRoot)}  `,
    `Hash command: ${hashCommand}  `,
    `These checks were executed against the real remote machine over SSH/SFTP, not a simulation.`,
    ``,
  ];

  const pair: PairSpec = { id: 'real-sftp', label: 'Source', sourcePath: src, destinationName: 'Source', target: { kind: 'sftp', destinationName: 'Source' } };
  const hashCache = new HashCache();
  const run = (): Promise<RunResult> =>
    runMirror({
      pairs: [pair],
      backendFor: async () => new SftpBackend({ connection: { ...connection, hostKeyFingerprint: conn.hostKeyFingerprint }, rootPath: toNativePath(testRoot), rootId: marker.mirrorRootId, destinationName: 'Source', hashCommand }),
      options: { ...DEFAULT_ENGINE_OPTIONS, uploadConcurrency: 2 },
      hashCache,
      onProgress: (p) => process.stdout.write(`\r    ${p.phase.padEnd(16)} ${p.currentPath ?? p.message ?? ''}`.slice(0, 110).padEnd(110)),
    });
  const tree = async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    const walk = async (dir: string, rel: string): Promise<void> => {
      for (const e of await conn.readdir(dir)) {
        if (e.name.startsWith('.mirror-')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.attrs.isDirectory()) {
          out[r] = '<dir>';
          await walk(joinSftp(dir, e.name), r);
        } else out[r] = `${e.attrs.size}`;
      }
    };
    await walk(joinSftp(testRoot, 'Source'), '');
    return out;
  };
  const write = async (rel: string, content: string | Buffer | null): Promise<void> => {
    const abs = path.join(src, rel);
    if (content === null) await fs.mkdir(abs, { recursive: true });
    else {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    }
  };
  const sentinelsIntact = async (): Promise<boolean> =>
    (await conn.readFile(joinSftp(testRoot, 'OUTSIDE-sentinel.txt')))?.toString() === 'must survive' && (await conn.readFile(joinSftp(testRoot, 'OtherPair', 'keep.txt')))?.toString() === 'keep';

  try {
    console.log('\n[1] First copy');
    const big = Buffer.alloc(6 * 1024 * 1024 + 123);
    for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24;
    await write('a.txt', 'alpha');
    await write('docs/b.txt', 'bravo');
    await write('docs/deep/c.txt', 'charlie');
    await write('docs/empty', null);
    await write('big.bin', big);
    let r = await run();
    console.log();
    let t = await tree();
    check('first copy completed', r.outcome === 'completed', r.pairs[0]?.issues.map((i) => `${i.code}: ${i.message}`).join('; '));
    check('empty folder created', t['docs/empty'] === '<dir>');
    check('large file uploaded', t['big.bin'] === String(big.length), t['big.bin']);
    check('remote hashing worked (no hashing warning)', !r.pairs[0]?.issues.some((i) => i.code === 'remote.hashingUnavailable' || i.code === 'verify.noHash'));
    check('sentinels untouched', await sentinelsIntact());

    console.log('[2] Second run (no changes)');
    r = await run();
    console.log();
    check('no-op run completed', r.outcome === 'completed');
    check('no-op transferred nothing', r.pairs[0]?.counters.filesUploaded === 0 && r.pairs[0]?.counters.filesDeleted === 0, JSON.stringify(r.pairs[0]?.counters));

    console.log('[3] Update (same size + grown)');
    await write('a.txt', 'alphA');
    await write('docs/b.txt', 'bravo-longer');
    r = await run();
    console.log();
    check('update completed', r.outcome === 'completed');
    check('exactly 2 files re-uploaded', r.pairs[0]?.counters.filesUploaded === 2, String(r.pairs[0]?.counters.filesUploaded));

    console.log('[4] Rename / move');
    await fs.mkdir(path.join(src, 'archive'), { recursive: true });
    await fs.rename(path.join(src, 'big.bin'), path.join(src, 'archive', 'big-renamed.bin'));
    r = await run();
    console.log();
    t = await tree();
    check('rename completed', r.outcome === 'completed');
    check('rename used a move (no re-upload)', r.pairs[0]?.counters.moves === 1 && r.pairs[0]?.counters.filesUploaded === 0, JSON.stringify(r.pairs[0]?.counters));
    check('renamed file present at new path', t['archive/big-renamed.bin'] === String(big.length) && !t['big.bin']);

    console.log('[5] Delete');
    await fs.rm(path.join(src, 'docs'), { recursive: true });
    r = await run();
    console.log();
    t = await tree();
    check('delete completed', r.outcome === 'completed');
    check('deleted subtree gone remotely', !Object.keys(t).some((k) => k.startsWith('docs')), Object.keys(t).join(', '));
    check('sentinels untouched after deletions', await sentinelsIntact());

    console.log('[6] Remote changes are reverted');
    await conn.writeFile(joinSftp(testRoot, 'Source', 'a.txt'), Buffer.from('edited on the remote machine'));
    await conn.writeFile(joinSftp(testRoot, 'Source', 'added-remotely.txt'), Buffer.from('x'));
    r = await run();
    console.log();
    t = await tree();
    check('remote edit overwritten', t['a.txt'] === '5', t['a.txt']);
    check('remote extra removed', t['added-remotely.txt'] === undefined);

    console.log('[7] Empty source guard');
    await fs.rm(src, { recursive: true });
    await fs.mkdir(src);
    r = await run();
    console.log();
    check('empty source refused', r.pairs[0]?.outcome === 'aborted' && r.pairs[0]?.issues[0]?.code === 'plan.emptySource');
    check('destination intact after refusal', Object.keys(await tree()).length > 0);

    console.log('[8] Marker check');
    await conn.unlink(joinSftp(testRoot, '.mirror-destination.json'));
    r = await run();
    console.log();
    check('missing marker aborts the pair', r.pairs[0]?.outcome === 'aborted' && r.pairs[0]?.issues[0]?.code === 'destination.markerMissing');
    await writeMarker(conn, testRoot, marker.mirrorRootId);
    check('marker restored', (await readMarker(conn, testRoot))?.mirrorRootId === marker.mirrorRootId);
    check('sentinels untouched at the end', await sentinelsIntact());
  } catch (err) {
    check('unexpected error', false, String(err));
  } finally {
    report.push(`| Check | Result | Detail |`, `|---|---|---|`);
    for (const c of checks) report.push(`| ${c.name} | ${c.ok ? 'PASS' : 'FAIL'} | ${c.detail.replace(/\|/g, '/')} |`);
    const failed = checks.filter((c) => !c.ok).length;
    report.push(``, `**${checks.length - failed}/${checks.length} checks passed.**`);
    if (!KEEP) {
      const rm = async (dir: string): Promise<void> => {
        for (const e of await conn.readdir(dir)) {
          const p = joinSftp(dir, e.name);
          if (e.attrs.isDirectory()) await rm(p);
          else await conn.unlink(p);
        }
        await conn.rmdir(dir);
      };
      await rm(testRoot);
      report.push(``, `Test root deleted.`);
    } else {
      report.push(``, `Test root kept (--keep).`);
    }
    await conn.close();
    const reportFile = path.join(process.cwd(), `real-test-sftp-report-${stamp}.md`);
    await fs.writeFile(reportFile, report.join('\n'));
    await fs.rm(tmp, { recursive: true, force: true });
    console.log(`\nReport written to ${reportFile}`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

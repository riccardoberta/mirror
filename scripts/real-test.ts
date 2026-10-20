/**
 * REAL OneDrive verification of the Mirror engine.
 *
 * This script talks to the real Microsoft Graph with your account. It works ONLY inside a dedicated,
 * freshly created root folder ("Mirror-Test-<timestamp>" at the top of your OneDrive) and a temporary
 * local folder; it never reads or modifies anything else. At the end the test root is deleted
 * (moved to the OneDrive recycle bin) unless you pass --keep.
 *
 * Usage (on your Mac, from the project folder, after `npm install`):
 *   MIRROR_CLIENT_ID=<app id> MIRROR_TENANT=organizations npm run test:real
 * or, if the app is already configured, the script reads clientId/tenant from the app's config.json.
 *
 * Sign-in happens in your browser (MSAL, PKCE, loopback). The token cache for this script is a plain
 * file in a private temp folder and is deleted when the script ends.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { PublicClientApplication, type AccountInfo } from '@azure/msal-node';
import { OneDriveBackend } from '../src/core/backends/onedrive.js';
import { GraphClient } from '../src/core/graph/client.js';
import { HashCache } from '../src/core/hashing.js';
import { runMirror } from '../src/core/mirror.js';
import { listRemoteTree } from '../src/core/remoteInventory.js';
import { DEFAULT_ENGINE_OPTIONS, type PairSpec, type RunResult } from '../src/core/types.js';

const SCOPES = ['Files.ReadWrite', 'User.Read', 'offline_access'];
const KEEP = process.argv.includes('--keep');

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

async function readAppConfig(): Promise<{ clientId?: string; tenant?: string }> {
  const candidates = [
    path.join(os.homedir(), 'Library', 'Application Support', 'Mirror', 'config.json'),
    path.join(os.homedir(), 'Library', 'Application Support', 'mirror', 'config.json'),
    path.join(process.env.APPDATA ?? '', 'Mirror', 'config.json'),
    path.join(os.homedir(), '.config', 'Mirror', 'config.json'),
    path.join(os.homedir(), '.config', 'mirror', 'config.json'),
  ];
  for (const c of candidates) {
    try {
      const j = JSON.parse(await fs.readFile(c, 'utf8')) as { settings?: { clientId?: string; tenant?: string } };
      if (j.settings?.clientId) return { clientId: j.settings.clientId, tenant: j.settings.tenant };
    } catch {
      /* next */
    }
  }
  return {};
}

function openBrowser(url: string): Promise<void> {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  return Promise.resolve();
}

async function main(): Promise<void> {
  const fromApp = await readAppConfig();
  const clientId = process.env.MIRROR_CLIENT_ID ?? fromApp.clientId;
  const tenant = process.env.MIRROR_TENANT ?? fromApp.tenant ?? 'organizations';
  if (!clientId) {
    console.error('Set MIRROR_CLIENT_ID (and optionally MIRROR_TENANT), or configure the Mirror app first.');
    process.exit(2);
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mirror-real-'));
  const cacheFile = path.join(tmpRoot, 'msal-cache.json');
  const pca = new PublicClientApplication({
    auth: { clientId, authority: `https://login.microsoftonline.com/${tenant}` },
    cache: {
      cachePlugin: {
        beforeCacheAccess: async (ctx) => {
          try {
            ctx.tokenCache.deserialize(await fs.readFile(cacheFile, 'utf8'));
          } catch {
            /* empty */
          }
        },
        afterCacheAccess: async (ctx) => {
          if (ctx.cacheHasChanged) await fs.writeFile(cacheFile, ctx.tokenCache.serialize(), { mode: 0o600 });
        },
      },
    },
  });

  console.log('Signing in (browser)…');
  const auth = await pca.acquireTokenInteractive({ scopes: SCOPES, openBrowser, prompt: 'select_account' });
  const account = auth.account as AccountInfo;
  let token = auth.accessToken;
  const client = new GraphClient({
    tokenProvider: {
      getAccessToken: async (force) => {
        if (force) token = (await pca.acquireTokenSilent({ account, scopes: SCOPES.slice(0, 2), forceRefresh: true })).accessToken;
        return token;
      },
    },
    log: (m) => console.log(`    graph: ${m}`),
  });

  const me = await client.getMe();
  const drive = await client.getMyDrive();
  console.log(`Account: ${me.userPrincipalName} · drive ${drive.driveType} (${drive.id})`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rootName = `Mirror-Test-${stamp}`;
  const driveRoot = await client.getRoot(drive.id);
  const testRoot = await client.createFolder(drive.id, driveRoot.id, rootName, 'fail');
  console.log(`Test root created on OneDrive: /${rootName} (${testRoot.id}). Nothing outside it will be touched.`);

  const report: string[] = [
    `# Mirror — REAL OneDrive test report`,
    ``,
    `Date: ${new Date().toISOString()}  `,
    `Account: ${me.userPrincipalName} (${drive.driveType})  `,
    `Test root: /${rootName} (${testRoot.id})  `,
    `These checks were executed against the real Microsoft Graph API, not a simulation.`,
    ``,
  ];

  try {
    // Sentinels: a file and a folder inside the test root but OUTSIDE the pair destination.
    const sentinel = await client.uploadSmall(drive.id, testRoot.id, 'OUTSIDE-sentinel.txt', Buffer.from('must survive'));
    const siblingFolder = await client.createFolder(drive.id, testRoot.id, 'OtherPair', 'fail');
    const siblingFile = await client.uploadSmall(drive.id, siblingFolder.id, 'keep.txt', Buffer.from('keep'));

    const dest = await client.createFolder(drive.id, testRoot.id, 'Source', 'fail');
    const src = path.join(tmpRoot, 'Source');
    const pair: PairSpec = { id: 'real-1', label: 'Source', sourcePath: src, destinationName: 'Source', target: { kind: 'onedrive', driveId: drive.id, destinationId: dest.id, rootId: testRoot.id } };
    const hashCache = new HashCache();
    const run = (opts: Partial<typeof DEFAULT_ENGINE_OPTIONS> = {}): Promise<RunResult> => {
      const options = { ...DEFAULT_ENGINE_OPTIONS, uploadConcurrency: 2, largeFileThreshold: 1024 * 1024, uploadChunkSize: 320 * 1024 * 4, ...opts };
      return runMirror({
        pairs: [pair],
        backendFor: async () => new OneDriveBackend(client, { driveId: drive.id, destinationId: dest.id, rootId: testRoot.id, destinationName: 'Source' }, options),
        options,
        hashCache,
        onProgress: (p) => process.stdout.write(`\r    ${p.phase.padEnd(16)} ${p.currentPath ?? p.message ?? ''}`.slice(0, 110).padEnd(110)),
      });
    };
    const remoteTree = async (): Promise<Record<string, string>> => {
      const inv = await listRemoteTree(client, drive.id, dest.id);
      const out: Record<string, string> = {};
      for (const e of inv.entries.values()) out[e.relPath] = e.kind === 'folder' ? '<dir>' : `${e.size}:${e.quickXorHash ?? '?'}`;
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
    const sentinelsIntact = async (): Promise<boolean> => {
      const a = await client.getItem(drive.id, sentinel.id);
      const b = await client.getItem(drive.id, siblingFile.id);
      return Boolean(a && b && a.parentReference?.id === testRoot.id && b.parentReference?.id === siblingFolder.id);
    };

    // 1. First copy
    console.log('\n[1] First copy');
    const big = Buffer.alloc(3 * 1024 * 1024 + 777);
    for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24;
    await write('a.txt', 'alpha');
    await write('docs/b.txt', 'bravo');
    await write('docs/deep/c.txt', 'charlie');
    await write('docs/empty', null);
    await write('big.bin', big);
    let r = await run();
    console.log();
    let t = await remoteTree();
    check('first copy completed', r.outcome === 'completed', r.pairs[0]?.issues.map((i) => i.message).join('; '));
    check('empty folder created', t['docs/empty'] === '<dir>');
    check('large file uploaded via upload session', t['big.bin']?.startsWith(`${big.length}:`) === true, t['big.bin']);
    check('sentinels untouched', await sentinelsIntact());

    // 2. No-op
    console.log('[2] Second run (no changes)');
    r = await run();
    console.log();
    check('no-op run completed', r.outcome === 'completed');
    check('no-op uploaded nothing', r.pairs[0]?.counters.filesUploaded === 0 && r.pairs[0]?.counters.filesDeleted === 0, JSON.stringify(r.pairs[0]?.counters));

    // 3. Update (same size, different content) + grown file
    console.log('[3] Update');
    await write('a.txt', 'alphA');
    await write('docs/b.txt', 'bravo-longer');
    r = await run();
    console.log();
    t = await remoteTree();
    check('update completed', r.outcome === 'completed');
    check('only 2 files re-uploaded', r.pairs[0]?.counters.filesUploaded === 2, String(r.pairs[0]?.counters.filesUploaded));

    // 4. Rename + move
    console.log('[4] Rename / move');
    await fs.mkdir(path.join(src, 'archive'), { recursive: true });
    await fs.rename(path.join(src, 'big.bin'), path.join(src, 'archive', 'big-renamed.bin'));
    r = await run();
    console.log();
    t = await remoteTree();
    check('rename completed', r.outcome === 'completed');
    check('rename used a move (no re-upload)', r.pairs[0]?.counters.moves === 1 && r.pairs[0]?.counters.filesUploaded === 0, JSON.stringify(r.pairs[0]?.counters));
    check('renamed file present at new path', Boolean(t['archive/big-renamed.bin']) && !t['big.bin']);

    // 5. Delete
    console.log('[5] Delete');
    await fs.rm(path.join(src, 'docs'), { recursive: true });
    r = await run();
    console.log();
    t = await remoteTree();
    check('delete completed', r.outcome === 'completed');
    check('deleted subtree gone remotely', !Object.keys(t).some((k) => k.startsWith('docs')), Object.keys(t).join(', '));
    check('sentinels untouched after deletions', await sentinelsIntact());

    // 6. Remote edit is overwritten / remote extra is removed (Mac authoritative)
    console.log('[6] Remote changes are reverted');
    await client.uploadSmall(drive.id, dest.id, 'a.txt', Buffer.from('edited on OneDrive'));
    await client.uploadSmall(drive.id, dest.id, 'added-on-web.txt', Buffer.from('web'));
    r = await run();
    console.log();
    t = await remoteTree();
    check('remote edit overwritten', t['a.txt']?.startsWith('5:') === true, t['a.txt']);
    check('remote extra removed', t['added-on-web.txt'] === undefined);

    // 7. Empty source guard
    console.log('[7] Empty source guard');
    await fs.rm(src, { recursive: true });
    await fs.mkdir(src);
    r = await run();
    console.log();
    check('empty source refused', r.pairs[0]?.outcome === 'aborted' && r.pairs[0]?.issues[0]?.code === 'plan.emptySource');
    check('destination intact after refusal', Object.keys(await remoteTree()).length > 0);

    // 8. Missing source
    console.log('[8] Missing source');
    await fs.rm(src, { recursive: true });
    r = await run();
    console.log();
    check('missing source aborts pair', r.pairs[0]?.outcome === 'aborted' && r.pairs[0]?.issues[0]?.code === 'source.missing');
    check('destination intact after missing source', Object.keys(await remoteTree()).length > 0);
    check('sentinels untouched at the end', await sentinelsIntact());
  } catch (err) {
    check('unexpected error', false, String(err));
  } finally {
    report.push(`| Check | Result | Detail |`, `|---|---|---|`);
    for (const c of checks) report.push(`| ${c.name} | ${c.ok ? 'PASS' : 'FAIL'} | ${c.detail.replace(/\|/g, '/')} |`);
    const failed = checks.filter((c) => !c.ok).length;
    report.push(``, `**${checks.length - failed}/${checks.length} checks passed.**`);
    if (!KEEP) {
      await client.deleteItem(drive.id, testRoot.id);
      report.push(``, `Test root deleted (moved to the OneDrive recycle bin).`);
    } else {
      report.push(``, `Test root kept on OneDrive (--keep).`);
    }
    const reportFile = path.join(process.cwd(), `real-test-report-${stamp}.md`);
    await fs.writeFile(reportFile, report.join('\n'));
    await fs.rm(tmpRoot, { recursive: true, force: true });
    console.log(`\nReport written to ${reportFile}`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

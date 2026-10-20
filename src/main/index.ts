import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { GraphClient } from '../core/graph/client.js';
import { describeError } from '../core/graph/errors.js';
import type { Progress } from '../core/types.js';
import { IPC, type AddFoldersResult, type AppState, type AppSettings, type PairConfig, type RootCandidate, type SftpSettingsPatch, type SftpTestResult, type TargetKind } from '../shared/ipc.js';
import { AuthService, describeSecureStorage, normalizeTenant } from './auth.js';
import { ConfigStore, DEFAULT_SFTP, type PersistedSftp, needsAcknowledgement, oneDriveReady, sftpDestinationId, sftpReady } from './config.js';
import { Logger } from './log.js';
import { createRoot, identifyAccount, listRootCandidates, provisionDestination, selectExistingRoot, uniqueDestinationName } from './provisioning.js';
import { RunController } from './runController.js';
import * as sftpSetup from './sftpSetup.js';

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

// Allow tests/screenshots to use an isolated user-data folder.
if (process.env.MIRROR_USER_DATA) app.setPath('userData', process.env.MIRROR_USER_DATA);

const userData = app.getPath('userData');
const log = new Logger(path.join(userData, 'logs'));
const config = new ConfigStore(path.join(userData, 'config.json'));
const auth = new AuthService(path.join(userData, 'msal-cache.bin'), log);
const runs = new RunController();
let win: BrowserWindow | undefined;
let progress: Progress | undefined;

const single = app.requestSingleInstanceLock();
if (!single) app.quit();

function graphClient(): GraphClient {
  return new GraphClient({ tokenProvider: auth, log: (m) => log.info(`graph: ${m}`) });
}

function configureAuth(): void {
  const c = config.get();
  auth.configure({ clientId: c.settings.clientId, tenant: c.settings.tenant }, c.account?.homeAccountId);
}

function publicSftp(s: PersistedSftp | undefined): AppState['sftp'] {
  if (!s) return undefined;
  const { passphraseEncrypted, ...rest } = s;
  return { ...rest, hasPassphrase: Boolean(passphraseEncrypted) };
}

function buildState(): AppState {
  const c = config.get();
  return {
    version: app.getVersion(),
    platform: process.platform,
    settings: c.settings,
    account: c.account,
    root: c.root,
    sftp: publicSftp(c.sftp),
    oneDriveReady: oneDriveReady(c),
    sftpReady: sftpReady(c),
    pairs: c.pairs,
    acknowledgement: c.acknowledgement,
    needsAcknowledgement: needsAcknowledgement(c),
    running: runs.running,
    progress,
    lastRun: c.lastRun,
    lastSuccessfulRun: c.lastSuccessfulRun,
    secureStorage: describeSecureStorage(),
    logDirectory: log.directory,
  };
}

function broadcast(): void {
  win?.webContents.send(IPC.stateChanged, buildState());
}

function assertIdle(what: string): void {
  if (runs.running) throw new Error(`Cannot ${what} while a Clone is running.`);
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc(): void {
  ipcMain.handle(IPC.getState, () => buildState());

  ipcMain.handle(IPC.updateSettings, async (_e, patch: Partial<AppSettings>) => {
    if (patch.tenant !== undefined) normalizeTenant(patch.tenant); // validate
    if (patch.uploadConcurrency !== undefined) patch.uploadConcurrency = Math.min(8, Math.max(1, Math.round(patch.uploadConcurrency)));
    await config.update((c) => {
      c.settings = { ...c.settings, ...patch };
    });
    configureAuth();
    broadcast();
    return buildState();
  });

  /* ---------------- OneDrive ---------------- */

  ipcMain.handle(IPC.connect, async () => {
    assertIdle('change the account');
    configureAuth();
    const msalAccount = await auth.signIn();
    const info = await identifyAccount(graphClient(), msalAccount.homeAccountId);
    await config.update((c) => {
      const changedUser = c.account && c.account.userId !== info.userId;
      c.account = info;
      if (changedUser) {
        // A different account: the stored root/destinations belong to another drive.
        c.root = undefined;
        c.acknowledgement = undefined;
        for (const p of c.pairs) if (p.target === 'onedrive') p.destinationId = '';
      }
    });
    configureAuth();
    log.info(`connected account ${info.username} (drive ${info.driveType})`);
    broadcast();
    return buildState();
  });

  ipcMain.handle(IPC.disconnect, async () => {
    assertIdle('disconnect');
    await auth.signOut();
    await config.update((c) => {
      c.account = undefined;
      c.acknowledgement = undefined;
    });
    log.info('disconnected account');
    broadcast();
    return buildState();
  });

  ipcMain.handle(IPC.listRootCandidates, async (): Promise<RootCandidate[]> => {
    const c = config.get();
    if (!c.account) throw new Error('Connect OneDrive first.');
    return listRootCandidates(graphClient(), c.account.driveId);
  });

  ipcMain.handle(IPC.selectRoot, async (_e, choice: { id: string } | { createName: string }) => {
    assertIdle('change the root');
    const c = config.get();
    if (!c.account) throw new Error('Connect OneDrive first.');
    const client = graphClient();
    const root = 'id' in choice ? await selectExistingRoot(client, c.account.driveId, choice.id) : await createRoot(client, c.account.driveId, choice.createName);
    if (root.id === c.root?.id) return buildState();
    // Re-provision every OneDrive destination under the new root (old folders are left untouched).
    const oneDrivePairs = c.pairs.filter((p) => p.target === 'onedrive');
    const reprovisioned: Record<string, string> = {};
    for (const p of oneDrivePairs) {
      const item = await provisionDestination(client, root, p.destinationName, oneDrivePairs, p.id);
      reprovisioned[p.id] = item.id;
    }
    await config.update((cfg) => {
      cfg.root = root;
      for (const p of cfg.pairs) if (p.target === 'onedrive') p.destinationId = reprovisioned[p.id] ?? p.destinationId;
      cfg.acknowledgement = undefined; // destinations changed → confirm again
    });
    log.info(`OneDrive root folder set to "${root.name}" (${root.id})`);
    broadcast();
    return buildState();
  });

  /* ---------------- Remote disk (SFTP) ---------------- */

  ipcMain.handle(IPC.updateSftpSettings, async (_e, patch: SftpSettingsPatch) => {
    assertIdle('change the remote disk settings');
    await config.update((c) => {
      const prev: PersistedSftp = c.sftp ?? { ...DEFAULT_SFTP };
      const next: PersistedSftp = { ...prev };
      if (patch.host !== undefined) next.host = patch.host.trim();
      if (patch.port !== undefined) next.port = Math.min(65535, Math.max(1, Math.round(patch.port) || 22));
      if (patch.username !== undefined) next.username = patch.username.trim();
      if (patch.privateKeyPath !== undefined) next.privateKeyPath = patch.privateKeyPath.trim();
      if (patch.hashCommand !== undefined) next.hashCommand = patch.hashCommand;
      if (patch.passphrase !== undefined) {
        next.passphraseEncrypted = patch.passphrase ? sftpSetup.encryptPassphrase(patch.passphrase) : undefined;
      }
      if (patch.hostKeyFingerprint === null) next.hostKeyFingerprint = undefined;
      else if (typeof patch.hostKeyFingerprint === 'string') next.hostKeyFingerprint = patch.hostKeyFingerprint;
      const connectionChanged = prev.host !== next.host || prev.port !== next.port;
      if (connectionChanged) next.hostKeyFingerprint = undefined; // a different machine → verify its key again
      if (patch.rootPath !== undefined && patch.rootPath.trim() !== prev.rootPath) {
        next.rootPath = patch.rootPath.trim();
        next.rootId = undefined; // must be provisioned again
        c.acknowledgement = undefined;
      }
      next.hasPassphrase = Boolean(next.passphraseEncrypted);
      c.sftp = next;
    });
    broadcast();
    return buildState();
  });

  ipcMain.handle(IPC.testSftp, async (): Promise<SftpTestResult> => {
    const c = config.get();
    if (!c.sftp) throw new Error('Enter the remote disk settings first.');
    const result = await sftpSetup.testConnection(c.sftp);
    let fingerprintRecorded = false;
    if (result.connectionOk && result.hostKeyFingerprint && !c.sftp.hostKeyFingerprint) {
      // Trust on first use: record the fingerprint presented by the server; later changes are refused.
      await config.update((cfg) => {
        if (cfg.sftp) cfg.sftp.hostKeyFingerprint = result.hostKeyFingerprint;
      });
      fingerprintRecorded = true;
      broadcast();
    }
    log.info(`remote disk test: ${result.ok ? 'ok' : 'failed'} — ${result.message}`);
    const { connectionOk: _c, ...rest } = result;
    return { ...rest, fingerprintRecorded };
  });

  ipcMain.handle(IPC.provisionSftpRoot, async () => {
    assertIdle('change the remote root');
    const c = config.get();
    if (!c.sftp) throw new Error('Enter the remote disk settings first.');
    const r = await sftpSetup.provisionRoot(c.sftp);
    const changed = c.sftp.rootId !== r.rootId;
    await config.update((cfg) => {
      if (!cfg.sftp) return;
      cfg.sftp.rootId = r.rootId;
      if (!cfg.sftp.hostKeyFingerprint && r.hostKeyFingerprint) cfg.sftp.hostKeyFingerprint = r.hostKeyFingerprint;
      if (changed) cfg.acknowledgement = undefined;
    });
    // Make sure every SFTP pair has its destination folder under this root.
    const cfg = config.get();
    for (const p of cfg.pairs.filter((p) => p.target === 'sftp')) {
      await sftpSetup.provisionDestination(cfg.sftp!, p.destinationName);
      await config.update(() => {
        p.destinationId = sftpDestinationId(r.rootId, p.destinationName);
      });
    }
    log.info(`remote root ${r.adopted ? 'adopted' : 'created'} at ${c.sftp.host}:${c.sftp.rootPath} (id ${r.rootId})`);
    broadcast();
    return buildState();
  });

  /* ---------------- Pairs ---------------- */

  ipcMain.handle(IPC.addFolders, async (_e, target: TargetKind): Promise<AddFoldersResult> => {
    assertIdle('add folders');
    const c = config.get();
    if (target === 'onedrive' && (!c.account || !c.root)) throw new Error('Connect OneDrive and choose a root folder first.');
    if (target === 'sftp' && !sftpReady(c)) throw new Error('Set up the remote disk first (test the connection and set up the root folder).');
    const res = await dialog.showOpenDialog(win!, {
      title: `Choose folders to mirror to ${target === 'onedrive' ? 'OneDrive' : 'the remote disk'}`,
      buttonLabel: 'Add',
      properties: ['openDirectory', 'multiSelections', 'treatPackageAsDirectory', 'dontAddToRecent'],
    });
    const out: AddFoldersResult = { added: [], warnings: [] };
    if (res.canceled) return out;
    const client = target === 'onedrive' ? graphClient() : undefined;
    for (const chosen of res.filePaths) {
      const source = path.resolve(chosen);
      const sameTarget = c.pairs.filter((p) => p.target === target);
      const existing = sameTarget.find((p) => path.resolve(p.sourcePath) === source);
      if (existing) {
        out.warnings.push(`"${source}" is already mirrored to this destination.`);
        continue;
      }
      const nested = sameTarget.find((p) => isInside(source, p.sourcePath) || isInside(p.sourcePath, source));
      if (nested) out.warnings.push(`"${source}" overlaps with the configured folder "${nested.sourcePath}"; its content will be mirrored twice.`);
      const destName = uniqueDestinationName(path.basename(source), sameTarget);
      let pair: PairConfig;
      if (target === 'onedrive') {
        const item = await provisionDestination(client!, c.root!, destName, sameTarget);
        pair = { id: newPairId(), sourcePath: source, target, destinationName: item.name, destinationId: item.id, enabled: true };
        if ((item.folder?.childCount ?? 0) > 0) out.warnings.push(`The OneDrive folder "${item.name}" already contains ${item.folder?.childCount} item(s); Clone will make it identical to "${source}" (extra items will be deleted).`);
      } else {
        const r = await sftpSetup.provisionDestination(c.sftp!, destName);
        pair = { id: newPairId(), sourcePath: source, target, destinationName: destName, destinationId: sftpDestinationId(c.sftp!.rootId!, destName), enabled: true };
        if (r.existed && r.itemCount > 0) out.warnings.push(`The remote folder "${destName}" already contains ${r.itemCount} item(s); Clone will make it identical to "${source}" (extra items will be deleted).`);
      }
      await config.update((cfg) => {
        cfg.pairs.push(pair);
      });
      out.added.push(pair);
      log.info(`added pair ${source} → ${target}/${pair.destinationName} (${pair.destinationId})`);
    }
    broadcast();
    return out;
  });

  ipcMain.handle(IPC.updatePair, async (_e, id: string, patch: { destinationName?: string; enabled?: boolean }) => {
    assertIdle('edit pairs');
    const c = config.get();
    const pair = c.pairs.find((p) => p.id === id);
    if (!pair) throw new Error('Pair not found.');
    if (patch.destinationName !== undefined && patch.destinationName.trim() !== pair.destinationName) {
      const name = patch.destinationName.trim();
      const siblings = c.pairs.filter((p) => p.target === pair.target);
      if (pair.target === 'onedrive') {
        if (!c.root) throw new Error('Choose a OneDrive root folder first.');
        const item = await provisionDestination(graphClient(), c.root, name, siblings, id);
        await config.update(() => {
          pair.destinationName = item.name;
          pair.destinationId = item.id; // previous destination folder is left untouched
          pair.lastSuccess = undefined;
        });
      } else {
        if (!sftpReady(c)) throw new Error('Set up the remote disk first.');
        const clash = siblings.find((p) => p.id !== id && p.destinationName.normalize('NFC').toLowerCase() === name.normalize('NFC').toLowerCase());
        if (clash) throw new Error(`Another pair already uses the destination "${clash.destinationName}". Destinations must be distinct.`);
        await sftpSetup.provisionDestination(c.sftp!, name);
        await config.update(() => {
          pair.destinationName = name;
          pair.destinationId = sftpDestinationId(c.sftp!.rootId!, name);
          pair.lastSuccess = undefined;
        });
      }
      log.info(`pair ${pair.sourcePath} destination changed to ${pair.destinationName} (${pair.destinationId})`);
    }
    if (patch.enabled !== undefined) {
      await config.update(() => {
        pair.enabled = patch.enabled!;
      });
    }
    broadcast();
    return buildState();
  });

  ipcMain.handle(IPC.removePair, async (_e, id: string) => {
    assertIdle('remove pairs');
    await config.update((c) => {
      const p = c.pairs.find((x) => x.id === id);
      c.pairs = c.pairs.filter((x) => x.id !== id);
      if (p) log.info(`removed pair ${p.sourcePath} (destination folder "${p.destinationName}" kept)`);
    });
    broadcast();
    return buildState();
  });

  ipcMain.handle(IPC.acknowledge, async () => {
    await config.update((c) => {
      c.acknowledgement = {
        userId: c.account?.userId,
        rootId: c.root?.id,
        sftpRootId: c.sftp?.rootId,
        destinationIds: c.pairs.map((p) => p.destinationId),
        at: Date.now(),
      };
    });
    broadcast();
    return buildState();
  });

  /* ---------------- Run ---------------- */

  ipcMain.handle(IPC.startClone, async () => {
    const c = config.get();
    if (runs.running) throw new Error('A Clone is already running.');
    if (needsAcknowledgement(c)) throw new Error('Please confirm the mirror warning before running Clone.');
    configureAuth();
    progress = { phase: 'preparing', itemsDone: 0, itemsTotal: 0, bytesDone: 0, bytesTotal: 0, pairIndex: 0, pairCount: c.pairs.filter((p) => p.enabled).length };
    broadcast();
    const startedAt = Date.now();
    try {
      const summary = await runs.start({
        client: graphClient(),
        config: c,
        hashCacheFile: path.join(userData, 'hash-cache.json'),
        log,
        onProgress: (p) => {
          progress = p;
          win?.webContents.send(IPC.progress, p);
        },
      });
      await config.update((cfg) => {
        cfg.lastRun = summary;
        if (summary.outcome === 'completed' || summary.outcome === 'completedWithWarnings') cfg.lastSuccessfulRun = { at: summary.finishedAt, summary: summary.summary };
        for (const pr of summary.pairs) {
          const pair = cfg.pairs.find((p) => p.id === pr.pairId);
          if (!pair) continue;
          pair.lastAttempt = { at: summary.finishedAt, outcome: pr.outcome, summary: pr.summary };
          if (pr.outcome === 'completed' || pr.outcome === 'completedWithWarnings') pair.lastSuccess = { at: summary.finishedAt, summary: pr.summary };
        }
      });
    } catch (err) {
      const message = describeError(err);
      log.error(`Clone failed to run: ${message}`);
      await config.update((cfg) => {
        cfg.lastRun = { startedAt, finishedAt: Date.now(), outcome: 'failed', summary: message, issues: [{ severity: 'error', code: 'run.failed', message }], pairs: [] };
      });
    } finally {
      progress = undefined;
      broadcast();
    }
  });

  ipcMain.handle(IPC.cancelClone, async () => {
    runs.cancel();
  });

  ipcMain.handle(IPC.openLogFolder, async () => {
    await shell.openPath(log.directory);
  });

  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    if (/^https:\/\//.test(url)) await shell.openExternal(url);
  });
}

function newPairId(): string {
  return `pair-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

/** Icon used in development (packaged builds get it from electron-builder's build/ resources). */
function devIconPath(): string | undefined {
  if (app.isPackaged) return undefined;
  const p = path.join(import.meta.dirname, '../../build/icon.png');
  return existsSync(p) ? p : undefined;
}

function createWindow(): void {
  const icon = devIconPath();
  if (icon && process.platform === 'darwin') app.dock?.setIcon(icon);
  win = new BrowserWindow({
    ...(icon && process.platform !== 'darwin' ? { icon } : {}),
    width: 860,
    height: 680,
    minWidth: 700,
    minHeight: 540,
    title: 'Mirror',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = undefined;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'));
  }

  // Automated UI check: capture the window and exit.
  const shot = process.env.MIRROR_SCREENSHOT;
  if (shot) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await win!.webContents.capturePage();
          await fs.writeFile(shot, image.toPNG());
        } finally {
          app.quit();
        }
      }, 1500);
    });
  }
}

app.whenReady().then(async () => {
  await config.load();
  // Optional demo state for UI review (never persisted).
  if (process.env.MIRROR_DEMO_STATE) {
    const demo = JSON.parse(await fs.readFile(process.env.MIRROR_DEMO_STATE, 'utf8')) as Partial<ReturnType<typeof config.get>>;
    Object.assign(config.get(), demo);
  }
  configureAuth();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  log.info(`Mirror ${app.getVersion()} started (no automatic transfers: Clone is manual)`);
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  // A running Clone keeps the process alive until it finishes or is cancelled; nothing restarts it.
  if (process.platform !== 'darwin' && !runs.running) app.quit();
});

app.on('before-quit', () => {
  if (runs.running) runs.cancel();
});

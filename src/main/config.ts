import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_EXCLUDE_NAMES, DEFAULT_EXCLUDE_PREFIXES } from '../core/types.js';
import type { Acknowledgement, AccountInfo, AppSettings, PairConfig, RootFolderInfo, RunSummary, SftpSettings } from '../shared/ipc.js';

export interface PersistedSftp extends SftpSettings {
  /** Passphrase encrypted with safeStorage (base64). */
  passphraseEncrypted?: string;
}

export interface PersistedConfig {
  version: 1;
  settings: AppSettings;
  account?: AccountInfo;
  root?: RootFolderInfo;
  sftp?: PersistedSftp;
  pairs: PairConfig[];
  acknowledgement?: Acknowledgement;
  lastRun?: RunSummary;
  lastSuccessfulRun?: { at: number; summary: string };
}

export const DEFAULT_SETTINGS: AppSettings = {
  clientId: '',
  tenant: 'organizations',
  excludeNames: DEFAULT_EXCLUDE_NAMES,
  excludePrefixes: DEFAULT_EXCLUDE_PREFIXES,
  allowEmptySourceToWipeDestination: false,
  uploadConcurrency: 3,
};

export const DEFAULT_SFTP: SftpSettings = {
  host: '',
  port: 22,
  username: '',
  privateKeyPath: '~/.ssh/id_ed25519',
  hasPassphrase: false,
  rootPath: 'D:\\Mirror',
  hashCommand: 'powershell',
};

/** JSON configuration persisted in the app's user-data folder. Written atomically. */
export class ConfigStore {
  private data: PersistedConfig = { version: 1, settings: { ...DEFAULT_SETTINGS }, pairs: [] };

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedConfig>;
      this.data = {
        version: 1,
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
        account: parsed.account,
        root: parsed.root,
        sftp: parsed.sftp ? { ...DEFAULT_SFTP, ...parsed.sftp } : undefined,
        pairs: Array.isArray(parsed.pairs) ? parsed.pairs.map((p) => ({ ...p, target: p.target ?? 'onedrive' })) : [],
        acknowledgement: parsed.acknowledgement,
        lastRun: parsed.lastRun,
        lastSuccessfulRun: parsed.lastSuccessfulRun,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  get(): PersistedConfig {
    return this.data;
  }

  async update(mutate: (c: PersistedConfig) => void): Promise<PersistedConfig> {
    mutate(this.data);
    await this.save();
    return this.data;
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await fs.rename(tmp, this.file);
  }
}

export function oneDriveReady(c: PersistedConfig): boolean {
  return Boolean(c.account && c.root);
}

export function sftpReady(c: PersistedConfig): boolean {
  const s = c.sftp;
  return Boolean(s && s.host && s.username && s.privateKeyPath && s.rootPath && s.rootId && s.hostKeyFingerprint);
}

export function sftpDestinationId(rootId: string, name: string): string {
  return `sftp:${rootId}:${name.normalize('NFC').toLowerCase()}`;
}

/**
 * Confirmation is required again whenever the account, a root, or any enabled destination changed.
 * Only destinations actually used by enabled pairs are considered.
 */
export function needsAcknowledgement(c: PersistedConfig): boolean {
  const enabled = c.pairs.filter((p) => p.enabled);
  if (enabled.length === 0) return false;
  const ack = c.acknowledgement;
  if (!ack) return true;
  const known = new Set(ack.destinationIds);
  for (const p of enabled) {
    if (p.target === 'onedrive') {
      if (!c.account || !c.root) continue; // cannot run anyway
      if (ack.userId !== c.account.userId || ack.rootId !== c.root.id) return true;
    } else {
      if (!c.sftp?.rootId) continue;
      if (ack.sftpRootId !== c.sftp.rootId) return true;
    }
    if (!known.has(p.destinationId)) return true;
  }
  return false;
}

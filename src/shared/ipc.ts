/**
 * Types shared between the Electron main process and the renderer (UI).
 * Keep this file free of Node/Electron imports.
 */
import type { Issue, Progress, RunOutcome, PairOutcome } from '../core/types.js';

export type { Issue, Progress, RunOutcome, PairOutcome };

export interface AppSettings {
  /** Microsoft Entra application (client) ID. Never embedded in code; entered by the user. */
  clientId: string;
  /** 'organizations' | 'common' | 'consumers' | tenant GUID | verified domain (e.g. unige.it). */
  tenant: string;
  excludeNames: string[];
  excludePrefixes: string[];
  allowEmptySourceToWipeDestination: boolean;
  uploadConcurrency: number;
}

export interface AccountInfo {
  homeAccountId: string;
  /** Graph user id (stable). */
  userId: string;
  username: string;
  displayName: string;
  driveId: string;
  driveType: string;
}

export interface RootFolderInfo {
  id: string;
  name: string;
  driveId: string;
  webUrl?: string;
}

export interface RootCandidate {
  id: string;
  name: string;
  childCount: number;
  webUrl?: string;
}

export interface AttemptSummary {
  at: number;
  outcome: PairOutcome | RunOutcome;
  summary: string;
}

export type TargetKind = 'onedrive' | 'sftp';

export type HashCommand = 'powershell' | 'sha1sum' | 'none';

/** Remote disk (SFTP) settings as seen by the UI. The passphrase itself never leaves the main process. */
export interface SftpSettings {
  host: string;
  port: number;
  username: string;
  /** Path to the private key file (e.g. ~/.ssh/id_ed25519). */
  privateKeyPath: string;
  hasPassphrase: boolean;
  /** Root folder on the remote disk, e.g. D:\Backup\Mirror. */
  rootPath: string;
  /** Id written in the marker file inside the root; set when the root is provisioned. */
  rootId?: string;
  /** SHA256 fingerprint of the server host key, recorded on first successful test (trust on first use). */
  hostKeyFingerprint?: string;
  hashCommand: HashCommand;
}

export interface SftpSettingsPatch extends Partial<Omit<SftpSettings, 'hasPassphrase' | 'rootId' | 'hostKeyFingerprint'>> {
  /** New passphrase; null clears it. */
  passphrase?: string | null;
  /** null forgets the recorded host key fingerprint (e.g. after reinstalling the remote machine). */
  hostKeyFingerprint?: string | null;
}

export interface SftpTestResult {
  ok: boolean;
  message: string;
  hostKeyFingerprint?: string;
  fingerprintRecorded?: boolean;
  rootExists?: boolean;
  markerId?: string;
  markerMatches?: boolean;
  hashToolOk?: boolean;
  hashToolMessage?: string;
}

export interface PairConfig {
  id: string;
  sourcePath: string;
  /** Where this pair mirrors to. */
  target: TargetKind;
  destinationName: string;
  /** OneDrive: driveItem id of the destination folder. SFTP: "sftp:<rootId>:<name>". */
  destinationId: string;
  enabled: boolean;
  lastAttempt?: AttemptSummary;
  lastSuccess?: { at: number; summary: string };
}

export interface Acknowledgement {
  userId?: string;
  rootId?: string;
  sftpRootId?: string;
  destinationIds: string[];
  at: number;
}

export interface RunSummary {
  startedAt: number;
  finishedAt: number;
  outcome: RunOutcome;
  summary: string;
  issues: Array<Issue & { pairId?: string; pairLabel?: string }>;
  pairs: Array<{ pairId: string; label: string; outcome: PairOutcome; summary: string }>;
}

export interface AppState {
  version: string;
  platform: string;
  settings: AppSettings;
  account?: AccountInfo;
  root?: RootFolderInfo;
  sftp?: SftpSettings;
  /** OneDrive destination fully configured (account + root). */
  oneDriveReady: boolean;
  /** Remote disk configured (settings + provisioned root with marker + recorded fingerprint). */
  sftpReady: boolean;
  pairs: PairConfig[];
  acknowledgement?: Acknowledgement;
  needsAcknowledgement: boolean;
  running: boolean;
  progress?: Progress;
  lastRun?: RunSummary;
  lastSuccessfulRun?: { at: number; summary: string };
  /** Whether OS-backed encryption (Keychain / DPAPI / libsecret) is available for the token cache. */
  secureStorage: 'os' | 'basic' | 'unavailable';
  logDirectory: string;
}

export interface AddFoldersResult {
  added: PairConfig[];
  warnings: string[];
}

/** Renderer → main API exposed through the preload bridge. */
export interface MirrorApi {
  getState(): Promise<AppState>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppState>;
  connect(): Promise<AppState>;
  disconnect(): Promise<AppState>;
  listRootCandidates(): Promise<RootCandidate[]>;
  selectRoot(choice: { id: string } | { createName: string }): Promise<AppState>;
  addFolders(target: TargetKind): Promise<AddFoldersResult>;
  updateSftpSettings(patch: SftpSettingsPatch): Promise<AppState>;
  testSftp(): Promise<SftpTestResult>;
  provisionSftpRoot(): Promise<AppState>;
  updatePair(id: string, patch: { destinationName?: string; enabled?: boolean }): Promise<AppState>;
  removePair(id: string): Promise<AppState>;
  acknowledge(): Promise<AppState>;
  startClone(): Promise<void>;
  cancelClone(): Promise<void>;
  openLogFolder(): Promise<void>;
  openExternal(url: string): Promise<void>;
  onStateChanged(cb: (state: AppState) => void): () => void;
  onProgress(cb: (p: Progress) => void): () => void;
}

export const IPC = {
  getState: 'mirror:getState',
  updateSettings: 'mirror:updateSettings',
  connect: 'mirror:connect',
  disconnect: 'mirror:disconnect',
  listRootCandidates: 'mirror:listRootCandidates',
  selectRoot: 'mirror:selectRoot',
  addFolders: 'mirror:addFolders',
  updateSftpSettings: 'mirror:updateSftpSettings',
  testSftp: 'mirror:testSftp',
  provisionSftpRoot: 'mirror:provisionSftpRoot',
  updatePair: 'mirror:updatePair',
  removePair: 'mirror:removePair',
  acknowledge: 'mirror:acknowledge',
  startClone: 'mirror:startClone',
  cancelClone: 'mirror:cancelClone',
  openLogFolder: 'mirror:openLogFolder',
  openExternal: 'mirror:openExternal',
  stateChanged: 'mirror:stateChanged',
  progress: 'mirror:progress',
} as const;

/**
 * Core domain types for the Mirror engine.
 *
 * The engine is platform-agnostic Node code (no Electron imports) so that it can be
 * unit-tested with a fake Graph server and reused by the real-OneDrive test script.
 */

/** Relative POSIX-style path inside a pair ("" is the pair root). Always '/'-separated. */
export type RelPath = string;

export type LocalKind = 'file' | 'dir';

export interface LocalEntry {
  relPath: RelPath;
  /** Name of the last path component (as on disk). */
  name: string;
  kind: LocalKind;
  size: number;
  /** Modification time in milliseconds (float, as reported by fs.Stats.mtimeMs). */
  mtimeMs: number;
  /** Inode number when available; used as part of the hash-cache key. */
  ino: number;
  /** Heuristic: size > 0 but zero allocated blocks. May be a dataless/cloud-only file (or a compressed one). */
  possiblyDataless?: boolean;
}

export type LocalProblemKind =
  | 'symlink' // symbolic link (not followed, never uploaded)
  | 'special' // socket, FIFO, device, etc.
  | 'invalidName' // name not representable on OneDrive
  | 'caseCollision' // two siblings differ only by case / Unicode normalization
  | 'cloudPlaceholder' // ".icloud" placeholder, content not on disk
  | 'pathTooLong'
  | 'unreadable'; // stat/read failed for this item (scan is still complete)

export interface LocalProblem {
  kind: LocalProblemKind;
  relPath: RelPath;
  detail: string;
}

export interface LocalInventory {
  rootPath: string;
  /** Keyed by relPath. Does not include the pair root itself. */
  entries: Map<RelPath, LocalEntry>;
  /** Items that cannot be mirrored. They are reported, never silently skipped. */
  problems: LocalProblem[];
  /** Excluded by configured name filters (e.g. .DS_Store). Informational only. */
  excluded: RelPath[];
  scannedAt: number;
}

export type RemoteKind = 'file' | 'folder';

export interface RemoteEntry {
  /** Backend reference: driveItem id on OneDrive, absolute remote path on SFTP. */
  id: string;
  relPath: RelPath;
  name: string;
  kind: RemoteKind;
  size: number;
  eTag?: string;
  cTag?: string;
  /** Modification time (ms) when the backend exposes it (SFTP); used with size as deletion precondition. */
  mtimeMs?: number;
  parentId: string;
  quickXorHash?: string;
  sha1Hash?: string;
  /** For folders: number of children as reported by Graph at inventory time. */
  childCount?: number;
  /** Graph "package" facet (e.g. OneNote notebooks). Treated like a folder item we must not descend into. */
  isPackage?: boolean;
}

export interface RemoteInventory {
  driveId: string;
  destinationId: string;
  /** Keyed by relPath (case preserved as on OneDrive). */
  entries: Map<RelPath, RemoteEntry>;
  listedAt: number;
}

/* ----------------------------- Plan ----------------------------- */

export type PlanOp =
  | { type: 'mkdir'; relPath: RelPath; reason: 'missing' }
  | {
      /** Remote has a file where local has a folder (or vice versa): delete remote item first. */
      type: 'replaceType';
      relPath: RelPath;
      remote: RemoteEntry;
      localKind: LocalKind;
    }
  | { type: 'upload'; relPath: RelPath; local: LocalEntry; reason: 'new' | 'changed' | 'unverifiable' ; remote?: RemoteEntry }
  | {
      /** Rename/move detected by identical size+hash: PATCH instead of upload+delete. Falls back to upload+delete on failure. */
      type: 'move';
      fromRelPath: RelPath;
      toRelPath: RelPath;
      remote: RemoteEntry;
      local: LocalEntry;
    }
  | { type: 'deleteFile'; relPath: RelPath; remote: RemoteEntry }
  | { type: 'deleteFolder'; relPath: RelPath; remote: RemoteEntry };

export interface PlanStats {
  mkdirs: number;
  uploadsNew: number;
  uploadsChanged: number;
  moves: number;
  deletesFiles: number;
  deletesFolders: number;
  typeReplacements: number;
  unchanged: number;
  bytesToUpload: number;
}

export interface Plan {
  ops: PlanOp[];
  stats: PlanStats;
  /** Local relPaths we need a hash for before uploading (always true now, kept for clarity). */
  skippedIdentical: RelPath[];
}

/* ---------------------------- Results --------------------------- */

export type IssueSeverity = 'error' | 'warning';

export interface Issue {
  severity: IssueSeverity;
  code: string;
  relPath?: RelPath;
  message: string;
}

export type PairOutcome =
  | 'completed' // plan fully executed and verified, no issues
  | 'completedWithWarnings' // executed; warnings but no errors (e.g. excluded names)
  | 'incomplete' // some operations failed or divergences remain
  | 'aborted' // pair aborted before any cloud change (inventory/safety failure)
  | 'cancelled'
  | 'skipped'; // disabled pair

export interface PairRunResult {
  pairId: string;
  outcome: PairOutcome;
  startedAt: number;
  finishedAt: number;
  issues: Issue[];
  counters: {
    foldersCreated: number;
    filesUploaded: number;
    bytesUploaded: number;
    moves: number;
    filesDeleted: number;
    foldersDeleted: number;
    unchanged: number;
    failed: number;
  };
  /** Whether cloud deletions were executed (false when uploads failed or run was cancelled). */
  deletionsExecuted: boolean;
}

export type RunOutcome = 'completed' | 'completedWithWarnings' | 'incomplete' | 'cancelled' | 'failed';

export interface RunResult {
  startedAt: number;
  finishedAt: number;
  outcome: RunOutcome;
  pairs: PairRunResult[];
  issues: Issue[];
}

/* ---------------------------- Progress -------------------------- */

export type Phase =
  | 'idle'
  | 'preparing'
  | 'scanningLocal'
  | 'listingRemote'
  | 'hashing'
  | 'planning'
  | 'creatingFolders'
  | 'uploading'
  | 'verifying'
  | 'deleting'
  | 'finalizing'
  | 'done';

export interface Progress {
  phase: Phase;
  pairId?: string;
  pairLabel?: string;
  message?: string;
  currentPath?: string;
  /** Pair-level counters. */
  itemsDone: number;
  itemsTotal: number;
  bytesDone: number;
  bytesTotal: number;
  pairIndex: number;
  pairCount: number;
}

export type ProgressListener = (p: Progress) => void;

/* ------------------------- Configuration ------------------------ */

export interface EngineOptions {
  /** Exact file/folder names to exclude anywhere (case-sensitive, e.g. ".DS_Store"). */
  excludeNames: string[];
  /** Glob-less prefix exclusions (e.g. "._" for AppleDouble files). */
  excludePrefixes: string[];
  /**
   * When false (default) a readable but empty source whose destination still has content
   * aborts the pair instead of wiping the destination. Protects against unmounted volumes
   * that appear as empty directories.
   */
  allowEmptySourceToWipeDestination: boolean;
  /** Parallel uploads (1..8). */
  uploadConcurrency: number;
  /** Files at or above this size use resumable upload sessions. */
  largeFileThreshold: number;
  /** Upload session fragment size; must be a multiple of 320 KiB. */
  uploadChunkSize: number;
  /** Max path length accepted by OneDrive (characters, decoded, including destination path). */
  maxPathLength: number;
}

export const DEFAULT_EXCLUDE_NAMES = [
  '.DS_Store',
  '.localized',
  'Icon\r',
  '.Trashes',
  '.Spotlight-V100',
  '.fseventsd',
  '.TemporaryItems',
  '.DocumentRevisions-V100',
  '.VolumeIcon.icns',
  '.com.apple.timemachine.donotpresent',
  'desktop.ini',
  'Thumbs.db',
];

export const DEFAULT_EXCLUDE_PREFIXES = ['._'];

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  excludeNames: DEFAULT_EXCLUDE_NAMES,
  excludePrefixes: DEFAULT_EXCLUDE_PREFIXES,
  allowEmptySourceToWipeDestination: false,
  uploadConcurrency: 3,
  largeFileThreshold: 4 * 1024 * 1024,
  uploadChunkSize: 32 * 320 * 1024, // 10 MiB
  maxPathLength: 400,
};

export type PairTarget =
  | {
      kind: 'onedrive';
      /** Persistent identity of the destination folder (child of the managed root). */
      driveId: string;
      destinationId: string;
      /** Persistent identity of the managed root folder. The destination must still be its child. */
      rootId: string;
    }
  | {
      kind: 'sftp';
      /** Folder name under the remote root (also the destination's identity, together with the root marker). */
      destinationName: string;
    };

export interface PairSpec {
  id: string;
  label: string;
  sourcePath: string;
  destinationName: string;
  target: PairTarget;
}

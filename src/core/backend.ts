/**
 * Destination abstraction. The engine (planner/executor/mirror) only talks to a DestinationBackend;
 * OneDrive (Microsoft Graph) and a remote disk over SFTP are the two implementations.
 *
 * Every backend must honour the same safety contract:
 *  - `verifyDestination` throws DestinationError before any change when the destination is not the
 *    configured one (moved/renamed/missing, wrong disk, marker mismatch);
 *  - `list` returns the complete tree or throws (never a partial listing);
 *  - deletions take the inventory entry and fail with 'preconditionFailed' when the item changed
 *    since the inventory (eTag on OneDrive, size+mtime on SFTP), never deleting blindly;
 *  - `deleteFolder` refuses a non-empty folder ('notEmpty').
 */
import type { Issue, LocalEntry, RemoteEntry, RemoteInventory } from './types.js';

/** Opaque reference to a remote folder: a driveItem id on OneDrive, an absolute path on SFTP. */
export type RemoteRef = string;

export interface DestinationInfo {
  /** Length (chars) of the destination path prefix, used for the path-length limit. */
  destinationPrefixLength: number;
  maxPathLength: number;
  /** Which content hash the destination exposes natively. */
  hashAlgorithm: 'quickXorHash' | 'sha1Hash' | 'none';
}

export interface UploadReceipt {
  relPath: string;
  size: number;
  /** Hash as reported by the destination right after upload, when available. */
  quickXorHash?: string;
  sha1Hash?: string;
  /** Any backend data needed by verifyUploads (e.g. item id, remote path). */
  ref: RemoteRef;
}

export interface VerifiedHashes {
  size: number;
  quickXorHash?: string;
  sha1Hash?: string;
}

export type DeleteResult = 'deleted' | 'notFound' | 'preconditionFailed';
export type DeleteFolderResult = DeleteResult | 'notEmpty';

export interface DestinationBackend {
  readonly kind: 'onedrive' | 'sftp';
  readonly label: string;

  /** Validates identity (account, root, destination). Throws DestinationError. */
  verifyDestination(signal?: AbortSignal): Promise<DestinationInfo>;

  /** Complete inventory of the destination. Throws on any failure. */
  list(signal?: AbortSignal, onProgress?: (folders: number, items: number) => void): Promise<RemoteInventory>;

  /**
   * Fills `quickXorHash`/`sha1Hash` of the given remote entries when the backend can compute them
   * server-side (SFTP batch hashing). Entries that cannot be hashed are left untouched.
   */
  fillRemoteHashes?(entries: RemoteEntry[], signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<void>;

  /** Ref of the destination root ("" relPath). */
  rootRef(): RemoteRef;

  mkdir(parentRef: RemoteRef, name: string, relPath: string, signal?: AbortSignal): Promise<RemoteRef>;

  /**
   * Uploads a local file (replacing any existing file with that name). Must stream from disk and may
   * resume; returns a receipt. Throws on failure (including quota: see isQuotaError).
   */
  uploadFile(
    parentRef: RemoteRef,
    local: LocalEntry,
    localAbsPath: string,
    signal?: AbortSignal,
    onBytes?: (uploadedSoFar: number) => void,
  ): Promise<UploadReceipt>;

  /** Returns authoritative size/hash for uploaded files (batched where that is cheaper). */
  verifyUploads(receipts: UploadReceipt[], signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<Map<string, VerifiedHashes>>;

  /** Moves/renames a file; must fail (throw) when the remote item changed since the inventory. Returns the new ref. */
  move(entry: RemoteEntry, newParentRef: RemoteRef, newName: string, newRelPath: string, signal?: AbortSignal): Promise<RemoteRef>;

  deleteFile(entry: RemoteEntry, signal?: AbortSignal): Promise<DeleteResult>;
  /** Deletes an empty folder (re-checked right before). */
  deleteFolder(entry: RemoteEntry, signal?: AbortSignal): Promise<DeleteFolderResult>;
  /** Deletes an item whose type conflicts with the local one (folder subtree included), with precondition. */
  deleteConflicting(entry: RemoteEntry, signal?: AbortSignal): Promise<DeleteResult>;

  /** Called once after the pair run (success or not) to flush backend state (e.g. hash manifest). */
  finalize?(signal?: AbortSignal): Promise<void>;

  /** Non-fatal notes accumulated during the run (e.g. remote hashing unavailable). */
  drainWarnings?(): Issue[];

  isQuotaError(err: unknown): boolean;
  /** Releases connections. */
  close(): Promise<void>;
}

export class DestinationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DestinationError';
  }
}

/** Names reserved for Mirror's own bookkeeping inside destinations (never mirrored, never listed). */
export const RESERVED_NAMES = new Set(['.mirror-destination.json', '.mirror-manifest.json']);

import { promises as fs } from 'node:fs';
import { type DeleteFolderResult, type DeleteResult, DestinationError, type DestinationBackend, type DestinationInfo, type RemoteRef, type UploadReceipt, type VerifiedHashes } from '../backend.js';
import type { GraphClient } from '../graph/client.js';
import { GraphError } from '../graph/errors.js';
import { listRemoteTree } from '../remoteInventory.js';
import type { LocalEntry, RemoteEntry, RemoteInventory } from '../types.js';

export interface OneDriveTarget {
  driveId: string;
  rootId: string;
  destinationId: string;
  destinationName: string;
}

export interface OneDriveBackendOptions {
  largeFileThreshold: number;
  uploadChunkSize: number;
  maxPathLength: number;
}

/** OneDrive destination through Microsoft Graph. Items are addressed by persistent ids; eTags guard deletions. */
export class OneDriveBackend implements DestinationBackend {
  readonly kind = 'onedrive' as const;
  readonly label: string;

  constructor(
    private readonly client: GraphClient,
    private readonly target: OneDriveTarget,
    private readonly options: OneDriveBackendOptions,
  ) {
    this.label = `OneDrive/${target.destinationName}`;
  }

  async verifyDestination(signal?: AbortSignal): Promise<DestinationInfo> {
    const { client, target } = this;
    const root = await client.getItem(target.driveId, target.rootId, signal);
    if (!root || !root.folder) throw new DestinationError('destination.rootMissing', 'The Mirror root folder no longer exists on OneDrive. Choose a root folder again in Settings.');
    if (root.root !== undefined) throw new DestinationError('destination.isDriveRoot', 'The configured root is the OneDrive root itself, which is not allowed.');
    const dest = await client.getItem(target.driveId, target.destinationId, signal);
    if (!dest || !dest.folder) {
      throw new DestinationError('destination.missing', `The destination folder "${target.destinationName}" no longer exists on OneDrive (it may have been deleted or moved to the recycle bin). Edit the pair to recreate it.`);
    }
    if (dest.parentReference?.id !== target.rootId) {
      throw new DestinationError('destination.moved', `The destination folder "${dest.name}" is no longer inside the Mirror root folder. Nothing was changed. Edit the pair to choose its destination again.`);
    }
    if (dest.name.normalize('NFC').toLowerCase() !== target.destinationName.normalize('NFC').toLowerCase()) {
      throw new DestinationError('destination.renamed', `The destination folder was renamed on OneDrive to "${dest.name}". Nothing was changed. Edit the pair to confirm the new destination.`);
    }
    const parentPath = dest.parentReference?.path ? dest.parentReference.path.replace(/^.*root:/, '') : '';
    return { destinationPrefixLength: parentPath.length + 1 + dest.name.length, maxPathLength: this.options.maxPathLength, hashAlgorithm: 'quickXorHash' };
  }

  list(signal?: AbortSignal, onProgress?: (folders: number, items: number) => void): Promise<RemoteInventory> {
    return listRemoteTree(this.client, this.target.driveId, this.target.destinationId, signal, onProgress);
  }

  rootRef(): RemoteRef {
    return this.target.destinationId;
  }

  async mkdir(parentRef: RemoteRef, name: string, _relPath: string, signal?: AbortSignal): Promise<RemoteRef> {
    try {
      const item = await this.client.createFolder(this.target.driveId, parentRef, name, 'fail', signal);
      return item.id;
    } catch (err) {
      if (err instanceof GraphError && err.code === 'nameAlreadyExists') {
        // Created concurrently on OneDrive. Reuse it if it is a folder.
        const existing = await this.client.findChildByName(this.target.driveId, parentRef, name, signal);
        if (existing?.folder) return existing.id;
        throw new DestinationError('remote.conflict', 'an item with this name appeared on OneDrive during the run');
      }
      throw err;
    }
  }

  async uploadFile(parentRef: RemoteRef, local: LocalEntry, abs: string, signal?: AbortSignal, onBytes?: (n: number) => void): Promise<UploadReceipt> {
    const { client, target, options } = this;
    let item;
    if (local.size < options.largeFileThreshold) {
      const data = await fs.readFile(abs, { signal } as { signal?: AbortSignal });
      if (data.length !== local.size) throw new Error('file changed while reading');
      item = await client.uploadSmall(target.driveId, parentRef, local.name, data, signal);
      onBytes?.(local.size);
    } else {
      item = await client.uploadLarge(target.driveId, parentRef, local.name, abs, local.size, options.uploadChunkSize, signal, onBytes);
    }
    return { relPath: local.relPath, size: item.size ?? -1, quickXorHash: item.file?.hashes?.quickXorHash, sha1Hash: item.file?.hashes?.sha1Hash?.toUpperCase(), ref: item.id };
  }

  async verifyUploads(receipts: UploadReceipt[], signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<Map<string, VerifiedHashes>> {
    const out = new Map<string, VerifiedHashes>();
    let done = 0;
    for (const r of receipts) {
      let { size, quickXorHash, sha1Hash } = r;
      if (!quickXorHash && !sha1Hash) {
        // Hash may be computed asynchronously by OneDrive: fetch the item once more.
        const fresh = await this.client.getItem(this.target.driveId, r.ref, signal);
        if (fresh) {
          size = fresh.size ?? size;
          quickXorHash = fresh.file?.hashes?.quickXorHash;
          sha1Hash = fresh.file?.hashes?.sha1Hash?.toUpperCase();
        }
      }
      out.set(r.relPath, { size, quickXorHash, sha1Hash });
      onProgress?.(++done, receipts.length);
    }
    return out;
  }

  async move(entry: RemoteEntry, newParentRef: RemoteRef, newName: string, _newRelPath: string, signal?: AbortSignal): Promise<RemoteRef> {
    const item = await this.client.moveItem(this.target.driveId, entry.id, newParentRef, newName, entry.eTag, signal);
    if (item.file?.hashes?.quickXorHash && entry.quickXorHash && item.file.hashes.quickXorHash !== entry.quickXorHash) {
      throw new Error('content hash changed during move');
    }
    return item.id;
  }

  deleteFile(entry: RemoteEntry, signal?: AbortSignal): Promise<DeleteResult> {
    return this.client.deleteItem(this.target.driveId, entry.id, entry.eTag, signal);
  }

  async deleteFolder(entry: RemoteEntry, signal?: AbortSignal): Promise<DeleteFolderResult> {
    const fresh = await this.client.getItem(this.target.driveId, entry.id, signal);
    if (!fresh) return 'notFound';
    if ((fresh.folder?.childCount ?? 0) > 0) return 'notEmpty';
    return this.client.deleteItem(this.target.driveId, entry.id, fresh.eTag, signal);
  }

  deleteConflicting(entry: RemoteEntry, signal?: AbortSignal): Promise<DeleteResult> {
    return this.client.deleteItem(this.target.driveId, entry.id, entry.eTag, signal);
  }

  isQuotaError(err: unknown): boolean {
    return err instanceof GraphError && err.isInsufficientStorage;
  }

  async close(): Promise<void> {
    /* stateless */
  }
}

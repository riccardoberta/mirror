import type { GraphClient } from './graph/client.js';
import type { DriveItem } from './graph/types.js';
import { joinRel } from './names.js';
import type { RemoteEntry, RemoteInventory } from './types.js';

export interface RemoteInventoryProgress {
  (foldersListed: number, itemsSeen: number): void;
}

export function toRemoteEntry(item: DriveItem, relPath: string): RemoteEntry {
  const isFolder = item.folder !== undefined || item.package !== undefined;
  return {
    id: item.id,
    relPath,
    name: item.name,
    kind: isFolder ? 'folder' : 'file',
    size: item.size ?? 0,
    eTag: item.eTag,
    cTag: item.cTag,
    parentId: item.parentReference?.id ?? '',
    quickXorHash: item.file?.hashes?.quickXorHash,
    sha1Hash: item.file?.hashes?.sha1Hash?.toUpperCase(),
    childCount: item.folder?.childCount,
    isPackage: item.package !== undefined,
  };
}

/**
 * Lists the entire destination subtree (every page of every folder). Throws on any error so that
 * an incomplete remote inventory never leads to a plan.
 */
export async function listRemoteTree(
  client: GraphClient,
  driveId: string,
  destinationId: string,
  signal?: AbortSignal,
  onProgress?: RemoteInventoryProgress,
): Promise<RemoteInventory> {
  const entries = new Map<string, RemoteEntry>();
  const queue: Array<{ id: string; relPath: string }> = [{ id: destinationId, relPath: '' }];
  let foldersListed = 0;
  while (queue.length > 0) {
    const { id, relPath } = queue.shift()!;
    const children = await client.listChildrenAll(driveId, id, signal);
    foldersListed++;
    for (const child of children) {
      const childRel = joinRel(relPath, child.name);
      const entry = toRemoteEntry(child, childRel);
      entries.set(childRel, entry);
      // Packages (e.g. OneNote notebooks) are opaque: never descend into them.
      if (entry.kind === 'folder' && !entry.isPackage) queue.push({ id: child.id, relPath: childRel });
    }
    onProgress?.(foldersListed, entries.size);
  }
  return { driveId, destinationId, entries, listedAt: Date.now() };
}

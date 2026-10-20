import type { GraphClient } from '../core/graph/client.js';
import { GraphError } from '../core/graph/errors.js';
import type { DriveItem } from '../core/graph/types.js';
import { collisionKey, validateOneDriveName } from '../core/names.js';
import type { AccountInfo, PairConfig, RootCandidate, RootFolderInfo } from '../shared/ipc.js';

/** Configuration-time Graph operations: identify the account, pick/create the root, provision destinations. */

export async function identifyAccount(client: GraphClient, homeAccountId: string): Promise<AccountInfo> {
  const [me, drive] = await Promise.all([client.getMe(), client.getMyDrive()]);
  return {
    homeAccountId,
    userId: me.id,
    username: me.userPrincipalName ?? me.mail ?? '',
    displayName: me.displayName ?? me.userPrincipalName ?? 'Microsoft account',
    driveId: drive.id,
    driveType: drive.driveType ?? 'unknown',
  };
}

/** Top-level folders of the drive that could serve as the Mirror root (the drive root itself is never offered). */
export async function listRootCandidates(client: GraphClient, driveId: string): Promise<RootCandidate[]> {
  const root = await client.getRoot(driveId);
  const children = await client.listChildrenAll(driveId, root.id);
  return children
    .filter((c) => c.folder && !c.package)
    .map((c) => ({ id: c.id, name: c.name, childCount: c.folder?.childCount ?? 0, webUrl: c.webUrl }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function selectExistingRoot(client: GraphClient, driveId: string, id: string): Promise<RootFolderInfo> {
  const item = await client.getItem(driveId, id);
  if (!item || !item.folder) throw new Error('The selected folder no longer exists on OneDrive.');
  if (item.root !== undefined) throw new Error('The OneDrive root cannot be used as the Mirror root.');
  return { id: item.id, name: item.name, driveId, webUrl: item.webUrl };
}

export async function createRoot(client: GraphClient, driveId: string, name: string): Promise<RootFolderInfo> {
  const v = validateOneDriveName(name);
  if (!v.ok) throw new Error(`Invalid folder name: ${v.reason}`);
  const root = await client.getRoot(driveId);
  const item = await findOrCreateFolder(client, driveId, root.id, name);
  return { id: item.id, name: item.name, driveId, webUrl: item.webUrl };
}

export async function findOrCreateFolder(client: GraphClient, driveId: string, parentId: string, name: string): Promise<DriveItem> {
  try {
    return await client.createFolder(driveId, parentId, name, 'fail');
  } catch (err) {
    if (err instanceof GraphError && err.code === 'nameAlreadyExists') {
      const existing = await client.findChildByName(driveId, parentId, name);
      if (existing?.folder) return existing;
      throw new Error(`"${name}" already exists on OneDrive but is not a folder.`);
    }
    throw err;
  }
}

/**
 * Picks a destination folder name for a new source: the source's base name, made unique among the
 * configured pairs (case-insensitively, since OneDrive is case-insensitive).
 */
export function uniqueDestinationName(baseName: string, pairs: PairConfig[]): string {
  const taken = new Set(pairs.map((p) => collisionKey(p.destinationName)));
  let candidate = sanitizeForOneDrive(baseName);
  let n = 2;
  while (taken.has(collisionKey(candidate))) candidate = `${sanitizeForOneDrive(baseName)} ${n++}`;
  return candidate;
}

export function sanitizeForOneDrive(name: string): string {
  let s = name.replace(/["*:<>?/\\|\u0000-\u001f\u007f]/g, '_').replace(/_vti_/g, '_').trim().replace(/\.+$/, '');
  if (s.startsWith('~$')) s = s.slice(2);
  if (!s || !validateOneDriveName(s).ok) s = `Folder ${Date.now().toString(36)}`;
  return s;
}

/** Ensures a destination folder for a pair exists directly under the root and returns its id. */
export async function provisionDestination(client: GraphClient, root: RootFolderInfo, destinationName: string, pairs: PairConfig[], excludePairId?: string): Promise<DriveItem> {
  const v = validateOneDriveName(destinationName);
  if (!v.ok) throw new Error(`Invalid destination name: ${v.reason}`);
  const clash = pairs.find((p) => p.id !== excludePairId && collisionKey(p.destinationName) === collisionKey(destinationName));
  if (clash) throw new Error(`Another pair already uses the destination "${clash.destinationName}". Destinations must be distinct.`);
  const item = await findOrCreateFolder(client, root.driveId, root.id, destinationName);
  if (item.parentReference?.id !== root.id) throw new Error('The destination folder is not inside the Mirror root.');
  if (item.id === root.id) throw new Error('The destination cannot be the Mirror root itself.');
  return item;
}

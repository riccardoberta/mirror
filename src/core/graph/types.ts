/** Subset of Microsoft Graph driveItem used by Mirror. */
export interface DriveItem {
  id: string;
  name: string;
  size?: number;
  eTag?: string;
  cTag?: string;
  lastModifiedDateTime?: string;
  parentReference?: { driveId?: string; id?: string; path?: string; name?: string };
  file?: { mimeType?: string; hashes?: { quickXorHash?: string; sha1Hash?: string; sha256Hash?: string; crc32Hash?: string } };
  folder?: { childCount?: number };
  package?: { type?: string };
  deleted?: { state?: string };
  root?: Record<string, never>;
  webUrl?: string;
}

export interface GraphPage<T> {
  value: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

export interface GraphUser {
  id: string;
  displayName?: string;
  userPrincipalName?: string;
  mail?: string | null;
}

export interface GraphDrive {
  id: string;
  driveType?: 'personal' | 'business' | 'documentLibrary' | string;
  name?: string;
  owner?: { user?: { displayName?: string; id?: string } };
  quota?: { total?: number; used?: number; remaining?: number; state?: string };
}

export interface UploadSession {
  uploadUrl: string;
  expirationDateTime?: string;
  nextExpectedRanges?: string[];
}

export const DRIVE_ITEM_SELECT = 'id,name,size,eTag,cTag,file,folder,package,parentReference,lastModifiedDateTime';

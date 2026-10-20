import { promises as fs } from 'node:fs';
import { CancelledError, GraphError, NetworkError, isAbortError } from './errors.js';
import { DRIVE_ITEM_SELECT, type DriveItem, type GraphDrive, type GraphPage, type GraphUser, type UploadSession } from './types.js';

export interface TokenProvider {
  /** Returns a valid access token; `forceRefresh` after a 401. */
  getAccessToken(forceRefresh?: boolean): Promise<string>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type RequestBody = RequestInit['body'];

export interface GraphClientOptions {
  tokenProvider: TokenProvider;
  fetch?: FetchLike;
  baseUrl?: string;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  log?: (message: string) => void;
}

interface RequestOptions {
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: RequestBody;
  signal?: AbortSignal;
  /** When false, no Authorization header is sent (upload session URLs). */
  auth?: boolean;
  /** Treat these statuses as "expected" and return the Response instead of throwing. */
  allow?: number[];
  timeoutMs?: number;
}

const DEFAULT_BASE = 'https://graph.microsoft.com/v1.0';
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Thin Microsoft Graph client with retries (Retry-After aware), token refresh on 401,
 * full pagination, and resumable upload sessions.
 */
export class GraphClient {
  private readonly tokens: TokenProvider;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly log: (m: string) => void;

  constructor(opts: GraphClientOptions) {
    this.tokens = opts.tokenProvider;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxAttempts = opts.maxAttempts ?? 6;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
    this.log = opts.log ?? (() => {});
  }

  /* ------------------------------------------------------------------ */
  /* Low-level request with retry                                        */
  /* ------------------------------------------------------------------ */

  async request(method: string, pathOrUrl: string, opts: RequestOptions = {}): Promise<Response> {
    const url = this.buildUrl(pathOrUrl, opts.query);
    let attempt = 0;
    let refreshedOnce = false;
    for (;;) {
      attempt++;
      if (opts.signal?.aborted) throw new CancelledError();
      const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };
      if (opts.auth !== false) headers['Authorization'] = `Bearer ${await this.tokens.getAccessToken(false)}`;

      let res: Response;
      try {
        const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.requestTimeoutMs);
        const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
        res = await this.fetchImpl(url, { method, headers, body: opts.body ?? null, signal });
      } catch (err) {
        if (opts.signal?.aborted) throw new CancelledError();
        const timedOut = isAbortError(err) || (err as { name?: string })?.name === 'TimeoutError';
        if (attempt >= this.maxAttempts) {
          throw new NetworkError(timedOut ? `Request timed out: ${method} ${redact(url)}` : `Network error: ${describeCause(err)}`, err);
        }
        const delay = backoffMs(attempt);
        this.log(`network error on ${method} ${redact(url)} (attempt ${attempt}): ${describeCause(err)}; retrying in ${delay}ms`);
        await this.sleepCancellable(delay, opts.signal);
        continue;
      }

      if (res.ok || opts.allow?.includes(res.status)) return res;

      // Read the body once for diagnostics.
      const errInfo = await parseGraphError(res);

      if (res.status === 401 && opts.auth !== false && !refreshedOnce) {
        refreshedOnce = true;
        this.log(`401 on ${method} ${redact(url)}; refreshing token`);
        await this.tokens.getAccessToken(true);
        continue;
      }

      if (RETRYABLE_STATUSES.has(res.status) && attempt < this.maxAttempts) {
        const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
        const delay = retryAfter !== undefined ? retryAfter * 1000 : backoffMs(attempt);
        this.log(`${res.status} on ${method} ${redact(url)} (attempt ${attempt}); retrying in ${delay}ms`);
        await this.sleepCancellable(delay, opts.signal);
        continue;
      }

      throw new GraphError(errInfo.message, res.status, errInfo.code, errInfo.requestId, parseRetryAfter(res.headers.get('Retry-After')));
    }
  }

  async requestJson<T>(method: string, pathOrUrl: string, opts: RequestOptions & { json?: unknown } = {}): Promise<T> {
    const headers = { ...(opts.headers ?? {}) };
    let body = opts.body;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    const res = await this.request(method, pathOrUrl, { ...opts, headers, body });
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private buildUrl(pathOrUrl: string, query?: Record<string, string>): string {
    const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : this.baseUrl + pathOrUrl);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url.toString();
  }

  private async sleepCancellable(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new CancelledError();
    await this.sleep(ms);
    if (signal?.aborted) throw new CancelledError();
  }

  /* ------------------------------------------------------------------ */
  /* Identity                                                            */
  /* ------------------------------------------------------------------ */

  getMe(signal?: AbortSignal): Promise<GraphUser> {
    return this.requestJson<GraphUser>('GET', '/me', { query: { $select: 'id,displayName,userPrincipalName,mail' }, signal });
  }

  getMyDrive(signal?: AbortSignal): Promise<GraphDrive> {
    return this.requestJson<GraphDrive>('GET', '/me/drive', { query: { $select: 'id,driveType,name,owner,quota' }, signal });
  }

  getDrive(driveId: string, signal?: AbortSignal): Promise<GraphDrive> {
    return this.requestJson<GraphDrive>('GET', `/drives/${enc(driveId)}`, { query: { $select: 'id,driveType,name,owner,quota' }, signal });
  }

  /* ------------------------------------------------------------------ */
  /* Items                                                               */
  /* ------------------------------------------------------------------ */

  getRoot(driveId: string, signal?: AbortSignal): Promise<DriveItem> {
    return this.requestJson<DriveItem>('GET', `/drives/${enc(driveId)}/root`, { query: { $select: DRIVE_ITEM_SELECT }, signal });
  }

  async getItem(driveId: string, itemId: string, signal?: AbortSignal): Promise<DriveItem | undefined> {
    const res = await this.request('GET', `/drives/${enc(driveId)}/items/${enc(itemId)}`, { query: { $select: DRIVE_ITEM_SELECT }, signal, allow: [404] });
    if (res.status === 404) return undefined;
    return (await res.json()) as DriveItem;
  }

  /** Lists all children, following every @odata.nextLink page. */
  async listChildrenAll(driveId: string, itemId: string, signal?: AbortSignal, onPage?: (count: number) => void): Promise<DriveItem[]> {
    const out: DriveItem[] = [];
    let next: string | undefined = this.buildUrl(`/drives/${enc(driveId)}/items/${enc(itemId)}/children`, {
      $select: DRIVE_ITEM_SELECT,
      $top: '200',
    });
    while (next) {
      const page: GraphPage<DriveItem> = await this.requestJson<GraphPage<DriveItem>>('GET', next, { signal });
      out.push(...page.value);
      onPage?.(out.length);
      next = page['@odata.nextLink'];
    }
    return out;
  }

  async createFolder(
    driveId: string,
    parentId: string,
    name: string,
    conflictBehavior: 'fail' | 'replace' | 'rename' = 'fail',
    signal?: AbortSignal,
  ): Promise<DriveItem> {
    return this.requestJson<DriveItem>('POST', `/drives/${enc(driveId)}/items/${enc(parentId)}/children`, {
      json: { name, folder: {}, '@microsoft.graph.conflictBehavior': conflictBehavior },
      query: { $select: DRIVE_ITEM_SELECT },
      signal,
    });
  }

  /** Finds a direct child by name (case-insensitive, as OneDrive is). Lists all pages. */
  async findChildByName(driveId: string, parentId: string, name: string, signal?: AbortSignal): Promise<DriveItem | undefined> {
    const key = name.normalize('NFC').toLowerCase();
    const children = await this.listChildrenAll(driveId, parentId, signal);
    return children.find((c) => c.name.normalize('NFC').toLowerCase() === key);
  }

  /** Simple upload (files below the large-file threshold). Replaces existing content. */
  async uploadSmall(driveId: string, parentId: string, name: string, data: Uint8Array, signal?: AbortSignal): Promise<DriveItem> {
    return this.requestJson<DriveItem>('PUT', `/drives/${enc(driveId)}/items/${enc(parentId)}:/${encPath(name)}:/content`, {
      query: { '@microsoft.graph.conflictBehavior': 'replace', $select: DRIVE_ITEM_SELECT },
      headers: { 'Content-Type': 'application/octet-stream' },
      body: data as RequestBody,
      signal,
      timeoutMs: Math.max(this.requestTimeoutMs, 600_000),
    });
  }

  /**
   * Resumable upload: creates an upload session and PUTs fragments sequentially.
   * On transient failures the session status is queried (GET uploadUrl) and the upload
   * resumes from `nextExpectedRanges`. If the session vanished (404) it is recreated (bounded).
   */
  async uploadLarge(
    driveId: string,
    parentId: string,
    name: string,
    filePath: string,
    size: number,
    chunkSize: number,
    signal?: AbortSignal,
    onBytes?: (uploadedSoFar: number) => void,
  ): Promise<DriveItem> {
    if (chunkSize % (320 * 1024) !== 0) throw new Error('uploadChunkSize must be a multiple of 320 KiB');
    let sessionRestarts = 0;
    for (;;) {
      const session = await this.requestJson<UploadSession>('POST', `/drives/${enc(driveId)}/items/${enc(parentId)}:/${encPath(name)}:/createUploadSession`, {
        json: { item: { '@microsoft.graph.conflictBehavior': 'replace', name } },
        signal,
      });
      try {
        return await this.runUploadSession(session.uploadUrl, filePath, size, chunkSize, signal, onBytes);
      } catch (err) {
        if (err instanceof UploadSessionLost && sessionRestarts < 2) {
          sessionRestarts++;
          this.log(`upload session lost for "${name}"; restarting (${sessionRestarts})`);
          continue;
        }
        if (isAbortError(err) || err instanceof CancelledError) {
          // Best effort cleanup of temporary data.
          try {
            await this.fetchImpl(session.uploadUrl, { method: 'DELETE' });
          } catch {
            /* ignore */
          }
        }
        throw err;
      }
    }
  }

  private async runUploadSession(
    uploadUrl: string,
    filePath: string,
    size: number,
    chunkSize: number,
    signal: AbortSignal | undefined,
    onBytes: ((n: number) => void) | undefined,
  ): Promise<DriveItem> {
    const fh = await fs.open(filePath, 'r');
    try {
      let offset = 0;
      let consecutiveFailures = 0;
      const buf = Buffer.allocUnsafe(chunkSize);
      while (offset < size) {
        if (signal?.aborted) throw new CancelledError();
        const len = Math.min(chunkSize, size - offset);
        const { bytesRead } = await fh.read(buf, 0, len, offset);
        if (bytesRead !== len) {
          throw new Error(`Local file changed while uploading (expected ${len} bytes at ${offset}, read ${bytesRead})`);
        }
        const chunk = buf.subarray(0, len);
        let res: Response;
        try {
          res = await this.request('PUT', uploadUrl, {
            auth: false,
            // Content-Length is derived from the body by fetch; setting it manually is not allowed.
            headers: { 'Content-Range': `bytes ${offset}-${offset + len - 1}/${size}` },
            body: chunk as RequestBody,
            signal,
            allow: [404, 416, 409],
            timeoutMs: 600_000,
          });
        } catch (err) {
          if (isAbortError(err) || err instanceof CancelledError) throw err;
          consecutiveFailures++;
          if (consecutiveFailures > 3) throw err;
          offset = await this.resumeOffset(uploadUrl, signal);
          continue;
        }
        if (res.status === 404) throw new UploadSessionLost();
        if (res.status === 409) {
          const e = await parseGraphError(res);
          throw new GraphError(e.message, 409, e.code, e.requestId);
        }
        if (res.status === 416) {
          offset = await this.resumeOffset(uploadUrl, signal);
          continue;
        }
        consecutiveFailures = 0;
        if (res.status === 200 || res.status === 201) {
          onBytes?.(size);
          return (await res.json()) as DriveItem;
        }
        // 202 Accepted: continue from what the server expects next.
        const body = (await res.json().catch(() => ({}))) as UploadSession;
        const next = parseNextOffset(body.nextExpectedRanges);
        offset = next ?? offset + len;
        onBytes?.(offset);
      }
      // Reached the end without a final 200/201 (should not happen): ask the server.
      throw new Error('Upload session ended without a completed item');
    } finally {
      await fh.close();
    }
  }

  private async resumeOffset(uploadUrl: string, signal?: AbortSignal): Promise<number> {
    const res = await this.request('GET', uploadUrl, { auth: false, signal, allow: [404] });
    if (res.status === 404) throw new UploadSessionLost();
    const body = (await res.json()) as UploadSession;
    const next = parseNextOffset(body.nextExpectedRanges);
    if (next === undefined) throw new UploadSessionLost();
    return next;
  }

  /** Moves and/or renames an item. If-Match guards against concurrent remote changes. */
  async moveItem(driveId: string, itemId: string, newParentId: string, newName: string, ifMatch?: string, signal?: AbortSignal): Promise<DriveItem> {
    return this.requestJson<DriveItem>('PATCH', `/drives/${enc(driveId)}/items/${enc(itemId)}`, {
      json: { parentReference: { id: newParentId }, name: newName, '@microsoft.graph.conflictBehavior': 'fail' },
      headers: ifMatch ? { 'If-Match': ifMatch } : {},
      query: { $select: DRIVE_ITEM_SELECT },
      signal,
    });
  }

  /**
   * Deletes an item (to the recycle bin). With `ifMatch`, a concurrent remote change yields
   * 'preconditionFailed' instead of a blind deletion.
   */
  async deleteItem(driveId: string, itemId: string, ifMatch?: string, signal?: AbortSignal): Promise<'deleted' | 'notFound' | 'preconditionFailed'> {
    const res = await this.request('DELETE', `/drives/${enc(driveId)}/items/${enc(itemId)}`, {
      headers: ifMatch ? { 'If-Match': ifMatch } : {},
      signal,
      allow: [404, 412],
    });
    if (res.status === 404) return 'notFound';
    if (res.status === 412) return 'preconditionFailed';
    return 'deleted';
  }
}

export class UploadSessionLost extends Error {
  constructor() {
    super('Upload session no longer exists');
    this.name = 'UploadSessionLost';
  }
}

/* -------------------------------------------------------------------- */
/* Helpers                                                               */
/* -------------------------------------------------------------------- */

function enc(s: string): string {
  return encodeURIComponent(s);
}

/** Path segment for the `:/name:/` addressing form. */
function encPath(name: string): string {
  return encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function parseNextOffset(ranges: string[] | undefined): number | undefined {
  if (!ranges || ranges.length === 0) return undefined;
  const first = ranges[0]!;
  const start = Number.parseInt(first.split('-')[0]!, 10);
  return Number.isFinite(start) ? start : undefined;
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, n);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return undefined;
}

export function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** (attempt - 1));
  return Math.round(base / 2 + Math.random() * (base / 2));
}

async function parseGraphError(res: Response): Promise<{ message: string; code?: string; requestId?: string }> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    /* ignore */
  }
  try {
    const j = JSON.parse(text) as { error?: { code?: string; message?: string; innerError?: { 'request-id'?: string } } };
    if (j.error) {
      return { message: j.error.message ?? res.statusText, code: j.error.code, requestId: j.error.innerError?.['request-id'] };
    }
  } catch {
    /* not JSON */
  }
  return { message: text ? text.slice(0, 300) : res.statusText || `HTTP ${res.status}` };
}

/** Strip query strings and upload-session tokens from URLs before logging. */
function redact(url: string): string {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('graph.microsoft.com')) return `${u.protocol}//${u.hostname}/<upload-session>`;
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<url>';
  }
}

function describeCause(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code) return `${err.message} (${cause.code})`;
    return err.message;
  }
  return String(err);
}

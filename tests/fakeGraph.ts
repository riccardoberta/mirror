/**
 * In-memory simulation of the subset of Microsoft Graph used by Mirror.
 *
 * This is a SIMULATED backend for unit tests: it models drive items, paging, upload sessions,
 * eTags / If-Match, conflict behaviour and lets tests inject throttling (429 + Retry-After),
 * server errors and network failures. It is not OneDrive; see docs/TESTING.md for the real tests.
 */
import { createHash } from 'node:crypto';
import { QuickXorHash } from '../src/core/quickxorhash.js';
import type { FetchLike } from '../src/core/graph/client.js';

export interface FakeItem {
  id: string;
  name: string;
  parentId: string | null; // null for drive root
  kind: 'file' | 'folder';
  content: Buffer;
  version: number;
  isPackage?: boolean;
}

export interface FakeFault {
  /** Method + path regex (path only, no origin). */
  method?: string;
  pathPattern: RegExp;
  /** How many times to apply the fault (default 1). */
  times?: number;
  /** HTTP status to return; omit and set `network: true` to simulate a connection failure. */
  status?: number;
  retryAfter?: string;
  network?: boolean;
  body?: unknown;
}

export interface FakeGraphOptions {
  pageSize?: number;
  hashes?: 'quickXor' | 'both' | 'none';
  driveId?: string;
  userId?: string;
  /** Quota remaining in bytes; uploads beyond it fail with 507. */
  quotaRemaining?: number;
}

export class FakeGraph {
  readonly items = new Map<string, FakeItem>();
  readonly driveId: string;
  readonly userId: string;
  readonly rootId = 'root-item';
  readonly requests: Array<{ method: string; url: string }> = [];
  /** Test hook invoked before every request is handled (after fault injection). */
  onRequest?: (method: string, url: string) => void | Promise<void>;
  private nextId = 1;
  private faults: FakeFault[] = [];
  private sessions = new Map<string, { parentId: string; name: string; received: number; total?: number; chunks: Buffer[] }>();
  private readonly pageSize: number;
  private readonly hashMode: 'quickXor' | 'both' | 'none';
  private quotaRemaining: number;

  constructor(opts: FakeGraphOptions = {}) {
    this.pageSize = opts.pageSize ?? 2;
    this.hashMode = opts.hashes ?? 'quickXor';
    this.driveId = opts.driveId ?? 'drive-1';
    this.userId = opts.userId ?? 'user-1';
    this.quotaRemaining = opts.quotaRemaining ?? Number.MAX_SAFE_INTEGER;
    this.items.set(this.rootId, { id: this.rootId, name: 'root', parentId: null, kind: 'folder', content: Buffer.alloc(0), version: 1 });
  }

  /* ----------------------------- test helpers ----------------------------- */

  mkdir(parentId: string, name: string): FakeItem {
    const id = `item-${this.nextId++}`;
    const item: FakeItem = { id, name, parentId, kind: 'folder', content: Buffer.alloc(0), version: 1 };
    this.items.set(id, item);
    return item;
  }

  put(parentId: string, name: string, content: string | Buffer): FakeItem {
    const buf = typeof content === 'string' ? Buffer.from(content) : content;
    const existing = this.childByName(parentId, name);
    if (existing) {
      existing.content = buf;
      existing.version++;
      return existing;
    }
    const id = `item-${this.nextId++}`;
    const item: FakeItem = { id, name, parentId, kind: 'file', content: buf, version: 1 };
    this.items.set(id, item);
    return item;
  }

  /** Simulates an edit made on OneDrive by another client (bumps the eTag). */
  touch(id: string, content?: string): void {
    const it = this.items.get(id)!;
    if (content !== undefined) it.content = Buffer.from(content);
    it.version++;
  }

  injectFault(f: FakeFault): void {
    this.faults.push({ times: 1, ...f });
  }

  childByName(parentId: string, name: string): FakeItem | undefined {
    const key = name.normalize('NFC').toLowerCase();
    for (const it of this.items.values()) if (it.parentId === parentId && it.name.normalize('NFC').toLowerCase() === key) return it;
    return undefined;
  }

  children(parentId: string): FakeItem[] {
    return [...this.items.values()].filter((i) => i.parentId === parentId).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Returns a map relPath → content (files) / null (folders) below a folder. */
  tree(folderId: string, prefix = ''): Map<string, string | null> {
    const out = new Map<string, string | null>();
    for (const c of this.children(folderId)) {
      const rel = prefix ? `${prefix}/${c.name}` : c.name;
      if (c.kind === 'folder') {
        out.set(rel, null);
        for (const [k, v] of this.tree(c.id, rel)) out.set(k, v);
      } else {
        out.set(rel, c.content.toString());
      }
    }
    return out;
  }

  pathOf(id: string): string {
    const it = this.items.get(id)!;
    if (it.parentId === null) return '/drive/root:';
    return `${this.pathOf(it.parentId)}/${it.name}`;
  }

  /* ------------------------------ fetch impl ------------------------------ */

  get fetch(): FetchLike {
    return async (url, init) => this.handle(url, init);
  }

  private eTag(it: FakeItem): string {
    return `"etag-${it.id}-${it.version}"`;
  }

  private serialize(it: FakeItem): Record<string, unknown> {
    const out: Record<string, unknown> = {
      id: it.id,
      name: it.name,
      size: it.kind === 'file' ? it.content.length : this.children(it.id).reduce((n, c) => n + c.content.length, 0),
      eTag: this.eTag(it),
      cTag: `"ctag-${it.id}-${it.version}"`,
      lastModifiedDateTime: new Date().toISOString(),
      parentReference: it.parentId ? { driveId: this.driveId, id: it.parentId, path: this.pathOf(it.parentId) } : { driveId: this.driveId },
    };
    if (it.parentId === null) out.root = {};
    if (it.kind === 'folder') {
      if (it.isPackage) out.package = { type: 'oneNote' };
      else out.folder = { childCount: this.children(it.id).length };
    } else {
      const hashes: Record<string, string> = {};
      if (this.hashMode !== 'none') hashes.quickXorHash = QuickXorHash.ofBuffer(it.content);
      if (this.hashMode === 'both') hashes.sha1Hash = createHash('sha1').update(it.content).digest('hex').toUpperCase();
      out.file = { mimeType: 'application/octet-stream', hashes };
    }
    return out;
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  }

  private error(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
    return this.json(status, { error: { code, message, innerError: { 'request-id': `req-${this.requests.length}` } } }, headers);
  }

  private async handle(url: string, init: RequestInit): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const u = new URL(url);
    this.requests.push({ method, url });
    const headers = new Headers(init.headers as Record<string, string>);

    // Fault injection
    const fi = this.faults.findIndex((f) => (!f.method || f.method === method) && f.pathPattern.test(u.pathname + u.search));
    if (fi >= 0) {
      const f = this.faults[fi]!;
      f.times = (f.times ?? 1) - 1;
      if (f.times <= 0) this.faults.splice(fi, 1);
      if (f.network) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      const h: Record<string, string> = {};
      if (f.retryAfter) h['Retry-After'] = f.retryAfter;
      return f.body !== undefined ? this.json(f.status ?? 500, f.body, h) : this.error(f.status ?? 500, f.status === 429 ? 'activityLimitReached' : 'generalException', 'injected fault', h);
    }

    await this.onRequest?.(method, url);

    // Upload session endpoints live on a different host.
    if (u.hostname === 'upload.fake') return this.handleUpload(u, method, init, headers);

    if (headers.get('Authorization') !== 'Bearer good-token') return this.error(401, 'InvalidAuthenticationToken', 'Access token is empty or invalid.');

    const p = decodeURIComponent(u.pathname.replace(/^\/v1\.0/, ''));
    const q = u.searchParams;

    if (method === 'GET' && p === '/me') return this.json(200, { id: this.userId, displayName: 'Test User', userPrincipalName: 'test@example.org' });
    if (method === 'GET' && p === '/me/drive') return this.json(200, { id: this.driveId, driveType: 'business', quota: { remaining: this.quotaRemaining } });

    let m: RegExpExecArray | null;
    if ((m = /^\/drives\/([^/]+)\/root$/.exec(p)) && method === 'GET') {
      return this.json(200, this.serialize(this.items.get(this.rootId)!));
    }
    if ((m = /^\/drives\/([^/]+)\/root\/children$/.exec(p)) && method === 'GET') {
      return this.page(this.rootId, q);
    }
    if ((m = /^\/drives\/([^/]+)\/items\/([^/:]+)\/children$/.exec(p))) {
      const parent = this.items.get(m[2]!);
      if (!parent || parent.kind !== 'folder') return this.error(404, 'itemNotFound', 'not found');
      if (method === 'GET') return this.page(parent.id, q);
      if (method === 'POST') {
        const body = JSON.parse(String(init.body)) as { name: string; folder?: unknown; '@microsoft.graph.conflictBehavior'?: string };
        const existing = this.childByName(parent.id, body.name);
        if (existing) {
          const cb = body['@microsoft.graph.conflictBehavior'] ?? 'fail';
          if (cb === 'fail') return this.error(409, 'nameAlreadyExists', 'An item with the same name already exists under the parent');
          if (cb === 'replace' && existing.kind === 'folder') return this.json(200, this.serialize(existing));
        }
        const it = this.mkdir(parent.id, body.name);
        return this.json(201, this.serialize(it));
      }
    }
    if ((m = /^\/drives\/([^/]+)\/items\/([^/:]+):\/(.+):\/content$/.exec(p)) && method === 'PUT') {
      const parent = this.items.get(m[2]!);
      if (!parent || parent.kind !== 'folder') return this.error(404, 'itemNotFound', 'parent not found');
      const name = m[3]!;
      const buf = Buffer.from(await bodyBytes(init.body));
      if (buf.length > this.quotaRemaining) return this.error(507, 'quotaLimitReached', 'Insufficient Storage');
      this.quotaRemaining -= buf.length;
      const existing = this.childByName(parent.id, name);
      if (existing && existing.kind === 'folder') return this.error(409, 'nameAlreadyExists', 'folder exists');
      const cb = q.get('@microsoft.graph.conflictBehavior') ?? 'fail';
      if (existing && cb === 'fail') return this.error(409, 'nameAlreadyExists', 'exists');
      const it = this.put(parent.id, name, buf);
      return this.json(existing ? 200 : 201, this.serialize(it));
    }
    if ((m = /^\/drives\/([^/]+)\/items\/([^/:]+):\/(.+):\/createUploadSession$/.exec(p)) && method === 'POST') {
      const parent = this.items.get(m[2]!);
      if (!parent || parent.kind !== 'folder') return this.error(404, 'itemNotFound', 'parent not found');
      const sid = `s${this.nextId++}`;
      this.sessions.set(sid, { parentId: parent.id, name: m[3]!, received: 0, chunks: [] });
      return this.json(200, { uploadUrl: `https://upload.fake/${sid}`, expirationDateTime: new Date(Date.now() + 3600_000).toISOString() });
    }
    if ((m = /^\/drives\/([^/]+)\/items\/([^/:]+)$/.exec(p))) {
      const it = this.items.get(m[2]!);
      if (!it) return this.error(404, 'itemNotFound', 'The resource could not be found.');
      const ifMatch = headers.get('If-Match');
      if (method === 'GET') return this.json(200, this.serialize(it));
      if (method === 'DELETE') {
        if (ifMatch && ifMatch !== this.eTag(it)) return this.error(412, 'resourceModified', 'ETag does not match');
        this.deleteRecursive(it.id);
        return new Response(null, { status: 204 });
      }
      if (method === 'PATCH') {
        if (ifMatch && ifMatch !== this.eTag(it)) return this.error(412, 'resourceModified', 'ETag does not match');
        const body = JSON.parse(String(init.body)) as { name?: string; parentReference?: { id?: string } };
        const newParent = body.parentReference?.id ?? it.parentId!;
        const newName = body.name ?? it.name;
        if (!this.items.get(newParent)) return this.error(404, 'itemNotFound', 'target parent not found');
        const clash = this.childByName(newParent, newName);
        if (clash && clash.id !== it.id) return this.error(409, 'nameAlreadyExists', 'exists');
        it.parentId = newParent;
        it.name = newName;
        it.version++;
        return this.json(200, this.serialize(it));
      }
    }
    return this.error(400, 'invalidRequest', `unhandled ${method} ${p}`);
  }

  private page(parentId: string, q: URLSearchParams): Response {
    const all = this.children(parentId);
    const skip = Number(q.get('$skip') ?? '0');
    const top = Math.min(Number(q.get('$top') ?? this.pageSize), this.pageSize);
    const slice = all.slice(skip, skip + top);
    const body: Record<string, unknown> = { value: slice.map((i) => this.serialize(i)) };
    if (skip + top < all.length) {
      const next = new URL(`https://graph.microsoft.com/v1.0/drives/${this.driveId}/items/${parentId}/children`);
      next.searchParams.set('$top', String(top));
      next.searchParams.set('$skip', String(skip + top));
      next.searchParams.set('$select', q.get('$select') ?? '');
      body['@odata.nextLink'] = next.toString();
    }
    return this.json(200, body);
  }

  private deleteRecursive(id: string): void {
    for (const c of this.children(id)) this.deleteRecursive(c.id);
    this.items.delete(id);
  }

  private async handleUpload(u: URL, method: string, init: RequestInit, headers: Headers): Promise<Response> {
    const sid = u.pathname.slice(1);
    const s = this.sessions.get(sid);
    if (!s) return this.error(404, 'itemNotFound', 'upload session not found');
    if (headers.has('Authorization')) return this.error(401, 'InvalidAuthenticationToken', 'Authorization header must not be sent to the upload URL');
    if (method === 'GET') return this.json(200, { nextExpectedRanges: [`${s.received}-`] });
    if (method === 'DELETE') {
      this.sessions.delete(sid);
      return new Response(null, { status: 204 });
    }
    if (method === 'PUT') {
      const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(headers.get('Content-Range') ?? '');
      if (!range) return this.error(400, 'invalidRequest', 'bad Content-Range');
      const start = Number(range[1]);
      const end = Number(range[2]);
      const total = Number(range[3]);
      if (start !== s.received) return this.json(416, { error: { code: 'invalidRange', message: 'fragment overlaps' } });
      const buf = Buffer.from(await bodyBytes(init.body));
      if (buf.length !== end - start + 1) return this.error(400, 'invalidRequest', 'length mismatch');
      if (buf.length % (320 * 1024) !== 0 && end + 1 !== total) return this.error(400, 'invalidRequest', 'fragment not a multiple of 320 KiB');
      s.chunks.push(buf);
      s.received = end + 1;
      s.total = total;
      if (s.received < total) return this.json(202, { nextExpectedRanges: [`${s.received}-`] });
      const content = Buffer.concat(s.chunks);
      if (content.length > this.quotaRemaining) return this.error(507, 'quotaLimitReached', 'Insufficient Storage');
      this.quotaRemaining -= content.length;
      const existing = this.childByName(s.parentId, s.name);
      const it = this.put(s.parentId, s.name, content);
      this.sessions.delete(sid);
      return this.json(existing ? 200 : 201, this.serialize(it));
    }
    return this.error(400, 'invalidRequest', 'unhandled upload method');
  }
}

async function bodyBytes(body: RequestInit['body'] | undefined): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

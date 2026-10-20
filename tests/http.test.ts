/**
 * Exercises GraphClient over a real local HTTP server (Node's global fetch / undici), to make sure
 * the request shapes used against Microsoft Graph are valid on the wire: Buffer bodies get a
 * Content-Length, Content-Range reaches the server, Retry-After is honoured, nextLink paging works.
 * Still SIMULATED: the server is a local stub, not OneDrive.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphClient } from '../src/core/graph/client.js';

let server: Server;
let base: string;
const seen: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }> = [];
let throttleOnce = true;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/v1.0/page') {
      const skip = Number(url.searchParams.get('skip') ?? '0');
      const page = { value: [skip, skip + 1], ...(skip < 4 ? { '@odata.nextLink': `${base}/v1.0/page?skip=${skip + 2}` } : {}) };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(page));
      return;
    }
    if (url.pathname === '/v1.0/throttle') {
      if (throttleOnce) {
        throttleOnce = false;
        res.statusCode = 429;
        res.setHeader('Retry-After', '1');
        res.end(JSON.stringify({ error: { code: 'activityLimitReached', message: 'slow down' } }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/upload') {
      res.statusCode = 202;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ nextExpectedRanges: [`${body.length}-`] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { code: 'itemNotFound', message: 'nope' } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function client(): { c: GraphClient; sleeps: number[] } {
  const sleeps: number[] = [];
  const c = new GraphClient({
    tokenProvider: { getAccessToken: async () => 'tok' },
    baseUrl: `${base}/v1.0`,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { c, sleeps };
}

describe('GraphClient over real HTTP', () => {
  it('sends Buffer bodies with Content-Length and custom Content-Range', async () => {
    const { c } = client();
    const data = Buffer.alloc(1000, 5);
    const res = await c.request('PUT', `${base}/upload`, { auth: false, headers: { 'Content-Range': 'bytes 0-999/5000' }, body: data, allow: [202] });
    expect(res.status).toBe(202);
    const last = seen[seen.length - 1]!;
    expect(last.headers['content-length']).toBe('1000');
    expect(last.headers['content-range']).toBe('bytes 0-999/5000');
    expect(last.headers['authorization']).toBeUndefined();
    expect(last.body.length).toBe(1000);
  });

  it('follows absolute nextLink URLs and sends the bearer token', async () => {
    const { c } = client();
    const all: number[] = [];
    let next: string | undefined = `${base}/v1.0/page`;
    while (next) {
      const page: { value: number[]; '@odata.nextLink'?: string } = await c.requestJson('GET', next);
      all.push(...page.value);
      next = page['@odata.nextLink'];
    }
    expect(all).toEqual([0, 1, 2, 3, 4, 5]);
    expect(seen.filter((s) => s.url.startsWith('/v1.0/page')).every((s) => s.headers['authorization'] === 'Bearer tok')).toBe(true);
  });

  it('honours Retry-After on 429', async () => {
    const { c, sleeps } = client();
    const r = await c.requestJson<{ ok: boolean }>('GET', '/throttle');
    expect(r.ok).toBe(true);
    expect(sleeps).toEqual([1000]);
  });

  it('surfaces Graph error payloads', async () => {
    const { c } = client();
    await expect(c.requestJson('GET', '/missing')).rejects.toMatchObject({ status: 404, code: 'itemNotFound' });
  });
});

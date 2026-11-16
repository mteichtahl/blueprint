import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * public/sw.js keeps the app's built files (/assets/*) and nothing else.
 * It runs here against a small stand-in for the worker scope.
 */

type Handler = (event: {
  request: Request;
  respondWith: (r: Promise<Response>) => void;
  waitUntil: (p: Promise<unknown>) => void;
}) => void;

const ORIGIN = 'https://app.example';

function load(brokenCache = false) {
  const stores = new Map<string, Map<string, Response>>();
  const open = (name: string) => {
    if (brokenCache) return Promise.reject(new Error('no storage'));
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return Promise.resolve({
      match: (r: Request) => Promise.resolve(store.get(r.url)?.clone()),
      put: (r: Request, res: Response) => Promise.resolve(void store.set(r.url, res)),
      keys: () => Promise.resolve([...store.keys()].map((u) => new Request(u))),
      delete: (r: Request) => Promise.resolve(store.delete(r.url)),
    });
  };
  const handlers: Record<string, Handler> = {};
  const scope = {
    location: { origin: ORIGIN },
    caches: {
      open,
      keys: () => Promise.resolve([...stores.keys()]),
      delete: (n: string) => Promise.resolve(stores.delete(n)),
    },
    clients: { claim: () => Promise.resolve() },
    registration: {},
    addEventListener: (name: string, fn: Handler) => void (handlers[name] = fn),
    skipWaiting: () => undefined,
  };
  const source = readFileSync(resolve(import.meta.dirname, '../public/sw.js'), 'utf8');
  new Function('self', source)(scope);

  /** Sends a request through the worker; undefined when it leaves it to the browser. */
  const request = (path: string, init?: RequestInit): Promise<Response> | undefined => {
    let answer: Promise<Response> | undefined;
    handlers.fetch!({
      request: new Request(path.startsWith('http') ? path : ORIGIN + path, init),
      respondWith: (r) => void (answer = r),
      waitUntil: () => undefined,
    });
    return answer;
  };
  const activate = async () => {
    let done: Promise<unknown> = Promise.resolve();
    handlers.activate!({
      request: new Request(ORIGIN),
      respondWith: () => undefined,
      waitUntil: (p) => void (done = p),
    });
    await done;
  };
  return { stores, request, activate, open };
}

const file = (body: string, type = 'text/javascript', status = 200) => {
  const res = new Response(body, { status, headers: { 'content-type': type } });
  Object.defineProperty(res, 'type', { value: 'basic' });
  return res;
};

describe('service worker: app file cache', () => {
  const fetchMock = vi.fn<(r: Request) => Promise<Response>>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('downloads a built file once, then serves it from the cache', async () => {
    const sw = load();
    fetchMock.mockResolvedValue(file('console.log(1)'));
    expect(await (await sw.request('/assets/index-abc.js'))!.text()).toBe('console.log(1)');
    expect(await (await sw.request('/assets/index-abc.js'))!.text()).toBe('console.log(1)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves the page, settings, the API, other sites and uploads to the network', () => {
    const sw = load();
    expect(sw.request('/')).toBeUndefined();
    expect(sw.request('/config.json')).toBeUndefined();
    expect(sw.request('/v1/conversations')).toBeUndefined();
    expect(sw.request('https://elsewhere.example/assets/x.js')).toBeUndefined();
    expect(sw.request('/assets/x.js', { method: 'POST' })).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never keeps an error or a page in place of a file', async () => {
    const sw = load();
    fetchMock.mockResolvedValueOnce(file('gone', 'application/xml', 403));
    expect((await sw.request('/assets/old-123.js'))!.status).toBe(403);
    fetchMock.mockResolvedValueOnce(file('<!doctype html>', 'text/html'));
    await sw.request('/assets/odd-456.js');
    expect(sw.stores.get('bmg-assets-v1')?.size ?? 0).toBe(0);
  });

  it('falls back to the network when the cache cannot be used', async () => {
    const sw = load(true);
    fetchMock.mockImplementation(() => Promise.resolve(file('ok')));
    expect(await (await sw.request('/assets/a-1.js'))!.text()).toBe('ok');
  });

  it('drops the oldest files past the limit, and old caches on activate', async () => {
    const sw = load();
    fetchMock.mockImplementation(() => Promise.resolve(file('x')));
    for (let i = 0; i < 185; i += 1) await sw.request(`/assets/f-${i}.js`);
    const kept = sw.stores.get('bmg-assets-v1')!;
    expect(kept.size).toBe(180);
    expect(kept.has(`${ORIGIN}/assets/f-0.js`)).toBe(false);
    expect(kept.has(`${ORIGIN}/assets/f-184.js`)).toBe(true);

    await sw.open('bmg-assets-v0');
    await sw.open('something-else');
    await sw.activate();
    expect([...sw.stores.keys()].sort()).toEqual(['bmg-assets-v1', 'something-else']);
  });
});

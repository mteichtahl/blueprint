import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/lib/api.ts';

const cfg = {
  loginDomain: 'x',
  clientId: 'c',
  region: 'ap-southeast-2',
  userPoolId: 'p',
  apiBase: '/v1',
};

afterEach(() => vi.unstubAllGlobals());

describe('api', () => {
  it('sends the access token and JSON body to the same-origin API', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api(cfg, 'tok', 'POST', '/consent', { a: 1 })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/v1/consent', {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: '{"a":1}',
    });
  });

  it('turns problem+json into an ApiError with the detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            '{"title":"Forbidden","status":403,"detail":"admin actions need a fresh step-up"}',
            { status: 403 },
          ),
      ),
    );
    const err = await api(cfg, 'tok', 'GET', '/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).message).toBe('admin actions need a fresh step-up');
  });
});

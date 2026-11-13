import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, needsFreshSignIn, REAUTH_MESSAGE } from '../src/lib/api.ts';

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

  it('turns a fresh step-up refusal into the plain sign-in-again message', async () => {
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
    expect((err as ApiError).message).toBe(REAUTH_MESSAGE);
    expect((err as ApiError).reauth).toBe(true);
    expect(needsFreshSignIn(err)).toBe(true);
  });

  it("keeps the server's detail for other refusals", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"title":"Forbidden","status":403,"detail":"Blueprint only"}', {
            status: 403,
          }),
      ),
    );
    const err = await api(cfg, 'tok', 'GET', '/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('Blueprint only');
    expect(needsFreshSignIn(err)).toBe(false);
  });
});

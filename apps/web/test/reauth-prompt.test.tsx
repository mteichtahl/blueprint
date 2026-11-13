// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReauthPrompt } from '../src/components/ReauthPrompt.tsx';
import { api, REAUTH_MESSAGE } from '../src/lib/api.ts';

const cfg = {
  loginDomain: 'x',
  clientId: 'c',
  region: 'ap-southeast-2',
  userPoolId: 'p',
  apiBase: '/v1',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function refuse(detail: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ title: 'Forbidden', status: 403, detail }), { status: 403 }),
    ),
  );
}

describe('ReauthPrompt', () => {
  it('opens on any screen when an admin action needs a fresh sign-in', async () => {
    const onReauth = vi.fn();
    render(<ReauthPrompt onReauth={onReauth} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    refuse('admin actions need a fresh step-up');
    await act(async () => {
      await expect(api(cfg, 'tok', 'POST', '/connectors/apps', {})).rejects.toThrow(REAUTH_MESSAGE);
    });

    expect(screen.getByRole('alertdialog', { name: 'Confirm it’s you' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(onReauth).toHaveBeenCalledOnce();
  });

  it('closes with Not now, and stays shut for other refusals', async () => {
    render(<ReauthPrompt onReauth={() => {}} />);
    refuse('Making recovery codes needs a fresh step-up');
    await act(async () => {
      await api(cfg, 'tok', 'POST', '/access/recovery-codes', {}).catch(() => {});
    });
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();

    refuse('Blueprint only');
    await act(async () => {
      await api(cfg, 'tok', 'GET', '/access/team').catch(() => {});
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

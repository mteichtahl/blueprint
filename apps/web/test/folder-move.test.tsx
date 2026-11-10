// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MoveDialog } from '../src/components/Folders.tsx';
import { Library } from '../src/pages/Library.tsx';
import type { AppConfig } from '../src/lib/config.ts';

const calls: string[] = [];
let fileFolder: string | null = null;
const folder = {
  folderId: 'fold000000001',
  name: 'Contracts',
  parentId: null,
  sharedWithMe: false,
  path: [],
  level: 'manage',
  customAccess: false,
  ownerId: 'u1',
  ownerName: 'K',
  ownedByMe: true,
  createdAt: '',
  updatedAt: '',
};
const file = () => ({
  fileId: 'file000000001',
  scope: 'library',
  artistId: null,
  name: 'rider.pdf',
  title: null,
  displayName: 'rider.pdf',
  fileType: { kind: 'pdf', label: 'PDF', ext: 'pdf', mime: 'application/pdf', detected: true },
  hasThumbnail: false,
  thumbnailUrl: null,
  size: 10,
  contentType: 'application/pdf',
  status: 'available',
  rejectReason: null,
  visibility: null,
  sharing: 'bmg-only',
  sharedWithArtistIds: [],
  uploadedByMe: true,
  uploaderRole: 'bmg-admin',
  ownerId: 'u1',
  ownerRole: 'bmg-admin',
  ownerName: 'K',
  ownerJobTitle: '',
  ownedByMe: true,
  editAccess: 'everyone',
  editorIds: [],
  locked: false,
  canEdit: true,
  canManage: true,
  version: 1,
  versionUploadedBy: 'u1',
  versionUploadedByName: 'K',
  versionCreatedAt: '',
  versionNote: null,
  versions: [],
  pendingVersion: null,
  createdAt: '2026-11-10T00:00:00Z',
  availableAt: null,
  asset: null,
  folderId: fileFolder,
  customAccess: false,
  level: 'manage',
  canMove: true,
});

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const m = init?.method ?? 'GET';
  calls.push(`${m} ${url} ${init?.body ?? ''}`);
  let body: unknown = {};
  if (url.endsWith('/library/files')) body = { files: [file()] };
  else if (url.includes('/library/files/')) body = file();
  else if (url.endsWith('/library/folders'))
    body = { root: { level: 'manage' }, folders: [folder] };
  else if (url.endsWith('/folders/move')) {
    const b = JSON.parse(String(init?.body));
    if (!b.preview) fileFolder = b.to;
    body = { items: 1, changes: [] };
  }
  return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;
window.matchMedia ??= ((q: string) => ({
  matches: false,
  media: q,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
})) as unknown as typeof window.matchMedia;

const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  fileFolder = null;
  calls.length = 0;
  document.body.innerHTML = '';
});

const lib = () =>
  render(<Library cfg={{ apiBase: '' } as AppConfig} token="t" isBmg artists={[]} />);
const movesSent = () =>
  calls.filter((c) => c.includes('/folders/move') && c.includes('"preview":false')).length;

describe('moving a document into a folder', () => {
  it('from its page: says where it went, and Open the folder shows it there', async () => {
    lib();
    await settle();
    fireEvent.click(screen.getAllByText('rider.pdf')[0]!);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /Move to…/ }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /Contracts/ }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Move here' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /^Move to Contracts/ }));
    await settle();
    expect(movesSent()).toBe(1);
    expect(screen.getByText(/Moved to “Contracts”/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open the folder' }));
    await settle();
    expect(screen.getByRole('navigation', { name: 'Folder path' }).textContent).toContain(
      'Contracts',
    );
    expect(screen.getByText('rider.pdf')).toBeTruthy();
  });

  it('by drag and drop: opens the folder it went to', async () => {
    lib();
    await settle();
    const row = screen.getAllByText('rider.pdf')[0]!.closest('tr')!;
    const dt = { setData() {}, getData: () => '', effectAllowed: '' };
    fireEvent.dragStart(row, { dataTransfer: dt });
    const target = screen.getByRole('list', { name: 'Folders' }).querySelector('li')!;
    fireEvent.dragOver(target, { dataTransfer: dt });
    fireEvent.drop(target, { dataTransfer: dt });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /^Move to Contracts/ }));
    await settle();
    expect(movesSent()).toBe(1);
    expect(screen.getByText(/Moved to “Contracts”/)).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Folder path' }).textContent).toContain(
      'Contracts',
    );
    expect(screen.getByText('rider.pdf')).toBeTruthy();
  });

  it('the confirm button stays ready when the page around it redraws', async () => {
    const props = {
      cfg: { apiBase: '' } as AppConfig,
      token: 't',
      base: '/library/folders',
      rootLabel: 'Library',
      to: 'fold000000001',
      onClose: () => {},
      onMoved: () => {},
    };
    const view = render(<MoveDialog {...props} items={[{ kind: 'file', id: 'file000000001' }]} />);
    await settle();
    const previews = () => calls.filter((c) => c.includes('"preview":true')).length;
    expect(previews()).toBe(1);
    // A parent redraw passes a new (equal) array.
    view.rerender(<MoveDialog {...props} items={[{ kind: 'file', id: 'file000000001' }]} />);
    await settle();
    expect(previews()).toBe(1);
    const btn = screen.getByRole('button', { name: /^Move to Contracts/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
});

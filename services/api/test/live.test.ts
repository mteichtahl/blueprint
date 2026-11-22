import { describe, expect, it } from 'vitest';
import { nudgeFor, nudgesFor } from '../src/live/model.ts';

describe('live nudges', () => {
  it('sends artist changes to that artist and to Blueprint', () => {
    expect(nudgeFor('ARTIST#art_abcdefghij', 'GIG#g1')).toEqual({
      topic: 'gigs',
      artistId: 'art_abcdefghij',
      channels: ['/inbox/artist-art-abcdefghij', '/inbox/bmg'],
    });
    expect(nudgeFor('ARTIST#art_abcdefghij', 'TODO#t1')?.topic).toBe('todos');
    expect(nudgeFor('ARTIST#art_abcdefghij', 'TODOC#t1#2026#c1')?.topic).toBe('todos');
    expect(nudgeFor('ARTIST#art_abcdefghij', 'PLAN')?.topic).toBe('plan');
    expect(nudgeFor('ARTIST#art_abcdefghij', 'PROFILE')?.topic).toBe('artists');
  });

  it('sends shared lists to everyone, Blueprint-only lists to Blueprint', () => {
    expect(nudgeFor('ORG#venues', 'VENUE#v1')?.channels).toEqual([
      '/inbox/bmg',
      '/inbox/all-artists',
    ]);
    expect(nudgeFor('ORG#events', 'EVENT#e1')?.channels).toEqual(['/inbox/bmg']);
    expect(nudgeFor('EVENT#e1', 'GIG#x')).toEqual({ topic: 'events', channels: ['/inbox/bmg'] });
    expect(nudgeFor('INVITE#a@b.c', 'INVITE')).toEqual({
      topic: 'artists',
      channels: ['/inbox/bmg'],
    });
  });

  it('ignores items no screen shows', () => {
    expect(nudgeFor('SESSION#x', 'META')).toBeUndefined();
    expect(nudgeFor('ARTIST#art_abcdefghij', 'KB')).toBeUndefined();
    expect(nudgeFor('ARTIST#art_abcdefghij', '2026-11-21#spotify')).toBeUndefined();
    expect(nudgeFor('USER#sub', 'PROFILE')).toBeUndefined();
  });

  it('sends one nudge per topic and artist for a batch', () => {
    const out = nudgesFor([
      { pk: 'ARTIST#art_abcdefghij', sk: 'TODO#1' },
      { pk: 'ARTIST#art_abcdefghij', sk: 'TODO#2' },
      { pk: 'ARTIST#art_abcdefghij', sk: 'GIG#1' },
      { pk: 'ARTIST#art_klmnopqrst', sk: 'TODO#3' },
      { pk: 'RATE#x', sk: 'y' },
    ]);
    expect(out.map((n) => `${n.topic}:${n.artistId}`)).toEqual([
      'todos:art_abcdefghij',
      'gigs:art_abcdefghij',
      'todos:art_klmnopqrst',
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import type { Principal } from '@bmg/authz';
import {
  applyContentPatch,
  artistsInvolved,
  clock,
  emptyContent,
  isMeetingAudio,
  jobName,
  mediaFormat,
  meetingAllowed,
  MeetingCreate,
  meetingDate,
  meetingFileName,
  meetingFolderPath,
  meetingFromJob,
  noteMarkdown,
  parseSpaceParam,
  segmentsFromTranscribe,
  speakerCount,
  speakerName,
  transcriptionBlock,
  type Meeting,
} from '../src/meetings/model.ts';

const ARTIST = 'art_aaaaaaaaaaaa';
const OTHER = 'art_bbbbbbbbbbbb';
const who = (role: Principal['role'], extra: Partial<Principal> = {}): Principal => ({
  sub: '11111111-1111-1111-1111-111111111111',
  role,
  mfaSatisfied: true,
  secondsSinceAuth: 10,
  ...extra,
});

const word = (content: string, start: number, end: number, speaker = 'spk_0') => ({
  type: 'pronunciation',
  start_time: String(start),
  end_time: String(end),
  speaker_label: speaker,
  alternatives: [{ content }],
});
const punct = (content: string) => ({ type: 'punctuation', alternatives: [{ content }] });

describe('meeting transcript', () => {
  it('joins words by speaker and sticks punctuation to the word before', () => {
    const segs = segmentsFromTranscribe({
      results: {
        items: [
          word('Hi', 0, 0.3),
          punct(','),
          word('Chloe', 0.3, 0.8),
          punct('.'),
          word('Hey', 1.0, 1.3, 'spk_1'),
          word('Kyra', 1.3, 1.7, 'spk_1'),
          punct('!'),
          word('So', 2.0, 2.2),
        ],
      },
    });
    expect(segs).toEqual([
      { id: 0, speaker: 'spk_0', start: 0, end: 0.8, text: 'Hi, Chloe.' },
      { id: 1, speaker: 'spk_1', start: 1, end: 1.7, text: 'Hey Kyra!' },
      { id: 2, speaker: 'spk_0', start: 2, end: 2.2, text: 'So' },
    ]);
  });

  it('starts a new paragraph after a long pause, even for the same speaker', () => {
    const segs = segmentsFromTranscribe({
      results: { items: [word('One', 0, 0.5), word('two', 4, 4.5)] },
    });
    expect(segs.map((s) => s.text)).toEqual(['One', 'two']);
  });

  it('splits a long monologue at a sentence end', () => {
    const items = [];
    for (let i = 0; i < 95; i++) items.push(word(`w${i}`, i * 0.3, i * 0.3 + 0.2));
    items.push(punct('.'));
    items.push(word('next', 30, 30.2));
    const segs = segmentsFromTranscribe({ results: { items } });
    expect(segs).toHaveLength(2);
    expect(segs[1]!.text).toBe('next');
  });

  it('copes with output it does not understand', () => {
    expect(segmentsFromTranscribe(null)).toEqual([]);
    expect(segmentsFromTranscribe({ results: {} })).toEqual([]);
    expect(segmentsFromTranscribe({ results: { items: [punct('.'), word('', 0, 1)] } })).toEqual(
      [],
    );
  });

  it('names speakers, and falls back to "Speaker n"', () => {
    const c = { ...emptyContent(), speakers: { spk_0: 'Kyra' } };
    expect(speakerName(c, 'spk_0')).toBe('Kyra');
    expect(speakerName(c, 'spk_2')).toBe('Speaker 3');
    expect(speakerName(c, '')).toBe('Speaker');
  });

  it('applies names, fixes and notes, ignoring unknown lines', () => {
    const base = {
      ...emptyContent(),
      segments: [
        { id: 0, speaker: 'spk_0', start: 0, end: 1, text: 'helo' },
        { id: 1, speaker: 'spk_1', start: 1, end: 2, text: 'bye' },
      ],
    };
    const next = applyContentPatch(base, {
      speakers: { spk_0: 'Kyra', spk_1: '' },
      segments: [
        { id: 0, text: 'hello' },
        { id: 1, text: '' },
        { id: 9, text: 'x' },
      ],
      notes: 'Budget agreed',
      markers: [{ at: 30 }, { at: 5, note: 'start' }],
    });
    expect(next.speakers).toEqual({ spk_0: 'Kyra' });
    expect(next.segments).toEqual([{ id: 0, speaker: 'spk_0', start: 0, end: 1, text: 'hello' }]);
    expect(next.edited).toBe(true);
    expect(next.markers.map((m) => m.at)).toEqual([5, 30]);
    expect(base.segments[0]!.text).toBe('helo');
  });
});

describe('meeting note', () => {
  const m: Pick<Meeting, 'title' | 'startedAt' | 'durationSec' | 'attendees' | 'artistId'> = {
    title: 'Plan *review* #1',
    startedAt: '2026-11-11T03:00:00.000Z',
    durationSec: 3725,
    attendees: [{ kind: 'staff', id: 'x', name: 'Kyra' }],
    artistId: ARTIST,
  };
  it('has the details, notes, moments and transcript, with Markdown escaped', () => {
    const md = noteMarkdown(
      m,
      {
        notes: 'Push the EP',
        markers: [{ at: 61, note: 'budget [agreed]' }],
        speakers: { spk_0: 'Kyra' },
        segments: [{ id: 0, speaker: 'spk_0', start: 3, end: 5, text: 'Let’s move it <b>' }],
      },
      { artistName: 'Chloe Poli', summary: 'We agreed to push the EP.' },
    );
    expect(md).toContain('# Plan \\*review\\* \\#1');
    expect(md).toContain('1:02:05 · About Chloe Poli');
    expect(md).toContain('## Summary\n\nWe agreed to push the EP.');
    expect(md).toContain('- 1:01 budget \\[agreed\\]');
    expect(md).toContain('**Kyra** (0:03)\n\nLet’s move it \\<b\\>');
    expect(md).toContain('Recorded with everyone’s agreement');
  });

  it('says when there was nothing to transcribe', () => {
    expect(noteMarkdown({ ...m, artistId: undefined }, emptyContent())).toContain(
      'No speech was found',
    );
    expect(noteMarkdown({ ...m, artistId: undefined }, emptyContent())).toContain('Blueprint only');
  });

  it('formats times', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(61.9)).toBe('1:01');
    expect(clock(3600)).toBe('1:00:00');
  });
});

describe('where meetings are filed', () => {
  it('uses the Melbourne date', () => {
    // 2:30 pm UTC on 30 Nov is 1:30 am on 1 Dec in Melbourne (daylight saving).
    expect(meetingDate('2026-11-30T14:30:00.000Z')).toBe('2026-12-01');
    expect(meetingFolderPath('2026-11-30T14:30:00.000Z')).toEqual(['Meetings', '2026', '12']);
  });

  it('names the recording and the note after the meeting', () => {
    const m = { title: 'Meeting with Chloe/Kyra', startedAt: '2026-11-11T03:00:00.000Z' };
    expect(meetingFileName(m, 'audio', 'rec.WEBM')).toBe(
      '2026-11-11_Meeting with Chloe Kyra_audio.webm',
    );
    expect(meetingFileName(m, 'notes')).toBe('2026-11-11_Meeting with Chloe Kyra_notes.md');
    expect(meetingFileName(m, 'audio')).toMatch(/_audio\.webm$/);
  });

  it('reads spaces from paths', () => {
    expect(parseSpaceParam('library')).toEqual({ kind: 'library' });
    expect(parseSpaceParam(ARTIST)).toEqual({ kind: 'artist', artistId: ARTIST });
    expect(parseSpaceParam('items')).toBeUndefined();
    expect(parseSpaceParam('art_X')).toBeUndefined();
  });
});

describe('transcription jobs', () => {
  it('round-trips the job name, space included', () => {
    const name = jobName('bmg', 'prod', { meetingId: 'mabcdefghij12', artistId: ARTIST }, 2);
    expect(name).toBe(`bmg-prod-meeting-${ARTIST}-mabcdefghij12-2`);
    expect(/^[0-9a-zA-Z._-]+$/.test(name)).toBe(true);
    expect(meetingFromJob('bmg', 'prod', name)).toEqual({
      space: { kind: 'artist', artistId: ARTIST },
      meetingId: 'mabcdefghij12',
      attempt: 2,
    });
    expect(
      meetingFromJob('bmg', 'prod', jobName('bmg', 'prod', { meetingId: 'mabcdefghij12' }, 1)),
    ).toEqual({ space: { kind: 'library' }, meetingId: 'mabcdefghij12', attempt: 1 });
    // Another environment's job is not ours.
    expect(meetingFromJob('bmg', 'staging', name)).toBeUndefined();
  });

  it('asks for at least two and at most ten voices', () => {
    expect(speakerCount([])).toBe(2);
    expect(
      speakerCount(
        Array.from({ length: 14 }, (_, i) => ({ kind: 'contact' as const, id: `${i}`, name: 'x' })),
      ),
    ).toBe(10);
  });

  it('accepts audio Transcribe can read', () => {
    expect(isMeetingAudio('audio/webm;codecs=opus')).toBe(true);
    expect(isMeetingAudio('audio/mp4')).toBe(true);
    expect(isMeetingAudio('video/quicktime')).toBe(false);
    expect(isMeetingAudio('application/pdf')).toBe(false);
    expect(mediaFormat('audio/webm;codecs=opus')).toBe('webm');
    expect(mediaFormat('audio/x-m4a')).toBe('m4a');
    expect(mediaFormat('audio/mpeg')).toBe('mp3');
    expect(mediaFormat('video/mp4')).toBe('mp4');
  });
});

describe('who decides whether a meeting is transcribed', () => {
  it('stops for any artist who turned AI off, before anything else', () => {
    expect(transcriptionBlock({ artistsOptedIn: [true, false], awsOptedOut: true })?.status).toBe(
      'no-ai',
    );
    expect(transcriptionBlock({ artistsOptedIn: [false], awsOptedOut: false })?.status).toBe(
      'no-ai',
    );
  });

  it('stays off until the AWS AI opt-out is in place', () => {
    expect(transcriptionBlock({ artistsOptedIn: [true], awsOptedOut: false })?.status).toBe('off');
    expect(transcriptionBlock({ artistsOptedIn: [], awsOptedOut: true })).toBeUndefined();
  });

  it('counts the linked artist and artist attendees', () => {
    expect(
      artistsInvolved({
        artistId: ARTIST,
        attendees: [
          { kind: 'artist', id: OTHER, name: 'SARUN' },
          { kind: 'artist', id: ARTIST, name: 'Chloe' },
          { kind: 'contact', id: 'c1', name: 'Booker' },
        ],
      }),
    ).toEqual([ARTIST, OTHER]);
  });
});

describe('who can open meetings', () => {
  const artistSpace = { kind: 'artist' as const, artistId: ARTIST };
  it('is Blueprint only', () => {
    expect(meetingAllowed(who('artist', { artistId: ARTIST }), artistSpace, 'read').allow).toBe(
      false,
    );
    expect(
      meetingAllowed(who('artist', { artistId: ARTIST }), { kind: 'library' }, 'read').allow,
    ).toBe(false);
  });

  it('needs staff to be assigned to the artist', () => {
    expect(
      meetingAllowed(who('bmg-staff', { assignedArtistIds: [] }), artistSpace, 'read').allow,
    ).toBe(false);
    expect(
      meetingAllowed(who('bmg-staff', { assignedArtistIds: [ARTIST] }), artistSpace, 'write').allow,
    ).toBe(true);
    expect(meetingAllowed(who('bmg-admin'), artistSpace, 'write').allow).toBe(true);
    expect(meetingAllowed(who('bmg-staff'), { kind: 'library' }, 'write').allow).toBe(true);
  });

  it('needs everyone’s agreement before a meeting exists', () => {
    expect(MeetingCreate.safeParse({ title: 'Catch-up' }).success).toBe(false);
    expect(MeetingCreate.safeParse({ title: 'Catch-up', consent: false }).success).toBe(false);
    expect(MeetingCreate.safeParse({ title: 'Catch-up', consent: true }).success).toBe(true);
    expect(
      MeetingCreate.safeParse({ title: 'Catch-up', consent: true, shared: true }).success,
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { onTodoReminder, onTodoUpdated } from '../src/model.ts';

const ctx = { appOrigin: 'https://app.example.com' };
const todo = { title: 'Finish lyrics', due: '2026-12-03', remindAt: '2026-12-02T22:00:00.000Z' };
const base = { artistId: 'art_abcdefghij', todoId: 'abcdefghij' };

describe('todo.updated', () => {
  it('emails the artist when Blueprint edits their to-do', () => {
    const d = onTodoUpdated(
      ctx,
      { ...base, changedFields: ['due'], byRole: 'bmg-admin', notify: 'artist' },
      todo,
      'Chloe',
    );
    expect(d.send && d.to).toBe('artist');
  });
  it('emails Blueprint when the artist edits a Blueprint to-do', () => {
    const d = onTodoUpdated(
      ctx,
      { ...base, changedFields: ['title'], byRole: 'artist', notify: 'bmg' },
      todo,
      'Chloe',
    );
    expect(d.send && d.to).toBe('bmg');
    expect(d.send && d.email.text).toContain('Chloe');
  });
  it('never tells the artist about BMG-only to-dos or their own edits', () => {
    expect(
      onTodoUpdated(
        ctx,
        { ...base, changedFields: ['due'], byRole: 'bmg-staff', notify: 'artist' },
        { ...todo, visibility: 'bmg-only' },
        undefined,
      ).send,
    ).toBe(false);
    expect(
      onTodoUpdated(
        ctx,
        { ...base, changedFields: ['due'], byRole: 'artist', notify: 'artist' },
        todo,
        undefined,
      ).send,
    ).toBe(false);
  });
});

describe('todo.reminder', () => {
  const e = { ...base, remindAt: todo.remindAt };
  it('sends while the schedule is current', () => {
    expect(onTodoReminder(ctx, e, todo).send).toBe(true);
  });
  it('skips done, missing and stale reminders', () => {
    expect(onTodoReminder(ctx, e, { ...todo, done: true }).send).toBe(false);
    expect(onTodoReminder(ctx, e, undefined).send).toBe(false);
    expect(onTodoReminder(ctx, e, { ...todo, remindAt: '2026-12-01T22:00:00.000Z' }).send).toBe(
      false,
    );
  });
});

import { describe, expect, it } from 'vitest';
import { describeError } from '../src/server.ts';

describe('describeError', () => {
  it('finds the Bedrock error inside a model error', () => {
    const bedrock = Object.assign(
      new Error('Invocation of model ID x with on-demand throughput isn’t supported.'),
      {
        name: 'ValidationException',
        $metadata: { httpStatusCode: 400 },
      },
    );
    const wrapped = Object.assign(new Error('model failed', { cause: bedrock }), {
      name: 'ModelError',
    });
    expect(describeError(wrapped)).toEqual({
      error: 'ModelError ← ValidationException',
      status: 400,
      detail: 'Invocation of model ID x with on-demand throughput isn’t supported.',
    });
  });

  it('keeps the library’s own message for a bare model error', () => {
    const e = Object.assign(new Error('Stream ended without completing a message'), {
      name: 'ModelError',
    });
    expect(describeError(e)).toEqual({
      error: 'ModelError',
      detail: 'Stream ended without completing a message',
    });
  });

  it('logs only the type of anything else', () => {
    expect(describeError(new TypeError('the user said something private'))).toEqual({
      error: 'TypeError',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { AI_OPT_OUT_POLICY, optedOutOf } from '../src/ai-opt-out.ts';

describe('AI services opt-out', () => {
  it('opts every service out by default and locks child policies', () => {
    const d = AI_OPT_OUT_POLICY.services.default.opt_out_policy;
    expect(d['@@assign']).toBe('optOut');
    expect(d['@@operators_allowed_for_child_policies']).toEqual(['@@none']);
  });

  it('reads the default setting from an effective policy', () => {
    const effective = JSON.stringify({ services: { default: { opt_out_policy: 'optOut' } } });
    expect(optedOutOf('transcribe', effective)).toBe(true);
  });

  it('lets a service-specific setting win over the default', () => {
    const optedBackIn = JSON.stringify({
      services: { default: { opt_out_policy: 'optOut' }, transcribe: { opt_out_policy: 'optIn' } },
    });
    expect(optedOutOf('transcribe', optedBackIn)).toBe(false);
    const onlyTranscribe = JSON.stringify({
      services: { transcribe: { opt_out_policy: 'optOut' } },
    });
    expect(optedOutOf('transcribe', onlyTranscribe)).toBe(true);
    expect(optedOutOf('polly', onlyTranscribe)).toBe(false);
  });

  it('accepts the authoring form', () => {
    expect(optedOutOf('transcribe', JSON.stringify(AI_OPT_OUT_POLICY))).toBe(true);
  });

  it('fails closed on anything missing or unreadable', () => {
    expect(optedOutOf('transcribe', undefined)).toBe(false);
    expect(optedOutOf('transcribe', '')).toBe(false);
    expect(optedOutOf('transcribe', 'not json')).toBe(false);
    expect(optedOutOf('transcribe', 'null')).toBe(false);
    expect(optedOutOf('transcribe', JSON.stringify({ services: {} }))).toBe(false);
    expect(
      optedOutOf('transcribe', JSON.stringify({ services: { default: { opt_out_policy: 1 } } })),
    ).toBe(false);
  });
});

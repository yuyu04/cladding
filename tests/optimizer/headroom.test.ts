// Cladding · unit tests for optimizer/headroom.ts (F-6aebb9)
//
// The seam's load-bearing invariant: compressContext() never throws and falls
// back to the ORIGINAL messages on every off-path (disabled, below-min-token,
// no savings). Compression now runs natively in-process (compress-native.ts) —
// no subprocess, so there is no transport to mock; these tests exercise the
// gates, the simulate dry-run, and the real native win on a bulky JSON payload.

import {afterEach, beforeEach, describe, expect, test} from 'vitest';

import {
  approxTokens,
  compressContext,
  headroomMode,
  needsFullContext,
  shouldRecover,
  type OpenAIMessage,
} from '../../src/optimizer/headroom.js';
import {PROFILES} from '../../src/optimizer/profiles.js';

const ENV_KEYS = ['CLADDING_HEADROOM', 'CLADDING_HEADROOM_MIN_TOKENS'] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const big = (): OpenAIMessage[] => [{role: 'user', content: 'x'.repeat(20_000)}];

/** A bulky JSON tool output — the archetypal compressible payload. */
const jsonToolPayload = (): OpenAIMessage[] => {
  const findings = Array.from({length: 120}, (_, i) => ({
    detector: 'CAPABILITIES_FEATURE_MAPPING',
    severity: 'info',
    path: 'spec.yaml',
    message: `feature F-${i.toString(16).padStart(6, '0')} is not claimed by any capability`,
  }));
  return [{role: 'tool', tool_call_id: 't', content: JSON.stringify({findings}, null, 2)}];
};

describe('compressContext gates', () => {
  test('AC-ac034f: disabled → original messages, applied=false, reason=disabled', async () => {
    delete process.env.CLADDING_HEADROOM;
    const messages = big();
    const out = await compressContext(messages, 'spec');
    expect(out.applied).toBe(false);
    expect(out.fallbackReason).toBe('disabled');
    expect(out.messages).toBe(messages); // same reference — untouched
  });

  test('AC-00ac36: below min tokens → skip with reason below_min_tokens', async () => {
    process.env.CLADDING_HEADROOM = 'on';
    process.env.CLADDING_HEADROOM_MIN_TOKENS = '100000';
    const out = await compressContext(big(), 'json');
    expect(out.applied).toBe(false);
    expect(out.fallbackReason).toBe('below_min_tokens');
  });
});

describe('compressContext native compression', () => {
  test('AC-c71d04: bulky JSON tool output is compressed, applied=true, savings>0', async () => {
    process.env.CLADDING_HEADROOM = 'on';
    process.env.CLADDING_HEADROOM_MIN_TOKENS = '100';
    const out = await compressContext(jsonToolPayload(), 'json');
    expect(out.applied).toBe(true);
    expect(out.result?.tokensSaved).toBeGreaterThan(0);
    expect(out.result?.transformsApplied).toContain('native:json_dedup');
  });

  test('AC-9f23a1: simulate mode computes savings but does NOT apply', async () => {
    process.env.CLADDING_HEADROOM = 'simulate';
    process.env.CLADDING_HEADROOM_MIN_TOKENS = '100';
    const messages = jsonToolPayload();
    const out = await compressContext(messages, 'json');
    expect(out.applied).toBe(false);
    expect(out.fallbackReason).toBe('simulate');
    expect(out.result?.tokensSaved).toBeGreaterThan(0); // predicted, not applied
    expect(out.messages).toBe(messages); // original payload sent
  });

  test('AC-ca3e88: protected prose (spec profile) → no savings, original returned', async () => {
    process.env.CLADDING_HEADROOM = 'on';
    process.env.CLADDING_HEADROOM_MIN_TOKENS = '100';
    const messages: OpenAIMessage[] = [
      {role: 'system', content: 'persona prompt '.repeat(50)},
      {role: 'user', content: 'feature shard prose '.repeat(100)},
    ];
    const out = await compressContext(messages, 'spec');
    expect(out.applied).toBe(false);
    expect(out.fallbackReason).toBe('no_savings');
    expect(out.messages).toBe(messages);
  });
});

describe('profiles + helpers', () => {
  test('AC-0bbaf3: every context kind has a profile posture', () => {
    for (const kind of ['logs', 'json', 'code', 'spec', 'history'] as const) {
      const p = PROFILES[kind];
      expect(p).toBeDefined();
      expect(typeof p.compress_user_messages).toBe('boolean');
      expect(typeof p.min_tokens_to_compress).toBe('number');
    }
    expect(PROFILES.code.protect_analysis_context).toBe(true);
    expect(PROFILES.logs.target_ratio).toBeLessThan(0.5);
  });

  test('approxTokens ~ chars/4', () => {
    expect(approxTokens([{role: 'user', content: 'abcd'.repeat(100)}])).toBe(100);
  });
});

describe('auto mode + recovery (F-6aebb9)', () => {
  test('headroomMode parses off/on/simulate/auto; unknown → off', () => {
    process.env.CLADDING_HEADROOM = 'auto';
    expect(headroomMode()).toBe('auto');
    process.env.CLADDING_HEADROOM = 'bananas';
    expect(headroomMode()).toBe('off');
    delete process.env.CLADDING_HEADROOM;
    expect(headroomMode()).toBe('off');
  });

  test('auto mode applies compression (like on) on a compressible payload', async () => {
    process.env.CLADDING_HEADROOM = 'auto';
    process.env.CLADDING_HEADROOM_MIN_TOKENS = '100';
    const out = await compressContext(jsonToolPayload(), 'json');
    expect(out.applied).toBe(true);
  });

  test('needsFullContext detects insufficiency signals (EN + KO)', () => {
    expect(needsFullContext('I can only see 2 of 150 findings; I need the full output.')).toBe(true);
    expect(needsFullContext('148 entries were omitted, so I cannot enumerate them.')).toBe(true);
    expect(needsFullContext('생략된 항목이 있어 전부 나열할 수 없습니다. 전체 출력이 필요합니다.')).toBe(true);
    // no signal → no recovery
    expect(needsFullContext('Here are the 3 actionable findings: A, B, C.')).toBe(false);
    expect(needsFullContext('All logs show status ok; no anomalies.')).toBe(false);
  });

  test('shouldRecover: only auto + applied + needy reply', () => {
    const needy = 'I only saw 2 of 150; need the full output.';
    const fine = 'Done — 3 findings triaged.';
    process.env.CLADDING_HEADROOM = 'auto';
    expect(shouldRecover(true, needy)).toBe(true);
    expect(shouldRecover(false, needy)).toBe(false); // compression not applied
    expect(shouldRecover(true, fine)).toBe(false); // no signal
    process.env.CLADDING_HEADROOM = 'on';
    expect(shouldRecover(true, needy)).toBe(false); // not auto
  });
});

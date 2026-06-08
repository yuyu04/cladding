// Cladding · unit tests for optimizer/headroom.ts (F-6aebb9)
//
// The seam's load-bearing invariant: compressContext() never throws and falls
// back to the ORIGINAL messages on every off-path (disabled, below-min-token,
// open circuit, bridge failure). These tests exercise the gates + fallback
// without a real Headroom engine — a bogus python path forces a transport
// error so the passthrough/circuit logic is observable deterministically.

import {afterEach, beforeEach, describe, expect, test} from 'vitest';

import {
  approxTokens,
  compressContext,
  resetCircuitForTesting,
  type OpenAIMessage,
} from '../../src/optimizer/headroom.js';
import {PROFILES} from '../../src/optimizer/profiles.js';

const ENV_KEYS = [
  'CLADDING_HEADROOM',
  'CLADDING_HEADROOM_PYTHON',
  'CLADDING_HEADROOM_BRIDGE',
  'CLADDING_HEADROOM_MIN_TOKENS',
  'CLADDING_HEADROOM_MAX_FAILS',
  'CLADDING_HEADROOM_TIMEOUT_MS',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  resetCircuitForTesting();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetCircuitForTesting();
});

const big = (): OpenAIMessage[] => [{role: 'user', content: 'x'.repeat(20_000)}];

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
    const out = await compressContext(big(), 'spec');
    expect(out.applied).toBe(false);
    expect(out.fallbackReason).toBe('below_min_tokens');
  });
});

describe('compressContext fallback (never throws)', () => {
  test('AC-b9218d: bridge failure (bad python) → original messages, no throw', async () => {
    process.env.CLADDING_HEADROOM = 'on';
    process.env.CLADDING_HEADROOM_MIN_TOKENS = '1';
    process.env.CLADDING_HEADROOM_PYTHON = '/usr/bin/__no_such_python__';
    const messages = big();
    const out = await compressContext(messages, 'spec');
    expect(out.applied).toBe(false);
    expect(out.messages).toBe(messages);
    expect(['bridge_error', 'timeout']).toContain(out.fallbackReason);
  });

  test('AC-8bd17a: circuit opens after max consecutive failures', async () => {
    process.env.CLADDING_HEADROOM = 'on';
    process.env.CLADDING_HEADROOM_MIN_TOKENS = '1';
    process.env.CLADDING_HEADROOM_MAX_FAILS = '3';
    process.env.CLADDING_HEADROOM_PYTHON = '/usr/bin/__no_such_python__';
    for (let i = 0; i < 3; i++) await compressContext(big(), 'spec');
    const fourth = await compressContext(big(), 'spec');
    expect(fourth.fallbackReason).toBe('circuit_open');
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
    // logs is the most aggressive (lowest keep ratio); code/spec are protected.
    expect(PROFILES.code.protect_analysis_context).toBe(true);
    expect(PROFILES.logs.target_ratio).toBeLessThan(0.5);
  });

  test('approxTokens ~ chars/4', () => {
    expect(approxTokens([{role: 'user', content: 'abcd'.repeat(100)}])).toBe(100);
  });
});

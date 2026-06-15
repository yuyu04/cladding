// Cladding · unit tests for optimizer/compress-native.ts (F-6aebb9)
//
// The native, in-process compressor: deterministic structural transforms
// (JSON array dedup, repetitive log dedup) with profile-driven protection of
// high-value prose. Pure function — no env, no subprocess, no clock.

import {describe, expect, test} from 'vitest';

import {compressNative} from '../../src/optimizer/compress-native.js';
import type {OpenAIMessage} from '../../src/optimizer/headroom.js';
import {PROFILES} from '../../src/optimizer/profiles.js';

const jsonFindings = (n: number): string => {
  const findings = Array.from({length: n}, (_, i) => ({
    detector: 'CAPABILITIES_FEATURE_MAPPING',
    severity: 'info',
    path: 'spec.yaml',
    message: `feature F-${i.toString(16).padStart(6, '0')} unclaimed`,
  }));
  return JSON.stringify({findings}, null, 2);
};

const repetitiveLog = (n: number): string =>
  Array.from(
    {length: n},
    (_, i) => `2026-06-05T10:00:${i}Z [info] dispatch attempt ${i} status=ok latency=12ms`,
  ).join('\n');

describe('json_dedup', () => {
  test('collapses a large near-identical JSON array, big savings', () => {
    const msgs: OpenAIMessage[] = [{role: 'tool', tool_call_id: 't', content: jsonFindings(150)}];
    const r = compressNative(msgs, PROFILES.json);
    expect(r.compressed).toBe(true);
    expect(r.tokensSaved).toBeGreaterThan(0);
    expect(r.tokensAfter).toBeLessThan(r.tokensBefore);
    expect(r.transformsApplied).toContain('native:json_dedup');
    // a summary marker replaces the omitted entries
    expect(r.messages[0].content).toContain('__cladding_compressed__');
  });

  test('small arrays are left alone (no gain)', () => {
    const msgs: OpenAIMessage[] = [{role: 'tool', content: jsonFindings(3)}];
    const r = compressNative(msgs, {...PROFILES.json, min_tokens_to_compress: 1});
    expect(r.compressed).toBe(false);
    expect(r.messages).toBe(msgs); // original reference
  });
});

describe('log_dedup', () => {
  test('collapses repetitive log lines, big savings', () => {
    const msgs: OpenAIMessage[] = [{role: 'tool', tool_call_id: 't', content: repetitiveLog(400)}];
    const r = compressNative(msgs, PROFILES.logs);
    expect(r.compressed).toBe(true);
    expect(r.transformsApplied).toContain('native:log_dedup');
    expect(r.messages[0].content).toContain('more lines matching this pattern');
  });
});

describe('profile protection', () => {
  test('spec profile protects system + user prose → no savings', () => {
    const msgs: OpenAIMessage[] = [
      {role: 'system', content: 'persona '.repeat(200)},
      {role: 'user', content: 'shard prose '.repeat(200)},
    ];
    const r = compressNative(msgs, PROFILES.spec);
    expect(r.compressed).toBe(false);
    expect(r.transformsApplied).toContain('native:protected');
  });

  test('protect_analysis_context shields fenced code', () => {
    const code = '```ts\n' + 'const x = 1;\n'.repeat(200) + '```';
    const msgs: OpenAIMessage[] = [{role: 'user', content: code}];
    const r = compressNative(msgs, {
      ...PROFILES.json,
      compress_user_messages: true,
      protect_analysis_context: true,
      protect_recent: 0,
      min_tokens_to_compress: 1,
    });
    expect(r.compressed).toBe(false);
  });
});

describe('determinism + safety', () => {
  test('identical input → identical output (no clock / no randomness)', () => {
    const msgs: OpenAIMessage[] = [{role: 'tool', content: jsonFindings(150)}];
    const a = compressNative(msgs, PROFILES.json);
    const b = compressNative(msgs, PROFILES.json);
    expect(a.tokensAfter).toBe(b.tokensAfter);
    expect(a.messages[0].content).toBe(b.messages[0].content);
  });

  test('never throws on malformed / non-JSON content', () => {
    const msgs: OpenAIMessage[] = [{role: 'tool', content: '{not valid json at all ]['.repeat(50)}];
    expect(() => compressNative(msgs, PROFILES.json)).not.toThrow();
  });
});

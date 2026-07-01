// Cladding · unit tests for optimizer/compress-native.ts (F-6aebb9)
//
// The native, in-process compressor: deterministic LOSSY structural transforms
// (json_dedup, log_dedup, profile-gated) plus a LOSSLESS tier (json_minify,
// ws_collapse) that may apply even to protected content. Pure — no env, no
// subprocess, no clock.

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

  test('small arrays are not deduped (lossy tier skips; lossless minify may still apply)', () => {
    const msgs: OpenAIMessage[] = [{role: 'tool', content: jsonFindings(3)}];
    const r = compressNative(msgs, {...PROFILES.json, min_tokens_to_compress: 1});
    expect(r.transformsApplied).not.toContain('native:json_dedup');
    expect(r.messages[0].content).not.toContain('__cladding_compressed__');
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

describe('lossless tier (json_minify + ws_collapse)', () => {
  // One big nested object (NOT an array of >=8 objects), so json_dedup skips it
  // and json_minify is isolated. A 30-tenant map makes it sizable.
  const prettyConfig = (): string =>
    JSON.stringify(
      {
        service: 'billing',
        limits: {rpm: 600, burst: 50, regions: ['us', 'eu', 'ap']},
        flags: {dunning: true, multiCurrency: true, idempotency: 'strict'},
        retries: {schedule: [1, 3, 7], unit: 'day'},
        tenants: Object.fromEntries(
          Array.from({length: 30}, (_, i) => [
            `tenant_${i}`,
            {plan: 'pro', currency: 'USD', active: true},
          ]),
        ),
      },
      null,
      2,
    );

  test('json_minify losslessly shrinks pretty JSON (single object → dedup skips it)', () => {
    const before = prettyConfig();
    const msgs: OpenAIMessage[] = [{role: 'tool', content: before}];
    const r = compressNative(msgs, {...PROFILES.json, min_tokens_to_compress: 1});
    expect(r.compressed).toBe(true);
    expect(r.transformsApplied).toContain('native:json_minify');
    expect(r.messages[0].content).not.toContain('\n  '); // pretty indentation gone
    // lossless: the minified output parses back to the identical object
    expect(JSON.parse(r.messages[0].content)).toEqual(JSON.parse(before));
  });

  test('ws_collapse folds 3+ blank lines to one (lossless)', () => {
    // spec profile → lossy tier is skipped (user protected), isolating ws_collapse.
    const before = ('paragraph number ' + 'X'.repeat(8) + '\n\n\n\n').repeat(60);
    const msgs: OpenAIMessage[] = [{role: 'user', content: before}];
    const r = compressNative(msgs, {...PROFILES.spec, min_tokens_to_compress: 1});
    expect(r.transformsApplied).toContain('native:ws_collapse');
    expect(r.transformsApplied).not.toContain('native:log_dedup'); // lossy skipped
    expect(r.messages[0].content).not.toMatch(/\n[ \t]*\n[ \t]*\n/); // no 3-in-a-row blanks
  });

  test('lossless applies even to lossy-protected content (spec profile, JSON user msg)', () => {
    const msgs: OpenAIMessage[] = [{role: 'user', content: prettyConfig()}];
    const r = compressNative(msgs, {...PROFILES.spec, min_tokens_to_compress: 1});
    // spec protects the user message from the LOSSY tier, but lossless still minifies
    expect(r.compressed).toBe(true);
    expect(r.transformsApplied).toContain('native:json_minify');
  });

  test('system messages are never touched (cache-prefix byte stability)', () => {
    const sys = 'You are the persona.\n\n\n\n\nGuidance follows.\n\n\n\nMore.'.repeat(40);
    const msgs: OpenAIMessage[] = [{role: 'system', content: sys}];
    const r = compressNative(msgs, {...PROFILES.json, min_tokens_to_compress: 1});
    expect(r.compressed).toBe(false);
    expect(r.messages[0].content).toBe(sys); // byte-identical
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

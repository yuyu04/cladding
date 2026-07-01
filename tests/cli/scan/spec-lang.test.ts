// Cladding · unit tests for cli/scan/spec-lang.ts (F-36f11b, F-ea1f13)
//
// Canonical-language policy + companion-view language derivation, plus the
// broad display-name map. Explicit env always wins (the authoritative path for
// any language, even ones auto-detection cannot resolve).

import {afterEach, beforeEach, describe, expect, test} from 'vitest';

import {canonicalLang, langDisplayName, viewLang} from '../../../src/cli/scan/spec-lang.js';

const ENV = ['CLADDING_SPEC_LANG', 'CLADDING_SPEC_VIEW_LANG'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV) saved[k] = process.env[k];
  for (const k of ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const KO = '결제 시스템을 만들거야 멱등성과 웹훅 서명 검증이 필요해';

describe('canonicalLang', () => {
  test('AC-... defaults to English', () => {
    expect(canonicalLang()).toBe('en');
  });
  test('AC F-36f11b: CLADDING_SPEC_LANG overrides (escape hatch)', () => {
    process.env.CLADDING_SPEC_LANG = 'ko';
    expect(canonicalLang()).toBe('ko');
  });
});

describe('viewLang', () => {
  test('derives view language from a non-English intent (default canonical en)', () => {
    expect(viewLang(KO)).toBe('ko');
  });
  test('English intent → no companion view', () => {
    expect(viewLang('build a payment settlement system')).toBeNull();
  });
  test('explicit CLADDING_SPEC_VIEW_LANG wins', () => {
    process.env.CLADDING_SPEC_VIEW_LANG = 'ja';
    expect(viewLang('build a payment system')).toBe('ja');
  });
  test('view equal to canonical → null (no redundant view)', () => {
    process.env.CLADDING_SPEC_LANG = 'ko';
    expect(viewLang(KO)).toBeNull();
  });
});

describe('langDisplayName', () => {
  test('AC F-ea1f13: covers a broad set of world languages', () => {
    expect(langDisplayName('en')).toBe('English');
    expect(langDisplayName('ko')).toBe('Korean');
    expect(langDisplayName('vi')).toBe('Vietnamese');
    expect(langDisplayName('el')).toBe('Greek');
    expect(langDisplayName('km')).toBe('Khmer');
  });
  test('falls back to the code for unknown languages', () => {
    expect(langDisplayName('xx')).toBe('xx');
  });
});

// Cladding · unit tests for optimizer/lang-normalize.ts (F-60b842, F-ea1f13)
//
// Covers: world-language detection (non-Latin scripts + Latin-script languages
// with English-safety), code/identifier masking, and normalizeToEnglish()'s
// never-throw passthrough across every off-path.

import {afterEach, beforeEach, describe, expect, test} from 'vitest';

import {
  detectLangHint,
  detectLatinLang,
  looksNonEnglish,
  maskCode,
  normalizeToEnglish,
} from '../../src/optimizer/lang-normalize.js';

const ENV = ['CLADDING_I18N', 'CLADDING_I18N_MIN_CHARS'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('detectLangHint — non-Latin scripts', () => {
  const cases: Array<[string, string]> = [
    ['ko', '결제 시스템을 만들거야 멱등성과 웹훅 서명 검증이 필요해'],
    ['ja', '決済システムを作ります。冪等性とウェブフックの検証が必要です'],
    ['zh', '我要构建一个支付结算系统需要幂等性和签名验证以及对账'],
    ['ru', 'Я хочу построить платёжную систему с проверкой подписи вебхука'],
    ['el', 'Θέλω να φτιάξω ένα σύστημα πληρωμών με επαλήθευση υπογραφής'],
  ];
  for (const [want, text] of cases) {
    test(`detects ${want}`, () => {
      expect(detectLangHint(text)).toBe(want);
      expect(looksNonEnglish(text)).toBe(true);
    });
  }
});

describe('detectLatinLang — Latin-script languages with English safety', () => {
  test('AC F-ea1f13: detects Spanish / French / German', () => {
    expect(detectLatinLang('Quiero construir un sistema de pagos que también verifique la firma')).toBe('es');
    expect(detectLatinLang('Je veux construire un système de paiement avec vérification de la signature')).toBe('fr');
    expect(detectLatinLang('Ich möchte ein Zahlungssystem bauen das nicht nur die Signatur prüft')).toBe('de');
  });

  test('AC F-ea1f13 (unwanted): English is NOT misclassified', () => {
    expect(detectLatinLang('I want to build a payment settlement system with webhook verification')).toBe('en');
    expect(detectLangHint('build a shopping mall with realtime inventory and checkout')).toBe('en');
    expect(looksNonEnglish('this is a perfectly ordinary english sentence about payments')).toBe(false);
  });
});

describe('maskCode', () => {
  test('hides code/identifiers and restores them verbatim', () => {
    const src = '보세요 `F-1a2b3c` 그리고 ```const x = 1;``` 끝';
    const {masked, restore} = maskCode(src);
    expect(masked).not.toContain('const x = 1');
    expect(masked).toContain('CLAD_CODE');
    expect(restore(masked)).toContain('const x = 1;');
    expect(restore(masked)).toContain('F-1a2b3c');
  });
});

describe('normalizeToEnglish — never throws, passthrough on off-paths', () => {
  const KO = '결제 시스템을 만들거야 멱등성과 웹훅 서명 검증이 필요하고 정산 보고서도 필요합니다 '.repeat(6);

  test('disabled → original text, applied=false', async () => {
    delete process.env.CLADDING_I18N;
    const out = await normalizeToEnglish(KO, async () => 'X');
    expect(out.applied).toBe(false);
    expect(out.text).toBe(KO);
    expect(out.fallbackReason).toBe('disabled');
  });

  test('enabled + translator → applied, text replaced', async () => {
    process.env.CLADDING_I18N = 'on';
    process.env.CLADDING_I18N_MIN_CHARS = '50';
    const out = await normalizeToEnglish(KO, async () => 'ENGLISH RESULT');
    expect(out.applied).toBe(true);
    expect(out.text).toContain('ENGLISH RESULT');
    expect(out.detectedNonEnglish).toBe(true);
  });

  test('translator throws → original text, no throw, reason translate_error', async () => {
    process.env.CLADDING_I18N = 'on';
    process.env.CLADDING_I18N_MIN_CHARS = '50';
    const out = await normalizeToEnglish(KO, async () => {
      throw new Error('boom');
    });
    expect(out.applied).toBe(false);
    expect(out.text).toBe(KO);
    expect(out.fallbackReason).toBe('translate_error');
  });

  test('English intent → skip with reason looks_english', async () => {
    process.env.CLADDING_I18N = 'on';
    process.env.CLADDING_I18N_MIN_CHARS = '50';
    const en = 'a fairly long english planning document about a payment system repeated '.repeat(5);
    const out = await normalizeToEnglish(en, async () => 'X');
    expect(out.applied).toBe(false);
    expect(out.fallbackReason).toBe('looks_english');
  });
});

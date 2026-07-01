// Cladding · Token Optimizer · Cheap-model intent normalization (i18n)
//
// F-60b842 — non-English free-text intent (e.g. a large Korean planning doc
// passed to `clad init docs/plan-ko.md`) costs ~1.8x the tokens of the
// equivalent English when the expensive authoring model reads it. This module
// normalizes such intent to English ONCE with a relay model (Sonnet 4.6) before
// the selected model consumes it, so the expensive call reads fewer tokens.
//
// Scope is deliberately narrow (see docs/i18n-haiku-relay.md):
//   · Only large, genuinely non-English intent is normalized — short or
//     already-English text passes through (a round-trip is not worth the cost).
//   · Code blocks and identifiers are masked so they survive verbatim.
//   · This module is PURE: the translator is injected by the caller. The CLI
//     wires a cheap-model dispatcher only in SDK mode (where model selection is
//     honored); in host/MCP mode the caller skips it entirely (host no-op).
//
// Contract (load-bearing): normalizeToEnglish() NEVER throws. Disabled config,
// a too-short or English intent, a missing translator, or ANY translation
// failure all return the ORIGINAL text. Normalization is a pure optional cost
// optimization — clad init behaves identically with it off.
//
// @see docs/i18n-haiku-relay.md — design, rollout, honest caveats.
// @see spec/features/i18n-cheap-model-intent-normalize-60b842.yaml — contract.

import process from 'node:process';

/** A flat prompt→text translator. Matches scan/llm.ts ScanLlmDispatcher. */
export type TranslateFn = (prompt: string) => Promise<string>;

/** Why the normalizer declined to use a translated payload, when it did. */
export type NormalizeFallbackReason =
  | 'disabled'
  | 'below_min_chars'
  | 'looks_english'
  | 'no_translator'
  | 'translate_error'
  | 'empty_result';

/** Result wrapper — `text` is ALWAYS usable (English when applied, else original). */
export interface NormalizeOutcome {
  readonly text: string;
  readonly applied: boolean;
  readonly detectedNonEnglish: boolean;
  readonly charsBefore: number;
  readonly charsAfter: number;
  readonly fallbackReason?: NormalizeFallbackReason;
}

// Non-Latin script ranges as [startCodePoint, endCodePoint, langCode]. Numeric
// code points (not regex char-class literals) so the ranges are unambiguous and
// correct regardless of source-file encoding. The dominant script by count
// wins. Covers the world's major non-Latin writing systems — also where
// tokenization is heaviest vs English. (Cyrillic defaults to 'ru'; CJK to 'zh';
// override with CLADDING_SPEC_VIEW_LANG for uk/bg/sr/ja-kanji-only/etc.)
const SCRIPT_RANGES: ReadonlyArray<readonly [number, number, string]> = [
  [0x1100, 0x11ff, 'ko'], [0x3130, 0x318f, 'ko'], [0xac00, 0xd7a3, 'ko'], // Hangul
  [0x3040, 0x30ff, 'ja'], // Kana (Hiragana + Katakana)
  [0x3400, 0x4dbf, 'zh'], [0x4e00, 0x9fff, 'zh'], // CJK ideographs
  [0x0400, 0x04ff, 'ru'], // Cyrillic
  [0x0600, 0x06ff, 'ar'], [0x0750, 0x077f, 'ar'], // Arabic
  [0x0590, 0x05ff, 'he'], // Hebrew
  [0x0e00, 0x0e7f, 'th'], // Thai
  [0x0900, 0x097f, 'hi'], // Devanagari (Hindi)
  [0x0980, 0x09ff, 'bn'], // Bengali
  [0x0b80, 0x0bff, 'ta'], // Tamil
  [0x0c00, 0x0c7f, 'te'], // Telugu
  [0x0370, 0x03ff, 'el'], // Greek
  [0x10a0, 0x10ff, 'ka'], // Georgian
  [0x0530, 0x058f, 'hy'], // Armenian
  [0x0e80, 0x0eff, 'lo'], // Lao
  [0x1780, 0x17ff, 'km'], // Khmer
];

/** Dominant non-Latin script in `text`: its lang code + matched-char count. */
function scriptHint(text: string): {code: string; count: number} {
  const counts = new Map<string, number>();
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    for (const [lo, hi, code] of SCRIPT_RANGES) {
      if (cp >= lo && cp <= hi) {
        counts.set(code, (counts.get(code) ?? 0) + 1);
        break;
      }
    }
  }
  let best = 'en';
  let bestCount = 0;
  for (const [code, c] of counts) {
    if (c > bestCount) {
      bestCount = c;
      best = code;
    }
  }
  return {code: best, count: bestCount};
}

// Distinctive function words for common Latin-script languages. Detection is a
// best-effort default — explicit CLADDING_SPEC_LANG / CLADDING_SPEC_VIEW_LANG
// always overrides. A clear margin over English is required so English text is
// never misclassified (which would trigger a spurious translation).
const LATIN_STOPWORDS: Readonly<Record<string, readonly string[]>> = {
  en: ['the', 'and', 'is', 'are', 'to', 'of', 'for', 'with', 'that', 'this', 'you', 'it', 'be', 'we', 'will', 'can', 'have', 'from'],
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'por', 'para', 'con', 'una', 'un', 'es', 'está', 'como', 'pero', 'también', 'del', 'se', 'su'],
  fr: ['je', 'ne', 'vous', 'nous', 'être', 'qui', 'le', 'la', 'les', 'des', 'une', 'un', 'est', 'pour', 'avec', 'dans', 'que', 'sur', 'ce', 'et', 'du', 'aux'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'für', 'auch', 'eine', 'ein', 'sich', 'den', 'von', 'werden', 'ich', 'möchte', 'wir', 'aber'],
  pt: ['o', 'os', 'as', 'de', 'que', 'para', 'com', 'uma', 'um', 'não', 'está', 'como', 'mas', 'também', 'do', 'da', 'se', 'são', 'você', 'eu'],
  it: ['il', 'lo', 'la', 'di', 'che', 'per', 'con', 'una', 'un', 'anche', 'sono', 'non', 'del', 'della', 'gli', 'nel', 'più', 'questo', 'voglio'],
  nl: ['het', 'een', 'en', 'van', 'niet', 'dat', 'op', 'voor', 'met', 'zijn', 'aan', 'worden', 'ook', 'ik', 'wil', 'te'],
  vi: ['và', 'là', 'của', 'các', 'được', 'cho', 'không', 'một', 'người', 'này', 'với', 'trong', 'để', 'tôi', 'xây', 'dựng', 'hệ'],
  tr: ['ve', 'bir', 'bu', 'için', 'ile', 'çok', 'daha', 'olarak', 'olan', 'var', 'değil', 'gibi', 'istiyorum', 'sistemi'],
  id: ['yang', 'dan', 'untuk', 'dengan', 'adalah', 'ini', 'itu', 'dari', 'pada', 'akan', 'tidak', 'saya', 'membuat', 'sistem'],
  pl: ['na', 'do', 'nie', 'że', 'to', 'jest', 'się', 'dla', 'są', 'jako', 'oraz', 'chcę', 'system', 'oraz'],
};

// Diacritics that strongly signal one language (small +2 boost).
const DIACRITIC_SIGNALS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[ñ]/u, 'es'], // ñ
  [/[ß]/u, 'de'], // ß
  [/[ãõ]/u, 'pt'], // ã õ
  [/[ışğ]/u, 'tr'], // ı ş ğ
  [/[đ]/u, 'vi'], // đ
];

function tokenizeWords(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/\p{L}+/gu) ?? []);
}

/**
 * Best-effort language code for Latin-script text via stopword overlap plus
 * diacritic signals. Returns 'en' unless another language clearly wins (≥2
 * distinctive hits and strictly more than English), so English text is never
 * misclassified into a spurious translation.
 */
export function detectLatinLang(text: string): string {
  const words = tokenizeWords(text);
  if (words.size === 0) return 'en';
  const scores: Record<string, number> = {};
  for (const [code, stops] of Object.entries(LATIN_STOPWORDS)) {
    let hits = 0;
    for (const w of stops) if (words.has(w)) hits += 1;
    scores[code] = hits;
  }
  for (const [probe, code] of DIACRITIC_SIGNALS) {
    if (probe.test(text)) scores[code] = (scores[code] ?? 0) + 2;
  }
  const en = scores.en ?? 0;
  let best = 'en';
  let bestScore = en;
  for (const [code, score] of Object.entries(scores)) {
    if (code !== 'en' && score > bestScore) {
      bestScore = score;
      best = code;
    }
  }
  return best !== 'en' && bestScore >= 2 && bestScore > en ? best : 'en';
}

/**
 * Coarse language hint for `text`. First the dominant non-Latin script
 * (Hangul, Kana, CJK, Cyrillic, Arabic, Hebrew, Thai, Devanagari, Bengali,
 * Tamil, Telugu, Greek, Georgian, Armenian, Lao, Khmer); when the text is
 * Latin-script, fall back to {@link detectLatinLang}. Returns 'en' when no
 * non-English language is found. Used to default the localized-view language.
 */
export function detectLangHint(text: string): string {
  const {code, count} = scriptHint(text);
  if (count > 0) return code;
  return detectLatinLang(text);
}

/**
 * True when `text` is in any detected non-English language (non-Latin script or
 * a recognized Latin-script language) — the unified gate for both intent
 * normalization and the localized companion view.
 */
export function looksNonEnglish(text: string): boolean {
  return detectLangHint(text) !== 'en';
}

/**
 * Replace fenced/inline code spans with restorable placeholders so the
 * translator cannot rewrite code, paths, or identifiers embedded in them.
 *
 * @returns the masked text plus a `restore` that puts the spans back.
 */
export function maskCode(text: string): {masked: string; restore: (s: string) => string} {
  const spans: string[] = [];
  const masked = text.replace(/```[\s\S]*?```|`[^`]*`/g, (m) => {
    const i = spans.length;
    spans.push(m);
    return `[[CLAD_CODE_${i}]]`;
  });
  const restore = (s: string): string =>
    s.replace(/\[\[CLAD_CODE_(\d+)\]\]/g, (_, i: string) => spans[Number(i)] ?? '');
  return {masked, restore};
}

function enabled(): boolean {
  return (process.env.CLADDING_I18N ?? 'off') !== 'off';
}

function minChars(): number {
  return Number(process.env.CLADDING_I18N_MIN_CHARS ?? 400);
}

function buildPrompt(maskedText: string): string {
  return [
    'Translate the following text to English faithfully and completely.',
    'Rules:',
    '- Preserve every placeholder of the form [[CLAD_CODE_n]] exactly as-is.',
    '- Preserve identifiers (e.g. F-1a2b3c, AC-12), file paths, and technical terms verbatim.',
    '- Do not summarize, do not add commentary. Output ONLY the English translation.',
    '',
    '---',
    maskedText,
  ].join('\n');
}

/**
 * Normalize possibly-non-English intent to English using an injected
 * translator. Always returns usable text.
 *
 * @param text - The raw intent (free-text or a loaded document body).
 * @param translate - Cheap-model translator, or null/undefined to force skip.
 * @returns A {@link NormalizeOutcome} whose `text` is safe to forward whether
 *   or not translation actually ran.
 */
export async function normalizeToEnglish(
  text: string,
  translate: TranslateFn | null | undefined,
): Promise<NormalizeOutcome> {
  const charsBefore = text.length;
  const skip = (
    fallbackReason: NormalizeFallbackReason,
    detectedNonEnglish = false,
  ): NormalizeOutcome => ({
    text,
    applied: false,
    detectedNonEnglish,
    charsBefore,
    charsAfter: charsBefore,
    fallbackReason,
  });

  if (!enabled()) return skip('disabled');
  if (text.trim().length < minChars()) return skip('below_min_chars');
  if (!looksNonEnglish(text)) return skip('looks_english');
  if (!translate) return skip('no_translator', true);

  try {
    const {masked, restore} = maskCode(text);
    const raw = (await translate(buildPrompt(masked))).trim();
    if (raw.length === 0) return skip('empty_result', true);
    const restored = restore(raw);
    return {
      text: restored,
      applied: true,
      detectedNonEnglish: true,
      charsBefore,
      charsAfter: restored.length,
    };
  } catch {
    // Passthrough — degraded cost, never broken correctness (AC unwanted).
    return skip('translate_error', true);
  }
}

/** The relay model used for normalization. Overridable for cost/quality tuning. */
export function i18nModel(): string {
  return process.env.CLADDING_I18N_MODEL ?? 'claude-sonnet-4-6';
}

/** Whether the i18n normalization feature is switched on. */
export function i18nEnabled(): boolean {
  return enabled();
}

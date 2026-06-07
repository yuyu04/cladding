// Cladding · Token Optimizer · Cheap-model intent normalization (i18n)
//
// F-60b842 — non-English free-text intent (e.g. a large Korean planning doc
// passed to `clad init docs/plan-ko.md`) costs ~1.8x the tokens of the
// equivalent English when the expensive authoring model reads it. This module
// normalizes such intent to English ONCE with a cheap model (Haiku) before the
// selected model consumes it, so the expensive call reads fewer tokens.
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

// Letter-bearing non-Latin script ranges: Hangul (jamo + syllables), Kana,
// CJK, Cyrillic, Arabic, Hebrew, Thai. Enough to catch the languages whose
// tokenization is materially heavier than English.
const NON_LATIN_RE =
  /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯Ѐ-ӿ؀-ۿ֐-׿฀-๿]/gu;

/**
 * Heuristic: does this text contain enough non-Latin script to be worth
 * translating? Compares non-Latin letters against all non-whitespace chars.
 *
 * @param threshold - non-Latin ratio above which text is "non-English"
 *   (default 0.15 — Korean/Japanese/Chinese prose clears this easily, while
 *   English text with the odd accented name or emoji stays below).
 */
export function looksNonEnglish(text: string, threshold = 0.15): boolean {
  const nonSpace = text.replace(/\s/g, '');
  if (nonSpace.length === 0) return false;
  const matches = text.match(NON_LATIN_RE);
  return (matches?.length ?? 0) / nonSpace.length > threshold;
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

/** The cheap model used for normalization. Overridable for cost/quality tuning. */
export function i18nModel(): string {
  return process.env.CLADDING_I18N_MODEL ?? 'claude-haiku-4-5-20251001';
}

/** Whether the i18n normalization feature is switched on. */
export function i18nEnabled(): boolean {
  return enabled();
}

// Cladding · scan · Spec language policy (F-36f11b)
//
// The canonical spec (project-context.md, capabilities, scenario flows, feature
// titles) is read by the model on every session/feature dispatch. Non-English
// prose tokenizes ~1.8x heavier than English, so cladding authors the canonical
// artifacts in English by default and offers a localized companion *view* for
// humans (docs/project-context.<lang>.md) — generated, non-authoritative.
//
// Two knobs:
//   · CLADDING_SPEC_LANG      — canonical authoring language (default 'en').
//                               Set 'ko' to restore the prior user-language
//                               behavior (escape hatch).
//   · CLADDING_SPEC_VIEW_LANG — human companion-view language. When unset it is
//                               derived from the intent's dominant script. A
//                               view equal to the canonical language is skipped.
//
// @see docs/i18n-haiku-relay.md — design + rollout.
// @see spec/features/english-canonical-spec-localized-view-36f11b.yaml.

import process from 'node:process';

import {detectLangHint} from '../../optimizer/lang-normalize.js';

const LANG_NAMES: Readonly<Record<string, string>> = {
  en: 'English',
  ko: 'Korean',
  ja: 'Japanese',
  zh: 'Chinese',
  ru: 'Russian',
  ar: 'Arabic',
  he: 'Hebrew',
  th: 'Thai',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
};

/** The language the canonical (model-read) spec artifacts are authored in. */
export function canonicalLang(): string {
  return (process.env.CLADDING_SPEC_LANG ?? 'en').toLowerCase();
}

/** Prompt-facing display name for a language code (falls back to the code). */
export function langDisplayName(code: string): string {
  return LANG_NAMES[code] ?? code;
}

/**
 * The human companion-view language, or null when no view should be written.
 *
 * - Explicit `CLADDING_SPEC_VIEW_LANG` wins (null when it equals canonical).
 * - Otherwise derive from the intent's dominant script; null when that equals
 *   the canonical language (e.g. English intent → no view needed).
 *
 * @param intent - The user intent, used to derive the default view language.
 */
export function viewLang(intent?: string): string | null {
  const canonical = canonicalLang();
  const explicit = process.env.CLADDING_SPEC_VIEW_LANG?.toLowerCase();
  if (explicit) return explicit === canonical ? null : explicit;
  if (intent && intent.trim().length > 0) {
    const hint = detectLangHint(intent);
    if (hint !== canonical) return hint;
  }
  return null;
}

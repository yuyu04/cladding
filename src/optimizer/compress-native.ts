// Cladding · Token Optimizer · native deterministic compressor
//
// F-6aebb9 — the in-process replacement for the former Headroom subprocess
// bridge. Pure TypeScript, ZERO external dependencies: it ships inside the
// cladding npm package, installs with `npm i`, and needs no Python, no Rust
// extension, and no long-running proxy. Deterministic by construction (no
// clocks, no randomness, stable iteration order) — it fits cladding's Iron Law
// posture (`ai_hints.preferred_patterns`: synchronous + deterministic).
//
// Design rationale: the committed external-engine A/B (docs/headroom-ab-report)
// showed the *realized* token savings came entirely from deterministic
// structural transforms on bulky machine output — JSON tool arrays (~98%) and
// repetitive execution logs (~98%) — while the ML prose compressor no-op'd. So
// this native engine implements exactly those two transforms and nothing that
// would need a model:
//   · json_dedup — collapse near-identical objects in a large JSON array,
//                  keeping a few verbatim exemplars + a summary of the rest.
//   · log_dedup  — collapse runs of repetitive log lines by normalized pattern.
// High-value content (system / user / code / spec prose) is protected by the
// profile gating below and passes through byte-for-byte.
//
// @see src/optimizer/headroom.ts — the seam that calls this.
// @see src/optimizer/profiles.ts — the per-context-kind eligibility postures.

import type {CompressResult, OpenAIMessage} from './compress-types.js';
import type {HeadroomProfileConfig} from './profiles.js';

/** Verbatim exemplars kept before a JSON-array group is collapsed. */
const KEEP_REPRESENTATIVES = 2;
/** Arrays shorter than this are not worth a dedup pass. */
const MIN_ARRAY_FOR_DEDUP = 8;
/** Line blocks shorter than this are not worth a dedup pass. */
const MIN_LINES_FOR_DEDUP = 16;
/** A consecutive run shorter than this is emitted verbatim (no collapse). */
const MIN_RUN_TO_COLLAPSE = 3;

/**
 * chars/4 token proxy — the same heuristic as headroom.ts::approxTokens.
 * Never sent to the model or used for billing, so the approximation is fine;
 * the compression *ratio* is what matters and char-ratio ≈ token-ratio for
 * the whole-chunk removals this engine performs.
 */
function approx(s: string): number {
  return Math.ceil(s.length / 4);
}

function totalApprox(messages: readonly OpenAIMessage[]): number {
  return messages.reduce((n, m) => n + approx(m.content), 0);
}

// --- Eligibility ---------------------------------------------------------

/**
 * Decide whether a single message may be compressed under a profile.
 *
 * - `tool` messages (bulky, disposable machine output) are ALWAYS eligible —
 *   they are the whole point — subject only to the min-token floor.
 * - `system` / `user` / `assistant` prose is eligible only when the profile
 *   opts in (`compress_system_messages` / `compress_user_messages`) AND the
 *   message is not among the trailing `protect_recent` turns (the live ask).
 * - `protect_analysis_context` additionally protects anything that looks like
 *   fenced code, so a "review this module" turn is never mangled.
 */
function isEligible(
  msg: OpenAIMessage,
  index: number,
  total: number,
  cfg: HeadroomProfileConfig,
): boolean {
  if (approx(msg.content) < cfg.min_tokens_to_compress) return false;

  if (msg.role === 'tool') return true;

  // Trailing protect_recent non-tool turns are the live conversation — protect.
  if (index >= total - cfg.protect_recent) return false;

  if (msg.role === 'system' && !cfg.compress_system_messages) return false;
  if ((msg.role === 'user' || msg.role === 'assistant') && !cfg.compress_user_messages) {
    return false;
  }
  if (cfg.protect_analysis_context && msg.content.includes('```')) return false;
  return true;
}

// --- Transform: JSON array dedup -----------------------------------------

/** Sorted-key structural signature of a plain object. */
function signature(o: Record<string, unknown>): string {
  return Object.keys(o).sort().join('|');
}

/** Fields whose value is NOT constant across the group (deterministic order). */
function varyingFields(group: Array<Record<string, unknown>>): string[] {
  if (group.length === 0) return [];
  const keys = Object.keys(group[0]).sort();
  return keys.filter((k) => {
    const first = JSON.stringify(group[0][k]);
    return group.some((o) => JSON.stringify(o[k]) !== first);
  });
}

/**
 * Collapse a large JSON array of similarly-shaped objects. Keeps the first
 * {@link KEEP_REPRESENTATIVES} of each structural group verbatim and replaces
 * the remainder with one summary marker noting the omitted count and which
 * fields varied. Returns the original text unchanged when not applicable.
 */
function jsonDedup(content: string): {text: string; applied: boolean} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {text: content, applied: false};
  }

  // Target the largest array: a top-level array, or the largest array-valued
  // property of a top-level object (e.g. {findings: [...]}).
  let arr: unknown[] | undefined;
  let wrapKey: string | undefined;
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && typeof parsed === 'object') {
    for (const k of Object.keys(parsed as Record<string, unknown>)) {
      const v = (parsed as Record<string, unknown>)[k];
      if (Array.isArray(v) && v.length > (arr?.length ?? 0)) {
        arr = v;
        wrapKey = k;
      }
    }
  }
  if (!arr || arr.length < MIN_ARRAY_FOR_DEDUP) return {text: content, applied: false};
  if (!arr.every((e) => e !== null && typeof e === 'object' && !Array.isArray(e))) {
    return {text: content, applied: false};
  }

  const objects = arr as Array<Record<string, unknown>>;
  // Group by signature, preserving first-seen order (deterministic).
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const o of objects) {
    const sig = signature(o);
    (groups.get(sig) ?? groups.set(sig, []).get(sig)!).push(o);
  }

  const collapsed: unknown[] = [];
  let omitted = 0;
  for (const group of groups.values()) {
    if (group.length <= KEEP_REPRESENTATIVES) {
      collapsed.push(...group);
      continue;
    }
    collapsed.push(...group.slice(0, KEEP_REPRESENTATIVES));
    const rest = group.slice(KEEP_REPRESENTATIVES);
    omitted += rest.length;
    collapsed.push({
      __cladding_compressed__: `${rest.length} more entries with identical shape {${Object.keys(
        group[0],
      )
        .sort()
        .join(', ')}} omitted; fields that varied across them: [${varyingFields(rest).join(', ')}]`,
    });
  }
  if (omitted === 0) return {text: content, applied: false};

  const rebuilt =
    wrapKey !== undefined
      ? {...(parsed as Record<string, unknown>), [wrapKey]: collapsed}
      : collapsed;
  return {text: JSON.stringify(rebuilt, null, 2), applied: true};
}

// --- Transform: repetitive log dedup -------------------------------------

/** Normalize a log line so near-identical lines share a pattern key. */
function normalizeLine(line: string): string {
  return line.replace(/\d+/g, '#');
}

/**
 * Collapse consecutive runs of log lines that share a normalized pattern.
 * Each run of length R ≥ {@link MIN_RUN_TO_COLLAPSE} becomes the first line
 * plus a `… (×N more lines matching this pattern)` marker. Returns the
 * original text unchanged when there is nothing repetitive to collapse.
 */
function logDedup(content: string): {text: string; applied: boolean} {
  const lines = content.split('\n');
  if (lines.length < MIN_LINES_FOR_DEDUP) return {text: content, applied: false};

  const out: string[] = [];
  let collapsed = false;
  let i = 0;
  while (i < lines.length) {
    const key = normalizeLine(lines[i]);
    let j = i + 1;
    while (j < lines.length && normalizeLine(lines[j]) === key) j++;
    const run = j - i;
    if (run >= MIN_RUN_TO_COLLAPSE) {
      out.push(lines[i]);
      out.push(`… (×${run - 1} more lines matching this pattern)`);
      collapsed = true;
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }
  if (!collapsed) return {text: content, applied: false};
  return {text: out.join('\n'), applied: true};
}

// --- Lossless tier (json_minify · ws_collapse) ---------------------------
//
// Meaning-preserving transforms. Because they never change semantics, they may
// apply EVEN to content the lossy tier protects (spec/code/recent), broadening
// coverage at ~zero risk. The one exception is `system` messages, which the
// caller excludes to keep the cached persona prefix byte-stable.

/** Re-serialize a JSON document without pretty-print whitespace. Lossless. */
function jsonMinify(content: string): {text: string; applied: boolean} {
  const trimmed = content.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return {text: content, applied: false};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {text: content, applied: false};
  }
  const min = JSON.stringify(parsed);
  return min.length < content.length ? {text: min, applied: true} : {text: content, applied: false};
}

/** Collapse runs of 3+ consecutive blank lines to a single blank line. Lossless. */
function collapseBlankLines(content: string): {text: string; applied: boolean} {
  const out = content.replace(/(\r?\n[ \t]*){3,}/g, '\n\n');
  return out.length < content.length ? {text: out, applied: true} : {text: content, applied: false};
}

/** Run the lossless tier; returns the transformed text + the transforms used. */
function losslessNormalize(content: string): {content: string; transforms: string[]} {
  let text = content;
  const transforms: string[] = [];
  const j = jsonMinify(text);
  if (j.applied) {
    text = j.text;
    transforms.push('native:json_minify');
  }
  const w = collapseBlankLines(text);
  if (w.applied) {
    text = w.text;
    transforms.push('native:ws_collapse');
  }
  return {content: text, transforms};
}

// --- Per-message dispatch ------------------------------------------------

/** Apply the best-fitting LOSSY transform to one message's content. */
function compressContent(content: string): {content: string; transform: string | null} {
  const j = jsonDedup(content);
  if (j.applied && approx(j.text) < approx(content)) {
    return {content: j.text, transform: 'native:json_dedup'};
  }
  const l = logDedup(content);
  if (l.applied && approx(l.text) < approx(content)) {
    return {content: l.text, transform: 'native:log_dedup'};
  }
  return {content, transform: null};
}

// --- Public API ----------------------------------------------------------

/**
 * Compress a payload in-process and deterministically. Returns the same
 * {@link CompressResult} shape the old subprocess bridge produced, so the
 * seam (headroom.ts) is unchanged downstream. NEVER throws is the caller's
 * contract — this function is pure and side-effect-free, but the seam still
 * wraps it defensively.
 */
export function compressNative(
  messages: OpenAIMessage[],
  cfg: HeadroomProfileConfig,
): CompressResult {
  const before = totalApprox(messages);
  const transforms = new Set<string>();
  let changed = false;

  const out = messages.map((m, i) => {
    let content = m.content;

    // Lossy tier — profile-gated (protects system/user/recent/code per profile).
    if (isEligible(m, i, messages.length, cfg)) {
      const r = compressContent(content);
      if (r.transform) {
        content = r.content;
        transforms.add(r.transform);
      }
    }

    // Lossless tier — meaning-preserving, so it may run even on protected
    // content. Excluded for `system` messages to keep the cached persona prefix
    // byte-stable (a changed prefix would cost a cache miss > the tokens saved).
    if (m.role !== 'system') {
      const lossless = losslessNormalize(content);
      if (lossless.transforms.length > 0) {
        content = lossless.content;
        for (const tr of lossless.transforms) transforms.add(tr);
      }
    }

    if (content !== m.content) {
      changed = true;
      return {...m, content};
    }
    transforms.add('native:protected');
    return m;
  });

  const after = totalApprox(out);
  const saved = before - after;
  const win = changed && saved > 0;

  return {
    messages: win ? out : messages,
    tokensBefore: before,
    tokensAfter: win ? after : before,
    tokensSaved: win ? saved : 0,
    compressionRatio: before > 0 && win ? after / before : 1,
    transformsApplied: [...transforms].sort(),
    ccrHashes: [],
    compressed: win,
  };
}

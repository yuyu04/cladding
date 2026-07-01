// Cladding · Token Optimizer · Headroom compression seam
//
// F-6aebb9 — the single integration point between the cladding harness and the
// context compressor. Compression now runs NATIVELY in-process (see
// compress-native.ts): pure TypeScript, no subprocess, no Python, no Rust
// extension, no proxy. It ships inside the cladding npm package, so it installs
// with `npm i` and is active wherever cladding runs — nothing extra to set up.
//
// (Historically this seam shelled out to an external Headroom engine via a
// one-shot Python subprocess bridge. That made compression an out-of-band
// dependency the operator had to install separately. The committed A/B showed
// the realized savings were all deterministic structural transforms, which we
// now implement directly in TS — so the engine ships with the harness.)
//
// Contract (the load-bearing invariant): compressContext() NEVER throws and
// NEVER blocks correctness. On disabled config, a too-small payload, no
// savings, or ANY internal error it returns the ORIGINAL messages. Compression
// is a pure cost optimization layered over the existing dispatch path — the
// harness behaves identically with it off.
//
// @see docs/headroom-integration.md — full design + rollout.
// @see spec/features/headroom-compression-seam-6aebb9.yaml — the contract.

import process from 'node:process';

import {compressNative} from './compress-native.js';
import type {CompressResult, OpenAIMessage} from './compress-types.js';
import type {ContextKind, HeadroomProfileConfig} from './profiles.js';
import {PROFILES} from './profiles.js';

// Re-export the shared shapes so existing `from './headroom.js'` imports
// (anthropic.ts, bench, tests) keep working; the definitions live in the leaf
// module compress-types.ts to keep the seam ↔ engine import graph acyclic.
export type {CompressResult, OpenAIMessage} from './compress-types.js';

/** Why the seam declined to use a compressed payload, when it did. */
export type FallbackReason =
  | 'disabled'
  | 'below_min_tokens'
  | 'no_savings'
  | 'simulate'
  | 'compute_error';

/** The four master-switch modes. */
export type HeadroomMode = 'off' | 'on' | 'simulate' | 'auto';

/**
 * The seam's decision wrapper. `messages` is ALWAYS usable — it is the
 * compressed payload when `applied`, otherwise the untouched original.
 * Callers send `outcome.messages` unconditionally.
 */
export interface CompressOutcome {
  readonly messages: OpenAIMessage[];
  readonly applied: boolean;
  readonly result?: CompressResult;
  readonly fallbackReason?: FallbackReason;
}

// --- Gates ---------------------------------------------------------------

/** Master switch. `auto` = apply like `on`, but the caller may recover (below). */
export function headroomMode(): HeadroomMode {
  const m = (process.env.CLADDING_HEADROOM ?? 'off').toLowerCase();
  return m === 'on' || m === 'simulate' || m === 'auto' ? m : 'off';
}

function enabled(): boolean {
  const m = headroomMode();
  return m === 'on' || m === 'simulate' || m === 'auto';
}

/** Simulate = compute predicted savings but DON'T apply them (dry run). */
function simulating(): boolean {
  return headroomMode() === 'simulate';
}

// --- Auto-recovery (CLADDING_HEADROOM=auto) ------------------------------
//
// Compression is lossy on the bulk it collapses (json_dedup drops outlier
// values within same-shaped objects; log_dedup keeps anomalies but drops
// repetition). `auto` mode applies compression optimistically, then lets the
// caller (the SDK adapter) detect — deterministically, no LLM — whether the
// model's reply signals it needed the omitted data, and if so re-dispatch that
// ONE turn with the original uncompressed payload. Lossy-but-self-correcting.

/**
 * Deterministic detector: does a model reply signal it lacked the omitted
 * (compressed-away) context? Matches the markers the compressor leaves
 * (`__cladding_compressed__`, `… (×N more …)`) being referenced back, plus
 * common "I can't see the full set" phrasings in English and Korean. Pure +
 * conservative — a miss just means no recovery (degraded, never broken).
 */
export function needsFullContext(reply: string): boolean {
  return /\b(omitted|compressed[- ]?away|truncat\w+|the (full|complete|entire|original) (output|context|list|log|set|payload|findings)|all \d+ (entries|findings|records|lines|items)|only (saw|see|have|\d+ of)|can(?:no|')t (see|tell|enumerate|determine|identify)|need (the|more|full))\b|생략|압축|전체 (출력|목록|내용|결과|데이터)|원본(이|을)? ?(필요|봐야)|전부 (필요|나열|봐야)/i.test(
    reply,
  );
}

/**
 * Should the adapter re-dispatch uncompressed? Only in `auto` mode, only when
 * compression was actually applied, and only when the reply signals a gap.
 * Bounded to a single recovery (the caller does not loop).
 */
export function shouldRecover(applied: boolean, reply: string): boolean {
  return headroomMode() === 'auto' && applied && needsFullContext(reply);
}

function minTokens(): number {
  return Number(process.env.CLADDING_HEADROOM_MIN_TOKENS ?? 1500);
}

/**
 * Cheap heuristic (~4 chars/token). Only used to decide whether a payload is
 * large enough to be worth a compression pass — never sent to the model or
 * used for billing, so approximation is fine.
 */
export function approxTokens(messages: readonly OpenAIMessage[]): number {
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  return Math.ceil(chars / 4);
}

// --- Public API ----------------------------------------------------------

/**
 * Compress the messages for one LLM call. Always returns usable messages.
 *
 * @param messages - The payload about to be sent to the model.
 * @param kind - Which {@link ContextKind} profile to apply (default 'spec').
 * @returns A {@link CompressOutcome} whose `messages` are safe to send whether
 *   or not compression actually ran.
 */
export async function compressContext(
  messages: OpenAIMessage[],
  kind: ContextKind = 'spec',
): Promise<CompressOutcome> {
  if (!enabled()) return {messages, applied: false, fallbackReason: 'disabled'};
  if (approxTokens(messages) < minTokens()) {
    return {messages, applied: false, fallbackReason: 'below_min_tokens'};
  }

  try {
    const config: HeadroomProfileConfig = PROFILES[kind];
    const result = compressNative(messages, config);
    if (!result.compressed || result.tokensSaved <= 0) {
      return {messages, applied: false, result, fallbackReason: 'no_savings'};
    }
    // Simulate mode: report the predicted win, but send the ORIGINAL payload.
    if (simulating()) {
      return {messages, applied: false, result, fallbackReason: 'simulate'};
    }
    return {messages: result.messages, applied: true, result};
  } catch {
    // Passthrough — degraded cost, never broken correctness.
    return {messages, applied: false, fallbackReason: 'compute_error'};
  }
}

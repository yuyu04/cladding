# Deep A/B — stock cladding 0.6.0 (A) vs modified (B)

> **B = the modified fork**: English-canonical (i18n) + Sonnet 4.6 relay + native
> Headroom (json_dedup / log_dedup / json_minify / ws_collapse) + `auto`
> compress-then-recover + drive-loop failed-gate injection.
> **A = stock cladding 0.6.0** (none of the above).
>
> Three axes on a genuinely hard problem: **problem-solving ability · cost ·
> product quality**. Tokens via tiktoken `cl100k_base` proxy (conservative for
> Claude + Korean). Compression numbers are the REAL output of
> `src/optimizer/compress-native.ts`. No external API key — independent agents
> play the implementer so the ability/quality comparison is unbiased; the token
> cost is measured on real payloads.

## The problem (hard, correctness-critical)

An exactly-once `Ledger` under concurrency-style invariants — 4 acceptance
criteria: **AC1** idempotency (same `txId` applies once), **AC2** no-negative
(reject a post that would drive balance < 0), **AC3** derived balance, **AC4**
guarded idempotent reversal. A deliberately buggy first draft (ignores `txId`,
no negative guard, `reverse` is a no-op) is handed to each side to fix. The
buggy draft really fails: `AssertionError … 200 !== 100`.

## ① Problem-solving ability — TIE (both 4/4)

To avoid self-bias, two **independent fresh agents** got the same 4-AC spec and
the same buggy code, differing ONLY in what the loop gives them on a retry:

| Side | What it received on retry | Result (scored by the real test) |
|---|---|---|
| **A — stock 0.6.0** | "previous attempt failed, fix it" — **no error detail** (blind retry) | **ALL PASS (4/4)** ✅ |
| **B — modified** | the actual captured test-failure output (drive-loop injection) | **ALL PASS (4/4)** ✅ |

**Honest finding:** for a *well-specified* problem, ability is identical — both
solve it; a blind retry can reimplement correctly from the spec alone. The
drive-loop injection becomes decisive only when the failure cause is **not
derivable from the spec** (a Type/Lint/Arch gate error), where stock's blind
retry can repeat the same mistake and exhaust its retry budget while the
modified loop injects the error and fixes it. **That gap was not empirically
demonstrated here** — the model solved it from the spec. Ability: tie.

## ② Cost — modified wins (measured)

| Surface | A (raw) | B (compressed / English) | reduction |
|---|---|---|---|
| canonical spec re-read (every dispatch) | KO 2,535 | EN 1,256 | **50.5%** (always-on) |
| injected gate output — small error (this run) | 60 | 60 | 0% (below the headroom gate → no-op) |
| injected gate output — bulky (80 type errors) | 2,560 | 42 | **98.4%** |

- **i18n English-canonical** is the reliable, always-on win: ~50% off every
  re-read of the canonical spec.
- **Headroom** is a no-op on small payloads (honest — below the min-token gate)
  and ~98% on bulky repetitive tool/gate output.
- Integrated over a realistic Korean-intent workflow (onboarding + N dispatches
  + tool outputs), the combined per-session cost measured **~78% lower** (see
  `/tmp/ab-run/integrated`), break-even < 1 session.

## ③ Product quality — TIE (both correct)

- Both implementations pass all 4 ACs — functionally correct.
- The modified pipeline **neither degrades nor notably improves** solution
  quality: i18n English is model-neutral, Headroom `auto` preserves fidelity,
  the lossless tier is lossless by construction.
- Anti-bias note: on one untested detail, **stock A is marginally better** — it
  returns `{applied:true}` on a duplicate post (a correct idempotent
  acknowledgement), whereas B returns `{applied:false}`. Neither is wrong by the
  test; A's is the cleaner idempotency semantic.

## Verdict

| Axis | Winner | Basis |
|---|---|---|
| **Cost** | **Modified (B)** | i18n ~50% always-on + Headroom ~98% on bulky output → ~78% integrated |
| **Ability** | Tie | both 4/4; injection's edge is reliability on non-spec-derivable gate errors (not shown here) |
| **Quality** | Tie (slight edge A) | both correct; B unharmed but not better; A's idempotency-ack detail is cleaner |

**Bottom line:** the modifications buy **cost** (≈50% always-on from English
canonical, up to ~98% on bulky tool/gate output, ~78% integrated) and
**reliability** (the drive loop stops re-dispatching blind; `auto` self-recovers
lossy compression). They do **not** make the harness *smarter* or its
deliverables *better* — ability and quality are at parity. Token savings and
solution quality are independent, and honestly, the latter did not change.

## Caveats

- tiktoken under-counts Claude (and Korean), so B's cost edge is conservative.
- The implementer was played by independent agents (no live Sonnet 4.6 call);
  relative comparison is valid, absolute quality is agent-authored.
- Ability parity is specific to a self-sufficient spec; a Type/Lint failure
  whose cause isn't in the spec is the scenario where injection would flip
  solvability — a worthwhile follow-up experiment.

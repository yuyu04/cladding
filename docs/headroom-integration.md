# Headroom × Cladding Harness — Integration Design

> **Feature:** `F-6aebb9` (`spec/features/headroom-compression-seam-6aebb9.yaml`)
> **Status:** dark-launch implementation (off by default)
> **Engine:** **native** — `src/optimizer/compress-native.ts` (pure TypeScript, ships with cladding)
> **Host:** Cladding TS harness (Node ≥18, ESM)

This document records *why* and *how* context compression is embedded into the
cladding harness. It is the design SSoT (Tier B); the normative contract lives
in the feature shard above. Code must trace back to that shard's acceptance
criteria.

---

## 1. The decision that shapes everything

The compressor runs **natively, in-process, in TypeScript** — it is part of the
cladding package. There is **no external engine to install, no Python, no Rust
extension, no proxy, and no daemon**. Install cladding (`npm i`) and the
compressor is present; flip one env var and it is active.

### Why native (and not the external Headroom engine)

An earlier iteration shelled out to the external [chopratejas/headroom](https://github.com/chopratejas/headroom)
engine (Python library over a Rust core) via a one-shot subprocess bridge. That
made compression an **out-of-band dependency** the operator had to `pip install`
separately — and anyone using a cladding fork had to install it too, or
compression silently stayed off.

The committed A/B against that external engine showed the **realized** token
savings came **entirely from deterministic structural transforms** on bulky
machine output — JSON tool arrays and repetitive logs — while the ML prose
compressor (Kompress) no-op'd on real cladding payloads. So the native engine
implements exactly those deterministic transforms and nothing that would need a
model:

| Transform | Target | Behavior |
|---|---|---|
| `json_dedup` | large JSON arrays of similar objects (tool outputs) | keep a few exemplars verbatim + one summary marker noting the omitted count and which fields varied |
| `log_dedup` | repetitive log lines | collapse consecutive runs of pattern-identical lines into the first line + `… (×N more matching)` |

This is **lossy on disposable bulk, lossless on everything protected** — and it
is deterministic (no clock, no randomness), which fits cladding's Iron Law
posture (`spec.yaml::project.ai_hints` prefers synchronous + deterministic).

### Architecture options compared

| Option | Ships with cladding? | External dep | Verdict |
|---|---|---|---|
| **Native TS compressor (`compress-native.ts`)** | ✅ yes | ❌ none | ✅ **Chosen** — installs with `npm i`, sub-ms, deterministic |
| External engine via Python subprocess bridge | ❌ no | `pip install headroom-ai` + python3 | ❌ Replaced — out-of-band install, ~80–300 ms cold-start |
| External engine via managed proxy / Cloud | ❌ no | running daemon or Cloud key | ❌ Rejected — stands up a server / sends context off-box |

---

## 2. Where compression attaches

Cladding has two dispatch modes (`src/adapters/`):

- **`host`** (default — `claude-code`, `generic-mcp`): the *host* owns the LLM
  wire and the user's subscription. Cladding does **not** make the API call, so
  there is no outbound payload to intercept. The dark launch does not wire the
  host path.
- **`sdk`** (`claude-anthropic`, `src/adapters/sdk/anthropic.ts`): cladding owns
  `client.messages.create()`. **Full message-array compression** is possible.

The integration is a **middleware in the adapter layer**. The dark launch wires
the seam into the `sdk` adapter (the path cladding fully controls).

### Component & data flow

```
drive/loop.ts → drive/agent.ts → selectAdapter()
                                      │
                ┌─────────────────────┴───────────┐
             host adapter                      sdk adapter
        (claude-code / mcp)              (anthropic.ts)
                │                               │
                ▼                               ▼
        ┌──────────────────────────────────────────────┐
        │  optimizer/headroom.ts   (the seam)            │
        │  compressContext(messages, kind)               │
        │  · enabled gate · min-token gate · simulate    │
        │  · native pass · fallback passthrough          │
        └───────────────────────┬──────────────────────┘
                                 ▼
        optimizer/compress-native.ts   (pure, in-process)
        · profile gating (isEligible)
        · json_dedup · log_dedup
                                 ▼
              compressed messages → Anthropic API → LLM
```

### Sequence (SDK mode)

```
loop → agent → AnthropicTransport.invoke(persona, ctx)
  1. build messages[] = [{system: persona.body}, {user: featureShard+guardrails}]
  2. compressContext(messages, kind)
       2a. disabled?         → passthrough (applied=false)
       2b. below min_tokens? → passthrough
       2c. native pass (compressNative)
            savings>0 + on    → compressed messages
            savings>0 + simulate → predicted result, ORIGINAL messages sent
            no savings        → passthrough (no_savings)
            internal error    → passthrough (compute_error)
  3. emit `compression` event → .cladding/events.log.jsonl
  4. messages.create(returned messages)   # compressed OR original
```

**Invariant:** `compressContext` never throws and is pure pass-through on any
failure. The harness runs identically with compression off — it is strictly an
optional optimization, never a correctness dependency.

---

## 3. Per-data-type optimization strategy

Cladding's payload mixes several pressure sources. Each maps to a posture via a
profile (`src/optimizer/profiles.ts`), which `compress-native.ts::isEligible()`
enforces:

| Context kind | Posture | Native effect |
|---|---|---|
| **logs** (agent execution logs) | `protect_recent=2`, aggressive | `log_dedup` collapses repetitive lines. |
| **json** (tool outputs / API responses) | dedup, `min_tokens_to_compress=250` | `json_dedup` collapses near-identical array items. |
| **code** (source context) | `protect_analysis_context`, `compress_user_messages=false` | protected — fenced code passes through. |
| **spec** (feature shards + guardrails) | `compress_system_messages=false`, `protect_recent=6` | protected — prefix byte-stable → prompt-cache hits. |
| **history** (multi-turn) | `keep recent`, `compress_user_messages=true` | `json_dedup` on repeated tool records; recent turns protected. |

---

## 4. Configuration — turning it on and off

The compressor is **off by default** (dark launch). It is controlled entirely by
environment variables:

```bash
CLADDING_HEADROOM=off        # default — seam inert, zero behavior change
CLADDING_HEADROOM=simulate   # dry run: compute & log predicted savings, send ORIGINAL payload
CLADDING_HEADROOM=on         # active: apply native compression to eligible payloads
CLADDING_HEADROOM=auto       # apply, but self-recover: re-dispatch uncompressed if the reply
                             #   signals it needed the omitted data (compress-then-recover)

CLADDING_HEADROOM_MIN_TOKENS=1500   # skip payloads smaller than this (default 1500)
```

That is the whole surface — no interpreter path, no bridge path, no timeout, no
circuit-breaker knob, because there is no subprocess. To use it:

| Goal | Command |
|---|---|
| **Off** (default) | unset `CLADDING_HEADROOM`, or `export CLADDING_HEADROOM=off` |
| **Preview savings** (no risk) | `export CLADDING_HEADROOM=simulate` — the `compression` event logs predicted `tokensSaved`; the original payload is still sent |
| **On** | `export CLADDING_HEADROOM=on` |
| **On, self-correcting** | `export CLADDING_HEADROOM=auto` |

### `auto` — compress-then-recover (mitigates the lossy risk)

Compression is **lossy** on the bulk it collapses: `json_dedup` drops outlier
*values* inside same-shaped objects (e.g. one `severity:error` finding hidden
among 150 `info` ones), and `log_dedup` keeps anomalies but drops repetition.
For audit/enumeration tasks that need every record, plain `on` can yield a
worse answer for a smaller token bill.

`auto` applies compression optimistically, then — **deterministically, with no
LLM** — inspects the model's reply for signals that it lacked the omitted data
(`needsFullContext()`: phrases like "omitted", "only saw N of", "need the full
output", Korean "전체 출력이 필요", plus the compressor's own markers). On a hit it
**re-dispatches that one turn with the original, uncompressed payload** (bounded
to a single retry) and uses that reply, emitting a `compression` event with
`recovered: true`. So the cheap path is taken by default and the full-fidelity
path is taken only when the model actually needs it — lossy, but self-correcting.

> Caveat: the detector is a conservative heuristic — a miss just means no
> recovery (degraded cost, never broken correctness), and recovery only fires on
> dispatches that actually compressed (with the current `spec`-profile call site,
> the assembled persona+shard payload is protected, so `auto` is dormant there;
> it activates wherever bulkier `json`/`logs` payloads flow through the seam).

Set it in your shell, your CI env, or per-invocation:
`CLADDING_HEADROOM=on clad <cmd>`.

---

## 5. Exception handling & fallback (defense-in-depth)

Layers, none of which can break the harness:

1. **Structural protection (lossless).** `protect_recent`,
   `protect_analysis_context`, `min_tokens_to_compress`, and
   `compress_system_messages=false` ensure the active turn, code-under-review,
   and persona prompt are never touched. (AC `ca3e88`.)
2. **Simulate-guard.** `CLADDING_HEADROOM=simulate` predicts savings with zero
   lossy risk — no compressed payload is ever sent. (AC `9f23a1`.)
3. **No-savings → passthrough.** If a pass yields no net reduction, the seam
   returns the **original** message reference (`no_savings`).
4. **Internal error → passthrough.** Any error in the native pass is caught and
   the original messages are returned (`compute_error`). The pass is pure and
   side-effect-free, so this is a belt-and-suspenders guard. (AC `b9218d`.)

Every attempt (applied, skipped, fallback) is appended to
`.cladding/events.log.jsonl` as a `compression` event so the `observability`
persona and `clad doctor` can report realized savings and fallback rate.

---

## 6. Rollout & verification

1. **Nothing to install** — the compressor ships in the cladding package.
2. **Land dark:** ship with `CLADDING_HEADROOM` unset. The seam is inert.
3. **Simulate:** `CLADDING_HEADROOM=simulate` → events log predicted savings with
   zero lossy risk.
4. **Measure:** `clad doctor` / the `observability` persona read the new
   `compression` events → realized `tokensSaved`, fallback rate.
5. **Promote:** flip `CLADDING_HEADROOM=on` once savings justify it.
6. **Bench any time:** `npx tsx scripts/bench-headroom.ts` regenerates
   `docs/headroom-ab-report.md` (pure TS — no setup).

---

## 7. Known caveats (honest)

- **Deterministic transforms only.** The native engine does `json_dedup` and
  `log_dedup`. It deliberately omits ML-based prose compression — the committed
  external-engine A/B showed that path contributed ~0 realized savings on real
  cladding payloads, so dropping it loses nothing while removing a model
  dependency.
- **Wins are payload-shaped.** Big reductions land on bulky repetitive machine
  output (JSON tool arrays, logs). Prose (spec/code/system/user) is protected by
  design and shows 0% — that is correct, not a miss.
- **Token counts are a chars/4 proxy** for the gate and the bench (never billed;
  the compression *ratio* is what matters).
- **Host mode has limited reach** — when Claude Code owns the wire, the dark
  launch only wires the `sdk` adapter; the `host` path is a documented follow-up.

# i18n Cheap-Model Intent Normalization

> **Feature:** `F-60b842` (`spec/features/i18n-cheap-model-intent-normalize-60b842.yaml`)
> **Status:** dark-launch (off by default; `CLADDING_I18N=on` to enable)
> **Scope:** SDK mode only — host/MCP is a no-op

## Why (and the honest scope)

Non-English text tokenizes heavier than English — measured **~1.77x** for Korean
vs the equivalent English (cl100k_base; Claude's tokenizer is similar or worse).
So when a user feeds a large non-English intent to the expensive onboarding
model, they pay ~1.8x the input tokens for the same meaning.

The original proposal was a full "translation sandwich": translate every input
in *and* every answer back out via Haiku, claiming identical performance and
dramatic savings. We deliberately **did not** build that, because:

1. **Host mode can't pick the model.** Cladding's MCP sampling model parameter
   is *advisory* — the host (Claude Code / Cursor) ignores it and routes to the
   user's selected model (`src/cli/scan/dispatcher.ts:104`). So "translate on
   Haiku, author on Opus" is impossible in host mode; it only works in SDK mode
   where cladding makes the calls and the model override is honored.
2. **"Identical performance" is false.** Translation is lossy, and spec authoring
   is the most nuance-sensitive task. A round-trip can degrade spec quality.
3. **Back-translation *increases* tokens.** Cladding artifacts are English by
   design — there is no Korean output to save on. Auto-translating answers back
   adds a whole extra generation.
4. **Small intents save almost nothing.** The user-typed intent is usually a tiny
   fraction of total context (the bulk is already-English spec/code/system
   prompt).

So this feature is the **narrow, defensible win only**: normalize *large,
genuinely non-English intent* to English **once** with a cheap model, before the
expensive onboarding model reads it. No back-translation. SDK mode only.

## What

`clad init <large non-English intent or docs/plan-ko.md>`:

```
load intent (free-text or file body)
   │
   ▼  (only if CLADDING_I18N=on AND not host/MCP mode)
normalizeToEnglish(intent, cheapTranslator)
   │   · gate: length ≥ CLADDING_I18N_MIN_CHARS (400) AND looksNonEnglish()
   │   · mask code/identifiers → translate via Haiku → unmask
   │   · never throws → original intent on any failure
   ▼
English intent → interpretOnboardingWithFallback (expensive selected model)
```

The expensive model now reads the leaner English intent. The cheap (Haiku)
translation is a separate SDK call routed by `selectDispatcher({model: haiku})`.

## Components

| File | Role |
|---|---|
| `src/optimizer/lang-normalize.ts` | Pure core: `looksNonEnglish()`, `maskCode()`, `normalizeToEnglish(text, translate)`, `i18nEnabled()`, `i18nModel()`. Never throws; translator is injected. |
| `src/cli/init.ts` | Wires the hook after intent load: SDK-mode gate (`!getHostMcpServer()`), builds the Haiku translator via `selectDispatcher`, emits the event. |
| `src/events/log.ts` | `lang_normalized` telemetry event. |

The core is dependency-injected (the CLI passes the translator) so the optimizer
layer never imports an SDK and host mode simply never calls it.

## Configuration

```bash
CLADDING_I18N=on|off                 # master switch (default: off)
CLADDING_I18N_MIN_CHARS=400          # skip intents shorter than this
CLADDING_I18N_MODEL=claude-haiku-4-5-20251001   # cheap translation model
```

The translator is built with `selectDispatcher({model})`, which honors the model
override on the Anthropic / OpenAI / Gemini SDK providers. In host/MCP mode the
override is ignored, so the CLI skips normalization entirely.

## Fallback (never breaks `clad init`)

`normalizeToEnglish` returns the **original** intent on every off-path:
`disabled`, `below_min_chars`, `looks_english`, `no_translator`,
`empty_result`, `translate_error`. It never throws. Code blocks and identifiers
(`F-1a2b3c`, `AC-12`, file paths) are masked before translation and restored
after, so they survive verbatim.

## Verification

```bash
# unit (pure core)
npx vitest run tests/optimizer/lang-normalize.test.ts

# end-to-end, SDK mode, large Korean intent
CLADDING_I18N=on ANTHROPIC_API_KEY=... clad init docs/plan-ko.md
#  → stderr: "normalized non-English intent → English (N→M chars) via claude-haiku-4-5…"
#  → .cladding/events.log.jsonl gains a lang_normalized event (charsBefore/After)

# off by default — identical to before
clad init docs/plan-ko.md      # no normalization, no event
```

## Caveats / follow-ups (out of scope)

- **No back-translation.** Answers/artifacts stay English by design.
- **Host mode is a no-op** — only SDK mode (API key) routes a cheap model.
- A real token-savings A/B (Opus input saved vs added Haiku cost) is the natural
  next step, mirroring `docs/headroom-ab-report.md`.

# Plan — Add Gemini 3.7 Flash to the gemini model picker

| Field | Value |
| --- | --- |
| Date | 2026-08-13 |
| Source | /implement — "also add Gemini 3.7 Flash for Gemini CLI, they just announced it" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/add-mythos-5 (continuing the user's active task branch) |
| Base SHA | 450a708 (GPT-5.6 Cyber commit) |
| Mode | **Autonomous** — grill and plan-approval gates bypassed; assumptions in §8 |

## 1. Objective & success criteria

`gemini-3.7-flash` selectable for gemini tasks; runs launch `gemini -m
gemini-3.7-flash`; effort picker stays collapsed (gemini has no effort flag);
default stays `gemini-3-pro-preview`; typecheck + tests green.

## 2. Context & constraints (grounded)

Web research (verified 2026-08-13, announcement day):
- Model id **`gemini-3.7-flash`** — confirmed on the official Gemini API models
  table (ai.google.dev/gemini-api/docs/models), listed **Stable** ("New
  Stable"), no preview suffix — unlike `gemini-3-pro-preview`/`gemini-3.1-pro-preview`.
- Positioning: Google's "latest and most capable Flash" — coding/agentic
  workhorse tier, intro pricing $0.75/$3.75 per MTok through end of 2026.
- Caveat: the gemini-cli repo has no `gemini-3.7-flash` references yet (0 code
  hits on announcement day) — the CLI picker may lag, but agetor passes the id
  verbatim via `-m`, so it works as soon as the CLI/API accepts it.

Local sync points (verified):
- `src/shared/types.ts` `AGENT_OPTIONS.gemini.models` (~1590): 3-pro-preview
  (recommended default) → 3.1-pro-preview → 2.5-pro → 3.5-flash → 2.5-flash.
- `src/shared/types.ts` `MODEL_EFFORT_SUPPORT.gemini` (~1471): every entry `[]`
  — gemini has no per-invocation effort flag (settings.json-only, verified on
  CLI 0.54.0 per existing comments); empty list collapses the effort picker.
- `src/bun/agents.ts:493-496`: gemini model is passed verbatim via `-m`;
  `opts.effort` is intentionally ignored on the gemini branch. **No change.**
- `MODEL_MODE_DENY.gemini` = `{}` — no entry needed.
- README has no gemini model enumeration (only a roadmap mention) — no change.
- Tests: `src/bun/agents.test.ts:725+` gemini argv tests (use the default model;
  none are order-sensitive); no existing per-model gemini assertions in
  `effort-support.test.ts`.

## 3. Approach & key decisions

- **Position: first Flash entry** — above `gemini-3.5-flash`, below the Pro
  tiers. The user didn't say "on top" this time; the list's existing order is
  capability-tiered (Pros first, then Flashes, newest first within tier), and
  3.7 Flash is a Flash-tier model, so it slots in as the newest Flash (A1).
- **Hint reflects official positioning**: latest/most-capable Flash, strong on
  coding/agentic work. No gating language — it's GA.
- **Effort entry `[]`** — matches every sibling; keeps the picker collapsed.
- **DEFAULT_MODEL.gemini unchanged** (`gemini-3-pro-preview`): repo policy pins
  the flagship Pro as default (root CLAUDE.md "best available model"); 3.7
  Flash is the top Flash, not the flagship.
- No agents.ts change (verbatim `-m` passthrough is the tested contract).

## 4. Work breakdown — implementation

**IMPL-1**: add the model entry + effort-support entry.
- Owns: `src/shared/types.ts` only.
- Acceptance: `gemini-3.7-flash` between `gemini-2.5-pro` and
  `gemini-3.5-flash` in `AGENT_OPTIONS.gemini.models` with the positioning
  hint; `MODEL_EFFORT_SUPPORT.gemini["gemini-3.7-flash"] = []`; nothing else.

## 5. Work breakdown — tests

**TEST-1**: minimal coverage mirroring the suites' conventions.
- Owns: `src/bun/agents.test.ts`, `src/bun/effort-support.test.ts`.
- Acceptance: an agents.test.ts test asserting `-m gemini-3.7-flash` verbatim
  argv emission (mirroring the existing gemini argv tests); an
  effort-support.test.ts test asserting `supportedEfforts("gemini",
  "gemini-3.7-flash")` is empty (picker collapses).

**E2e: not applicable** — registry addition, same rationale as the two prior
model-addition plans on this branch.

## 6. Execution waves

Wave 1: IMPL-1 (sonnet) → review (opus) → Wave 2: TEST-1 (sonnet) → run
(haiku: `bun run typecheck` + `bun test`; node_modules present).

## 7. Blast radius & risks

- `supportedEfforts` unknown-id fallback for gemini already yields `[]`
  (default model's set), so even a missed entry is behavior-neutral.
- Users on a gemini CLI build predating 3.7 Flash get a CLI/API model error at
  run time — pre-existing risk class, verbatim-passthrough design accepts it.

## 8. Open questions / assumptions (autonomous mode)

- **A1**: placement = newest Flash slot (above 3.5 Flash), NOT top of the whole
  list — the user didn't request top placement and the default/flagship is the
  Pro preview. One-line reorder if they wanted it elsewhere.
- **A2**: no Cursor catalog change — Cursor hosts its own separately-named
  gemini entries (`gemini-3.6-flash` etc. in CURSOR_MODEL_SPECS); adding
  Cursor's 3.7 Flash when Cursor ships it is a separate change.

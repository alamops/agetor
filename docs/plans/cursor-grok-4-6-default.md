# Plan — Cursor Grok 4.6 in the model picker + new Cursor default

| Field | Value |
| --- | --- |
| Date | 2026-08-12 |
| Source | /implement request — "make Grok 4.6 available in the options and the default for Cursor" (ref: https://x.ai/news/grok-4-6) |
| Config | AGENTS_CONFIG.yml (balanced) — run collapsed to inline execution (see §6) |
| Branch | feature/add-grok-4-6 |
| Base SHA | 2a4f1a1f3eb8a88aae8bd9581592a5c109d87a85 |
| Mode | Autonomous — grill + plan-approval gates self-approved; assumptions logged in §8 |

## 1. Objective & success criteria

Grok 4.6 appears in the Cursor model picker with its full effort/fast surface, and a new
Cursor task defaults to it (instead of `auto`). `bun run typecheck` and `bun test` green.

## 2. Context & constraints (grounded)

- **Verified live** via `~/.local/bin/cursor-agent models` (CLI `2026.08.11-e8db854`):
  Grok 4.6 is exposed as `cursor-grok-4.6-low|medium|high|xhigh` plus `-fast` variants of
  all four tiers. There is **no bare `cursor-grok-4.6` id**, no `max` tier, and no 1M-context
  ("Max Mode") variant — same shape as `cursor-grok-4.5` but with an added `xhigh` tier.
  The unsuffixed label ("Cursor Grok 4.6") belongs to the `-high` variant, matching 4.5.
- The Cursor picker, `MODEL_EFFORT_SUPPORT.cursor`, and `--model` composition all derive
  from `CURSOR_MODEL_SPECS` (`src/shared/types.ts:1058`, consumed at 1455 and 1570 and by
  `cursorModelArg` at 1327) — one spec entry lights up everything.
- `DEFAULT_MODEL.cursor` (`src/shared/types.ts:1036`) is what the New Task form pre-selects,
  what `orchestrator.createTask` backfills when a request omits `model`
  (`src/bun/orchestrator.ts:2378`), what the CLI `add` command pre-highlights, and the
  fallback key for `supportedEfforts` / `cursorModelSupportsFast` / `cursorModelSupportsMaxMode`.
- `DEFAULT_EFFORT.cursor` is already `"high"`; grok-4.6 has a `high` variant, so omitted
  effort resolves cleanly (`orchestrator.ts:2381-2383` picks `high` because the support
  list is non-empty).

## 3. Approach & key decisions

- **Catalog key `cursor-grok-4.6`** with `effortIds` for xhigh/high/medium/low and
  `fastEfforts` for all four — mirrors the 4.5 entry; ids rest on the live CLI listing
  (measured, not inferred). No `supportsMaxMode` (no 1M variant exists).
- **Default flips from `auto` to `cursor-grok-4.6`** — per the explicit request. Side
  effect (accepted): unknown/pasted cursor model ids now fall back to grok-4.6's effort
  set (xhigh/high/medium/low) in the picker instead of collapsing to none; this matches
  how codex already treats unknown ids.
- **Picker placement: first entry, before `auto`** — codex and gemini both list their
  recommended default first; the default model topping the list is the house pattern.
- Legacy rows are untouched: existing tasks carry explicit `model` values; only new
  tasks (or API calls omitting `model`) get the new default.

## 4. Work breakdown — implementation

- **T1** (`src/shared/types.ts`): add the `cursor-grok-4.6` spec (first entry in
  `CURSOR_MODEL_SPECS`); set `DEFAULT_MODEL.cursor = "cursor-grok-4.6"`; refresh the
  stale comments on `DEFAULT_MODEL.cursor` and `DEFAULT_EFFORT.cursor` (both currently
  say the default is `auto`/declines effort).

## 5. Work breakdown — tests

- **T2** (`src/bun/effort-support.test.ts`): update the three assertions that pin the old
  default (`DEFAULT_MODEL.cursor === "auto"`; `supportedEfforts("cursor", null)` /
  unknown-id fallback returning `[]`); add coverage: catalog contains `cursor-grok-4.6`,
  its effort surface is xhigh/high/medium/low with no max, `cursorModelArg` composes
  `cursor-grok-4.6-high` for default effort and `-xhigh-fast` for fast xhigh, and no
  Max-Mode support.
- **e2e: not applicable** — pure catalog/constants change in shared types; no new UI
  surface or flow (the picker rows are data-driven). Existing unit suite exercises the
  full derivation chain.

## 6. Execution waves

Single wave, executed inline by the orchestrator — a two-file change is below the
threshold where sub-agent fan-out pays for itself (per the skill's "Adapting to reality").

## 7. Blast radius & risks

- New-task defaults change for Cursor only; claude-code/codex/gemini untouched.
- `supportedEfforts` fallback behavior change for unknown cursor ids (see §3) — benign;
  `cursorModelArg` passes unknown ids through verbatim regardless.
- Existing tasks/runs unaffected (explicit model persisted per row).

## 8. Open questions / assumptions (autonomous mode)

- **A1:** "Grok 4.6" = Cursor's `cursor-grok-4.6-*` family (the only 4.6 Grok ids the CLI
  exposes). Confidence: high — verified against the live CLI.
- **A2:** Default effort stays `high` (repo-wide `DEFAULT_EFFORT.cursor`), i.e. a new
  Cursor task runs `cursor-grok-4.6-high`. The CLI's own unsuffixed "Cursor Grok 4.6"
  label is the high tier, so this matches Cursor's presentation.
- **A3:** Picker label "Cursor Grok 4.6" (CLI's own label), not "Grok 4.6" — consistent
  with the existing "Cursor Grok 4.5" row.

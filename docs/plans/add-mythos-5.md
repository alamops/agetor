# Plan — Add Claude Mythos 5 to the claude-code model picker

| Field | Value |
| --- | --- |
| Date | 2026-08-12 |
| Source | /implement — "add Mythos 5 in Agetor as an available option, on top of Fable 5" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/add-mythos-5 |
| Base SHA | 2a4f1a1f3eb8a88aae8bd9581592a5c109d87a85 |
| Mode | **Autonomous** — grill and plan-approval gates bypassed; assumptions logged in §8 |

## 1. Objective & success criteria

Users whose Anthropic org has Claude Mythos 5 access (Project Glasswing) can pick
"Mythos 5" in agetor's claude-code model picker and run tasks on it. Success:

- `mythos-5` appears in the New Task form and the RunPanel model picker for claude-code.
- Runs launch `claude --model claude-mythos-5`.
- Effort picker offers max/xhigh/high/medium/low (same surface as Fable 5).
- Default model stays `opus-5`; nothing changes for existing tasks.
- `bun run typecheck` and `bun test` green.

## 2. Context & constraints (grounded)

Model facts (verified via the claude-api reference skill, cached 2026-06-24):
Mythos 5 id is `claude-mythos-5`; same underlying model, capabilities, pricing
($10/$50 per MTok = 2x Opus), and API surface as Fable 5 (`claude-fable-5`);
availability is restricted to orgs in Project Glasswing. Effort support:
low/medium/high/xhigh/max — identical to Fable 5.

Adding a claude-code model touches exactly these sync points (fleet knowledge
from the Fable 5 / Opus 5 / Sonnet 5 additions, re-verified against current code):

1. `src/shared/types.ts:1531` — `AGENT_OPTIONS["claude-code"].models` (list order = picker order; `fable-5` is currently first).
2. `src/shared/types.ts:1432` — `MODEL_EFFORT_SUPPORT["claude-code"]`.
3. `src/shared/types.ts:1501` — `MODEL_MODE_DENY["claude-code"]` (all `[]` today).
4. `src/bun/agents.ts:116` — `CLAUDE_MODEL_FLAG` friendly-id → `--model` string.
5. `src/mainview/components/kanban/NewTaskForm.tsx:944` — contextual helper line shown when `model === "fable-5"` (2x-usage warning); Mythos gets the analogous treatment.

Tests that hard-assert these maps: `src/bun/agents.test.ts` (`--model` mapping),
`src/bun/effort-support.test.ts` (per-model effort + DEFAULT_MODEL). Both UI
pickers read AGENT_OPTIONS, so no other UI change is needed.

Fresh worktree has no `node_modules` — run `bun install` before typecheck/test.

## 3. Approach & key decisions

- **Position: top of the picker, above Fable 5.** "On top of Fable 5" read
  literally, matching the precedent of Fable 5 being added above Opus 4.8 at the
  top. Rests on assumption A1.
- **Hint flags restricted access**: users without Project Glasswing access would
  otherwise hit an opaque CLI error. Hint: capability parity with Fable + 2x
  Opus usage + approved-org requirement.
- **Default stays `opus-5`.** Mythos is access-gated; defaulting to it would
  break first runs for nearly all users. No DB migration (DEFAULT_MODEL only
  seeds the new-task form).
- **Effort/mode maps mirror `fable-5`** — same underlying model, evidence above.
- **No Cursor/codex/gemini changes.** Cursor's model list is a separate,
  cursor-hosted catalog; no evidence Cursor serves Mythos. Out of scope (A2).
- **`CLAUDE_MODEL_FLAG` entry is required**, not optional: without it the
  friendly id `mythos-5` would pass through verbatim to `--model mythos-5`,
  which the claude CLI doesn't accept.

## 4. Work breakdown — implementation

**IMPL-1** (single task — files are small, tightly coupled edits):
Add Mythos 5 to the claude-code model surface.
- Owns: `src/shared/types.ts`, `src/bun/agents.ts`, `src/mainview/components/kanban/NewTaskForm.tsx`.
- Acceptance: entries described in §2 items 1–5 added; `mythos-5` first in the
  models list; comments follow surrounding style; nothing else edited.

## 5. Work breakdown — tests

**TEST-1**: extend the two hard-assert test files (covers IMPL-1).
- Owns: `src/bun/agents.test.ts`, `src/bun/effort-support.test.ts`.
- Acceptance: a `mythos-5 → --model claude-mythos-5` mapping test mirroring the
  fable-5 one; a mythos-5 effort-support test (max/xhigh/high/medium/low);
  existing DEFAULT_MODEL assertions untouched.

**E2e: not applicable.** This is a data-table addition; the pickers render from
AGENT_OPTIONS generically and are already covered by the existing e2e harness's
task-creation flows. No new user flow is introduced, and running Mythos for real
requires org access agetor's CI doesn't have.

## 6. Execution waves

- Wave 1: IMPL-1 (implementation runner: claude sonnet).
- Review: opus, diff vs base SHA.
- Wave 2: TEST-1 (tests runner: sonnet) — file-disjoint from IMPL-1.
- Test run: haiku — `bun install`, `bun run typecheck`, `bun test`.

## 7. Blast radius & risks

- `MODEL_EFFORT_SUPPORT` unknown-id fallback means even a missed entry degrades
  gracefully (falls back to opus-5's set) — low risk.
- Users without Mythos access selecting it will get a CLI-side model error at
  run time; mitigated by the hint text. Agetor has no way to probe org access.
- No schema/migration changes; no server route changes.

## 8. Open questions / assumptions (autonomous mode)

- **A1**: "on top of Fable 5" = literally above Fable 5 (picker position 0).
  If the intent was merely "in addition to", the fix is a one-line reorder.
- **A2**: scope is the claude-code agent only; Cursor's catalog untouched.
- **A3**: helper line under the picker mirrors Fable's, mentioning 2x usage and
  approved-org access, shown only when mythos-5 is selected.

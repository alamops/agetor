# Plan — Add GPT-5.6 Cyber to the codex model picker

| Field | Value |
| --- | --- |
| Date | 2026-08-12 |
| Source | /implement — "also add GPT 5.6 Cyber for Codex, on top of 5.6 Sol, even though not available for all" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/add-mythos-5 (continuing the user's active task branch) |
| Base SHA | db8bbf0 (Mythos 5 commit) |
| Mode | **Autonomous** — grill and plan-approval gates bypassed; assumptions in §8 |

## 1. Objective & success criteria

Users with GPT-5.6 Cyber access can pick it for codex tasks. Success:
`gpt-5.6-cyber` appears first in the codex model picker (above Sol), runs pass
it through as `--model gpt-5.6-cyber`, the effort picker offers the GPT-5.6
family surface, default stays `gpt-5.6-sol`, typecheck + tests green.

## 2. Context & constraints (grounded)

Web research (official OpenAI docs, verified 2026-08-12):
- Model id **`gpt-5.6-cyber`** — confirmed at developers.openai.com/api/docs/models/gpt-5.6-cyber.
  An alias for OpenAI's cybersecurity-purpose-trained models built on GPT-5.6 Sol.
  400K context / 128K output; $12.50/$75 per MTok.
- **Access-gated**: requires approval + provisioning through OpenAI's Daybreak
  program (Daybreak Red tier) — not unlocked by standard ChatGPT/API plans.
- Effort levels: not enumerated for Cyber specifically; the GPT-5.6 family
  supports none→max (assumption A1 mirrors Sol's set).

Local sync points (verified against current code; simpler than the claude-code
recipe because codex has no flag table):
- `src/shared/types.ts` — `AGENT_OPTIONS.codex.models` (~1560; order = picker
  order, `gpt-5.6-sol` currently first) and
  `MODEL_EFFORT_SUPPORT.codex` (~1449; sol/terra/luna = `["max","xhigh","high","medium","low","none"]`).
- `src/bun/agents.ts` — codex model ids pass through **verbatim** as `--model <id>`; no entry needed.
- `MODEL_MODE_DENY.codex` is `{}` — no entry needed.
- `README.md:238` enumerates the codex model examples.
- Tests: `src/bun/effort-support.test.ts:89-99` — family-effort loop and a
  **picker-order test asserting `ids.slice(0, 3)` = sol/terra/luna, which must
  be updated** when cyber is inserted at position 0; `src/bun/agents.test.ts:478`
  — verbatim `--model` passthrough test pattern.

## 3. Approach & key decisions

- **Position 0, above Sol** — the user's explicit ask ("on top of 5.6 Sol"),
  consistent with Mythos 5's placement on the claude-code list.
- **Hint carries the access gate** ("requires OpenAI Daybreak approval") so
  non-approved users understand why a run would fail; agetor cannot probe access.
- **Effort set mirrors Sol** (`max/xhigh/high/medium/low/none`) — A1. Agetor's
  codex family entries deliberately omit `minimal` (Cursor-only in this repo);
  keep that convention.
- **No DEFAULT_MODEL change**; no MODE_DENY entry; no agents.ts change (verbatim
  passthrough is the tested contract).
- README example list gains Cyber to stay true to the picker.

## 4. Work breakdown — implementation

**IMPL-1**: add the model entry + effort support + README mention.
- Owns: `src/shared/types.ts`, `README.md`.
- Acceptance: `gpt-5.6-cyber` first in `AGENT_OPTIONS.codex.models` with an
  access-gate hint; `MODEL_EFFORT_SUPPORT.codex["gpt-5.6-cyber"]` = Sol's set;
  README line 238 mentions Cyber; nothing else edited.

## 5. Work breakdown — tests

**TEST-1**: extend/update codex model tests.
- Owns: `src/bun/effort-support.test.ts`, `src/bun/agents.test.ts`.
- Acceptance: family-effort loop includes `gpt-5.6-cyber`; picker-order test
  updated to expect cyber at position 0 followed by sol/terra/luna; an
  agents.test.ts verbatim-passthrough test for `gpt-5.6-cyber`.

**E2e: not applicable** — registry addition with no new flow (same rationale as
the prior GPT-5.6 family plan and the Mythos 5 plan).

## 6. Execution waves

Wave 1: IMPL-1 (sonnet) → review (opus) → Wave 2: TEST-1 (sonnet) → run (haiku:
`bun run typecheck` + `bun test`; node_modules already installed).

## 7. Blast radius & risks

- Unknown-id fallback in `supportedEfforts` already resolves to Sol's set, so
  even map drift degrades gracefully.
- Users without Daybreak access selecting Cyber get a codex CLI error at run
  time (same accepted trade-off as Mythos 5; hint mitigates).
- Codex CLI versions predating Cyber will reject the id — same pre-existing
  risk class as the GPT-5.6 family addition.

## 8. Open questions / assumptions (autonomous mode)

- **A1**: Cyber's effort surface = Sol's (`max/xhigh/high/medium/low/none`).
  Official docs don't enumerate Cyber-specific levels; family docs include the
  full range. Fallback behavior makes a mismatch non-breaking.
- **A2**: "on top of 5.6 Sol" = literal picker position 0 (same reading the
  user confirmed implicitly by re-using the phrasing from the Mythos request).
- **A3**: continuing on `feature/add-mythos-5` — this worktree/branch is the
  user's active agetor task; a separate branch would fight agetor's
  worktree-per-task model.

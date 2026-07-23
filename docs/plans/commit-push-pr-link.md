# Plan — PR-open link in the Commit & Push prompt

| Field | Value |
| --- | --- |
| Date | 2026-07-23 |
| Source | /implement conversation ask |
| Config | AGENTS_CONFIG.yml (collapsed — single-file prose change, no fan-out) |
| Branch | feature/add-pr-link-to-commit-and-push-button |
| Base SHA | 4bf523249743f9c02676876eb50988c1864145ee |

> **Autonomous mode:** the grill and plan-approval gates were bypassed (owner not
> present mid-run). Assumptions are logged in §5.

## 1. Objective & success criteria

Extend the "Commit & push" agent instructions so that, after pushing, the agent
also returns the **full link to open a pull request** for the branch — as plain
text (not a code block), placed **above** the existing PR-title and
PR-description fenced blocks. Done when `commitPushPrompt` asks for the link in
that position, tests cover it, and typecheck + the prompt test suite are green.

## 2. Context & constraints

- Single source of truth: `commitPushPrompt(task)` in `src/shared/types.ts:1854`,
  consumed identically by the webview RunPanel chip, CLI `agetor commit`, and the
  TUI `c` key — one edit covers all three surfaces.
- Existing structure (fleet workdone `be6642c1`): commit/push instruction → "PR
  title:" 3-backtick block → "PR description:" 4-backtick block. The 4-backtick
  fence is load-bearing (fleet knowledge `71eec552`) — inner ``` fences would
  otherwise truncate the copy button. Preserve both blocks unchanged.
- RunPanel renders agent markdown with react-markdown + remark-gfm, so a bare
  URL in plain text autolinks (GFM autolink literals) — no fence needed for it
  to be clickable.
- Tests live in `src/shared/branch.test.ts` (`describe("commitPushPrompt")`).
- The chip tooltip at `src/mainview/components/kanban/RunPanel.tsx:1413`
  describes what the prompt asks for; update to mention the link.

## 3. Approach

Insert one sentence into the prompt between "push" and the two-block ask: after
pushing, first print the full URL to open a pull request for the branch — git
prints one in the push output ("Create a pull request…"); otherwise construct it
from the remote URL — as plain text on its own line, not inside a code block.
Update the function's doc comment, the tooltip, and add ordering/plain-text
assertions to the existing test describe.

## 4. Work breakdown

Single wave, single task (inline — no sub-agent): edit `src/shared/types.ts`
(prompt + doc comment), `src/mainview/components/kanban/RunPanel.tsx` (tooltip),
`src/shared/branch.test.ts` (new assertions). Then `bun test src/shared/branch.test.ts`
and `bun run typecheck`.

## 5. Open questions / assumptions

- "Full link to open the PR" = the create-PR URL for the just-pushed branch
  (e.g. `https://github.com/<owner>/<repo>/pull/new/<branch>`), sourced from the
  push output hint or constructed from the remote — the PR doesn't exist yet at
  that point.
- "Above the code blocks" = immediately after the push confirmation, before the
  "PR title:" block.

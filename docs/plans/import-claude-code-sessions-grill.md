# Grill — import Claude Code sessions started outside Agetor

| Field | Value |
| --- | --- |
| Date | 2026-10-16 |
| Source | `docs/plans/import-claude-code-sessions.md` (this worktree), plus the 2026-10-15 grill and investigation in worktree `74d9f0f2-84bf-4823-9972-f6cdfa797665` |
| Mode | interactive; confirmation questions were skipped — proceeding on the assumptions below |
| Flags | none |

D1–D8 from the 2026-10-15 grill stand. They are restated in the plan’s §3. This pass only settles the two points the plan left for approval, plus the defaults that were offered in the same sitting and not overridden.

## Decisions

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| D1–D8 | Scope, liveness, in-place, branch, listing, discovery, history, task shape, missing harness | See the 2026-10-15 grill | Unchanged | owner / owner → delegated / derived |
| G1 | Permission mode | Claude `default`, and a transcript with no permission-mode line, resume as what? | Store `ask`. Resume passes `--permission-mode default`. Do not store `null`. | judgment, after the owner skipped the question. Safer reversible option: `null` resolves through `defaultModeFor("claude-code")` to `auto` (`src/shared/types.ts` modes[0], `types.test.ts`), and `agents.ts` always passes `--permission-mode` on resume. `toClaudeModeString("ask")` is `"default"`. |
| G2 | Long folder path | Encoded name would exceed 200 characters and the hash is still unknown. | The row stays visible and Import is disabled, with a short reason, until `encodeProjectPath` is proven against a real vector. No guessed hash. Other sessions import as planned. Do not hold the feature. | judgment, after the owner skipped the question. Shipping a task whose first message cannot find the transcript would be unfinished. |
| G3 | Caps, toast memory, Send during import, non-goals, subagent status | Lock the plan’s remaining defaults? | Locked. Title cap 200 characters. Stored prompt cap 100 KB; the full text stays in `run_events`. Seen-set is “already toasted”, newest 2,000 ids. Send is refused while `importedClaude.status` is `"importing"` or `"failed"`. Trust-dialog handling, a TUI screen, fork, and worktree import stay out. Subagent rows are inserted as `completed` (`SubagentStatus` in `src/shared/types.ts`). The 2026-10-15 grill’s word “succeeded” is the same idea and is not a status value. | plan §3 / §8, not overridden |

G1 supersedes the literal D7 row `default` → `null`. The other D7 mappings stay: `auto` → `auto`, `bypassPermissions` → `bypass`, `acceptEdits` → `acceptEdits`, `plan` → `plan`. An unrecognized mode string is stored as `ask` as well, same as a missing line.

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| D1–D8 items already in the plan’s §9 | Unchanged | Plan §9 |
| Map Claude `default`, missing, and unknown permission modes to `ask` | In this change | G1. Planning revises the plan’s D7 mode row, §8.1, and the T4 field table. |
| Disable Import when the encoded project dir would exceed 200 characters and the hash is not yet proven | In this change | G2. Planning adds this to the scanner and the dialog. T3 still must not invent a hash. |
| Subagent status `completed` | In this change | G3. Already in the plan; do not revert to “succeeded”. |
| Trust dialog, TUI, fork, worktree import, re-check on every Send | Out of scope | 2026-10-15 grill and plan §9. Not reopened. |

## Assumptions still open

- **G1 can be flipped to `null` / auto** if the owner wants imported sessions to resume hands-off. One mapping. The questions that would have locked this were skipped.
- **G2 can be flipped to “import anyway”** if a long-cwd session should create a task that fails on the first message, which is today’s lookup behavior. The questions were skipped.
- The over-200 hash algorithm is still unknown. T3 derives it from the installed `claude` binary or an existing `projects/` directory before changing `encodeProjectPath`. Until that vector exists, G2 is the user-visible behavior.
- `ai-title`, `permission-mode`, and `continued-in` line shapes stay best-effort (Claude Code 2.1.300–2.1.301). Absent keys use the G1 / title fallbacks.
- `claude agents --json` may stop listing interactive sessions. The registry plus pid / `procStart` remains the fallback, and a failed probe stays `liveness: "unknown"` and cannot be imported.
- A resume in the original cwd is still assumed not to show a trust dialog. If dogfood shows one, that is a follow-up.

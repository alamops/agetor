# Plan — Task details "Agent" row + Harness relabel (webview + CLI)

| Field | Value |
| --- | --- |
| Date | 2026-09-16 |
| Source | `/implement` follow-up to `docs/plans/agent-profiles.md` (conversation) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Flags | none |
| Gates | grilled with owner (5 questions, answered); plan approval pending |
| Branch | `feature/agents-creating-agents` |
| Base SHA | `ff9dc2c` (tree clean) |

## 1. Objective & success criteria

1. RunPanel → Task details: the dropdown currently labeled **Agent** (the harness picker) is relabeled **Harness**. A new **Agent** row sits first in the list and shows the bound profile as a compact clickable chip (icon + name + "(deleted)" marker) or **None**. Clicking the chip opens a modal with the agent's details as the task holds them (snapshot): name, harness, model, effort, mode, fast/max-mode, the full instructions, skills, deleted/live status, and an "Edit in Settings" link when the profile still exists. The Detach button and "Manage agents…" link move into the Agent row; the bound-task hint stays; the header chip stays.
2. CLI vocabulary (owner's final call): **the CLI keeps `agent` = harness and says "profile" for agent profiles.** `--agent <harness id>` on `add`/`edit`/`ls` is unchanged; `agetor add --profile <id|name>` and `agetor edit --detach-profile` are unchanged; the profile subcommand is renamed `agetor profile <ls|show|add|edit|rm>` (alias `profiles`; the `agent`/`agents` spellings are dropped, since "agent" is the harness in the CLI); `agetor ls` gets a separate `profile` column (name or `-`) instead of folding the profile name into the `agent` column; `agetor show` prints `profile: <name> (<id>) [(deleted)]` (was `agent profile:`). The HTTP/JSON field `agent` (harness id) is unchanged and documented in CLAUDE.md as "field `agent` = harness id"; the webview keeps "Agent" (profile) / "Harness" labels. Nothing here has shipped in a release, so no deprecation aliases are needed.
3. Docs (CLAUDE.md item 15 + CLI paragraph, README CLI mentions, plan landed notes) and tests (e2e specs keyed on the "Agent" dt, CLI unit + integration tests) updated; typecheck clean; e2e green.

## 2. Context & constraints

- Task details block: `src/mainview/components/kanban/RunPanel.tsx` ~L6241-6330 — `<dl>` rows `Agent`(harness)/`Mode`/`Model`/`Effort`, the `profileLock` hint (~L6250) and the standalone Detach + "Manage agents…" block (~L6262-6284); `agentProfileDisplay` (from `resolveTaskProfileDisplay`) and `agentProfileForCard` already computed for the header chip (~L3126). `AgentProfileCard` has `chip`/`row`/`selected` variants; `Dialog` primitive in `src/mainview/components/ui/dialog.tsx` (Escape yields to `[data-popover-open]` inside its panel).
- Launch forms already label the profile picker **Agent** and the harness grid **Harness** (`NewTaskForm.tsx:704/751`, `TaskLaunchPickers.tsx:512/546`) — the details section is the odd one out.
- CLI: `src/cli/commands/add.ts` (`--agent` = harness id at `parseAdd`, `--profile` = profile ref, `assertProfileFlagCombo`, wizard "Agent" step = profiles and the harness step), `manage.ts` (`agetor edit --agent`, `--detach-profile`), `ls.ts` (`--agent` filter; agent column shows `profile (harness)`), `show.ts` (`agent`/`model`/`mode` line + `agent profile:` line), `usage.ts` (`add`/`edit`/`ls` blocks), `index.ts` help; tests `src/cli/commands/add.test.ts`, `src/cli/ls.test.ts`, `src/cli/show.test.ts`, `src/cli/manage.test.ts`, `src/cli/agent-profile-daemon.test.ts`.
- e2e: `detailsRow(panel, "Agent")` in `e2e/agent-profiles.spec.ts:448/455` and `e2e/agent-profiles-launch.spec.ts:573-582` targets the harness select and must become `"Harness"`; new assertions for the Agent row, modal, Detach/Manage placement.
- Docs: CLAUDE.md item 15 ("CLI parity" paragraph names `--agent` as the harness flag and `--profile`), README CLI snippets (grep `--agent`).

## 3. Approach & key decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 | Agent row = `AgentProfileCard variant="chip"` wrapped in a `<button data-testid="task-agent-profile-open">`; "None" (`task-agent-profile-none`) when unbound. | Owner: compact chip in the row; details behind a click. |
| D2 | New `AgentProfileDetailsDialog` (`src/mainview/components/kanban/AgentProfileDetailsDialog.tsx`, `Dialog` primitive, `data-testid="agent-profile-details-dialog"`): shows the task's **snapshot** values (what the task runs with), a status line ("Frozen since first run" when `runs`/`hasOpenableRun` indicate a run exists, "Follows the live agent until the first run" otherwise, "(deleted)" when the live list lacks it), instructions in a scrollable `whitespace-pre-wrap` block, skills as chips, and an "Edit in Settings" button (`onOpenSettingsAgents`) when not deleted. | Snapshot is the truth for a task; live values are one click away in Settings. |
| D3 | Detach + "Manage agents…" render inline in the Agent row's `<dd>` (after the chip), only when bound; the standalone block is removed. Hint text unchanged. | Owner Q3. |
| D4 | CLI keeps `--agent` = harness id everywhere; profiles are "profile" in the CLI: subcommand `agetor profile` (alias `profiles`), flags `--profile` / `--detach-profile` unchanged. | Owner's final answer: CLI vocabulary stays agent=harness; only the profile subcommand name and output labels move to "profile". |
| D5 | `ls` table: `agent` column stays the harness id; a new `profile` column (name or `-`); `show`: `profile: <name> (<id>) [(deleted)]` replaces `agent profile:`; `--json` shapes unchanged. | Consistent CLI vocabulary; JSON is the contract. |
| D6 | Header chip stays; board card unchanged. | Owner Q4. |

## 4. Work breakdown — implementation tasks (one wave, disjoint)

- **T1 — webview.** Owns `src/mainview/components/kanban/RunPanel.tsx`, new `src/mainview/components/kanban/AgentProfileDetailsDialog.tsx`. Relabel the dt to "Harness"; add the Agent row first (D1/D3); wire the dialog (D2) with `open` state in `TaskDetails`; keep test ids `task-agent-profile-hint`/`task-agent-profile-detach`; add `task-agent-profile-open`, `task-agent-profile-none`, `task-agent-profile-manage`, `agent-profile-details-dialog` (+ `-edit`, `-close`).
- **T2 — CLI.** Owns `src/cli/index.ts` (dispatch `profile`/`profiles` → `cmdAgentProfile`; drop `agent`/`agents`; help line), `src/cli/usage.ts` (rename the `agent`, `agent add`, `agent edit` usage keys/text to `profile …`; `add`/`edit` blocks already say `--profile`), `src/cli/commands/agent-profile.ts` (usage-error keys + success/error copy say "profile"), `ls.ts` (separate `profile` column), `show.ts` (`profile:` line), and tests `src/cli/ls.test.ts`, `src/cli/show.test.ts`, `src/cli/commands/agent-profile.test.ts`, `src/cli/agent-profile-daemon.test.ts`, `src/cli/usage.test.ts` if it enumerates keys. `add.ts`/`manage.ts` flags are unchanged (verify only).
- **T3 — docs.** Owns `CLAUDE.md`, `README.md`, this plan's §10. Owner-requested, explicit: (a) CLAUDE.md item 15 gains a leading **Vocabulary** paragraph recording the decision and its rationale — *UI:* "Agent" = agent profile, "Harness" = the CLI (New Task form, launch dialogs, Settings, Task details); *CLI:* `agent`/`--agent` = harness id (unchanged, matches the API), "profile"/`--profile`/`agetor profile …` = agent profile; *API + DB:* the `agent` field/column on tasks and runs is the **harness id** (legacy name kept on purpose — renaming it would touch ~118 files/550 references, a column migration and every JSON consumer for no functional gain); plus the item-15 "CLI parity" paragraph rewritten for `agetor profile …`, the `ls` `profile` column and the `show` `profile:` line, and the Task-details Agent row/modal + Harness relabel. (b) README: the Agents highlight bullet is expanded into a short **Agents** section (what a profile is, where to create one, picking it on launch, freeze-at-first-run in one sentence, the Task-details Agent row/modal) and the CLI section gains `agetor profile ls|show|add|edit|rm`, `agetor add --profile <id|name>`, `agetor edit --detach-profile`, with a one-line vocabulary note (`--agent` is the harness).

## 5. Test tasks

- **TT1 (e2e).** Owns `e2e/agent-profiles.spec.ts`, `e2e/agent-profiles-launch.spec.ts`: rename the dt lookups to "Harness"; assert the Agent row chip/None, the modal contents (name, harness, model, instructions, skills, status line, Edit-in-Settings deep link), Detach + Manage inside the row, and the None state after detach. Run recipe unchanged (`bun node_modules/@playwright/test/cli.js test <specs> --workers=1` on this loaded machine).
- CLI tests ride with T2.

## 6. Waves

1. T1 ∥ T2 ∥ T3 → typecheck + `bun test src/cli/commands/add.test.ts src/cli/ls.test.ts src/cli/show.test.ts src/cli/manage.test.ts src/cli/agent-profile-daemon.test.ts` + `bun test src/mainview`.
2. Review (opus, `code-review` skill) ∥ TT1.
3. Run: the two e2e specs (`--workers=1`), CLI suites; fixes if needed.

## 7. Blast radius & risks

- `agetor agent …` → `agetor profile …` is a subcommand rename on an unreleased branch; no deprecation alias needed (D4).
- RunPanel `editable` gating and `save()` PATCH paths untouched; only labels/rows change.
- e2e specs that key on the "Agent" dt would silently target the new row — TT1 updates them in the same commit.

## 8. Open questions / assumptions

- A1: the modal shows snapshot values, not live (D2); "Edit in Settings" is the path to live values.
- A2: `--profile` and `--detach-profile` stay as aliases indefinitely (cheap, no ambiguity).

## 9. Completeness ledger

| Remainder | Disposition |
| --- | --- |
| e2e specs keyed on the old "Agent" dt | in this run — TT1 |
| CLI tests referencing the `agent` subcommand / `agent profile:` line | in this run — T2 |
| README + CLAUDE.md CLI wording | in this run — T3 |
| `agetor harness` subcommand naming | unchanged — already "harness" |
| HTTP/JSON field `agent` | out of scope — owner: keep as the legacy name, documented in CLAUDE.md as "field `agent` = harness id" (T3) |
| Board card wording | unchanged — owner Q5/Q4 |

## 10. Landed notes

Delivered on `feature/agents-creating-agents`: `5a3bd3c` plan · `3980a01` wave 1 (webview row + `AgentProfileDetailsDialog`, CLI `agetor profile` vocabulary, CLAUDE.md vocabulary paragraph + README Agents section) · the following commit: review fixes + e2e updates.

**Review (Opus, `code-review` skill):** 0 critical · 1 major · 3 medium · 5 minor · 2 nits — all addressed: the Agent row's action cluster is gated on `profileLock || agentProfileDisplay` so Detach can never vanish while the lock holds (an unreadable snapshot now shows an "Unknown agent" marker, `task-agent-profile-unknown`, and a name-less hint); the details dialog is portaled to `document.body` (RunPanel's `<aside>` transform rebases `position: fixed` — `MdImage` precedent, not `PlanDialog`); the status line has a third "Frozen — the agent it was created from no longer exists." state; the chip button uses `aria-label`/`aria-expanded`; `asProfileError` moved to `src/shared/agent-profile.ts` and applied at both `agetor add --profile` throw sites; the wizard's profile step is labeled "Profile"; `agetor edit` rewords the server's `bound to agent` 409 to `bound to profile … (agetor edit <id> --detach-profile)` at the CLI boundary; stale `agetor agent` comments fixed; weak `ls`/daemon assertions tightened.

**Tests:** typecheck clean; 2094 unit/integration tests pass (mainview, shared, CLI, bun agent-profile suites); all five agent-profile e2e specs 33/33 with `--workers=1`. Test ids: `task-agent-profile-open/none/unknown/detach/manage`, `agent-profile-details-dialog/-status/-deleted/-edit/-close`.

**Ledger:** every in-run row landed; HTTP/JSON `agent` field kept as the harness id (documented in CLAUDE.md item 15's Vocabulary paragraph); board card unchanged.

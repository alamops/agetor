# Plan — Move "Resolve Conflicts" to the composer action-chip row

| Field | Value |
| --- | --- |
| Date | 2026-08-03 |
| Source | /implement request (conversation) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/move-resolve-conflicts-button-to-message |
| Base SHA | 0a7cf7697cc13cb0092b31469ff4cf177887bab1 |
| Mode | Autonomous — grill gate and plan-approval gate bypassed (owner not present); assumptions logged in §8 |

## 1. Objective & success criteria

Relocate the "Resolve Conflicts" button in Task Details (RunPanel) from the modal header's action cluster to the action-chip row that sits directly above the message textarea — the same row that hosts "Save for later", "Commit & push", and "Open PR". Behavior (gating, prompt, toasts, "Sent to agent" feedback) is unchanged; only placement and chip styling change.

Success: button renders next to Commit & push above the composer, no longer in the header; all existing gates preserved; typecheck + `bun test` green.

## 2. Context & constraints

- Header instance today: `RunPanel.tsx:2297-2323` — gated on `!archived && activeStream === "main" && canOfferResolveConflicts(parsedPrUrl, prStatus)`, disabled on `!canSend || modalPending || sending || backlogBusy || resolvingConflicts || resolveConflictsSent`, `variant="outline"`, `GitMerge` icon, label flips to "Sent to agent" for 5s after send.
- Target row: `RunPanel.tsx:2669-2745`, rendered when `(canSend || input.trim() || sendRefs.length > 0)`; right-side group holds Save for later (ghost), Commit & push (secondary), Open PR (secondary).
- `canSend = !!resumableRunId` (`:1475`). `canOfferResolveConflicts` requires a parsed PR URL + fetched mergeability with conflicts — a PR implies prior runs, so the row's `canSend` gate cannot realistically hide an offerable button. The `!canSend` disabled-branch is kept as a belt-and-braces guard.
- The header keeps the PR mergeability re-check (`RefreshCw`) button and "View PR" link — only Resolve Conflicts moves.
- Comment at `:1765` ("PR mergeability for the header \"Resolve Conflicts\" button") must be updated to point at the composer row.

## 3. Approach & key decisions

Cut the button JSX (with its gating comment) from the header cluster and re-insert it in the right-side chip group, after "Open PR" (they're near-mutually-exclusive: Open PR shows pre-PR, Resolve Conflicts post-PR-with-conflicts). Switch `variant="outline"` → `variant="secondary"` to match its new siblings. Keep the full disabled expression and title ladder verbatim. Alternative considered: hide-on-`sending` like Commit & push — rejected; the disabled ladder carries the "Sent to agent" cooldown state that hiding would lose.

## 4. Work breakdown — implementation

- **T1** (sonnet, wave 1): move the button block in `src/mainview/components/kanban/RunPanel.tsx` as per §3; update the `:1765` comment. Owns only this file. Acceptance: button gone from header, present after Open PR in chip row, gates/disabled/title/label logic byte-identical apart from variant.

## 5. Work breakdown — tests

None. Pure JSX relocation; gating helpers (`canOfferResolveConflicts`, `buildResolveConflictsPrompt`) are untouched and already covered by `pr-url.test.ts` / `resolve-conflicts-prompt.test.ts`. Existing suite runs in Phase 7.

## 6. Execution waves

Wave 1: T1. Then review (opus), then typecheck + `bun test` (haiku).

## 7. Blast radius & risks

Single component. Risk: the chip row doesn't render for `!canSend && no draft` — accepted per §2 (unreachable when the button is offerable). Archived tasks: row renders (Send is offered) but the button keeps its own `!archived` gate, matching prior behavior.

## 8. Open questions / assumptions

- Assumed placement after "Open PR" in the right-side group (user said "like the Commit and push one" — exact ordering unspecified).
- Assumed `secondary` variant to match row siblings rather than keeping header `outline`.
- Assumed the header's mergeability re-check icon button stays in the header (user asked only about Resolve Conflicts).

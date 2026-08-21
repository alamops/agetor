# Plan — Remove "Files mentioned" section from task details

| Field | Value |
| --- | --- |
| Date | 2026-08-20 |
| Source | /implement invocation: "remove files mentioned section from task details. that's not getting the correct reference to the files and it's kinda being useless" |
| Config | AGENTS_CONFIG.yml (balanced, v1 schema) |
| Flags | none |
| Branch | feature/remove-files-mentioned |
| Base SHA | 8a7e4b066f7eeb89856365acd86704a396ad4b8d |
| Mode | Autonomous — grill (Phase 2) and plan approval (Phase 3) self-resolved; assumptions logged in §8 |

## 1. Objective & success criteria

Remove the "Files mentioned" collapsible chip row from the RunPanel task-details area, together with its now-dead heuristic path-harvesting code. Success: the section no longer renders, no dead code remains, `bun run typecheck` and `bun test` stay green.

## 2. Context & constraints

The feature is fully self-contained in `src/mainview/components/kanban/RunPanel.tsx`:

- Render site: `<FileMentions task={task} events={events} />` (RunPanel.tsx:2555), between the log-search bar and `<TaskDetails …>`.
- Component `FileMentions` (RunPanel.tsx:3604–3633): a `<details>` chip row; each chip calls `api.openPath`.
- Harvester block (RunPanel.tsx:~3315–3377): doc comment, `FILE_EXTENSIONS`, `ABS_PATH_RE`, `REL_PATH_RE`, `isInternalPath` (+ its comment), `extractFileMentions`, and a local `basename` helper — **all referenced only by `FileMentions`** (verified by grep; the `basename` used by ProjectPicker/KanbanFilters/WorktreesDialog is a different function in those files' scope, and RunPanel's local `basename` has exactly one call site, inside `FileMentions`).
- Must **not** be removed: the `FileText` lucide import (also used by the tool-icon map at RunPanel.tsx:4886) and `api.openPath` (used at RunPanel.tsx:2443 and 5228, plus AttachmentChips.tsx).
- No test file references `FileMentions` / `extractFileMentions` / "Files mentioned".

## 3. Approach & key decisions

Straight deletion (no feature flag, no "improve the heuristic" alternative): the user's stated reason is that the heuristic resolves wrong references and adds no value. Removing dead helpers along with the render site keeps the file clean; leaving them would trip future readers and the `simplify`/review passes. Decision rests on grep evidence, not assumption.

## 4. Work breakdown — implementation tasks

- **T1** — Remove the FileMentions feature. Owns `src/mainview/components/kanban/RunPanel.tsx` only. Delete: (a) the render line at 2555, (b) the harvester block (~3315–3377, including its doc comments), (c) the `FileMentions` component (~3604–3633). Keep `FileText` import and all `api.openPath` usages outside the deleted component. Acceptance: no remaining references to any deleted symbol; typecheck green.

## 5. Work breakdown — test tasks

- None to create: the feature had zero test coverage, and a pure removal leaves nothing new to test. **E2e: not applicable** — a Playwright harness does exist (`playwright.config.ts`, `e2e/*.spec.ts`), but no spec references the "Files mentioned" chip row and a pure deletion adds no new browser-observable behavior to assert.
- Verification: run `bun run typecheck` and `bun test` (full suite).

## 6. Execution waves

- Wave 1: T1 (single agent). Then review → test run.

## 7. Blast radius & risks

Minimal. The section rendered between the search bar and TaskDetails; removing it only collapses that strip. Risk to watch: over-deletion (the `FileText` import or a shared helper) — guarded by the explicit keep-list and typecheck.

## 8. Open questions / assumptions

- Assumed "task details" refers to this RunPanel "Files mentioned" chip row (the only UI with that label in the codebase) — grep confirms no other candidate.
- Assumed `api.openPath` server route stays (other consumers exist).

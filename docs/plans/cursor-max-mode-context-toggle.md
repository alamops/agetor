# Plan - Cursor Max Mode Context Toggle
| Field | Value |
| --- | --- |
| Date | 2026-08-07 |
| Source | `/implement` follow-up: fix Cursor Max Mode after web/docs confirmation |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/fix-cursor-max-mode |
| Base SHA | 7a50d75ccb2aa8232a50c2b8f06262c3311bdc15 |

## 1. Objective & success criteria
Correct the Cursor harness `Max` toggle so it represents Cursor Max Mode / large-context selection, not reasoning effort `max`. Users should see a separate Cursor-only `Max Mode` toggle where the selected Cursor model supports it, and task launches should translate that toggle into a `cursor-agent --model` context override.

## 2. Context & constraints
- Cursor docs describe Max Mode as extended context / max context, separate from reasoning effort.
- `cursor-agent --help` confirms parameterized model overrides such as `context=1m`, `effort=high`, and `fast=false`.
- The merged implementation already persists `fast` and composes Cursor model variants from `src/shared/types.ts`.
- Existing `effort=max` values must remain valid because Cursor and other harnesses still expose max reasoning/thinking variants.

## 3. Approach & key decisions
- Add a separate `Task.maxMode` boolean persisted as `tasks.max_mode`.
- Add Cursor metadata for whether a base model supports Max Mode.
- Replace the UI's current effort-driven `Max` switch with a Cursor harness-level `Max Mode` switch.
- Keep `Fast` as an independent toggle.
- Compose Cursor known model launches with a `context=1m` parameter when `maxMode` is enabled; keep unknown model ids pass-through.
- Rename the generic effort label from `Max` to `Max thinking` so the two controls are not visually conflated.

## 4. Work breakdown - implementation tasks
- T1 shared model/task metadata: `src/shared/types.ts`.
- T2 command translation: `src/bun/agents.ts`.
- T3 persistence/API/CLI: migration, DB, orchestrator, server, client and CLI types/flags.
- T4 UI controls: `NewTaskForm.tsx`, `RunPanel.tsx`.

## 5. Work breakdown - test tasks
- Update Cursor model helper tests for max-mode support and `context=1m` command output.
- Update Cursor command tests for `maxMode` and `fast` composition.
- Update task fixtures for the new `maxMode` field.
- Run focused Cursor/migration tests, then the backend suite if feasible.
- E2E is not applicable for this correction; the critical behavior is option persistence and command argument generation.

## 6. Execution waves
- Wave 1: shared type + command + persistence + UI edits in one local pass because the contracts are tightly coupled.
- Wave 2: test updates and fixes.

## 7. Blast radius & risks
- Existing tasks default `maxMode` to false.
- Non-Cursor harnesses ignore `maxMode`.
- Cursor CLI support for `context=1m` is documented in current local help; if Cursor changes this parameter, the blast radius is isolated to `cursorModelArg`.

## 8. Open questions / assumptions
- Assumption: `context=1m` is the correct headless representation for Cursor Max Mode / large context in the current CLI.
- Assumption: Auto should not expose Max Mode unless Cursor exposes an explicit parameterized Auto contract later.

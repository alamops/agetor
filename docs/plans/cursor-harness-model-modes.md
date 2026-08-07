# Plan - Cursor Harness Model Modes
| Field | Value |
| --- | --- |
| Date | 2026-08-07 |
| Source | `/implement` request with Cursor model picker screenshots |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/include-all-available-cursor-models |
| Base SHA | 4b9328f |

## 1. Objective & success criteria
Expose the full Cursor model/mode surface shown in the screenshots, keep Cursor's `Auto` model as the default, and add UI controls for Cursor `Max` and `Fast` where supported. A created or edited Cursor task must launch `cursor-agent` with the correct model variant.

## 2. Context & constraints
- Shared model/mode/effort metadata lives in `src/shared/types.ts`.
- Cursor command construction is in `src/bun/agents.ts`.
- New-task and task-detail selectors already derive effort options from `supportedEfforts`.
- Local `cursor-agent --help` confirms parameterized model overrides and `--list-models` exposes concrete `*-fast`, `*-max`, `*-xhigh`, etc. model ids.
- `Fast` needs persistence; otherwise edited tasks and restarts lose the toggle.

## 3. Approach & key decisions
- Add a backwards-compatible `tasks.fast` boolean column, ignored by non-Cursor harnesses.
- Keep permission `mode` separate from model thinking mode.
- Use `effort` for Cursor thinking level, including `max`, `none`, and `minimal` where supported.
- Translate `(model, effort, fast)` to the concrete Cursor `--model` id in `buildCommand`.
- Add Cursor-only `Max` and `Fast` switches in the new-task form and task details, while retaining the effort select for non-Max levels.

## 4. Work breakdown - implementation tasks
- T1: Shared types and metadata: `src/shared/types.ts`.
- T2: Persistence/API plumbing: migrations, `src/bun/db.ts`, `src/bun/orchestrator.ts`, `src/bun/server.ts`, client API types.
- T3: Cursor argv translation: `src/bun/agents.ts`.
- T4: UI controls: `src/mainview/components/kanban/NewTaskForm.tsx`, `src/mainview/components/kanban/RunPanel.tsx`.

## 5. Work breakdown - test tasks
- Update `src/bun/effort-support.test.ts` for Cursor effort/fast support.
- Update `src/bun/agents.test.ts` for Cursor model composition and `fast`.
- Run focused Bun tests plus typecheck. E2E is not applicable; this is local option mapping and command construction, with no existing browser e2e harness for this narrow control change.

## 6. Execution waves
- Wave 1: implement shared metadata, persistence, command translation, and UI in one local pass because the files are tightly coupled.
- Wave 2: tests and fixes.

## 7. Blast radius & risks
- Existing tasks default `fast` to false.
- Unknown/discovered Cursor model ids pass through unchanged.
- API callers can omit `fast`; server defaults it to false.

## 8. Open questions / assumptions
- Assumption: "modes" in the screenshots means Cursor model/thinking variants, not Agetor permission modes.
- Assumption: `Fast` is a Cursor-only model variant toggle and should not affect Claude/Codex.

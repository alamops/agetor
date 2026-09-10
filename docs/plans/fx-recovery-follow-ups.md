# Plan — fx recovery follow-ups: paused badge, Gateway links, auto-resume, null mode → Full access

| Field | Value |
| --- | --- |
| Date | 2026-09-09 |
| Source | owner: "/implement them" on the four out-of-scope rows of `docs/plans/fix-fx-harness-rate-limit.md` §9 |
| Config | AGENTS_CONFIG.yml (balanced) |
| Flags | none |
| Gates | grilled + approved by owner |
| Branch | fix/fix-fx-harness |
| Base SHA | 4e2fa95 (wave 3 of the rate-limit plan) |

## 1. Objective & success criteria

Finish the fx rate-limit story on the board and in the daemon:
1. **Paused badge.** A kanban card whose fx task's latest run ended paused (resumable) shows a badge — and a countdown when an auto-resume is scheduled — driven by a server-managed `Task.fxRecovery` field; the card context menu offers "Resume paused response" / "Cancel auto-resume"; the TUI list row and `agetor ls` show the same state.
2. **Clickable Gateway link.** URLs inside fx's recovery message open in the system browser from the live/paused notices and from the persisted paused/recovered status lines.
3. **Auto-resume.** After an fx run settles paused on a rate limit, Agetor schedules `resumeFxRecovery` itself: on by default, delay from preference `fxAutoResumeDelaySec` (default 120 s), at most `FX_AUTO_RESUME_MAX = 3` per pause chain, persisted on the task so a restart re-arms it, cancellable from the notice, the context menu, `agetor resume <id> --cancel`, and implicitly by a new message, a manual Resume, Stop, archive, delete or an agent switch. Settings → General exposes the toggle and the delay; `agetor config` already round-trips the keys.
4. **Null mode → Full access.** A stored `null` fx mode spawns as `yolo` (the kind's `modes[0]`) through one shared `defaultModeFor(kind)`; the Task Details dropdown shows the same value; docs and tests follow.

Done when: unit/db/orchestrator/CLI tests are green, `e2e/fx-recovery.spec.ts` (extended) drives badge → countdown → auto-resume → recovered, cancel, context-menu, link click, settings toggle, and null-mode display; a live smoke on the owner's account shows one automatic resume recovering.

## 2. Context & constraints (Phase 1 evidence)

- Card badges: one flex cluster in `TaskCard.tsx:138-193` (todo badge 163-177, paperclip 178-192 with `data-testid="sent-files-badge"`); `TaskCard` is `memo` with the default shallow comparator and `reconcileById` (`src/mainview/lib/reconcile.ts:34-66`) diffs the whole task JSON, so a new `Task` field re-renders the card with **no prop threading** in `Column`/`App`. `TaskCard` has no `harnesses` prop → gate on the server field, never on `task.agent`.
- Server-managed fields: `todo_progress` (044) rides the generic `tasks.update`; `sent_files` (050) uses a targeted UPDATE that skips `updated_at` and is excluded from the generic SET (`db.ts:444-452`, `mergeSentFiles` `db.ts:556-580`). Latest migration is `050_sent_files` → next is **051**. `ALLOWED_PATCH_FIELDS` at `server.ts:375-377`. Memo-stability rule (fleet entry 85ffd1d4): server-managed writes must not bump `updated_at` on hot paths; optimistic UI merges only the owned field.
- Settlement hook: `attachDoneHandler` (`orchestrator.ts:1776-1940`; `.then` 1794, `.catch` 1905) computes `newStatus`/column then always `drainFxQueue`. A paused fx turn settles `failed` → `ready`. By then every `fx-recovery:` sentinel is persisted, so `resumeFxRecovery`'s own gate (`orchestrator.ts:3536-3549`: latest run failed, last sentinel `isFxRecoveryResumable`, prior `fx_session_id`) is the single source of truth to mirror.
- Cancel seams (the four places `fxTurnQueue` is cleared): `sendFxTurn` 3274-3298, `reconcileTaskSession` 1984, `archiveTask` 4671, `deleteTask` 4748; plus `resumeFxRecovery` (manual) and `startTask`/`spawnFxRun`'s `startingTaskIds` claim (3350). `cancelRun` (2506-2523) does not reach a paused task today (no `active` handle) — new path needed.
- Boot: `reconcileOrphans` sees only `status='running'` rows; a re-arm step belongs right after it in `index.ts:133` and `headless.ts:126`, before `startApiServer`. Timer hygiene (fleet entry 83006209): `.unref()` every timer, identity-check handles, never enumerate foreign state.
- Double-resume race: the route's `fxResumesInFlight` claim lives in `server.ts:462-469`; an orchestrator-side timer bypasses it → move the synchronous claim into `resumeFxRecovery`.
- Preferences: opaque k/v (`db.ts:748-770`, routes `server.ts:2759-2771`, `api.listPreferences/setPreference` `api.ts:1154-1159`), read once in `App.tsx:276-295`; Settings toggle precedent = "Sticky user messages" `Switch` in `SettingsDialog.tsx:742-757` with the constant in its own lib file; `agetor config <key> [value]` is generic (`src/cli/commands/config.ts`).
- Global events: union `types.ts:3255-3321` (`files-sent` is the live-only precedent), `emitGlobal` `orchestrator.ts:364`, handler switch `App.tsx:756-883` — a new kind must return before the `column` fallthrough.
- External links: `ExternalLink` (`md-components.tsx:26-48`) = `preventDefault` + `api.openExternal(url)`; `POST /open-external` (`server.ts:4046-4064`) answers **501** headless; no linkify helper exists. Notices: `RecoveryNotice` `RunPanel.tsx:4757-4768` (`title={text}`, `truncate`), `PausedRecoveryNotice` 4789-4816.
- Mode default seams: `buildCommand` fx `agents.ts:707-708`, fake path 1788, ACP spawn 1802; `createTask` stores `input.mode ?? null` (`orchestrator.ts:4418`); `nullModeFallback` `RunPanel.tsx:5985-6003`; `reconcileTaskSession` 1992 / `add.ts:338-340` / RunPanel `onAgentChange` 5967 already use `modes[0]`. Tests pinning null→auto: `agents.test.ts:1442-1445, 1076-1079, 1124-1127`. Docs: CLAUDE.md fx bullet + the "Defaults preserve hands-off behavior" paragraph (~lines 159-165).
- TUI list row `Dashboard.tsx:428-457` and `ls.ts:83-107` are `Task`-only (no events) — the new field is what makes a row hint possible; the detail-pane hint (`Dashboard.tsx:490-500`) can read the field instead of rescanning events.
- Live facts (smoke 2): after a 100 s wait a resume still absorbed 7 more 429s before recovering on attempt 8/10 — hence the 120 s default and the cap.

## 3. Approach & key decisions

1. **One field, one lifecycle.** `Task.fxRecovery` (JSON column `tasks.fx_recovery`, migration 051, written only by `tasks.setFxRecovery` — targeted UPDATE, no `updated_at` bump, excluded from the generic SET, not patchable) holds the paused state AND the auto-resume schedule/counter, so badge, menu, TUI, `ls`, the notice countdown and boot re-arm all read one source that mirrors `resumeFxRecovery`'s gate. Set at settlement of a failed run whose last sentinel is resumable; kept (with `autoResume: null`) while a continue-recovery run is in flight; cleared to `null` when a NORMAL turn starts (`spawnFxRun({line})`, `startTask`), when a run settles without a resumable pause, and on archive/delete/agent switch. The per-chain counter lives on the field, so a pause → auto-resume → pause again chain counts up until the cap, and a recovery resets it by clearing the row.
2. **Auto-resume engine in the orchestrator**, mirroring the turn-queue maps: `fxAutoResumeTimers: Map<taskId, Timer>` (unref'd, identity-checked), `scheduleFxAutoResume`, `fireFxAutoResume` (re-validates the persisted `at` before acting), `cancelFxAutoResume(taskId, reason)`, `rearmFxAutoResumes()` at boot (past-due entries fire after a 5 s stagger). Preference read at schedule time via `parseFxAutoResumePrefs(preferences.list())`; test seam `AGETOR_FX_AUTO_RESUME_DELAY_MS` overrides the delay. `resumeFxRecovery` gains `{ origin: "manual" | "auto" }` and owns the synchronous in-flight claim (`resumingTaskIds`), so the route and the timer can't double-spawn; the route drops its private set.
3. **Everything visible is also persisted as a plain status line** on the paused run (`auto-resume scheduled in 120 s (1/3)`, `auto-resume cancelled`, `auto-resume gave up after 3 attempts — resume manually once the limit clears`) and the resume run's opening status says `auto-resuming paused fx response (2/3) in session …`; a `GlobalEvent` `fx-auto-resume` (`scheduled|fired|cancelled|exhausted|disabled`) drives toasts (fired → info, exhausted → error). No OS notification (out of scope).
4. **Cancel everywhere**: notice button, context-menu entry, `agetor resume <id> --cancel` → `DELETE /tasks/:id/fx-auto-resume`; implicit cancel on message/manual Resume/Stop/archive/delete/agent switch. Stop on a paused task with a pending timer becomes a real path: `cancelRun` cancels the timer when the task has no active run.
5. **Linkify by splitting, not markdown**: `src/mainview/lib/linkify.tsx` `renderLinkified(text)` splits on `https?://` runs (trailing `.,;:!?)]}'"` stripped back into text) and wraps each in `ExternalLink`; used by both notices (keep `title={text}` plain) and by RunPanel's plain `status` line renderer. CLI/TUI need nothing (terminals linkify).
6. **`defaultModeFor(kind)` = `AGENT_OPTIONS[kind].modes[0]?.id ?? "auto"`** in `src/shared/types.ts`, used by every spawn branch in `buildCommand`/`spawnAgent` (only fx changes behavior: `yolo`), by `reconcileTaskSession`, `add.ts`, RunPanel's `onAgentChange` and `nullModeFallback` (which becomes `defaultModeFor(kind)` again). `createTask` keeps storing `null` (resolution is at spawn and display). This reverses the earlier "no silent escalation" decision at the owner's explicit request.

### Shared spec (binding)

```ts
// src/shared/types.ts — additive
export interface TaskFxRecovery {
  state: "paused";                 // the only stored state; null row otherwise
  runId: string;                   // the failed run whose last sentinel paused
  pausedAt: number;                // ms epoch
  cause?: string; attempt?: number; attemptLimit?: number; message?: string; // copied from that sentinel
  autoResume: { at: number; attempt: number; max: number; delaySec: number } | null; // pending timer, else null
  autoResumeCount: number;         // auto-resumes already fired in this pause chain
  autoResumeStopped?: "exhausted" | "cancelled" | "disabled"; // why no timer is pending (undefined while one is)
}
// Task.fxRecovery?: TaskFxRecovery | null   (server-managed; NOT in ALLOWED_PATCH_FIELDS)
export const FX_AUTO_RESUME_PREF = "fxAutoResume";              // "on" | "off"; missing → on
export const FX_AUTO_RESUME_DELAY_PREF = "fxAutoResumeDelaySec"; // integer seconds; missing/invalid → 120; clamp 10..3600
export const FX_AUTO_RESUME_DEFAULT_DELAY_SEC = 120;
export const FX_AUTO_RESUME_MAX = 3;
export type GlobalEvent = … | { kind: "fx-auto-resume"; taskId: string; state: "scheduled" | "fired" | "cancelled" | "exhausted" | "disabled"; at?: number; attempt: number; max: number; ts: number };
export function defaultModeFor(kind: AgentKind): string;        // AGENT_OPTIONS[kind].modes[0]?.id ?? "auto"

// src/shared/fx-recovery.ts — additive, pure
parseTaskFxRecovery(json: string | null): TaskFxRecovery | null;   // tolerant: state must be "paused", runId string, pausedAt finite; autoResume kept only when at/attempt/max/delaySec are finite; autoResumeCount defaults 0
parseFxAutoResumePrefs(prefs: Record<string, string>): { enabled: boolean; delaySec: number };
fxAutoResumeCountdownText(at: number, now: number): string;        // "1:58" / "0:07" / "now"
isTaskFxPaused(task: Pick<Task, "fxRecovery" | "column">): boolean; // state === "paused" && column !== "running"

// DB (db.ts): TaskRow.fx_recovery; parse via parseTaskFxRecovery; toTask → fxRecovery; NOT in insert/update SET;
//   tasks.setFxRecovery(taskId, value: TaskFxRecovery | null) — `UPDATE tasks SET fx_recovery = ? WHERE id = ?`, no updated_at;
//   tasks.listFxAutoResumePending(): Array<{ id, fxRecovery }> — rows whose JSON has autoResume.at (boot re-arm).
// Orchestrator: export function cancelFxAutoResume(taskId, reason: "cancelled"|"message"|"stopped"|"switched"|"archived"|"deleted"): boolean
//   export async function rearmFxAutoResumes(): Promise<number>; resumeFxRecovery(taskId, opts?: { origin?: "manual" | "auto" })
// Routes: DELETE /tasks/:id/fx-auto-resume → 200 {ok:true} | 404 | 400 {error:"no auto-resume pending"}; POST /tasks/:id/fx-resume unchanged (cancels a pending timer first)
// Clients: api.cancelFxAutoResume(taskId); AgetorClient.cancelFxAutoResume(taskId); CLI `agetor resume <id> --cancel`
// Test seams: env AGETOR_FX_AUTO_RESUME_DELAY_MS (overrides delay, min 0); fake fx driver `FAKE_FX_REPAUSE_PROMPT_MARKER = "__agetor_fake_fx_repause__"` / AGETOR_FAKE_FX_REPAUSE=1 → a continueRecovery launch ALSO storms and pauses (attempt 3/3) instead of recovering, so the cap is testable.
// Test ids: fx-paused-badge (card), fx-recovery-cancel-auto (notice button), fx-recovery-countdown (notice text), settings-fx-auto-resume (switch), settings-fx-auto-resume-delay (input); context-menu actions "resume-recovery", "cancel-auto-resume".
// Status lines (persisted on the paused run): `auto-resume scheduled in <n> s (<k>/<max>)`, `auto-resume cancelled`, `auto-resume disabled in Settings — resume manually`, `auto-resume gave up after <max> attempts — resume manually once the limit clears`; on the resume run: `auto-resuming paused fx response (<k>/<max>) in session <id8>…`.
```

## 4. Work breakdown — implementation tasks

**Wave 1**
- **T1 — Shared contract + DB.** Files: `src/shared/types.ts`, `src/shared/fx-recovery.ts`, `src/bun/db.ts`, `src/bun/migrations/051_fx_recovery.sql` (new), `src/bun/migrations/index.ts`. Everything in the spec above; `defaultModeFor`; docs on `Task.fxRecovery` mirroring `sentFiles`'s doc; the generic SET-clause exclusion comment extended. Acceptance: typecheck; `bun test src/shared src/bun/migrate.test.ts src/bun/db-*.test.ts` green.

**Wave 2** (file-disjoint)
- **T2 — Auto-resume engine + routes + boot.** Files: `src/bun/orchestrator.ts`, `src/bun/server.ts`, `src/bun/index.ts`, `src/bun/headless.ts`. Settlement hook in both `attachDoneHandler` branches (before `drainFxQueue`): fx + `failed` + resumable last sentinel → `recordFxPause` (carry `autoResumeCount` from the existing row if its `runId` chain continues, else 0) → schedule per prefs/cap (or mark `disabled`/`exhausted` + status line + event); otherwise clear the row. `spawnFxRun`: `{line}` → clear row + cancel timer; `{continueRecovery}` → cancel timer, keep row with `autoResume: null`; `startTask` → clear. `fireFxAutoResume` validates `at`, bumps `autoResumeCount`, emits `fired` + status line, calls `resumeFxRecovery(taskId, {origin:"auto"})`; a failure result appends a status line and marks `exhausted`/keeps the row. `cancelFxAutoResume` at all seams (§3.4), including `cancelRun` for a paused task with a pending timer. Move the in-flight claim into `resumeFxRecovery`; route `DELETE /tasks/:id/fx-auto-resume`; `rearmFxAutoResumes()` called after `reconcileOrphans()` in both boot files (awaited, logs the count). `reconcileTaskSession`'s mode reset → `defaultModeFor`. Acceptance: `orchestrator-fx.test.ts`, `headless-routes.test.ts`, `fx-resume-endpoint.test.ts` green; typecheck.
- **T3 — Spawn default + fake repause.** File: `src/bun/agents.ts`. `buildCommand`/`spawnAgent` mode fallbacks → `defaultModeFor(harness.kind)` for every kind (fx: `yolo`); `FAKE_FX_REPAUSE_PROMPT_MARKER` / `AGETOR_FAKE_FX_REPAUSE=1` scenario: a `continueRecovery` launch under the repause marker emits the 3-attempt storm → paused → `refused` (exit 1) exactly like the storm scenario; without the marker the existing recovered path stays. Acceptance: `agents.test.ts` green except the three null→auto tests (leave failing for the test wave, report them).
- **T4 — Webview transcript + card.** Files: `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/components/kanban/TaskCard.tsx`, `src/mainview/lib/linkify.tsx` (new), `src/mainview/lib/fx-auto-resume.ts` (new: `useCountdown(at)` hook + text helper wrappers). RunPanel: notices render `renderLinkified(text)`; `PausedRecoveryNotice` gains the countdown line `Auto-resume in m:ss (k/max)` + Cancel button (`api.cancelFxAutoResume`, hint on error) when `task.fxRecovery?.autoResume`, or the stopped reason text (`exhausted`/`cancelled`/`disabled`); plain `status` lines go through `renderLinkified`; `nullModeFallback` → `defaultModeFor(kind)`; `onAgentChange` reset → `defaultModeFor`. TaskCard: `fx-paused-badge` (PauseCircle icon, text `paused` or `auto-resume m:ss`, `title` = message + hint) when `isTaskFxPaused(task)`. Acceptance: typecheck; semantic tokens only.
- **T5 — App wiring, settings, context menu.** Files: `src/mainview/App.tsx`, `src/mainview/components/settings/SettingsDialog.tsx`, `src/mainview/lib/task-context-menu.ts`, `src/mainview/lib/toasts.ts`, `src/mainview/lib/api.ts`, `src/mainview/lib/fx-auto-resume-prefs.ts` (new: pref keys re-export + parse for the webview). Context menu: `resume-recovery` (primary, when `isTaskFxPaused`) and `cancel-auto-resume` (when `fxRecovery.autoResume`), App maps them to `api.resumeFxRecovery`/`api.cancelFxAutoResume` with error toasts; `ICON_BY_ACTION`; `fx-auto-resume` event handler (toasts; returns before the column fallthrough); preferences state + `SettingsDialog` General: Switch `settings-fx-auto-resume` + number input `settings-fx-auto-resume-delay` (10..3600) with hint text; `api.cancelFxAutoResume`. Acceptance: typecheck; `task-context-menu.test.ts` updated by the test wave (leave the exhaustive map failing if it must; report).
- **T6 — CLI/TUI.** Files: `src/cli/api-client.ts`, `src/cli/commands/resume.ts`, `src/cli/usage.ts`, `src/cli/index.ts`, `src/cli/commands/ls.ts`, `src/cli/tui/Dashboard.tsx`, `src/cli/commands/config.ts` (help text only), `src/cli/commands/add.ts` (`defaultNonInteractiveMode` → `defaultModeFor`). `agetor resume <id> --cancel` → `cancelFxAutoResume`; `ls` needs column `⏸ paused` / `⏸ auto m:ss`; TUI row hint `· ⏸ paused (r)` / `· ⏸ auto-resume m:ss`, detail hint reads `task.fxRecovery`, `r` unchanged; `config` usage mentions the two keys. Acceptance: `bun test src/cli` green except tests the test wave owns.

**Wave 3**
- **T7 — Docs.** File: `CLAUDE.md`: fx bullet (field, engine, routes, seams, boot re-arm, linkify, test seams), the defaults paragraph rewritten for `defaultModeFor` (null fx mode now spawns `yolo`; the earlier no-escalation rationale is superseded by the owner's decision), Persistence section: `fx_recovery` joins the skipped-columns list.

## 5. Work breakdown — test tasks (one wave, file-disjoint)

- **TT1** `src/shared/fx-recovery.test.ts`, `src/shared/types.test.ts`: new helpers, `defaultModeFor` for every kind, prefs parsing/clamps, countdown text, `isTaskFxPaused`.
- **TT2** `src/bun/db-fx-recovery.test.ts` (new) + `src/bun/migrate.test.ts` if it enumerates migrations: parse tolerance, `setFxRecovery` round-trip, generic `update` cannot clobber it, `listFxAutoResumePending`.
- **TT3** `src/bun/orchestrator-fx.test.ts` (+ `src/bun/fx-resume-endpoint.test.ts` for the DELETE route): with `AGETOR_FX_AUTO_RESUME_DELAY_MS=300`: storm → row set + `scheduled` status/event → fires → recovered → row null; repause marker → chain counts to 3 → `exhausted` status, row keeps `paused`; cancel via `cancelFxAutoResume` and via a `sendInput` message; preference off → `disabled`; `rearmFxAutoResumes` with a past-due persisted `at` fires; manual `resumeFxRecovery` during a pending timer cancels it and the claim rejects a concurrent second call; `reconcileTaskSession` mode reset via `defaultModeFor`.
- **TT4** `src/bun/agents.test.ts`: rewrite the three null→auto tests to yolo; repause scenario chunk order; `defaultModeFor` applied to every kind's spawn.
- **TT5** `src/mainview/lib/task-context-menu.test.ts`, `src/cli/resume.test.ts`, `src/cli/api-client.test.ts`, `src/cli/logs.test.ts`/`src/cli/tui/Dashboard.test.tsx` (row hint), a new `src/cli/ls.test.ts` if `ls` has none (check), `src/mainview/lib/linkify.test.tsx`? (no jsdom — test the pure splitter by exporting `splitLinks(text)` from `linkify.tsx`'s sibling pure module `src/shared/linkify.ts`; T4 must put the splitter there).
- **TT6** `e2e/fx-recovery.spec.ts` (extend) + `e2e/fixtures.ts` (set `AGETOR_FX_AUTO_RESUME_DELAY_MS=2000` for the backend): badge appears with countdown after the storm, auto-resume fires, "✓ recovered", badge gone; second task: cancel via the notice → badge reads `paused`, no auto-resume; context-menu entries; link click on a notice with a URL (a fake storm variant message must include `https://example.invalid/upgrade` — T3 adds the URL to the fake storm message) → `POST /open-external` observed via `page.waitForRequest` (501 → toast); Settings toggle off persists (`agetor config`/`GET /preferences`); a task created with `mode: null` shows Full access in Task Details.

E2e recipe unchanged (`bun node_modules/@playwright/test/cli.js test e2e/fx-recovery.spec.ts`, one run at a time, quiet machine). Live smoke: dev daemon `:4327` + `~/.agetor-dev`, `agetor config fxAutoResumeDelaySec 120`, storm → wait → observe `auto-resuming paused fx response (1/3)` → recovered; delete the task after.

## 6. Execution waves

1. T1 alone → typecheck + shared/db tests.
2. T2–T6 in parallel (disjoint files; cross-file names pinned above) → typecheck + full `bun test` → commit.
3. T7 → commit. Then review (opus) + tests TT1–TT6 in parallel → full suite + e2e → fixes → live smoke → commit.

## 7. Blast radius & risks

- New column + parse in `toTask` touches every `/tasks` response; the field is `null` for all existing rows (no backfill needed — a paused task from before this change simply has no badge until its next pause).
- `resumeFxRecovery`'s claim moves into the orchestrator: the route's 409 wording stays; `fx-resume-endpoint.test.ts` may need its expectation adjusted.
- `defaultModeFor` changes fx spawn for stored-null rows (owner-approved escalation); other kinds are unchanged (`modes[0] === "auto"`).
- Timers: unref'd, identity-checked, cleared on every teardown seam; boot re-arm only reads this instance's DB.
- The countdown hook ticks once per second only on cards/notices with a pending schedule.
- Linkify touches every plain status line's rendering: it must be a no-op (same text node) when no URL is present.

## 8. Open questions / assumptions

- Grill answers: on-by-default with Settings toggle + delay, cap 3; persist + boot re-arm, cancel everywhere; badge + menu + TUI + `ls`; links in notices + status lines.
- Assumption: a resume run that recovers clears the row (chain reset); a run that pauses for a non-rate-limit cause still counts as paused/resumable (fx's `requiredAction` gate decides), and auto-resume applies to any resumable pause, not only `rate_limited`.
- Assumption: no OS notification for auto-resume outcomes (toasts only) — out of scope below.

## 9. Completeness ledger

| Remainder | Disposition |
| --- | --- |
| Board badge, context-menu entries, TUI row hint, `agetor ls` column | In this run — T4/T5/T6 |
| Auto-resume engine, prefs, Settings UI, cancel routes/CLI, boot re-arm, status lines, toasts | In this run — T2/T5/T6 |
| Links in notices AND transcript status lines | In this run — T4 |
| Null fx mode → yolo via `defaultModeFor`, dropdown parity, tests, docs | In this run — T1/T3/T4/T6/T7 |
| Stop cancelling a pending auto-resume on a paused task | In this run — T2 (`cancelRun`) |
| Fake-driver repause scenario + URL in the fake message (e2e seams) | In this run — T3 |
| OS notification when auto-resume fires/gives up | Out of scope — toasts + status lines cover it; GUI-only notifier |
| Auto-resume for non-fx harnesses | Out of scope — only fx pauses with a checkpoint |
| Backfilling `fx_recovery` for tasks paused before this change | Out of scope — next pause populates it |
| Owner-deferred | none |

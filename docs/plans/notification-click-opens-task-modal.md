# Plan — Clicking a macOS notification opens its task's details modal

| Field | Value |
| --- | --- |
| Date | 2026-07-07 |
| Source | `/implement` — "When opening a macOS notification regarding a Task, we should open its task details modal in Agetor" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | `agetor/2d65e29940e1-support-opening-task-by-native-macos-not` (already a feature branch) |
| Base SHA | `833529b837989cf11a8ff141049d14fdd3b3835f` |

## 1. Objective & success criteria

**Objective:** When the user clicks (activates) a native macOS notification that concerns a specific task, Agetor comes to the foreground and opens that task's details modal (the `RunPanel`).

**Success criteria:**
- Clicking a task-scoped notification (succeeded / failed / orphaned / "Waiting on you") opens **that exact task's** `RunPanel`, and focuses the app window (recreating it if it was dismissed).
- If the clicked task isn't in the loaded board, the board refreshes once and retries; if still absent, the click is silently ignored (no crash, no wrong task).
- If no deep-link-capable notifier is available, notifications still fire via the current `Utils.showNotification` path (graceful degradation — feature enhances, never regresses).
- `bun run typecheck` green; `bun test` green (new unit tests for the pure logic).

## 2. Context & constraints (grounded findings, file:line)

- **Task-details modal = `RunPanel`**, open iff `App.tsx` `selected !== null` (`src/mainview/App.tsx:76`, render `:638-648`). Open-by-task idiom: `setSelected(tasksRef.current.find(t => t.id === id))` + `window.focus()` (`App.tsx:261-268`). Requires the task to be in `tasksRef.current` (`App.tsx:196-203`).
- **App-level event bus** `GET /app/events` carries `AppEvent` (currently only `quit_request`), `shared/types.ts:814-820`. Bun emits via `broadcastAppEvent()` (`src/bun/quit-guard.ts:30-32`); webview consumes in `App.tsx:210-236` (`api.subscribeAppEvents`, `api.ts:457-468`).
- **Native notification** posted through `POST /notifications` (`server.ts:1661-1688`) → `native.showNotification({title,body,subtitle,silent})` (iface `server.ts:204-209`) → `Utils.showNotification(n)` (`index.ts:132`). `taskId` is **dropped** at `toasts.ts:38-42` (`maybeNotifyOS` forwards only `{title, body}`); `notifyOS` (`api.ts:428-432`) has no `taskId`. The OS notification is anonymous.
- **Electrobun v1.18.1 has NO notification-click callback** — one-way FFI, no id/callback/event (verified: `dist/api/bun/proc/native.ts:1607-1620`; zero matches for notification-click events). Documented at `api.ts:424-427`. → See fleet knowledge entry `757b4891-3bed-498e-8904-7f30054ac23f`.
- **Electrobun DOES expose:** `urlSchemes?: string[]` config (`node_modules/electrobun/dist/api/bun/ElectrobunConfig.ts:43,58`) and an `open-url` application event `{ url }` (`ApplicationEvents.ts` `openUrl` → `"open-url"`, wired via `setAppOpenUrlHandler` in `native.ts:~2078`). App already hooks `before-quit`/`reopen`/`move`/`close`/`resize` via `Electrobun.events.on(...)` (`index.ts:208,298,303,320,336`).
- **Window lifecycle:** `windowLifecycle.createMainWindow()` is idempotent and restores frame; used by `reopen` (`index.ts:255-291,336-340`). We reuse it to ensure a window exists when a notification is clicked while the app was dismissed (`exitOnLastWindowClosed:false`, `electrobun.config.ts`).
- **Notifier binary:** `terminal-notifier` supports `-open <url>` (fire-and-forget) and `-sender <bundleid>` (show under the app's icon). NOT installed by default; `osascript` notifications support no click action. App already **bundles binaries** the same way we'll bundle this (tmux → `vendor/tmux/arm64` → `Contents/Resources/app/bin`, `electrobun.config.ts build.copy` + `src/bun/tmux-resolution.ts`).
- **No DOM test harness** in the webview (fleet memory `a5a27556`): test React behavior by extracting **pure logic into `src/mainview/lib/*.ts`** and unit-testing with `bun test`.

## 3. Approach & key decisions

**Chosen mechanism (user-approved): custom URL scheme + bundled `terminal-notifier`.**

Flow: post task notifications via `terminal-notifier … -open "agetor://task/<id>"` → user clicks → macOS runs `open agetor://task/<id>` → the registered `agetor://` scheme routes to Agetor → Electrobun fires `open-url` → Bun parses the taskId, ensures the window exists, and `broadcastAppEvent({type:"open_task", taskId})` → webview `App.tsx` handler opens the `RunPanel` (with refresh-retry).

Key decisions:
- **`terminal-notifier`** over `alerter` (alerter blocks per-notification; terminal-notifier is fire-and-forget, matching the current model). Passed `-sender sh.alamops.agetor` so it renders under Agetor's identity/icon.
- **Graceful fallback:** the Bun-side `showNotification` uses the deep-link notifier only when (a) a `taskId` is present AND (b) a notifier binary resolves (bundled path, then `PATH`). Otherwise it falls back to `Utils.showNotification` (today's behavior). The feature never breaks notifications.
- **Reuse `/app/events` + `AppEvent`** (not the per-task `GlobalEvent` channel) — it's the app-level bus, already wired end-to-end for `quit_request`.
- **Deep-link scope:** `agetor://task/<taskId>` only (single verb). Parser strictly validates host `task` + a non-empty id segment.
- **Alternatives rejected:** focus-heuristic (lossy, fires on any focus); native Electrobun patch (heavy fork). See task prompt history.

**Rollout / risk-managed decision:** bundling + notarizing a nested helper binary is the one build-time risk (see §7). The runtime code is fully functional with `terminal-notifier` on `PATH` (dev via `brew install terminal-notifier`); the bundle wiring is added but its notarized-signing is verified at build and, if it needs follow-up, the fallback keeps shipping notifications working.

## 4. Work breakdown — implementation tasks

Contract shared across tasks — the deep-link URL and the AppEvent:
- URL: `agetor://task/<taskId>` (host = `task`, first path segment = taskId).
- `AppEvent` new variant: `{ type: "open_task"; taskId: string; ts: number }`.
- `ApiNative.showNotification` + `POST /notifications` gain an optional `taskId?: string`.

| ID | Goal | Owns (exact files) | Deps |
| --- | --- | --- | --- |
| **T1** | Add `open_task` variant to the `AppEvent` union. | `src/shared/types.ts` | — |
| **T2** | New pure leaf modules: `deep-link.ts` (`buildTaskUrl(id)` → `agetor://task/<id>`, `parseTaskDeepLink(url)` → `taskId | null`, strict validation) and `notifier.ts` (`resolveNotifier()` → bundled path ?? PATH ?? null; `buildNotifierArgs({title,body,subtitle,silent,url,sender})` → argv). | `src/bun/deep-link.ts` (new), `src/bun/notifier.ts` (new) | — |
| **T3** | Wire the Bun notification + deep-link path: (a) thread `taskId` through `POST /notifications` parse + `ApiNative.showNotification` iface; (b) implement the injected `showNotification` to use `notifier.ts` (deep-link `-open agetor://task/<id>`) when `taskId` + notifier resolve, else `Utils.showNotification`; (c) add `Electrobun.events.on("open-url", …)` → `parseTaskDeepLink` → `windowLifecycle.createMainWindow()` → `broadcastAppEvent({type:"open_task", taskId, ts})`. | `src/bun/index.ts`, `src/bun/server.ts` | T1, T2 |
| **T5** | Register the scheme + bundle the notifier: add `urlSchemes: ["agetor"]` to `electrobun.config.ts`; add `build.copy` mapping for the vendored notifier into `bin/`; add `scripts/fetch-terminal-notifier.ts` (mirror `scripts/fetch-tmux.ts`) + a `package.json` script. | `electrobun.config.ts`, `scripts/fetch-terminal-notifier.ts` (new), `package.json` | — |
| **T6** | Thread `taskId` through the webview notify path: `notifyOS` accepts `taskId?`; `maybeNotifyOS` forwards `args.taskId`. | `src/mainview/lib/api.ts`, `src/mainview/lib/toasts.ts` | T1 |
| **T7** | Handle `open_task` in the webview: extract pure `resolveTaskToOpen(tasks, taskId)` into `src/mainview/lib/notification-open.ts` (new); add an `open_task` branch to the `/app/events` handler in `App.tsx` — find task; if missing `await refresh()` then retry; `setSelected` + `window.focus()`; else no-op. | `src/mainview/App.tsx`, `src/mainview/lib/notification-open.ts` (new) | T1 |

**File-disjointness check (Wave 2 = T3, T5, T6, T7):** index.ts+server.ts (T3), electrobun.config.ts+scripts+package.json (T5), api.ts+toasts.ts (T6), App.tsx+notification-open.ts (T7) — no overlap. ✅ T3 owns both index.ts and server.ts together precisely because they share the `taskId` iface contract (kept in one agent to avoid cross-agent drift).

## 5. Work breakdown — test tasks

| ID | Covers | Owns (test file) |
| --- | --- | --- |
| **TT1** | `deep-link.ts`: round-trip build↔parse; reject wrong host, empty id, non-`agetor` scheme, extra segments; url-encoding of ids. | `src/bun/deep-link.test.ts` (new) |
| **TT2** | `notifier.ts`: `buildNotifierArgs` includes `-open <url>`, title/message/subtitle/sender, `-silent` handling; `resolveNotifier` prefers bundled path then PATH then null (via env override, mirroring tmux tests). | `src/bun/notifier.test.ts` (new) |
| **TT3** | `POST /notifications` now accepts & forwards `taskId`; still 400 without title; when notifier unavailable, still records a `Utils.showNotification` call (fallback). Extends existing suite. | `src/bun/notifications.test.ts` (extend) |
| **TT4** | `resolveTaskToOpen(tasks, taskId)` pure decision: found → open; missing → needs-refresh; still-missing-after-refresh → no-op. | `src/mainview/lib/notification-open.test.ts` (new) |

## 6. Execution waves

- **Wave 1 (parallel):** T1, T2. — barrier —
- **Wave 2 (parallel):** T3, T5, T6, T7.
- **Phase 5 review** on the Wave-1+2 diff.
- **Wave 3 (tests, parallel):** TT1, TT2, TT3, TT4.
- **Phase 7:** run `bun test` + `bun run typecheck`.
- **Phase 8:** fix any failures, re-run.

## 7. Blast radius & risks

- **Notification path is central** — every toast that fires an OS notification flows through `showNotification`. Mitigated by the fallback: unknown/absent notifier or missing `taskId` → exact current behavior.
- **`ApiNative.showNotification` iface change** — adding optional `taskId?` is backward-compatible; test double `test-native.ts` needs no change (optional field).
- **Notarization of the bundled notifier** (biggest risk) — nested helper must be deep-signed + hardened-runtime for `notarize:true` to pass. Verify at `bun run build`; if signing needs follow-up, the runtime falls back cleanly. Flag to user in final report.
- **`open-url` while window closed** — handled by `windowLifecycle.createMainWindow()` before broadcast; the webview may connect its SSE slightly after the broadcast, so also make the broadcast fire after a short tick / rely on the webview requesting current state, OR have the handler retry. (T3 note: broadcast after `createMainWindow()` resolves; T7's refresh-retry also covers a just-mounted board.)
- **Scheme registration in dev** — `agetor://` only routes once the built `.app` is registered with LaunchServices; full click-loop testing uses `bun run build` + launching the `.app` (note in verification).
- **Security:** deep-link taskId is validated (non-empty, expected shape) before lookup; webview only ever `setSelected` an already-fetched task row — no arbitrary fetch/exec. `open-url` payload is treated as untrusted input.

## 8. Open questions / assumptions

- **Assumption:** `terminal-notifier` is the bundled notifier (fire-and-forget + `-open`). If notarization proves painful, a single-binary `alerter` fork or a tiny custom Swift helper is the fallback — deferred, not in this branch.
- **Assumption:** notifications fire only while the app is unfocused (`maybeNotifyOS` bails on `isFocused`, `toasts.ts:39`) — the deep-link only matters unfocused, consistent.
- **Assumption:** the `agetor://` scheme name is acceptable (matches bundle-id-ish branding). Change is a one-liner if not.

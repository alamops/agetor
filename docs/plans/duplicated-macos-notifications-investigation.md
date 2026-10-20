# Investigation — one macOS notification per task (no duplicate stacking)

| Field | Value |
| --- | --- |
| Date | 2026-10-20 |
| Change | Stop Agetor from piling up several macOS notifications for the same task: at most one per task, with a newer event replacing the older notification and showing on top. This brief informs where the dedupe lives (Swift helper vs Bun vs webview), what "replace" does on macOS, and which adjacent behaviors the owner must decide. |
| Agents | 0 sub-agents (pipeline step forbids them): inline codebase + git-history reading, web research, 3 scratchpad spikes |
| Flags | none |

## 1. What we know

### The OS-notification pipeline (single path for every app notification)

1. **Webview decides when.** `App.tsx`'s global-event handler (`src/mainview/App.tsx:1253-1544`) calls the toast helpers in `src/mainview/lib/toasts.ts`. Every helper that can reach the OS goes through `maybeNotifyOS` (`toasts.ts:39-48`), which skips when the window is focused (unless `force`) and otherwise calls `api.notifyOS({ title: heading, body: detail, taskId })` (`toasts.ts:47`).
   - Callers: `toastSuccess` (`:58`), `toastError` (`:70`), `showBlockingToast` (`:101`, used by `toastPending`, `toastApiError`, `toastSessionEnded`, `toastUnknownCommand`), `notifyWaitingInput` (`:145`), `notifyFilesSent` (`:180`, forced for `proactive`).
   - Event → helper map in `App.tsx`: `interaction` pending → `notifyWaitingInput` (`:1342`); `run-status` succeeded/failed/orphaned → `toastSuccess`/`toastError` (`:1396`/`:1398`); `files-sent` → `notifyFilesSent` (`:1445`); `pipeline` → `done` → `toastSuccess` (`:1492`); `column` → `blocked` → `toastApiError`/`toastSessionEnded`/`toastUnknownCommand`/`toastPending` (`:1512-1539`).
   - **`taskId` is always present** and is already the right "per task" key. Hidden pipeline **step** events are retargeted to the **parent** id (`App.tsx:1304-1323`), so one key per pipeline already exists.
   - The in-app sonner toasts are single-slot per task only for the "needs attention" family (`pendingByTask`, `toasts.ts:33`). Success, error and files-sent toasts stack freely.
2. **Webview → Bun.** `api.notifyOS` → `POST /notifications` (`src/mainview/lib/api.ts:2012-2022` → `src/bun/server.ts:7228-7268`). The route caps strings at 256 characters, bounds `taskId` at 512, and calls `native.showNotification` (`ApiNative` type at `server.ts:1111-1118`). The headless core has no `native` and answers 501.
3. **Bun → helper.** `index.ts:378` wires `showNotification` to `showTaskNotification` (`src/bun/index.ts:268-325`). With a `taskId` and a resolved helper, it spawns the bundled `AgetorNotifier.app/Contents/MacOS/notifier` with `buildNotifierArgs` (`src/bun/notifier.ts:99-107`: `--title --message [--subtitle] [--url agetor://task/<id>] [--silent]`).
   - Exit 0 means posted. Exit 2 means permission denied, with deliberately no fallback. Any other failure falls back to `Utils.showNotification`, which has no identifier control (Electrobun 1.18.1 FFI; its dylib uses UN with a legacy `NSUserNotification` fallback).
   - Every post is a **separate, short-lived helper process**.
4. **Helper posts with a random id. This is the root cause.** `native/notifier/notifier.swift:92-93`: `UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)`. Every post is a new Notification Center entry, so N events for one task leave N entries.
   - `userInfo = ["url": "agetor://task/<id>"]` (`:90`) is the only per-task marker on the notification.
   - There is no `threadIdentifier`, no `removeDelivered…`, and no remove mode. `git log -S` finds no `threadIdentifier` or `removeDelivered` anywhere in history, so there has been no prior dedupe attempt.
   - The helper's CLI parser ignores unknown flags (`notifier.swift:36-52`, `default: i += 1`).
   - A launch without `--title` is treated as a **click relaunch**: it waits 10 s for `didReceive` (`:65-71`). Any new non-post mode (for example "withdraw") must not look like that.
5. **The volume source.** Each Claude Code follow-up turn is its own run row (CLAUDE.md, *Claude session lifecycle*), and every succeeded run fires `run-status` → `toastSuccess` → an OS notification while Agetor is unfocused. So an interactive task worked on in the background produces one "Task succeeded" per turn, plus "Waiting on you", "Files sent" and so on. All of them stack, because ids are random.
6. **Click path (unchanged by this work).** On click, macOS relaunches the helper; `didReceive` opens the `agetor://` URL (`notifier.swift:110-185`) → `open-url` → `open_task` (`index.ts:706+`). macOS removes the clicked notification itself. The bundle id `sh.alamops.agetor.notifier` must stay stable (`native/notifier/Info.plist:12-16`).
7. **Other OS-notification surface: the CLI.** `agetor logs <id> --notify` posts via `osascript display notification` (`src/cli/notify.ts:57-68`, called from `src/cli/commands/logs.ts:120-125`). It has no identifier, so it cannot replace, and it posts under the osascript/Script Editor identity, not Agetor's. The TUI posts no OS notifications (`src/cli/tui/useGlobalEvents.ts`).

### Latent bug found next to this path (proved, §2): `interaction` "resolved" never reaches the global bus

- `interactions.ts` holds **one** resolved-broadcaster (`src/bun/interactions.ts:320,339-341`).
- `orchestrator.ts:742` calls `wireInteractionBroadcast()`, which installs a broadcaster that also emits `GlobalEvent{kind:"interaction", state:"resolved"}` (`:720-739`). Then `orchestrator.ts:750-758` (from `da8c2cd`, 2026-07-01) installs a second, per-task-only broadcaster that **replaces** it.
- Production never re-wires. Only tests call `wireInteractionBroadcast()` again (`src/bun/global-events.test.ts:81`), which masks the bug.
- Effects in the webview:
  - `PendingInputTracker.remove` (`src/mainview/lib/pending-input-tracker.ts:33`) never runs.
  - A **second question in the same run never alerts at all** (`tracker.add` returns `false` because the first, answered id is still in the set).
  - The "Waiting on you" toast and OS notification are never withdrawn when the question is answered. Only a terminal `run-status` or a column change clears the tracker.
- This matters here twice: fixing it will **raise** notification volume (making per-task replacement more important), and any "withdraw the notification when the question is answered" design depends on it.

### Read-state hooks a "withdraw when opened" design would use

- Opening, switching or closing the run panel calls `api.markTaskSeen(id)` for both ids (`App.tsx:993-1020`) → `POST /tasks/:id/seen` → `tasks.markSeen` (`server.ts:6612-6625`).
- A pipeline parent opens the full-page run view, not the panel, so it never goes through that effect. It would need its own hook.

## 2. What we proved

| Question | Verdict | Evidence (command → output) | Versions | Artifact |
| --- | --- | --- | --- | --- |
| Re-adding a request with the **same identifier from a new helper process** replaces the delivered notification, or stacks a second? | **Replaces.** Exactly one entry remains, holding the new content. | Posted `spike-task-A` "A #1", then `spike-task-B`, then `spike-task-A` "A #2" (three separate processes) → `getDeliveredNotifications`: `total=2`, entries `spike-task-A title=Spike A #2 date=…13:57:37.764Z` and `spike-task-B …13:57:35.212Z`. | macOS 26.6.2 (25G83), Swift 6.4, `-target arm64-apple-macos13`, ad-hoc signed bundle with id `sh.alamops.agetor.notifier` | `<scratchpad>/spikes/un-replace/src/main.swift` |
| Does the replacement **re-alert** (fresh banner + sound) and sort **on top**, or update silently in place? | **Fresh banner + sound, newest date (on top).** usernoted removes the old entry and delivers the new one as new. | `log show` (usernoted/NotificationCenter): `Adding new request, remove notifications similar to … req:"spike-task-A"` → `Removed history notification … Animate removal` → `Delivering … updatedExisting: false` → `Presenting … as banner (["badge","sound","alert"])` → `Playing notification sound … 09:57:38.317`. The delivered date moved past task B's. This contradicts a third-party claim of "no second sound" ([roarcli](https://roarcli.readthedocs.io/en/latest/CONCEPTS/)). | same | same |
| Fresh-id alternative: can a new process find a task's notification by `userInfo.url`, remove it, and post a new one? | **Yes** | `remove-task-then-post --task A` → `removing ["spike-task-A"]` → list shows only `spike-fresh-A3` (+ B). `cleanup` from a new process → `delivered total=0`. | same | same |
| Is the delivered list (and replace/remove) shared across helper builds? | **Scoped per code signature, not per path.** Same cdhash at two paths: shared. Different ad-hoc cdhash: invisible. The ad-hoc spike could not see the production (Developer ID, team `ZQG3522LY7`) helper's notification `832A1B5A`, posted 09:53:30 and never removed. **Developer-ID builds across releases: inconclusive** (would need signing with the owner's certificate). | Post from build 1 (cdhash `f050eb…`) → list from build 2 (cdhash `b8eb98…`): `delivered total=0`. Copy at another path with the same cdhash: `total=1`, and its same-id post replaced build 1's. usernoted logs show `source:"10CE7FA6"` (prod) vs `"06194F4E"` (spike). | same | same |
| Is the global `interaction` `resolved` event emitted in production wiring? | **No: only `pending`.** | `bun run probe.ts` (imports the main checkout's identical `orchestrator.ts`/`interactions.ts`, fresh `AGETOR_DATA_DIR` in the scratchpad), `registerTmuxPrompt` + `cancelPendingForTask` → `global interaction events seen …: ["pending"]` | bun at `~/.bun/bin`, main checkout `b2cacb1` (same as this branch) | `<scratchpad>/spikes/resolved-broadcast/probe.ts` |
| Would today's tests notice a naive Swift-only fix (stable id in `notifier.swift`)? | **No (by reading).** No test exercises the Swift helper. `notifier.test.ts` pins only `buildNotifierArgs` argv order. `notifications.test.ts` records `showNotification` calls through `makeTestNative`. `bun test` can't observe UN. | `src/bun/notifier.test.ts:4-62`, `src/bun/notifications.test.ts:19-131` | — | — |

Spike hygiene: every spike notification was removed (`removed spike ids=…`, final `delivered total=0`). The spike bundles self-registered in LaunchServices, so they were `lsregister -u`'d, and the real helper was re-registered with `lsregister -f /Applications/Agetor.app/…/AgetorNotifier.app` (the same call `index.ts:335-348` makes at boot). The final `lsregister -dump` shows only the real and the pre-existing dev copies. `<scratchpad>` = `/private/tmp/claude-501/-Users-alamosaravali--agetor-worktrees-027e97fc-b38e-4821-a4ed-c6516af737df/406c8a96-4913-431e-a8d2-d5af2e2fc63c/scratchpad`.

**Design consequence:** the cheapest correct fix is a **stable, per-task request identifier** (for example `agetor.task.<taskId>`) passed from Bun to the helper. macOS itself then guarantees one entry per task that re-alerts and sorts on top, which is exactly the owner's preferred behavior. The fresh-id + remove-by-url route also works and is the way to clean up **legacy** (UUID-id) notifications.

## 3. What we're assuming

- **Developer-ID helper builds from one team share a UN "source" across releases.** Unverified, since ad-hoc builds are cdhash-scoped. If wrong: after an app update, a notification the previous version posted for a task can't be replaced or removed by the new helper, leaving one leftover duplicate per task across the update boundary, which can't be fixed from code. Verify in manual QA on a real signed update.
- **Notification permission is granted** (observed `authorizationStatus=2`, banner style). If denied, the helper exits 2 and nothing posts. Dedupe is moot there.
- **The "Alerts" (persistent) style replaces the same way as banners.** Same usernoted removal pipeline, but untested. If wrong, persistent alerts could stack. Add to QA.
- **Concurrent posts for one task are rare but possible** (e.g. `files-sent` then `run-status` within milliseconds). Two helper processes race, so the older event could land last and be the one shown. Assumed fixable by serializing posts per task on the Bun side (wait for the previous child's exit). If ignored: occasionally a stale "on top" message.
- **The `Utils.showNotification` fallback** (helper missing or crashed) stays non-deduped. Acceptable because it is a degraded path.
- **The task id string is safe as an identifier component.** It is a UUID, bounded to 512 at the route, and goes into argv, never a shell.

## 4. What we must ask the owner

1. **Replacement policy.** Last-writer-wins (every new event for a task replaces its notification, re-alerting with banner + sound, proved), or priority-aware (an unanswered "Waiting on you" isn't overwritten by a lower-priority "Files sent" or "Task succeeded")? *Recommend last-writer-wins.* It is exactly "new one on top", and the question card is still on the task.
2. **Re-alert on every replacement?** macOS re-plays banner + sound for each same-id replacement. Keep that, or make rapid follow-ups (within a few seconds for the same task) replace silently? *Recommend keep the default re-alert*, plus per-task post serialization so the newest wins.
3. **Withdraw when the task is opened in Agetor.** When the user opens the task in the app (run panel open → `POST /tasks/:id/seen`, and the pipeline run view for a parent), remove that task's delivered notification from Notification Center? This matches "not yet opened" semantics and needs a new helper "withdraw" mode plus a native hook. *Recommend yes.*
4. **Withdraw when the reason goes away.** Remove a "Waiting on you" or blocked notification once the question is answered (in-app, CLI or terminal) or the task leaves `blocked`; remove a task's notification when it is archived or deleted (a click would otherwise open a gone task)? *Recommend yes for all.*
5. **Fix the interaction-`resolved` global-event bug in this change?** It's the prerequisite for #4's answered-question withdraw. It also fixes a real under-notification (a second question in the same run never alerts today), so it will add alerts, deduped per task by this work. *Recommend yes, in scope.*
6. **Legacy cleanup.** On the first post for a task after upgrading, also remove that task's older UUID-id notifications (matched by `userInfo.url`)? Cheap, and proved to work within one signing source. *Recommend yes.*
7. **CLI `agetor logs --notify`** (osascript, cannot replace, wrong identity). Leave it as is, or route it through the bundled helper (same per-task id) when `/Applications/Agetor.app` is present? *Recommend route through the helper if found, else keep osascript.* Lower priority, so the owner may scope it out.
8. **In-app (sonner) toasts.** Success, error and files-sent toasts still stack per task inside the app. Should "one per task" extend to them (replace the prior toast for the same task)? *Recommend yes if the owner reads "notification" broadly.* Otherwise keep this change OS-only.

## 5. Completeness inventory

- **Callers (direct and indirect):**
  - `src/mainview/lib/toasts.ts:39-48`: `maybeNotifyOS`, the only `api.notifyOS` caller. Its callers are at `:58`, `:70`, `:101` (×4 variants), `:145`, `:180`.
  - `src/mainview/App.tsx`: `:1342`, `:1396`, `:1398`, `:1445`, `:1492`, `:1512`, `:1514`, `:1516`, `:1524`, `:1539`.
  - `src/mainview/lib/api.ts:2012`.
  - `src/bun/server.ts:7228-7268` (route), `:1111-1118` (`ApiNative.showNotification`).
  - `src/bun/index.ts:268-325` (`showTaskNotification`), `:378` (native wiring).
  - `src/bun/notifier.ts:78-107`.
  - `native/notifier/notifier.swift:36-52`, `:74-106`.
  - CLI: `src/cli/notify.ts:57`, `src/cli/commands/logs.ts:125`.
  - Interaction bus: `src/bun/orchestrator.ts:689-758`, `src/bun/interactions.ts:320-350`.
  - Read-state: `App.tsx:993-1020` → `server.ts:6612-6625`.
- **Propagation surface:**
  - The `NotifierOptions` type and `buildNotifierArgs` argv contract (`notifier.ts`), mirrored by the helper's documented CLI contract (`notifier.swift:14-15`) and `parseArgs`.
  - A new withdraw capability would touch `ApiNative` (`server.ts:1091+`), `makeTestNative` (`src/bun/test-native.ts:11-34`), the `index.ts` native object (`:353-387`), and possibly a new route or a hook in `/tasks/:id/seen`.
  - The headless core injects no native, so any new route must 501 or no-op there (`headless-routes.test.ts:39` lists native routes).
  - The webview `api.ts` type, if new client calls are added.
- **Tests to extend:** `src/bun/notifier.test.ts` (argv order, including the "full combo" test that a new flag breaks); `src/bun/notifications.test.ts` (route threading); `src/bun/global-events.test.ts:75-110` (must stop masking the resolved bug, i.e. assert without re-calling `wireInteractionBroadcast()`); `src/mainview/lib/pending-input-tracker.test.ts` (exists; tracker semantics unchanged, but a resolved-event integration is untested). `src/mainview/lib/toasts.ts` has no unit test, since sonner and `api` are imported directly. No Swift test harness exists. Put id derivation in a pure Bun function so it is unit-testable.
- **Existing data:** notifications already delivered in users' Notification Center carry UUID ids + `userInfo.url = agetor://task/<id>`. They can be cleaned only by url match, and only from the same signing source. No DB rows or migrations are involved.
- **Docs / config:**
  - `docs/qa/native-notifier-qa.md`: add a "one per task / replace on top / withdraw" checklist.
  - `README.md:65` ("Native macOS notifications link straight to the task…"): optional wording.
  - `docs/plans/native-notifier-helper.md` is historic.
  - `electrobun.config.ts:8-9` still describes the retired `terminal-notifier` (stale comment).
  - CLAUDE.md does not document the notifier at all; consider a short entry.
- **What the change would orphan:** nothing. `UUID().uuidString` stays as the fallback when no id is passed (e.g. a hypothetical id-less post).

## 6. Runnability

- **Start locally:** `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`, then **`bun install` first** (this worktree has no `node_modules`). `bun run dev:hmr` (dev data dir `~/.agetor-dev`; never prod). Build the helper with `bun run vendor:notifier` → `vendor/notifier/AgetorNotifier.app` (ad-hoc unless `ELECTROBUN_DEVELOPER_ID` is set; needs `xcrun swiftc`, which is present, Swift 6.4).
- **Tests:** `bun run typecheck`; `bun test`; focused: `bun test src/bun/notifier.test.ts src/bun/notifications.test.ts src/bun/global-events.test.ts src/mainview/lib/`.
- **E2E harness:** Playwright (`bun node_modules/@playwright/test/cli.js test`) runs against a per-worker **headless** backend (`e2e/fixtures.ts`), where `POST /notifications` is 501. The OS layer is not e2e-observable. A webview-level spec could only intercept the request with `page.route` and fake `document.hasFocus()`. Real replacement behavior is manual QA plus the scratchpad spike recipe (dev-built helper, same bundle id: the ad-hoc copy was already authorized here; it **cannot** see production-signed notifications).

## 7. Risks & blast radius

- **Click-relaunch confusion:** a new "withdraw" mode must exit immediately and must not be mistaken for the no-arg click relaunch (`notifier.swift:65-71`).
- **LaunchServices:** any locally-built helper with the production bundle id self-registers in LS (seen in the spike; the main checkout's `vendor/notifier/AgetorNotifier.app` is already registered next to `/Applications/…`). A dev copy could catch production click relaunches. This is pre-existing, but worth a QA note.
- **Notarization:** the helper is signed inside-out before the outer app (`scripts/build-notifier.ts:121-131`, `scripts/verify-release.ts:64-73`). The pipeline doesn't change, but the helper must be rebuilt.
- **Volume goes up with the bug fix (#5):** the second-question alerts become real. Per-task replacement contains the volume to one entry per task.
- **Across-update leftovers:** see the §3 assumption (possibly one stale duplicate per task right after an update).
- **Fallback path:** `Utils.showNotification` can't dedupe. It is only reached when the helper fails, and stays as today.
- **Rollback:** pure code. No migration or persisted state, so reverting restores today's stacking behavior.

Sources: [Apple — UNNotificationRequest.identifier](https://developer.apple.com/documentation/usernotifications/unnotificationrequest/identifier) ("If you use the same identifier when scheduling a new notification, the system removes the previously scheduled notification with that identifier and replaces it with the new one"); [roarcli concepts](https://roarcli.readthedocs.io/en/latest/CONCEPTS/) (claims a same-id repost has "no second sound", contradicted by the spike on macOS 26.6.2); [par-term notify_macos.rs](https://docs.rs/crate/par-term/0.40.0/source/src/platform/notify_macos.rs) (prior art: stable identity → same-id replacement).

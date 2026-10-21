# Plan — One macOS notification per task (no duplicate stacking)

| Field | Value |
| --- | --- |
| Date | 2026-10-20 |
| Source | Pipeline "Alamo Pipeline (No Video)" goal; `docs/plans/duplicated-macos-notifications-investigation.md`; `docs/plans/duplicated-macos-notifications-grill.md` (D1–D23) |
| Flags | none |
| Gates | grilled + approved by owner (2026-10-20; Q1–Q3 in §8 answered by the owner) |
| Branch | `fix/duplicated-macos-notifications` (agetor task branch; no new branch cut) |
| Base SHA | `b2cacb1ce07dc14f09f0a3f21674f257c45bf3f3` (tree clean apart from the three untracked plan docs) |

## 1. Objective & success criteria

Agetor keeps **at most one** Notification Center entry per task. A newer event for a task replaces that task's entry and shows on top. Sounds follow the owner's rules, and Agetor removes the entry when it no longer applies. The in-app sonner toasts follow the same one-per-task rule.

Done means:

1. **One entry, newest on top.** Every OS notification for a task uses one fixed request id, `agetor.task.<taskId>`. N events leave one entry: the newest, at the top (D1, D14).
2. **Sound rules.** The sound plays when the task has no entry in Notification Center, or when the new event escalates a *quiet* entry to *needs you*. Any other replacement is a silent banner (D2–D5, D8).
3. **Removal triggers.** The task's entry is removed when:
   - the task is opened: run panel, pipeline run view, any step panel, or "Mark as read" (D6a, D16);
   - the reason went away: the question was answered from any client, or the task left `blocked`. The entry is removed only if it still shows that reason (D6b);
   - the task is archived or deleted from any client (D6c);
   - the window comes to the front with that task open (D6d);
   - while the window is focused, an event arrives that would otherwise post (D7).
4. **Old-style cleanup.** Random-id notifications from older versions are removed on the task's next post, matched by `userInfo.url` (D10).
5. **Serialized posts.** Bun runs each task's notifier operations one at a time, so the newest event always lands last (D15).
6. **Answer event fixed.** The `interaction` `state:"resolved"` global event fires in production (D9), and a test proves it from a fresh process.
7. **CLI.** `agetor logs --notify` posts through Agetor's helper with the same id and sound rules when it can, and falls back to osascript otherwise (D11).
8. **In-app toasts.** Each task has one toast slot. The newest toast replaces the previous one, and the toast is dismissed when the task is opened or its reason goes away (D12, D13).
9. **Checks.** `bun run typecheck`, `bun test`, the new and updated Playwright specs, the full e2e suite and `bun run vendor:notifier` are all green. The QA checklist, the CLAUDE.md entry and the `electrobun.config.ts` comment are updated (D20, D22).

## 2. Context & constraints

**The OS-notification path** (investigation §1):

| Step | Where | What happens |
| --- | --- | --- |
| Webview decides | `src/mainview/lib/toasts.ts:39-48` | `maybeNotifyOS` is the only caller of `api.notifyOS`. It skips the OS post when the window is focused (unless `force`). Its callers: `toastSuccess` (`:50-59`), `toastError` (`:61-71`), `showBlockingToast` (`:84-102`, which backs `toastPending`, `toastApiError`, `toastSessionEnded` and `toastUnknownCommand`), `notifyWaitingInput` (`:144-159`) and `notifyFilesSent` (`:174-188`). |
| Events → helpers | `src/mainview/App.tsx:1253-1551` | Events map to those helpers. Step events are retargeted to the parent id (`:1304-1323`). Pipeline done → `toastSuccess(... subtitle: "Pipeline finished")` (`:1492`). `blocked` reason `pipeline` is suppressed while `hasPendingToast(parent)` (`:1523`). |
| Webview → Bun | `src/mainview/lib/api.ts:2012-2022` | `api.notifyOS` → `POST /notifications` (`src/bun/server.ts:7228-7268`), which caps strings at 256 and the task id at 512. The headless core 501s. |
| Native interface | `src/bun/server.ts:1091-1131` | `ApiNative.showNotification`. Its doc comment still mentions terminal-notifier. |
| Bun → helper | `src/bun/index.ts:268-325` | `showTaskNotification` spawns one helper process per post. Exit 0 = posted; exit 2 = permission denied (no fallback); other exits fall back to `Utils.showNotification`. Wired at `:378`. |
| Helper | `native/notifier/notifier.swift:92-93` | `UUID().uuidString` request ids are the **root cause** of the stacking. `userInfo = ["url": …]` (`:90`). The parser ignores unknown flags (`:36-52`). A launch with no `--title` is treated as a **click relaunch** and waits 10 s (`:65-71`). `willPresent` honors `--silent` (`:189-197`). |
| Argv builder | `src/bun/notifier.ts:78-107` | `buildNotifierArgs` uses a fixed flag order. `notifier.test.ts` pins the "full combo" argv. |

**Spike verdicts** (investigation §2; macOS 26.6.2, Swift 6.4, ad-hoc-signed bundle id `sh.alamops.agetor.notifier`):

- Re-adding a **same-id** request from a **new process** replaces the delivered entry, re-alerts with banner + sound, and takes the newest date (on top). Measured.
- Find-by-`userInfo.url` + `removeDeliveredNotifications` from a new process works. Measured.
- The delivered list is scoped per code signature. Different ad-hoc cdhashes can't see each other's entries. Developer-ID builds across releases are **unverified** (owner-deferred, D19/D23).

**The answer-event bug** (D9). `src/bun/orchestrator.ts:742` calls `wireInteractionBroadcast()`, which installs a resolved-broadcaster that also emits the global `interaction`/`resolved` event (`:720-739`). Then `:750-758` installs a second, per-task-only resolved-broadcaster that **replaces** it. `src/bun/global-events.test.ts:81` re-calls `wireInteractionBroadcast()`, which hides the bug. The only other code that overrides the broadcasters is `src/bun/interactions.test.ts` (`:93-95`, `:111-114`, `:169-172`, `:316-318`), and it never restores them. `fanoutResolved` runs **after** the entry is deleted from its map (`src/bun/interactions.ts:453-458` and siblings), so `countPendingForTask` inside a resolved listener already excludes the resolved card.

**Removal hook points:**

- **Opened.** `POST /tasks/:id/seen` (`server.ts:6612-6625`) is called by the panel open/switch/close effect (`App.tsx:993-1020`) and by "Mark as read" (`App.tsx:1993-1998`). No CLI command calls `/seen` (grep: none in `src/cli`).
- **Pipeline run view.** It is entered only through `navigate` → `view = {kind:"pipeline-run", taskId}` (`App.tsx:417-541`). It never calls `/seen`.
- **Archive and delete.** No `GlobalEvent` exists for either (`src/shared/types.ts:4773-4960`). The only external entry points are the routes (`server.ts:5240-5262` DELETE, `:5318-5345` archive). The pipeline runner's internal cascade/restart archives (`pipeline-runner.ts:846,1225,1547,1570`) only touch **step** rows, which never own an entry, because step events are retargeted to the parent.
- **Reason gone.** The `interaction` event (once D9 is fixed) and the `column` event carrying `prev` both ride `subscribeGlobal` (`orchestrator.ts:439`).
- **Window focus.** `App.tsx:806-837` already listens for `focus`/`visibilitychange` (for polling). There is no notification hook today.
- **In-app toast dismissal on panel open.** It exists already (`App.tsx:951-957`): it dismisses the pending slot for the opened task, and the parent's slot only when the step is asking.

**Constraints:**

- **Native-only routes.** The headless core injects no `native`, so new native-backed routes must 501 there (`src/bun/headless-routes.test.ts:37-53`).
- **`ApiNative` changes.** Any change to `ApiNative` must be mirrored in `makeTestNative` (`src/bun/test-native.ts`) and the `index.ts` native literal (`:354-387`). Those are its only implementers (grep).
- **CLI imports.** The CLI already imports `src/bun` modules (`src/cli/api-client.ts:5,32-33`), so it may reuse `src/bun/notifier.ts`.
- **Shared code** (`src/shared/`) must have zero runtime imports from either process.
- **sonner gotchas** (fleet KB `ae607d3e`). Clicking an action button does **not** fire `onDismiss`, so code that tracks slots must clear on the action click itself. A timed toast that expires fires `onAutoClose`, not `onDismiss`; verify against `node_modules/sonner` after `bun install`.
- **Existing e2e specs that assume per-task toast stacking:**
  - `e2e/pipelines-run.spec.ts:1551-1580` hovers a front "Pipeline needs you" toast to reach a files-sent toast **of the same pipeline** stacked behind it.
  - `e2e/pipelines-run.spec.ts:1289-1316` asserts that a run-view-only landing **leaves** the parent's "Waiting on you" toast up.
  - `e2e/sent-files.spec.ts:293-336` asserts the files-sent toast while the same task's success toast follows right behind.

  The one-per-task rule changes all three (see §8 Q1).
- **This worktree** has no `node_modules`. Run `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" && bun install` first.

## 3. Approach & key decisions

**Where each piece of logic lives:**

| Concern | Lives in | Why |
| --- | --- | --- |
| *When* to post (focus, selection) | webview (`toasts.ts`), unchanged shape | It already owns focus and selection state. |
| Per-task id, kind → urgency, sound-over table | `src/shared/os-notification.ts` (pure) | The webview, Bun and the CLI all need it, and it is unit-testable (D22). |
| Sound decision against what's delivered | helper (`notifier.swift`), driven by a Bun-built rule list | Only the helper can read Notification Center (D5: "unopened" = still delivered). Bun passes `--sound-over <urgency>...`, so the rule table stays in TS. |
| Per-task serialization, may-be-delivered set, fallbacks | `src/bun/task-notifier.ts` (new; replaces `showTaskNotification`) | It is testable with an injected spawn. `index.ts` keeps only the wiring. |
| Answered / left-blocked removal | `src/bun/notification-hooks.ts` (new), installed by `index.ts` | It is server-side, so CLI answers and terminal answers count (D6b). The desktop app installs it; the headless core never does. |
| Opened (panel / Mark as read) | `POST /tasks/:id/seen` → `native.removeTaskNotification` | One hook covers every caller of `/seen`. A step id maps to its parent (D16). |
| Pipeline run view opened, window focus (D6d), focused update (D7) | webview → new `DELETE /notifications/:taskId` | These are webview-only facts. |
| Archive / delete | the two routes, after success | No global event exists, and the routes are the only external entry points. |
| In-app slot | `src/mainview/lib/toast-slots.ts` (pure) + `toasts.ts` | The slot logic is unit-testable without sonner or the api. |

**Decisions and their basis:**

- **Fixed id `agetor.task.<taskId>`, not find-and-remove plus a fresh id** (evidence: spike). macOS itself guarantees replace-on-top. Find-by-url is used only for old-style entries (D10) and in remove mode.
- **The sound decision is made in the helper** (evidence plus reasoning).
  - Bun can't see entries the user cleared, and D5 needs that.
  - The urgency is stored in `userInfo`. An entry with no urgency (old-style, or posted before this change) reads as `unknown` and is treated like `quiet`. So a needs-you post over it dings, and a quiet post over it is silent.
- **Remove and list modes never call `requestAuthorization`** (reasoning). A removal on a fresh install must never pop the permission prompt. Without authorization the delivered list is just empty.
- **New helper modes are flag-gated (`--remove`, `--list`)** (reasoning). The no-arg click relaunch (`notifier.swift:65-71`) can't be mistaken for them.
- **A may-be-delivered set gates removal spawns** (reasoning; §8 Q2).
  - Without it, every panel switch, every unblock and every focused event spawns a helper process.
  - The set is a superset: posts add to it; an unconditional remove that exits 0 takes the task out.
  - It is seeded at boot from `notifier --list`, so entries posted before a restart are still removed on open.
  - Until the seed lands, or if it fails, nothing is skipped (correctness over cost).
- **An unconditional remove drops not-yet-started queued posts for that task** (reasoning). Opening the task makes them moot, and dropping them avoids a banner flashing up only to be removed.
- **CLI posts go to the core first** (reasoning; §8 Q3). `agetor logs --notify` sends `POST /notifications` to the core it's connected to. When that core is the desktop app, the post shares the app's queue and may-be-delivered set, so removing on open works for CLI posts too. When the core is headless (501), the CLI spawns the installed app's helper directly with the same argv. Otherwise it falls back to osascript. The terminal bell always rings (D11).
- **Removal is conditional where it must be.**
  - An answered question removes only kind `waiting`, and only when no other question is still pending for that task (for a parent, across its steps).
  - Leaving `blocked` removes kinds `waiting|blocked|api-error|session-ended|unknown-command`. This mirrors today's in-app `dismissPending` on `prev === "blocked"`.
  - Open, archive, delete, focus and D7 removals are unconditional.
- **Step tasks.** Opening a step panel removes the parent's entry (server-side mapping in `/seen` and `DELETE /notifications/:taskId`). A step's own `column` event never triggers a removal. Archiving or deleting a task removes only its own id; there is no step→parent mapping there, so a pipeline Restart's internal step archives can't wipe the parent's entry.
- **In-app slot semantics.**
  - Every event toast in `toasts.ts` claims the task's one slot: the previous toast is dismissed and the new one is shown at the front (D12/D13).
  - `hasPendingToast`/`dismissPending` keep their meaning: they read or clear the slot only when it holds a "reason" kind.
  - A new `dismissTaskToast` clears the slot unconditionally. It runs on open, archive and delete, and on a poll that shows the task archived or gone.

**Alternatives considered and rejected:**

- *Bun tracks urgency in memory.* It can't see user-cleared entries, which breaks D5.
- *`threadIdentifier` grouping.* It still stacks entries.
- *A new `GlobalEvent` kind for archive/delete.* It touches every union consumer for no gain over route-level hooks.
- *A long-lived helper daemon.* It is a bigger lifecycle change and needs a new signing/LaunchServices story.
- *macOS's `passive` interruption level for silent updates.* Rejected by the owner (D8).

## 4. Work breakdown — implementation tasks

### Pinned interfaces

Tasks in the same wave code against these signatures.

```ts
// src/shared/os-notification.ts (T1) — zero imports
export const NOTIFICATION_KINDS = ["waiting", "blocked", "api-error", "session-ended", "unknown-command",
  "failed", "succeeded", "files-sent", "pipeline-finished"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type NotificationUrgency = "needs-you" | "quiet";
export type DeliveredUrgency = NotificationUrgency | "unknown";   // "unknown" = entry without urgency (old-style)
export interface TaskNotificationRemoval { taskId: string; ifKinds?: readonly NotificationKind[] }
export function isNotificationKind(v: unknown): v is NotificationKind;
export function notificationUrgency(kind: NotificationKind | undefined): NotificationUrgency; // D4; undefined → "quiet"
export function soundOverUrgencies(u: NotificationUrgency): readonly DeliveredUrgency[];   // needs-you → ["quiet","unknown"], quiet → []
export function taskNotificationId(taskId: string): string;                                  // `agetor.task.${taskId}`
export const ANSWERED_REMOVAL_KINDS: readonly NotificationKind[];   // ["waiting"]
export const UNBLOCKED_REMOVAL_KINDS: readonly NotificationKind[];  // ["waiting","blocked","api-error","session-ended","unknown-command"]

// src/bun/notifier.ts (T3) — additions
export interface NotifierOptions { title: string; body?: string; subtitle?: string; silent?: boolean; url?: string;
  id?: string; kind?: NotificationKind; urgency?: NotificationUrgency; soundOver?: readonly DeliveredUrgency[] }
export function buildNotifierArgs(o: NotifierOptions): string[]; // existing order, then --id, --kind, --urgency, --sound-over×N
export function buildTaskNotifierPostArgs(n: { title: string; body?: string; subtitle?: string; silent?: boolean;
  taskId: string; kind?: NotificationKind }): string[];           // composes url, id, urgency, soundOver
export function buildNotifierRemoveArgs(o: { id: string; url: string; ifKinds?: readonly NotificationKind[] }): string[];
export function buildNotifierListArgs(): string[];                // ["--list"]
export function resolveInstalledAppNotifier(): string | null;     // AGETOR_NOTIFIER_BIN ?? /Applications/Agetor.app/.../notifier if it exists

// src/bun/server.ts (T9) — ApiNative changes
showNotification(n: { title: string; body?: string; subtitle?: string; silent?: boolean; taskId?: string; kind?: NotificationKind }): void;
removeTaskNotification(r: TaskNotificationRemoval): void;

// src/bun/task-notifier.ts (T5)
export function createTaskNotifier(deps: { plain: (n: TaskNotification) => void; resolveBin?: () => string | null;
  spawn?: (argv: string[], opts: { stdout: "pipe" | "ignore" }) => { exited: Promise<number>; stdout?: ReadableStream<Uint8Array> | null };
  log?: (msg: string, err?: unknown) => void }): {
  post(n: TaskNotification): void; remove(r: TaskNotificationRemoval): void; seed(): Promise<void>; whenIdle(): Promise<void> };
// TaskNotification = ApiNative.showNotification's argument

// src/bun/notification-hooks.ts (T6)
export function notificationTargetTaskId(taskId: string): string;   // step → its pipeline parent (tasks.get); else itself
export function pendingInteractionsFor(taskId: string): number;     // own + every step's, for a parent
export function removalForEvent(ev: GlobalEvent, deps?: { pendingFor?: (taskId: string) => number }): TaskNotificationRemoval | null;
export function installNotificationRemovalHooks(remove: (r: TaskNotificationRemoval) => void): () => void;

// webview api.ts (T7)
notifyOS(input: { title: string; body?: string; subtitle?: string; silent?: boolean; taskId?: string; kind?: NotificationKind });
clearTaskNotification(taskId: string): Promise<{ ok: boolean }>;   // DELETE /notifications/:taskId

// toasts.ts (T7) — additions; existing exports keep their signatures
toastSuccess(args: ToastArgs & { kind?: "succeeded" | "pipeline-finished" }): void;
dismissTaskToast(taskId: string): void;
dismissTaskToastsFor(taskIds: Iterable<string>): void;
```

### Helper CLI contract

T2 implements this; the T3/T5/T8 argv builders follow it.

```
notifier --title <t> --message <m> [--subtitle <s>] [--url <agetor://task/…>] [--silent]
         [--id <identifier>] [--kind <kind>] [--urgency needs-you|quiet] [--sound-over <urgency>]…
notifier --remove --id <identifier> [--url <agetor://task/…>] [--if-kind <kind>]…
notifier --list
notifier                      # no args: click relaunch, unchanged
exit: 0 ok · 1 remove/list safety timeout · 2 post permission denied/timeout (as today) · 64 usage (--remove without --id)
```

### Tasks

| ID | Goal | Owned files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Shared notification policy. Implements the pinned module exactly. Kind → urgency per D4: `waiting`, `blocked`, `api-error`, `session-ended`, `unknown-command`, `failed` are needs-you; `succeeded`, `files-sent`, `pipeline-finished` are quiet. Doc comments cite D1–D5 and D10. | `src/shared/os-notification.ts` (new) | — | Exports match the pinned block. No imports. TT1 passes. |
| T2 | **Helper.** Per-task id, a sound decision read from the delivered list, old-style cleanup, and the remove and list modes. | `native/notifier/notifier.swift` | — (contract pinned above) | See the T2 detail below. |
| T3 | **Argv builders and app-helper resolution.** | `src/bun/notifier.ts` | T1 (same wave, pinned) | See the T3 detail below. |
| T4 | **D9 fix.** | `src/bun/orchestrator.ts`, `src/bun/interactions.ts` | — | See the T4 detail below. |
| T5 | **Task notifier module.** Replaces `showTaskNotification`. | `src/bun/task-notifier.ts` (new) | T1, T3 | See the T5 detail below. |
| T6 | **Reason-gone removal hooks.** | `src/bun/notification-hooks.ts` (new) | T1, T4 | See the T6 detail below. |
| T7 | **Webview one-per-task slot and API.** | `src/mainview/lib/toast-slots.ts` (new), `src/mainview/lib/toasts.ts`, `src/mainview/lib/api.ts` | T1 | See the T7 detail below. |
| T8 | **CLI `logs --notify` through Agetor's helper.** | `src/cli/notify.ts`, `src/cli/commands/logs.ts`, `src/cli/api-client.ts` | T1, T3 | See the T8 detail below. |
| T9 | **Server routes and the native interface.** | `src/bun/server.ts`, `src/bun/test-native.ts` | T1, T6 (`notificationTargetTaskId`) | See the T9 detail below. |
| T10 | **Desktop wiring.** | `src/bun/index.ts` | T5, T6, T9 (same wave, pinned `ApiNative`) | See the T10 detail below. |
| T11 | **App.tsx triggers.** | `src/mainview/App.tsx` | T7 | See the T11 detail below. |
| T12 | **Docs (D20).** | `docs/qa/native-notifier-qa.md`, `CLAUDE.md`, `electrobun.config.ts` | T1–T11 | See the T12 detail below. |

#### T2 — Helper

What to build:

- **Parsing.** Parse the new flags (`--sound-over` and `--if-kind` are repeatable) and keep ignoring unknown flags. Pick the mode in this order: `--list`, `--remove`, post (title present), otherwise relaunch.
- **Post with `--id`:**
  1. `requestAuthorization`, then `getDeliveredNotifications`.
  2. The *existing* entry is the one whose identifier equals `--id`. *Old-style* entries are those whose `userInfo.url` equals `--url` and whose identifier differs.
  3. `existingUrgency` = the existing entry's `userInfo["urgency"]`; else `"unknown"` if an existing or old-style entry is present; else nil.
  4. `playSound = !silent && (existingUrgency == nil || soundOver.contains(existingUrgency))`.
  5. Remove the old-style ids.
  6. `content.sound = playSound ? .default : nil`. `userInfo` gets `url`, `kind` and `urgency` (only the keys that were passed).
  7. Add the request with identifier `--id`, then exit 0 after 0.3 s.
  8. `willPresent` returns `[.banner, .sound]` only when `playSound`.
- **Post without `--id`:** exactly today's behavior (UUID id, no delivered query).
- **Remove mode:**
  - No `requestAuthorization`.
  - Targets are the entries whose identifier equals `--id`, plus the entries whose url equals `--url`.
  - With `--if-kind`, keep only the targets whose `userInfo.kind` is listed. Old-style entries carry no kind, so they never match.
  - Call `removeDeliveredNotifications(withIdentifiers:)`, print `removed <n>`, exit 0 after 0.3 s. Safety exit after 10 s with code 1.
  - `--remove` without `--id` exits 64.
- **List mode:** no auth. Print each distinct `agetor://` url among the delivered entries, one per line. Flush stdout, then exit 0. Safety exit after 10 s with code 1.
- **Docs.** Update the header contract comment. The click path (`didReceive`) is unchanged.

Acceptance:

- `bun run vendor:notifier` builds an arm64, ad-hoc-signed helper with no new warnings.
- A launch with no args still waits for `didReceive`; `--remove` or `--list` never does.
- The implementer's local smoke (§5 run recipe, "helper smoke") shows one entry after two same-id posts, `--list` prints the url, and `--remove` clears it.

#### T3 — Argv builders and app-helper resolution

What to build:

- Extend `NotifierOptions` and `buildNotifierArgs`, appending the new flags after the existing ones so the old order is unchanged.
- Add `buildTaskNotifierPostArgs`, built on `buildTaskDeepLink`, `taskNotificationId`, `notificationUrgency` and `soundOverUrgencies`.
- Add `buildNotifierRemoveArgs`, `buildNotifierListArgs` and `resolveInstalledAppNotifier`. Its path is `/Applications/Agetor.app/Contents/Resources/app/bin/AgetorNotifier.app/Contents/MacOS/notifier`, and `AGETOR_NOTIFIER_BIN` wins.
- Fix the header comment.

Acceptance: TT2 passes. Existing callers still compile.

#### T4 — D9 fix

What to build:

- Delete the second `setResolvedBroadcaster` block (`orchestrator.ts:744-758`) so `wireInteractionBroadcast()`'s resolved bridge, the per-task SSE emit **plus** the global emit, stays installed. Update the doc comment above `wireInteractionBroadcast`.
- `setBroadcaster` and `setResolvedBroadcaster` now **return the previously installed fn**, so a test can restore it. Existing callers ignore the return value.

Acceptance:

- A fresh process that imports `orchestrator.ts`, then registers and cancels a prompt, sees global `pending` **and** `resolved` events (TT3).
- The RunPanel's `interaction_resolved` SSE event is still emitted once (no duplicate).

#### T5 — Task notifier module

What to build:

- **Post with a taskId and a helper.** Enqueue a post running `buildTaskNotifierPostArgs`. Exit 0 → done; exit 2 → log, no fallback; any other exit, a rejection or a synchronous throw → `plain(n)`. These fallback semantics are copied from `index.ts:268-325`. Add the task to `maybeDelivered` when the post is enqueued.
- **Post with no taskId, or no helper:** `plain(n)` immediately.
- **Remove.** No helper → no-op. If the set is seeded and doesn't contain the task → skip. Otherwise enqueue.
  - An **unconditional** remove first drops any not-yet-started queued posts for that task, and takes the task out of `maybeDelivered` on exit 0.
  - A **conditional** remove leaves the set alone.
- **Queue.** One FIFO per task, with at most one helper child per task at a time (await `exited`). Different tasks run in parallel. Removal argv is `buildNotifierRemoveArgs({ id: taskNotificationId(taskId), url: buildTaskDeepLink(taskId), ifKinds })`.
- **`seed()`.** Run `--list` with `stdout: "pipe"` and parse each line with `parseTaskDeepLink`.
  - On exit 0, merge the ids into the set and mark it seeded.
  - On a failure, log it and stay unseeded, which means removals are never skipped.
  - `seed()` is idempotent.
- **`whenIdle()`.** Resolves once every queue is drained (a test seam).
- **No Electrobun import**, so the module works under `bun test`.

Acceptance: TT4 passes. The module imports nothing from `electrobun`.

#### T6 — Reason-gone removal hooks

What to build — `removalForEvent`:

- An `interaction` event with `state === "resolved"`:
  - The target is `ev.pipelineParentId ?? ev.taskId`.
  - If `pendingFor(target) > 0`, return null.
  - Otherwise return `{ taskId: target, ifKinds: ANSWERED_REMOVAL_KINDS }`.
- A `column` event where `prev === "blocked"`, `column !== "blocked"` and the event has no `pipelineParentId`: return `{ taskId: ev.taskId, ifKinds: UNBLOCKED_REMOVAL_KINDS }`.
- Anything else: null.

The other functions:

- `pendingInteractionsFor` uses `countPendingForTask`, plus `tasks.stepsForParent` for a pipeline parent (same union as `server.ts:6476-6492`).
- `notificationTargetTaskId` reads `tasks.get(id)?.pipelineParentId`. An unknown id is returned unchanged.
- `install…` calls `subscribeGlobal` and returns the unsubscribe function.
- No side effects at module load.

Acceptance: TT5 passes.

#### T7 — Webview one-per-task slot and API

What to build:

- **`toast-slots.ts`** (pure): a `TaskToastSlots` keyed by taskId holding `{ id, kind }`, with `set`, `get`, `release(taskId, id)` (clears only when the id is still current), `take(taskId, { onlyReason })` and `isReason(taskId)`. Reason kinds are `UNBLOCKED_REMOVAL_KINDS`. Slot kinds are `NotificationKind | "send-failed" | "fx-auto-resume-fired" | "fx-auto-resume-exhausted"`.
- **`toasts.ts`.** Replace `pendingByTask` with the slot, and route every event toast through one `showTaskToast(taskId, kind, show)` helper. The helper:
  - dismisses the prior toast;
  - shows the new one;
  - releases the slot on `onDismiss`, on `onAutoClose`, **and** from the wrapped action `onClick` (the sonner gotcha);
  - keeps today's `isSelected` and focus gates per helper unchanged.
- **Kinds per helper.** `toastSuccess` → `kind ?? "succeeded"`; `toastError` → `failed`; `toastPending` → `blocked`; `toastApiError` → `api-error`; `toastSessionEnded` → `session-ended`; `toastUnknownCommand` → `unknown-command`; `notifyWaitingInput` → `waiting`; `notifyFilesSent` → `files-sent`. The toast-only kinds are `toastSendFailed` and the two fx ones.
- **`maybeNotifyOS`** sends `kind`. When `isFocused && !force` it calls `api.clearTaskNotification(taskId)` instead of posting (D7), fire-and-forget.
- **`notifyFilesSent`** always calls `maybeNotifyOS(..., { force: proactive })`, so the focused, not-proactive case clears (D7). `shouldNotifyOsFilesSent` is equivalent to that gate, so the forced proactive post is unchanged.
- **`hasPendingToast` / `dismissPending`** keep their contract through `isReason`/`take({ onlyReason: true })`. `dismissTaskToast` and `dismissTaskToastsFor` are unconditional. Rewrite the block comment at `:25-33`.
- **`api.ts`:** `notifyOS` gains `kind`; add `clearTaskNotification`.

Acceptance:

- TT6 passes. Typecheck is green.
- No caller of `hasPendingToast`/`dismissPending` changes behavior for pending-family toasts.
- Two event toasts for one task never coexist.

#### T8 — CLI `logs --notify` through Agetor's helper

What to build:

- **`notifyFor`** also returns `kind`:
  - `succeeded` → `succeeded`; `failed` → `failed`; `orphaned` → `failed`;
  - `blocked` → `api-error` / `session-ended` / `unknown-command` by its reason, else `blocked`.
- **`osNotify(n: { title; body; taskId?; kind? }, deps?)`** returns `Promise<void>` and never throws. It always writes the bell, then tries, in order:
  1. `deps.notifyCore` (`client.notifyOS`) when a taskId is given;
  2. on any error (501 or otherwise), the direct helper: `resolveInstalledAppNotifier()` + `buildTaskNotifierPostArgs`, serialized per process;
  3. osascript (today's code).

  The deps also take seams for the helper resolver, spawn and the bell.
- **`logs.ts`** passes `{ taskId: task.id, kind }` and `notifyCore: (i) => client.notifyOS(i)`, and doesn't await the call.
- **`api-client.ts`** gains `notifyOS`.

Acceptance:

- TT7 passes.
- With no core route and no installed app, the behavior is today's (bell + osascript).
- `agetor logs --help` text is still accurate (verify `src/cli/usage.ts`; change it only if it names osascript).

#### T9 — Server routes and the native interface

What to build:

- **`ApiNative`.** Add `kind` to `showNotification` and add `removeTaskNotification`. Fix the stale terminal-notifier comment.
- **`POST /notifications`** reads `kind` through `isNotificationKind`; an invalid kind is dropped.
- **New `DELETE /notifications/:taskId`:**
  - authed;
  - 501 headless;
  - an id over 512 chars is a 400;
  - maps through `notificationTargetTaskId`, calls `native.removeTaskNotification({ taskId })`, and returns `{ ok: true }`.
- **`POST /tasks/:id/seen`:** on success, `native?.removeTaskNotification({ taskId: notificationTargetTaskId(id) })`. The `DELETE /tasks/:id/seen` variant ("mark unread") does not.
- **`DELETE /tasks/:id`** after `deleteTask`, and **`POST /tasks/:id/archive`** on success: `native?.removeTaskNotification({ taskId: req.params.id })`.
- **`makeTestNative`** defaults `removeTaskNotification: () => {}`.

All native calls are fire-and-forget and never change a response.

Acceptance: TT8 passes, and the existing `notifications.test.ts` and `headless-routes.test.ts` cases still pass.

#### T10 — Desktop wiring

What to build:

- Replace `showTaskNotification` with `const taskNotifier = createTaskNotifier({ plain: (n) => Utils.showNotification({...}) })`.
- Call `void taskNotifier.seed()` after `registerNotifierBundle()`.
- Wire `native.showNotification = (n) => taskNotifier.post(n)` and `native.removeTaskNotification = (r) => taskNotifier.remove(r)`.
- Call `installNotificationRemovalHooks((r) => taskNotifier.remove(r))` before `startApiServer`.
- Remove the now-unused imports.

Acceptance:

- `bun run typecheck` is green.
- The app boots in `bun run dev` (dev data dir) and posts a notification for a background task that finished (owner QA).

#### T11 — App.tsx triggers

What to build:

- **Pipeline done** (`:1492`) passes `kind: "pipeline-finished"`.
- **Panel open** (the `:951-957` effect):
  - `dismissTaskToast(selected.id)`;
  - for any step, also `dismissTaskToast(selected.pipelineParentId)` (D16). This replaces the "only when asking" condition.
- **Run view open.** A new effect keyed on `view.kind === "pipeline-run" ? view.taskId : null` calls `api.clearTaskNotification(id)` fire-and-forget, plus `dismissTaskToast(id)` (§8 Q1: the owner chose to dismiss).
- **Window focus.** A new `focus` listener: when `selectedIdRef.current` is set, call `api.clearTaskNotification(it)` (the server maps a step to its parent). When the view is a pipeline run view, clear that parent. It does **not** mark the task seen.
- **Mark as read** (`markRead`) also calls `dismissTaskToast(t.id)`. The OS side is handled by `/seen`.
- **`archive` and `del`** call `dismissTaskToast(t.id)`.
- **Poll sweep.** In `refresh` after reconcile, dismiss the slots of tasks that the new list shows archived, or that were in the previous list and are absent now. Never a task that simply hasn't been polled yet.

Acceptance:

- Typecheck is green.
- TT9's in-app scenarios pass.
- The existing App behavior for `hasPendingToast` suppression and attention landings is unchanged apart from §8 Q1.

#### T12 — Docs (D20)

What to change:

- **QA checklist.** Add a "One notification per task" section:
  - two events → one entry on top;
  - sound only on first;
  - quiet → needs-you dings;
  - a silent banner shows (the `sound = nil` assumption);
  - the Alerts style replaces too;
  - each removal case: open panel, run view, step panel, Mark as read, answered from the CLI, left blocked, archive and delete from the CLI, focus with the panel open, focused update;
  - old-style cleanup;
  - `agetor logs --notify` collapses with app posts;
  - the cross-update item marked unverified (D19/D23);
  - the LaunchServices dev-copy caveat.
- **CLAUDE.md.** Add a concise "Native notifications" entry (helper contract, fixed id, sound rule, removal triggers, may-be-delivered set, test seams), mirroring the house style.
- **`electrobun.config.ts:8-13`.** Fix the comment to name the AgetorNotifier helper instead of terminal-notifier.

Acceptance: the docs match the shipped behavior; there are no real company or ticket names (memory rule).

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| TT1 | unit | T1 | `src/shared/os-notification.test.ts` (new) | Covers: D4 urgency for every kind plus `undefined`; `soundOverUrgencies` for both urgencies; `taskNotificationId`; `isNotificationKind` (valid, invalid, non-string); both removal kind sets. |
| TT2 | unit | T3 | `src/bun/notifier.test.ts` | Covers: the updated "full combo" argv with the new flags in pinned order; `buildTaskNotifierPostArgs` for a needs-you kind (two `--sound-over`) and for a quiet kind (none); remove argv with and without `--if-kind`; list argv; `resolveInstalledAppNotifier` env override. Every existing assertion still holds. |
| TT3 | unit + integration | T4 | `src/bun/global-events.test.ts`, `src/bun/interactions.test.ts`, `src/bun/interaction-broadcast-wiring.test.ts` (new) | See the TT3 detail below. |
| TT4 | unit | T5 | `src/bun/task-notifier.test.ts` (new) | See the TT4 detail below. |
| TT5 | unit + integration | T6 | `src/bun/notification-hooks.test.ts` (new; mkdtemp `AGETOR_DATA_DIR`, `rmTestDataDir` cleanup) | See the TT5 detail below. |
| TT6 | unit | T7 | `src/mainview/lib/toast-slots.test.ts` (new) | Covers: `set` replaces and returns or keeps the prior id; `release` is id-guarded; `take({ onlyReason })` takes reason kinds only; `isReason` per kind. |
| TT7 | unit | T8 | `src/cli/notify.test.ts`, `src/cli/logs.test.ts` | Covers: `notifyFor` kinds per status and reason; the `osNotify` order (core ok → no helper and no osascript; core error → helper argv; no helper → osascript); the bell always rings; direct-helper posts serialized per process; `logs --notify` wires `notifyCore` and the task id. |
| TT8 | integration (HTTP) | T9 | `src/bun/notifications.test.ts`, `src/bun/headless-routes.test.ts` | See the TT8 detail below. |
| TT9 | e2e | T7, T9, T11 (+ T4 via behavior) | `e2e/one-notification-per-task.spec.ts` (new), `e2e/sent-files.spec.ts`, `e2e/pipelines-run.spec.ts` | See the TT9 detail below. |

**TT3 detail:**

- The new test spawns `process.execPath -e <script>` with `cwd` at the repo root and a fresh mkdtemp `AGETOR_DATA_DIR`. The script imports `./src/bun/orchestrator.ts` and `./src/bun/interactions.ts`, subscribes globally, registers a prompt and cancels it. The test asserts the script printed `pending` **and** `resolved`. This pins production wiring with nothing re-wired.
- `global-events.test.ts` no longer calls `wireInteractionBroadcast()`.
- `interactions.test.ts` restores every broadcaster it overrides, using the returned previous fn in `finally`.
- The suite passes in any file order.

**TT4 detail:**

- Uses a fake spawn and resolver.
- Per-task serialization: the second spawn waits for the first's `exited`. Two tasks run concurrently.
- An unconditional remove drops queued, unstarted posts.
- Skip-set:
  - an unseeded remove spawns;
  - a seeded remove for an unknown task skips;
  - a post adds the task;
  - an exit-0 unconditional remove takes it out;
  - a conditional remove keeps it.
- `seed()` parses url lines and ignores junk; a failed seed stays unseeded.
- Fallbacks: exit 2 means no plain; exit 1, a rejection or a throw means plain once; no taskId or no helper means plain.
- Argv contents: id, url, kind, urgency, sound-over.

**TT5 detail:**

- Pure cases:
  - resolved with no pending → `waiting` removal;
  - resolved with one still pending → null;
  - a step resolved → the parent id, pending counted across steps;
  - leaving blocked → the unblocked kinds;
  - a step's column event → null;
  - pending or other kinds → null.
- Integration: `installNotificationRemovalHooks(recorder)` plus a real `registerTmuxPrompt`/`cancelPendingForTask` records exactly one `waiting` removal (this needs T4). Two stacked prompts cancelled one at a time record a removal only after the last. Unsubscribe stops recording.

**TT8 detail:**

- `POST /notifications` threads a valid `kind` and drops an invalid one.
- `DELETE /notifications/:taskId`:
  - 401 without a token;
  - 400 for an over-length id;
  - calls `removeTaskNotification` with the id, and with the **parent** id for a step row.
- `POST /tasks/:id/seen` calls the removal (step → parent); `DELETE …/seen` doesn't.
- `DELETE /tasks/:id` and `POST /tasks/:id/archive` call the removal with the task's own id. A failed archive (400) doesn't.
- Rows are created via `tasks.insert` or `createTask({ isolation: "none" })` and cleaned up.
- Headless: `DELETE /notifications/x` → 501.

**TT9 detail:**

- **New spec:**
  - (a) A task's files-sent toast is replaced by its "Task succeeded" toast. Exactly one `[data-sonner-toast]` names the task.
  - (b) Opening the card dismisses that task's toast.
  - (c) With `document.hasFocus` overridden to `false` through `addInitScript`, a `page.route` capture of `POST /notifications` records `taskId` with `kind:"files-sent"`, then `"succeeded"`.
  - (d) With focus `true`, no POST is made and a `DELETE /notifications/<id>` request is captured.
  - (e) Opening a pipeline run view captures `DELETE /notifications/<parentId>`.
  - (f) Dispatching `focus` with a panel open captures `DELETE /notifications/<id>`.
- **`sent-files.spec.ts`** gets a resolve delay so the files-sent toast is observable before the success replaces it.
- **`pipelines-run.spec.ts`:**
  - `:1551-1580` clicks the files-sent toast's Open before the block replaces it (resolve delay), with no hover-the-front workaround;
  - `:1289-1316`: after the run-view-only landing, the parent's toast is **gone** (§8 Q1), and the asking node still reads Answer.
- Every other spec stays unchanged.

**E2e applies** to the in-app slot, the webview → `/notifications` and `DELETE /notifications/:id` requests, the run view and focus triggers, and the pipeline toast interplay. Real Notification Center behavior is **not** e2e-observable: the headless backend 501s, and UN needs a signed bundle. That part is covered by the Bun tests above plus the owner's manual QA on a dev-built helper (D23).

**Run recipe:**

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
bun install                                   # this worktree has no node_modules
bun run typecheck
bun test src/shared/os-notification.test.ts src/bun/notifier.test.ts src/bun/task-notifier.test.ts \
  src/bun/notification-hooks.test.ts src/bun/interaction-broadcast-wiring.test.ts src/bun/global-events.test.ts \
  src/bun/interactions.test.ts src/bun/notifications.test.ts src/bun/headless-routes.test.ts \
  src/mainview/lib/toast-slots.test.ts src/cli/notify.test.ts src/cli/logs.test.ts
bun test                                      # full; pre-existing failures: tmux-socket ×2 + a reconcile cancel test (memory) — report, don't "fix"
bun node_modules/@playwright/test/cli.js test e2e/one-notification-per-task.spec.ts e2e/sent-files.spec.ts e2e/pipelines-run.spec.ts
bun node_modules/@playwright/test/cli.js test # full suite; one Playwright run at a time
bun run vendor:notifier                       # helper compiles + ad-hoc signs (needs xcrun swiftc)
```

- **App and services.** Playwright's `webServer` starts Vite (`bun run hmr`). `e2e/fixtures.ts` starts a per-worker headless backend with fake drivers. No credentials or seed data are needed beyond what each spec creates over REST.
- **Load.** Under heavy machine load `bun test src/cli` can stall (memory). Check `uptime` and serialize suite runs.
- **Helper smoke** (T2 implementer, optional, pops real banners on this Mac):
  1. Run `vendor/notifier/AgetorNotifier.app/Contents/MacOS/notifier --title "Smoke 1" --message a --url agetor://task/smoke-1 --id agetor.task.smoke-1 --kind succeeded --urgency quiet` twice.
  2. Run `--list`; it prints `agetor://task/smoke-1` once.
  3. Run `--remove --id agetor.task.smoke-1 --url agetor://task/smoke-1`; a new `--list` prints nothing.
  4. Clean up LaunchServices: `lsregister -u <worktree>/vendor/notifier/AgetorNotifier.app`, then `lsregister -f /Applications/Agetor.app/Contents/Resources/app/bin/AgetorNotifier.app` (as in the investigation's hygiene).
  5. Never point anything at `~/.agetor`.

## 6. Execution waves

| Wave | Tasks (parallel) | Barrier (checkpoint commit when green) |
| --- | --- | --- |
| 1 | T1, T2, T3, T4, TT1, TT2, TT3 | `bun install`; `bun run typecheck`; the focused tests for TT1–TT3; full `bun test`; `bun run vendor:notifier` builds. |
| 2 | T5, T6, T7, T8, TT4, TT5, TT6, TT7 | typecheck; the focused tests for TT4–TT7; full `bun test`. |
| 3 | T9, T10, T11, TT8 | typecheck; TT8; full `bun test`. |
| 4 | TT9, T12 | typecheck; full `bun test`; the targeted Playwright specs, then the full e2e suite; `bun run vendor:notifier`. |

- **No file is owned twice within a wave.** Cross-checked:
  - Wave 1: `os-notification.ts`, `notifier.swift`, `notifier.ts`, `orchestrator.ts` + `interactions.ts`, and four disjoint test files.
  - Wave 2: four new or disjoint source sets and four disjoint test sets.
  - Wave 3: `server.ts` + `test-native.ts`, `index.ts`, `App.tsx`, and two test files.
  - Wave 4: three e2e files plus three doc files.
- **Same-wave coupling** relies only on the pinned interfaces in §4 (T3 on T1; T10 on T9's `ApiNative`). Every barrier is expected green. No red barrier is planned.
- **Spillover.** If a wave-1 task finds that the D9 fix changes another test's expectations (for example a webview e2e that relied on the toast lingering), it reports it, and the fix lands in wave 4's TT9. A barrier is never left red.

## 7. Blast radius & risks

- **Interaction bus (T4).** The RunPanel per-task `interaction_resolved` emit stays, now through `wireInteractionBroadcast`'s single bridge. The webview tracker now receives `resolved` events: "Waiting on you" clears on answer, and a second question in the same run alerts (D9, intended). Pipeline toast suppression (`hasPendingToast`) is re-tested by TT9.
- **Volume.** D9 adds second-question alerts, and the CLI can post through the core. D1/D2 contain both: one entry, silent repeats.
- **Click relaunch.** The new modes are flag-gated; a no-arg launch is unchanged. Covered by the QA item and T2's acceptance.
- **The permission prompt** can come only from a post, never from remove or list (T2).
- **First-run permission wait.** A post waiting on the first-run prompt (up to 120 s) holds that task's queue. Other tasks are unaffected, and later ops for the task run once it settles. Accepted.
- **Process cost.** Removals are gated by the may-be-delivered set; the boot seed is one `--list` spawn. If the seed fails, removals spawn every time. That is correct, just costlier.
- **Signing scope.** A dev-built helper can't see production entries and vice versa (spike). The owner's QA runs on a dev build (D23). The cross-update leftover is possible (D19).
- **LaunchServices.** A worktree-built helper self-registers with the production bundle id and could catch production click relaunches. This is pre-existing; the smoke recipe includes cleanup and the QA doc notes it.
- **Fallback.** `Utils.showNotification` is still not deduped (D18).
- **E2e behavior shifts.** The three pinned assertions in §2 are rewritten under owner decisions D12/D16 (§8 Q1). They are not loosened.
- **Rollback.** Pure code: no migration, no persisted state. Reverting restores stacking. Already-delivered fixed-id entries behave like old-style ones to an older helper (they stay until cleared).
- **Notarization.** The helper is rebuilt by `bun run build` as today (`scripts/build-notifier.ts`). There is no signing pipeline change.

## 8. Open questions / assumptions

**Decided by the owner when approving this plan** (2026-10-20, all recommended options):

- **Q1. Pipeline run view vs. the parent's in-app toast → dismiss it.** Opening the run view counts as opening the task for the in-app toast too (D6a/D12/D16 read literally). TT9 rewrites the assertion at `e2e/pipelines-run.spec.ts:1308`: the toast is gone after a run-view-only landing. The OS entry is removed either way.
- **Q2. Track possible entries.** Use the may-be-delivered set, seeded at launch from `notifier --list`. Do not spawn the helper on every removal.
- **Q3. CLI posts go through the running app first.** Order: the core's `POST /notifications`, then the installed app's helper directly when the core is headless, then osascript.
- **Plan approved** for the Implementing step.

**Proceeding on** (from the grill, with no new evidence):

- A `sound = nil` replacement still shows a banner on macOS 26 (QA item).
- The Alerts style replaces the same way banners do (QA item).
- Developer-ID builds share the delivered list across releases. Unverified; owner-deferred (D19/D23).
- A forced proactive "Files sent" while focused still posts under the D1–D4 rules. The D7 removal applies only when no post would happen.
- `hasPendingToast` suppression follows the one-slot rule. After a quiet toast replaces a needs-you toast, a later "Pipeline needs you" toasts again, replacing it. There is no stacking.

**Plan-level choices** (reasoning; reversible):

- An entry with no urgency (old-style) counts as `unknown`, which is treated like `quiet` for escalation.
- An absent or invalid `kind` → urgency `quiet`, and no kind is stored (so a conditional removal never matches it).
- An unconditional remove drops queued, unstarted posts.
- Focus (D6d) clears the notification but does not mark the task seen.
- The pipeline run view clears through `DELETE /notifications/:id`, not `/seen`.
- The in-app poll sweep is restricted to tasks seen in the previous poll or now archived, so a task that hasn't been polled yet can't lose its toast.

**Code-review round 1 fixes** (after wave 4):

- A forced focused post survives D7. `FocusedForcedPosts` (`toast-slots.ts`) remembers a task whose forced post (a proactive "Files sent") went out while focused; that task's later focused events skip the D7 clear (and so no longer drop the queued post) until the task is opened, marked read, archived or deleted, or an unfocused post replaces the entry. D6d still clears it, since the task is then open on screen.
- An owed "Pipeline needs you" is re-raised. When a step's retargeted "Waiting on you" suppressed or displaced the parent's block alert, `OwedPipelineAlerts` records it; once the question is answered and no reason toast holds the slot, App.tsx raises the alert (toast plus OS post when unfocused) if the run is still blocked on something other than the answered step's own `step-blocked` block or a block naming a step that is `running` again (the runner clears such a block asynchronously, under the parent's pipeline lock, so the parent's row can lag behind the step's own `running` column event). The debt is dropped when the run leaves `blocked`.
- Stale helpers are detected. The helper acks every mode on stdout (`posted <id>`, `removed <n>`, an `agetor-notifier list` header). An exit 0 without the ack can mean a helper from before this plan. An unacked `--list` proves it; an unacked post or `--remove` only starts a `--list` probe (one at a time), since a current helper can also exit 0 early when a notification click reaches it, and a failed probe proves nothing. Once proven, Bun logs once, skips later removals (each would wait 10 s for nothing), leaves the seed failed and keeps posting.

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| Random request id in `notifier.swift` | In | T2 |
| Remove mode that can't look like a click relaunch | In | T2 |
| Sound decision from the delivered list; urgency/kind in `userInfo` | In | T2, T1, T3 |
| Old-style (UUID) entry cleanup on the next post, and on unconditional remove | In | T2 |
| Argv contract + "full combo" test | In | T3, TT2 |
| Per-task serialization (D15) | In | T5, TT4 |
| `ApiNative.removeTaskNotification`, `makeTestNative`, index.ts native, headless 501 | In | T9, T10, TT8 |
| Stale terminal-notifier comment on `ApiNative.showNotification` | In | T9 |
| Removal on open: `/seen` (panel + Mark as read), step → parent | In | T9, TT8 |
| Removal on pipeline run view open | In | T11, T9 (route), TT9 |
| Removal on window focus with the task open (D6d) | In | T11, TT9 |
| Removal when answered (any client) / left blocked, conditional on kind | In | T6, T10, TT5 |
| Removal on archive/delete from any client | In | T9, TT8 |
| Focused-window update removes the entry (D7) | In | T7, TT9 |
| Interaction "resolved" global event (D9) + tests no longer hiding it | In | T4, TT3 |
| `interactions.test.ts` leaking broadcaster overrides (would re-hide D9) | In | T4 (setters return the previous fn), TT3 |
| CLI `logs --notify` through the helper (D11) | In | T8, TT7 |
| One-per-task in-app slot for every event toast (D12/D13) | In | T7, TT6 |
| `hasPendingToast`/`dismissPending` callers stay correct | In | T7, T11, TT9 |
| sonner action-click/auto-close not releasing the slot | In | T7, TT6 |
| In-app toast dismissal on archive/delete and on a poll showing the task archived or gone | In | T11 |
| `pipeline-finished` kind for the pipeline done toast | In | T11 |
| E2e specs that pin per-task stacking (`sent-files.spec.ts:293`, `pipelines-run.spec.ts:1289,1551`) | In | TT9 (§8 Q1) |
| QA checklist, CLAUDE.md entry, `electrobun.config.ts` comment (D20) | In | T12 |
| `src/cli/usage.ts` `--notify` wording | In (verify; edit only if it names osascript) | T8 |
| Webview e2e for real Notification Center behavior | Out of scope | Not observable headless; Bun tests + owner QA (D22/D23) |
| `README.md:65` wording | Out of scope | Still accurate (grill) |
| `docs/plans/native-notifier-helper.md` | Out of scope | Historic plan record |
| Dedupe for the `Utils.showNotification` fallback | Out of scope | Electrobun FFI has no identifier control (D18) |
| Verifying Developer-ID builds share the delivered list across releases | Owner-deferred | Owner, grill D23: check on the next signed release |
| Removing CLI-posted entries when only the headless daemon runs | Out of scope | The headless core has no native bridge (grill) |
| Notifying fewer event kinds (e.g. intermediate Claude turns) | Out of scope | Different ticket (grill) |
| Action-feedback toasts in `App.tsx` | Out of scope | Not task events (D13) |
| `threadIdentifier` grouping | Out of scope | Not needed with one entry per task |
| TUI OS notifications | Out of scope | The TUI posts none (`src/cli/tui/useGlobalEvents.ts`) |
| Pipeline restart/cascade archiving steps → removal | Not needed | Steps never own an entry; removal keys on the archived task's own id (§3) |
| `scripts/build-notifier.ts`, `scripts/verify-release.ts` | No change | They compile and sign whatever `notifier.swift` contains |
| Orphaned code | None | `UUID()` stays the id-less fallback; `showTaskNotification` moves into T5 |

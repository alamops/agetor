# Grill — one macOS notification per task (no duplicate stacking)

| Field | Value |
| --- | --- |
| Date | 2026-10-20 |
| Source | Pipeline "Alamo Pipeline (No Video)" overall goal + investigation brief `docs/plans/duplicated-macos-notifications-investigation.md` |
| Mode | interactive, answered by the owner (5 question rounds, including one contradiction check) |
| Flags | none |

## Ground truth carried in from the investigation (not re-asked)

- Root cause: `native/notifier/notifier.swift:92-93` posts every request with `UUID().uuidString`, so every event for a task becomes a new Notification Center entry.
- Proved on macOS 26.6.2: re-adding a request with the **same identifier** from a **new helper process** removes the delivered one and presents a fresh banner + sound, with the newest date (on top). Find-by-`userInfo.url` + remove also works from a new process.
- Proved: the delivered list is scoped per code signature (ad-hoc cdhash). Whether Developer-ID builds share it across releases is unverified.
- Proved, and re-read in this step: the global `interaction` `state:"resolved"` event never fires in production. `orchestrator.ts:750-758` replaces the broadcaster that `wireInteractionBroadcast()` (`:720-739`, called at `:742`) installed.
- Re-read in this step: the mark-seen effect (`src/mainview/App.tsx:993-1020`) runs only when `selected?.id` changes. So bringing the window to the front with a task's panel already open marks nothing. `notifyWaitingInput` (`src/mainview/lib/toasts.ts:144-145`) posts the OS notification even when the task's panel is open, if the window is unfocused.
- Re-read in this step: the CLI's `osNotify` (`src/cli/notify.ts:57-68`) uses `osascript` with no identifier.

## Decisions

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| D1 | Replace rule | When a new event comes in for a task, which notification wins? | **The newest always wins.** Each task has one fixed notification id. Every new event replaces the task's notification and shows on top. Accepted edge: on a pipeline, step B's "Files sent" can replace step A's unanswered "Waiting on you"; the board card still glows. | owner |
| D2 | Sound / re-alert | What does a replacement do? | **Sound only on the first.** While the task's previous notification is still unopened, a replacement of the same or lower urgency shows a banner with **no sound**. | owner |
| D3 | Escalation | Unopened quiet notification replaced by a needs-you one? | **Ding.** A replacement that moves a task from *quiet* to *needs you* plays the sound. Same-or-lower urgency stays silent. | owner |
| D4 | Urgency levels | Which events are "needs you" vs "quiet"? | **Needs you:** Waiting on you, API error — retry, Session ended, Message not delivered, Task failed. **Quiet:** Task succeeded, Files sent (proactive or not), Pipeline finished. A second needs-you event while the first is still unopened replaces it **silently**. | owner (accepted default #1) |
| D5 | "Unopened" | When does the next notification get its sound back? | "Unopened" means **still in Notification Center**. Once the user clicks it, clears or swipes it, or Agetor removes it, the next post for that task is a "first" again (banner + sound). | owner (accepted default #2) |
| D6 | Removal triggers | When should Agetor remove a task's notification without a click? | **All four:** (a) the task is opened in Agetor: run panel opened, the pipeline run view or any of its step panels opened, or "Mark as read" from the card menu; (b) the reason went away: the question was answered (in the app, the CLI or the terminal) or the task left `blocked`, removed **only if the entry still shows that reason**, so a newer event isn't wiped; (c) the task was archived or deleted; (d) the window was brought to the front while that task's panel is open. | owner |
| D7 | In-app focused update | The window is focused (no OS post) and task X, which isn't open, has an unopened entry. A newer event for X arrives. What happens to that entry? | **Remove X's old entry** (no banner). The in-app toast carries the news. This replaced the owner's first pick, "silent banner in both cases", after a contradiction check (see D8). | owner (confirmed after a contradiction check) |
| D8 | Banner on silent updates | Should silent updates show a banner? | **Away from the app:** a silent banner (no sound). **In the app:** no post at all, D7's removal instead. macOS's `passive` interruption level is **not used**, so no passive spike is needed. | owner |
| D9 | Answer-event bug | Fix the `interaction` "resolved" event in this change? | **Yes, in scope.** D6(b) needs it. Expected side effect: a second question in the same run now alerts, which is correct, and D1 keeps it to one entry. | owner |
| D10 | Old-style notifications | What happens to the random-id notifications older versions left in Notification Center? | **Remove them per task, on that task's next post.** They are matched by `userInfo.url = agetor://task/<id>`. No sweep at launch. Tasks that never post again keep theirs until the user clears them. | owner |
| D11 | CLI `agetor logs --notify` | Leave osascript, or route it through the helper? | **Use Agetor's helper when `/Applications/Agetor.app` is installed**, with the same per-task id and the same sound rules, so CLI and app posts collapse into one entry. Otherwise keep osascript (the terminal bell is unchanged). | owner |
| D12 | In-app toasts | Apply the same rules to sonner toasts? | **Yes, same rules:** one toast per task, the newest replaces the previous one, and it is dismissed when the task is opened or the reason goes away. | owner |
| D13 | In-app toast slot coverage | Which toasts share the one-per-task slot? | **Every event toast in `src/mainview/lib/toasts.ts`:** success, failed, the four blocking variants, Waiting on you, Files sent, Message not sent, fx auto-resume fired/exhausted. Action-feedback toasts in `App.tsx` (Copied, Couldn't open link, Couldn't open terminal, …) don't change. | owner (accepted default #5) |
| D14 | Notification text | Show a count of collapsed events? | **No.** The notification shows only the newest event's own text. | owner (accepted default #3) |
| D15 | Ordering | Two posts for one task within milliseconds (two helper processes racing)? | **Bun sends a task's posts one at a time** (waits for the previous helper to exit), so the newest event always ends up on top. | owner (accepted default #4) |
| D16 | Pipelines | Which id does a pipeline use? | **The parent task id** (step events are already retargeted to it). Opening the run view or **any** of its step panels removes the parent's entry. | owner (accepted default #6) |
| D17 | CLI/TUI viewing | Does `agetor logs` or the TUI detail view remove notifications? | **No.** Those views don't mark a task read today either. | owner (accepted default #7) |
| D18 | Fallback path | Helper missing or crashed → `Utils.showNotification`? | **Stays as today, with no dedupe.** It's a degraded path, and Electrobun's FFI has no identifier control. | owner (accepted default #8) |
| D19 | Across app updates | Leftover old-version notification per task after an update? | **Accepted as a possible leftover, one per task**, if signed releases don't share Notification Center's list. It can't be fixed in code. Listed on the QA checklist. | owner (accepted default #9) |
| D20 | Docs | What docs change? | Add a "one per task / replace on top / sound rules / each removal case / old-style cleanup" checklist to `docs/qa/native-notifier-qa.md`. Add a short notifier entry to CLAUDE.md. Fix the stale `terminal-notifier` comment in `electrobun.config.ts:8-9`. | owner (accepted default #10) |
| D21 | Click behavior | Change the click path? | **No.** A click opens the task as today. macOS removes the clicked entry itself, and the following "task opened" removal is a harmless no-op. | owner (accepted default #11) |
| D22 | Automated tests | What coverage? | **Bun unit/route tests:** building the per-task id, the sound/urgency decision, remove calls recorded through `makeTestNative`, the answer-event fix (`global-events.test.ts` must stop re-calling `wireInteractionBroadcast()` and so stop hiding the bug), legacy cleanup args, CLI helper routing. **Plus a Playwright spec:** in-app toasts (one per task, newest replaces, dismissed on open) and the `/notifications` + removal requests the webview makes, intercepted with `page.route`, since the headless backend 501s that route. | owner |
| D23 | Manual QA | Who verifies real macOS behavior, and on what build? | **The owner runs the QA checklist on a dev-built helper** (`bun run vendor:notifier`, ad-hoc signed). The cross-update question (D19) stays **unverified**, by the owner's choice. | owner |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| `notifier.swift`: per-task id passed in, kept as a UUID only when none is given; a remove mode that can't be mistaken for the no-arg click relaunch (`:65-71`); the sound decision from the delivered list; urgency/kind kept in `userInfo` | in this change | D1–D6, D10 |
| `src/bun/notifier.ts` argv contract (new flags) + `notifier.test.ts` "full combo" update | in this change | D1, D22 |
| `showTaskNotification` (`src/bun/index.ts:268-325`): per-task serialization | in this change | D15 |
| A new removal capability on `ApiNative` (`server.ts:1111-1118`), `makeTestNative`, the `index.ts` native object, and a 501/no-op in the headless core (`headless-routes.test.ts`) | in this change | D6 |
| Removal on open: `/tasks/:id/seen` (run panel + "Mark as read"), the pipeline run view, step panel → parent id mapping | in this change | D6(a), D16 |
| Removal on window focus with the task's panel open (mark-seen doesn't re-run today) | in this change | D6(d) |
| Removal when the reason goes away (answered anywhere, left `blocked`), conditional on the entry still showing that reason | in this change | D6(b) |
| Removal on archive/delete, from every client (app, CLI), including the pipeline cascade on a parent | in this change | D6(c) |
| In-app focused update → remove the task's old entry | in this change | D7 |
| Interaction "resolved" event fix (`orchestrator.ts:750-758`) + `global-events.test.ts` no longer hiding it + the second-question alert in `PendingInputTracker` | in this change | D9 |
| Old-style (UUID) notification cleanup per task on its next post | in this change | D10 |
| `agetor logs --notify` through the helper when installed | in this change | D11 |
| One-per-task slot for every event toast in `toasts.ts`, dismissed on open / reason gone; keep `hasPendingToast`/`dismissPending` callers (pipeline "needs you" suppression, attention landings) correct | in this change | D12, D13 |
| QA checklist, CLAUDE.md notifier entry, `electrobun.config.ts` stale comment | in this change | D20 |
| Bun tests + Playwright spec | in this change | D22 |
| `README.md:65` wording | out of scope | Still accurate ("link straight to the task"); no change needed |
| Dedupe for the `Utils.showNotification` fallback | out of scope | Degraded path; Electrobun's FFI has no identifier control (D18) |
| Verifying that Developer-ID builds share Notification Center's list across releases | owner-deferred | Owner chose dev-build-only QA (D23); check on the next signed release |
| Removing CLI-posted notifications when only the headless daemon runs (no desktop app) | out of scope | The headless core has no native bridge; removal runs wherever the desktop app runs. The CLI's own posts still follow the id/sound rules (D11) |
| Posting fewer kinds of events (e.g. skip "Task succeeded" for intermediate Claude turns) | out of scope | A different ticket (which events notify), not stacking. The D2/D3 sound rule already cuts the repeat sounds |
| Action-feedback toasts in `App.tsx` | out of scope | Not task-event notifications (D13) |
| `threadIdentifier` grouping per task | out of scope | Not needed with one entry per task |
| TUI OS notifications | out of scope | The TUI posts none today (`src/cli/tui/useGlobalEvents.ts`) |

## Assumptions still open

- **A silent banner is a post with `content.sound = nil`** and still shows a banner on macOS 26 (expected; not spiked). If wrong, D2/D8's "banner without sound" would instead be no banner at all. Check on the QA checklist.
- **The "Alerts" (persistent) style replaces the same way banners do** (unverified, from the investigation). If wrong, persistent alerts could still stack. Check on the QA checklist.
- **The helper can decide sound from what's delivered**: it finds the task's entry (fixed id, or `userInfo.url` for old-style ones) and reads the urgency stored in its `userInfo`. Find-by-url from a new process is proved; the urgency field is new. If wrong, Bun would have to track urgency in memory, and it can't see an entry the user cleared, which would break D5.
- **A forced post while focused** (a proactive "Files sent", `toasts.ts:180`) still posts as today, under the D1–D4 rules. D7's removal applies only when no post would happen. If the owner reads D7 as "never post while focused", the proactive force goes away.
- **The pipeline-parent "needs you" toast suppression** (`hasPendingToast` in `App.tsx`) follows D1 in-app: once a quiet toast replaces the needs-you toast, `hasPendingToast` reads false and a later blocked event toasts again, again replacing it. The planner should keep that consistent rather than reintroduce stacking.
- **Developer-ID builds share the delivered list across releases** (unverified, owner-deferred per D23). If wrong, the update leftover described in D19 happens.
- **Fixing D9 raises alert volume** (second questions in a run now alert). Accepted, since D1 + D2 contain it.

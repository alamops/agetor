# Manual QA — native notifier helper (notification click → task modal)

Everything except the notarized/OS-integration behavior is verified automatically
(`bun run typecheck` + `bun test` green; helper compiles + ad-hoc-signs arm64).
This checklist covers what can only be confirmed on a real, signed build.

## Build
```bash
export ELECTROBUN_DEVELOPER_ID="Developer ID Application: A&A GLOBAL INTERNATIONAL LLC (ZQG3522LY7)"
bun run build     # runs vendor:notifier (builds+signs AgetorNotifier.app), then electrobun build + notarize
```

- [ ] **Notarization accepts the nested bundle.** The build completes without a
      codesign/notarytool rejection mentioning `AgetorNotifier.app`. (If it
      fails: confirm the helper is signed hardened-runtime *before* Electrobun
      signs the outer app — sign inside-out. `codesign -dv --deep --strict
      <agetor.app>` should show both signatures valid.)
- [ ] Inside the built app: `<Agetor.app>/Contents/Resources/app/bin/AgetorNotifier.app`
      exists and `codesign --verify --strict` passes; `lipo -archs` on its inner
      binary is `arm64` only.

## First-run permission
- [ ] Launch the built Agetor. Trigger a task notification (finish a run while
      the Agetor window is **unfocused**).
- [ ] A one-time **"Agetor" would like to send notifications** prompt appears →
      click **Allow**.
- [ ] The notification banner shows, branded **Agetor** (icon + name), with the
      task title/subtitle.

## The core loop (the [high] item from review)
- [ ] Let the helper fully exit (it self-exits after posting). Then **click the
      banner** → Agetor comes to the foreground and the **RunPanel opens for that
      exact task**.
- [ ] Repeat with the Agetor **window closed** (Cmd-W, process still running):
      click a notification → window is recreated + the task opens.
- [ ] **Cold path:** Cmd-Q Agetor entirely, then click an older Agetor
      notification still in Notification Center → Agetor launches and the task
      opens once booted.

> If the click does **nothing** (banner dismisses, no task opens): the
> directly-exec'd helper wasn't relaunchable by LaunchServices. Startup already
> runs `lsregister -f` on it as a mitigation; if it still fails, switch to the
> pre-scoped **stay-alive-until-click** helper variant (keep the helper process
> alive with a timeout instead of relying on relaunch). Tell me and I'll wire it.

## Edge cases
- [ ] **Deny** the permission prompt on a fresh machine → notifications simply
      don't appear (by design we do NOT fall back to a second "Agetor" identity
      that would re-prompt). Re-enable in System Settings › Notifications › Agetor.
- [ ] `--silent` path: a notification posted with `silent: true` shows without a
      sound (both background and if Agetor is frontmost).
- [ ] Only **one** extra "Agetor" row appears in System Settings › Notifications
      (the helper's). The plain `Utils.showNotification` fallback only fires when
      the helper is missing or crashes (not on denial), so no duplicate identity
      under normal use.

## One notification per task

Each task owns at most one Notification Center entry (fixed request id
`agetor.task.<taskId>`, see `docs/plans/duplicated-macos-notifications.md`).
Run these on a build whose helper you built yourself (`bun run vendor:notifier`
or `bun run build`): the delivered list is scoped per code signature, so a dev
helper never sees entries the release build posted, and vice versa. Keep the
Agetor window **unfocused** while events arrive unless an item says otherwise.

**Replace on top and sound**
- [ ] Two events for one task (e.g. "1 file sent to you", then "Task
      succeeded") leave **one** entry for that task in Notification Center,
      showing the newer one, at the top of the list.
- [ ] The first entry plays the sound. A quiet replacement over it (succeeded
      over files sent) shows a banner **without** a sound.
- [ ] A **silent banner still shows** for that replacement on macOS 26 (we post
      it with `content.sound = nil`; unspiked assumption).
- [ ] **Escalation:** a quiet entry (Task succeeded) replaced by a needs-you
      event for the same task (Waiting on you / Task failed / API error) plays
      the sound. A needs-you event over a needs-you entry does not.
- [ ] After you **clear** the task's entry from Notification Center yourself,
      the next event for the task plays the sound again (nothing delivered).
- [ ] With **System Settings › Notifications › Agetor** set to **Alerts**
      (persistent), a newer event still replaces the task's entry instead of
      stacking (unverified assumption).
- [ ] Two different tasks keep two separate entries.

**Removal** — each of these removes the task's entry:
- [ ] Opening the task's run panel (card click, or clicking the notification).
- [ ] Opening a pipeline's full-page **run view** (removes the pipeline's entry).
- [ ] Opening any **step panel** of a pipeline (removes the pipeline's entry).
- [ ] **Mark as read** from the card's context menu.
- [ ] Answering the question from the **CLI** (`agetor answer <id>`) or in the
      tmux terminal — the "Waiting on you" entry goes; a newer "Task succeeded"
      entry for the same task is left alone. With two questions pending, the
      entry stays until the last one is answered.
- [ ] The task **leaving `blocked`** (e.g. retried) removes a blocked / API
      error / session ended / message-not-delivered entry.
- [ ] **Archive** and **delete** from the CLI (`agetor archive`, `agetor rm`)
      and from the app.
- [ ] Bringing the window to the front with that task's panel (or its pipeline
      run view) already open.
- [ ] An event arriving while the window is **focused** removes that task's
      older entry instead of posting (a proactive "files sent" still posts).

**Upgrades, restarts and the CLI**
- [ ] **Old-style cleanup:** with an entry posted by an older Agetor build for a
      task still in Notification Center, the task's next notification replaces
      it (one entry left). Only same-signature builds can see each other's
      entries, so test with two builds you signed with the same identity.
- [ ] An entry posted before an Agetor **restart** is still removed when you
      open the task after the restart (the boot seed reads `notifier --list`).
- [ ] `agetor logs <id> --notify` while the app runs: its notifications collapse
      into the same per-task entry as the app's own (the CLI posts through the
      running app first).
- [ ] **Unverified (owner-deferred):** whether Developer-ID builds from two
      releases share the delivered list, so an update cleans up entries the
      previous release posted. Check on the next signed release.
- [ ] Remove/list modes never pop the permission prompt: on a machine that has
      not granted permission yet, opening a task posts nothing and asks nothing.

> **LaunchServices caveat for dev copies.** A helper built in a worktree
> registers itself under the production bundle id and can catch production
> click relaunches. After testing a dev helper, run
> `lsregister -u <worktree>/vendor/notifier/AgetorNotifier.app`, then
> `lsregister -f /Applications/Agetor.app/Contents/Resources/app/bin/AgetorNotifier.app`
> (`lsregister` lives under
> `/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/`).

## Not needed on this machine
- Dev runs (`bun run dev`) resolve the helper from `vendor/notifier/` after
  `bun run vendor:notifier`; the `agetor://` scheme only routes once the built
  `.app` is registered with LaunchServices, so the full click loop is a
  built-app test, not a dev-server test.

## Focus behavior on click (macOS 14+ cooperative activation)

macOS 14 made `activate` a *request* the currently-active app can deny —
`NSApplication.activate` / `NSRunningApplication.activate(options:
.activateIgnoringOtherApps)` are deprecated no-ops. Clicking a notification
briefly makes the helper the active app with a real, yieldable activation
right, which it now explicitly yields to Agetor (`sh.alamops.agetor`) before
opening the deep link, so the request is honored instead of just bouncing the
Dock icon. Verify each scenario below on a real, signed, packaged build (per
the steps above) — this cannot be verified from `bun run dev`.

- [ ] **Buried behind other apps.** With several other apps' windows layered
      on top of Agetor's, click the notification → Agetor's window is raised
      above them and gets keyboard focus (not just a Dock bounce).
- [ ] **Minimized to the Dock.** Minimize the Agetor window, then click the
      notification → the window un-minimizes and comes to the front.
- [ ] **On a secondary display.** With Agetor's window on a second monitor and
      focus on the primary, click the notification → the secondary display's
      window is raised and focused; the OS switches your active display/cursor
      context to it as normal for cross-display activation.
- [ ] **On another Space.** With Agetor's window on a different Space than the
      one you're on, click the notification:
      - If **Desktop & Dock → Mission Control → "When switching to an
        application, switch to a Space with open windows for the
        application"** is **on** (the default): macOS switches you to
        Agetor's Space and focuses its window.
      - If that setting is **off**: the Space does *not* switch — only the
        menu bar changes to Agetor's and the window stays on its own Space.
        This is expected OS behavior, not a bug in the helper; don't file it
        as a regression.
- [ ] **Window fully closed** (not just minimized — actually closed, process
      still running). Click the notification → Agetor recreates/opens a
      window and it comes to the foreground with the right task open (same as
      the "window closed" case in the core loop above, verified here
      specifically for focus/activation rather than task routing).

# Manual QA — Always-on host (login item, background core, handback, remote access)

Everything except the macOS integration is covered by `bun run typecheck`, `bun test`, the
`e2e/background-settings.spec.ts` Playwright spec and the pure/subprocess tests (supervisor state
machine, app takeover, remote-access box, headless notifications). What no automated run can reach
is `SMAppService`, launchd, the Electrobun menu and message box, a real quit, a real login and the
notification click. This checklist covers those on a real **Developer-ID-signed canary build**.

Design: `docs/plans/always-on-host.md` (§5.1 is this list), decisions in
`docs/plans/always-on-host-grill.md`.

## Build and install

A canary build registers its own launchd job and runs against **`~/.agetor-dev` on port 4318**, so
none of this touches your real `~/.agetor` or the release app's login item.

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
export ELECTROBUN_DEVELOPER_ID="Developer ID Application: <your team>"   # same env the release build uses
bun install
bun run build:canary        # vendor:login-item + vendor:daemon + verify:vendor, then electrobun build --env=canary
```

- [ ] The build finishes with no `verify:vendor` failure.
- [ ] `bun scripts/verify-release.ts --layout <path to the built inner Agetor.app>` passes: helper is
      Developer ID + hardened runtime, both LaunchAgent plists lint and name the right
      `BundleProgram`, `ProcessType` is `Interactive`, `KeepAlive.SuccessfulExit` is `false`, and
      `Contents/Resources/app/daemon/{login-daemon,headless}.js` exist.
- [ ] Copy the **inner** canary `Agetor.app` (it may carry a channel suffix; or drag it out of the DMG) into **`~/Applications`** (or
      `/Applications`) and launch it from there. Do not run it from the DMG or a download folder.

Handy while testing (canary data dir):

```bash
launchctl print gui/$UID/sh.alamops.agetor.canary.daemon     # the job: state, runs, spawn type, last exit code
tail -f ~/.agetor-dev/daemon.log                             # the background core's stdout/stderr
cat ~/.agetor-dev/login-daemon.json                          # the supervisor's state (informational)
agetor --data-dir ~/.agetor-dev daemon status                # core + "background:" line
agetor --data-dir ~/.agetor-dev daemon background status     # works with no core running
tmux -L agetor-dev ls                                        # task sessions (socket named after the data dir)
```

## The checklist

For each item: do the steps, compare with **Expect**, and note anything off under **Record**.

### 1. Turn on

1. Open the canary app. Settings → General → **Keep Agetor running in the background** → switch on.

**Expect**
- macOS shows a **"Background Items Added"** notification for Agetor.
- The state reads **"On, parked while the app is open"**.
- `launchctl print gui/$UID/sh.alamops.agetor.canary.daemon` shows `state = running`, `runs = 1` and
  **`spawn type = interactive`** (the `ProcessType: Interactive` key; without it tmux and its panes
  run at the lower daemon priority).
- `cat ~/.agetor-dev/login-daemon.json` shows `"state":"parked"` and a live `pid`.

**Record (A12):** whether `register()` worked from the app's **disclaimed** child (the app runs the
helper through the TCC disclaim wrapper). If the switch fails with a helper error, copy the `detail`
line from Settings and `~/.agetor-dev/daemon.log`.

### 2. Quit with no tasks

1. With the switch on, press **⌘Q**. No dialog appears.
2. Within ~3 seconds run `agetor --data-dir ~/.agetor-dev daemon status`.
3. Open the app again.

**Expect**
- After the quit, `daemon status` prints `cli-daemon · launchedBy login-item · 127.0.0.1:4318 …` and a
  `background: running` line.
- Reopening the app takes the port over (the daemon is asked to hand off) and the supervisor goes back
  to **parked**; `daemon status` then says `app`.

### 3. Quit with a running task

1. Start a Claude Code task in a throwaway repo that takes a minute or so. Pin it with a prompt such as
   "wait 60 seconds, then say done".
2. While it runs, press **⌘Q**.
3. Read the dialog, choose **Quit**.
4. Wait for the task to finish with the app closed.

**Expect**
- The dialog says the task is still running and **"They'll keep running in the background"**, with
  buttons **Quit**, **Quit completely**, **Cancel**.
- After the quit, the task keeps running; the tmux session is still listed.
- When it finishes a macOS **"Task succeeded"** notification arrives with no app window open
  (headless notifications). **Click it**: the app launches and opens that task.
- If nothing is posted, check `~/.agetor-dev/daemon.log` for a notifier line.

**Record (A11):** whether the notification came from the **installed app's notifier**
(the canary app in `~/Applications`). The core resolves the helper in `/Applications`, then
`~/Applications`.

### 4. Quit Agetor Completely (⌥⌘Q)

1. In the app, open the **Agetor** menu. Confirm **Remote Access…** and **Quit Agetor Completely**
   (⌥⌘Q) are listed.
2. Press **⌥⌘Q**. (With a task running you get a "Quit Agetor completely?" dialog that says the tasks
   will stop; confirm it.)
3. `agetor --data-dir ~/.agetor-dev daemon status`.
4. Open the app again, then in Settings press **Start now**.

**Expect**
- The menu item fires (**A10**). The app quits.
- No core comes back: `daemon status` says `no Agetor core running`, and the background line says
  **stopped** (turned on, not running). Settings shows **"On, stopped, starts again at next login"**
  with a **Start now** button.
- **Start now** brings the background core back (state `running`, or `parked` while the app is open).

**Record (A10):** whether ⌥⌘Q ran our item or macOS's own "Quit and Keep Windows" alternate. If the
shortcut does nothing but clicking the menu item works, the accelerator loses to AppKit; if clicking
also does nothing, `application-menu-clicked` isn't being delivered.

### 5. Log out and in

1. With the switch on and the app closed, log out of macOS and back in (do not open the app).
2. After login, `agetor --data-dir ~/.agetor-dev daemon status`.

**Expect**
- A core is running at login with no app: `launchedBy login-item`, background state `running`.
- `tail ~/.agetor-dev/daemon.log` shows a normal boot, with no idle-shutdown line even after more than
  5 minutes.

### 6. System Settings › Login Items

1. System Settings → General → Login Items & Extensions → toggle **Agetor** off.
2. Look at Settings in the app.
3. Press **Open Login Items**.
4. Toggle Agetor back on.

**Expect**
- Settings shows **"Needs approval in System Settings › Login Items"** with an **Open Login Items**
  button.
- The button lands on the correct Login Items panel.
- After toggling back on, launchd restarts the job on its own (about a second) and Settings goes back
  to parked/running without re-registering.

### 7. `agetor daemon stop`

1. Quit the app so the background core runs.
2. `agetor --data-dir ~/.agetor-dev daemon stop`.
3. Wait a minute, then `agetor --data-dir ~/.agetor-dev daemon status`.
4. `agetor --data-dir ~/.agetor-dev daemon start`.

**Expect**
- `stop` prints **"stopped — the background core starts again at next login (turn it off with
  `agetor daemon background off`)"**.
- It stays stopped: `no Agetor core running`, background **stopped**.
- `daemon start` re-registers the login item and prints `started the background core …` within 20 s.

### 8. Remote Access…

1. Switch **off** "Keep Agetor running in the background" first. Open **Agetor › Remote Access…**.
2. Choose **Turn On**.
3. In Settings, look at the remote row. Press **Turn off**.
4. Repeat 1–2, then run `agetor --data-dir ~/.agetor-dev remote off` and `... remote status`.
5. Try to turn it on over HTTP: with the CLI token from `~/.agetor-dev/agetor-core.json`,
   `PUT /preferences/remoteAccess` with the value `on`.

**Expect**
- The box is titled **Remote access (preview)** and says it keeps this Mac reachable for the Agetor
  Companion app, that it's a preview (nothing can pair yet), and that turning it on also turns on Keep
  Agetor running in the background. Buttons: **Turn On**, **Cancel**.
- **Turn On** turns the background switch on **and** remote on. Settings shows both.
- **Turn off** in Settings turns remote off and leaves the background on.
- `agetor remote off` works; `agetor remote status` prints `Remote access (preview): off`. There is no
  `agetor remote on`.
- The HTTP `PUT` is refused with **403** and `{"code":"native-only"}`.
- When the box is opened while the background switch needs approval, it offers **Open Login Items**.

### 9. Turn background off with an agent running

1. Quit the app with a task running, so the background core hosts it.
2. Turn the background off: `agetor --data-dir ~/.agetor-dev daemon background off`.
3. `tmux -L agetor-dev ls`.
4. Open the app.

**Expect**
- The background core stops and `launchctl print …` reports the job gone.
- The agent's **tmux session survives** (listed in step 3).
- Opening the app reattaches the session: the task still shows as running, with the transcript
  intact and no duplicated events.

### 10. Update

1. Install an **older canary** into `~/Applications` with the switch on.
2. Update in-app to the newer canary.
3. Watch `tail -f ~/.agetor-dev/daemon.log` and `launchctl print …` across the update.

**Expect**
- After the update the parked job restarts from the **new bundle** (the supervisor logs a bundle
  change, `runs` increases) and waits up to 30 s for the new app.
- The new app launches and takes the port; **no second core appears**.
- `launchctl print …` still shows the same label and `login-daemon.json` shows the new `version`.

### 11. DMG or translocated copy

1. Mount the DMG and run Agetor straight from it, or run a freshly downloaded copy from `~/Downloads`.
2. Open Settings → General.

**Expect**
- The switch is **disabled**, with **"Move Agetor to Applications first"** beside it.
- If you move Agetor after having turned the switch on, Settings shows the honest state and turning
  it off then on again points the job at the new location.

### 12. TCC

1. With the switch on and the app closed, start (or let run) a task whose directory is under
   `~/Documents` (or another protected folder).
2. Let the background core run it end to end.

**Expect**
- **No** "Agetor would like to access data from other apps" prompt from the background core: its
  children are spawned through the disclaim helper, like the app's.
- A one-time prompt naming `git` or the harness for the protected folder is the documented tradeoff,
  not a failure.

### 13. Dev/canary and release sharing one Login Items row (A8)

1. With both a stable release and a canary registered, toggle the shared "Agetor" row in System
   Settings off and on.
2. Look at both apps' Settings.

**Expect**
- One of the two labels may read `notFound` afterwards. Settings must show that honestly as **Off**
  (not "On"), and turning it on again works.

## Open assumptions to record

| # | Assumption | What to record |
| --- | --- | --- |
| A10 | Electrobun delivers `application-menu-clicked` with `data.action` for custom items, and our ⌥⌘Q item wins over AppKit's Quit-and-Keep-Windows alternate. | Item 4: did both the click and the accelerator work? If only the click, drop the accelerator. If neither, put "Quit completely" in the dialog and Settings only. |
| A11 | A CLI-spawned or login-item daemon can run the installed app's notifier. | Item 3: did "Task succeeded" arrive with no window, and did clicking it open the task? |
| A12 | `register()` from a **disclaimed** child of the app behaves like the Terminal-launched spike (SMAppService resolves by `Bundle.main`, not by the responsible process). | Item 1: did the switch work? If not, the fallback is an exempt, un-disclaimed spawn for the helper (needs owner approval per the spawn allowlist). |
| A13 | The spike results (macOS 26.6.2) hold on macOS 14 and 15. | Which macOS version you ran. 14 and 15 are unverified. |
| A14 | Electrobun's signing covers the helper copied into `Contents/MacOS`. | Build step: did `verify-release.ts --layout` pass? If not, add an explicit `postBuild` signing step. |

(A6, a DMG or translocated copy breaking the registration once moved, is refused by rule instead; item
11 confirms the refusal.)

## Cleanup

1. Turn **Keep Agetor running in the background** off in Settings (or
   `agetor --data-dir ~/.agetor-dev daemon background off`). This also turns remote access off.
2. Confirm the job is gone: `launchctl print gui/$UID/sh.alamops.agetor.canary.daemon` should fail
   with "Could not find service", and `sfltool dumpbtm | grep -i agetor` (or System Settings → Login
   Items & Extensions) should no longer list the canary.
3. Quit the app. Kill leftover tmux sessions you started: `tmux -L agetor-dev kill-server`.
4. Remove the test data: `bun run wipe:dev` (only ever touches `~/.agetor-dev`), and delete the
   throwaway repos and the canary app in `~/Applications` if you don't want it.

> **Rollback note (for whoever ships a build without this feature):** keep the login-item helper in
> the bundle and call `unregister` on launch. Otherwise a user who left the switch on keeps a launchd
> job whose `BundleProgram` no longer exists, and launchd loops on exit 78. See CLAUDE.md item 22.

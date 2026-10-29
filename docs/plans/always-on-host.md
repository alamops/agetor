# Plan — Always-on host (login item, no idle exit, handback on quit, remote-access switch, headless notifications)

| Field | Value |
| --- | --- |
| Date | 2026-10-29 |
| Source | Companion blueprint §03 row "Always-on host", §09, §12 items 4.2 and 5.1–5.3 (https://claude.ai/artifact/25cyTFUnoiRksPpD9CiiPy#readiness); `docs/plans/always-on-host-investigation.md`; `docs/plans/always-on-host-grill.md` (D1–D13, C1–C22); the Planning-step SMAppService spike and web research (§2.3, §2.4) |
| Flags | none |
| Gates | grilled + spike run with the owner + approved by owner (2026-10-29) |
| Branch | `feature/agetor-always-on-host` |
| Base SHA | `0a2e636e26e85e85b5c8257e1646d58b7325cd03` (tree clean apart from the untracked plan docs) |

## 1. Objective & success criteria

Keep an Agetor core running whenever the user is logged in, so tasks, pipelines and (later) the Companion app keep working with the window closed.

Done means all of these hold on a Developer-ID-signed build in `/Applications` or `~/Applications`:

1. **Settings → General → "Keep Agetor running in the background"** registers an `SMAppService` LaunchAgent. From then on, a background core starts at every login and runs while the app is closed. Turning it off unregisters the agent and stops that core. Running agents survive in tmux, and the next core reattaches them.
2. The background (login-item) core **never idle-exits**. A CLI-spawned daemon keeps today's 5-minute idle exit. `AGETOR_DAEMON_IDLE_MS` overrides both.
3. **Handback.** While the app runs, the background job stays alive but *parked*: it holds no port, no database and no tmux. Quitting the app (⌘Q) lets it boot a core within about 1 s. Opening the app parks it again.
4. **Stopping.** `agetor daemon stop` and the new **Agetor › Quit Agetor Completely (⌥⌘Q)** stop the background core until the next login. The quit confirm says the running tasks keep running in the background, and offers "Quit completely".
5. **Updates.** After an in-app update the parked job restarts from the new bundle and waits up to 30 s for the new app before booting a core.
6. **Remote access (preview).** The Agetor › Remote Access… menu item opens a native message box, the only way to turn it on. Turning it on also turns on the background setting. Turning it off works from Settings, `DELETE /remote-access` and `agetor remote off`. `GET /remote-access` and `agetor remote status` read it.
7. **Headless notifications.** Any headless core (login-item or CLI-spawned) posts the same one-per-task OS notifications the app does. A click opens the app on that task.
8. Unsigned and dev builds show the switch disabled with a reason. Signed canary or dev builds run against `~/.agetor-dev` and port 4318 under their own launchd label, and the app of that channel defaults to the same data dir and port.
9. `bun run typecheck`, `bun test` and the new e2e spec are green. The owner's signed-build QA checklist (`docs/qa/always-on-host-qa.md`) passes.

## 2. Context & constraints

### 2.1 Code as it stands (repo @ `0a2e636e`)

- **Headless core.** `src/bun/headless.ts:46-48` fixes `IDLE_TIMEOUT_MS` at module load from `AGETOR_DAEMON_IDLE_MS` (default 300000). The idle loop `:340-352` runs only when that value is > 0. Bind failure `:256-273` exits **0** when a live core owns the port, else 1. `writeCoreCreds` `:313-329` writes `kind: "cli-daemon"`. SIGINT/SIGTERM handlers are installed only after the bind (`:334-335`). `shutdown()` `:101-132` always removes the creds file. `runDaemon` boot order is `:134-310`, and it imports `db.ts`, which opens SQLite on import.
- **Creds.** In `src/bun/core-creds.ts:33-49` (`CoreCreds`), `readCoreCreds` accepts only `kind: "app" | "cli-daemon"` (`:99`) and ignores unknown fields. Installed CLIs are often older than the app (`scripts/install.sh` ships the CLI separately).
- **`/daemon/shutdown`.** `src/bun/server.ts:8002-8020`: the app calls `native.quit()`. On a headless core it calls `removeCoreCreds` + `process.exit(0)` directly, bypassing `shutdown()`. Its policy is `app+cli` (`src/bun/route-policy.ts:440`).
- **App takeover.** `src/bun/index.ts:393-430`: on a bind failure with a live `cli-daemon`, it POSTs `/daemon/shutdown`, waits up to 10 s for the port, then binds. Otherwise it prints an `lsof` hint and runs `process.exit(1)`. There is no retry while the port is held and the creds file is missing.
- **App quit.** `index.ts:500-533` `before-quit`: with no `running` run it removes creds and allows the quit. Otherwise it broadcasts `quit_request` and vetoes. The webview confirm (`src/mainview/App.tsx:1365-1390`, `confirm()` with two buttons from `components/ui/confirm.tsx:6-14`) POSTs `/app/force-quit` (`server.ts:7971-7990`), which arms `quit-guard.ts`'s one-shot flag.
- **Menu.** `installNativeMenu` (`index.ts:67-108`) uses roles only. Electrobun 1.18.1 supports custom items: `{ label, action, accelerator }` emits `application-menu-clicked` with `e.data.action` (`node_modules/electrobun/dist/api/bun/core/ApplicationMenu.ts`, `proc/native.ts` `applicationMenuHandler`). `Utils.showMessageBox` returns `{ response }` (`Utils.ts:235-259`); the disclaim prompt already uses it (`index.ts:175-193`).
- **Updates.** `src/bun/updater.ts:120-121` `applyUpdate()` → `Updater.applyUpdate()`, which deletes and renames the running bundle, spawns a relaunch waiter, then `quit()` (investigation K10).
- **CLI.** In `src/cli/daemon/supervisor.ts:22-31`, `ensureCore` calls `discoverCore`, or else `spawnDaemon` (`:34-63`). `stopDaemon` `:93-105` POSTs `/daemon/shutdown`. `src/cli/commands/daemon.ts:20-57` implements `start|stop|status`, and `publicCore` `:10-18` drops the token. Help and dispatch live in `src/cli/index.ts` (`case "daemon"` at `:153`).
- **Notifications.** The webview decides when to post (`src/mainview/lib/toasts.ts:81-101` `maybeNotifyOS`, called from `App.tsx:1540, 1602-1611, 1651, 1699, 1724-1742`). The core only removes entries: `server.ts:1314-1321` goes through `native.removeTaskNotification`, plus `installNotificationRemovalHooks` (`notification-hooks.ts:82`), installed by `index.ts:342`. `headless.ts` installs neither. The posting helper is `createTaskNotifier` (`task-notifier.ts:114`) over `resolveNotifier()` (`notifier.ts:66-74`, execPath-relative bundle path, then the dev `vendor/` path). `resolveInstalledAppNotifier()` (`notifier.ts:212-226`) checks only `/Applications/Agetor.app`.
- **Route vocabulary rule.** In `src/bun/route-policy.test.ts:311-328` (TT3(c)), `BANNED_SEGMENT = /^(pair|pairing|device|devices|remote|remote-access)$/i`. `docs/plans/companion-pairing-requirements.md` rule 3 allows disabling remote access over HTTP or CLI, while rule 5 says the test must be changed in the same change. D11 settles that.
- **Preferences.** `PUT /preferences/:key` (`server.ts:3811-3870`) is `app+cli` and opaque, with value rules for retention, disclaim "off" and `tmux_source`. `preferences` is agent-writable at the SQLite level.
- **Settings.** `GeneralSection` is in `src/mainview/components/settings/SettingsDialog.tsx:1104-` (2018 lines). Machine toggles there read `GET /preferences` (`:392`).
- **Packaging.** `electrobun.config.ts` `build.copy` destinations are joined to `Contents/Resources/app` with `cpSync` (`node_modules/electrobun/src/cli/index.ts:3287-3308`), so `../../MacOS/x` lands in `Contents/MacOS`. Electrobun signs every Mach-O under `Contents/MacOS` (Developer ID, hardened runtime, `--identifier <filename>`, app entitlements) and never touches `Contents/Resources/app/bin` (`scripts/verify-vendor-signing.ts:1-20`). Dev builds skip signing. Channels share bundle id `sh.alamops.agetor`. `Contents/Resources/version.json` carries `channel` (installed v1.0.3: `"channel":"stable"`). Only the stable channel is ever released (grill grounding).
- **Data dir and port.** `db.ts:48-52` reads `AGETOR_DATA_DIR` at import, defaulting to `~/.agetor`. `api-config.ts:39-41` defaults the port to 4317. `src/bun/dev-defaults.ts` `DEV_API_PORT = 4318`. Only `package.json` scripts set the dev values, so a **canary app opened from Finder uses `~/.agetor` today**.
- **Process spawning.** Every spawn in `src/bun`/`src/shared` must go through `coreSpawn`/`coreSpawnSync` (`core-spawn-allowlist.test.ts`). `core-spawn.ts` imports only `disclaim.ts`, a leaf, so a module that must not open the database can still use it.
- **Tests.** `daemon-boot.test.ts` and `daemon-handoff.test.ts` spawn `bun src/bun/headless.ts` subprocesses. `headless-idle.test.ts` covers only `hasRunningWork`. Nothing tests the idle loop, takeover or quit (investigation S4). e2e runs one headless backend per worker (`e2e/fixtures.ts:491-504`, `AGETOR_DAEMON_IDLE_MS=600000`) and has no native.

### 2.2 Spike verdicts (Planning step, owner's Mac)

Scratch app `AgetorSpike` (bundle id `sh.alamops.agetor.spike`, Developer ID Application team ZQG3522LY7, hardened runtime, **not notarized**) in `~/Applications`. A Swift helper in `Contents/MacOS` was the `BundleProgram`; it `execv`'d the bundle's `bun` (copied from Agetor 1.0.3, bun 1.3.13) on a JS daemon. macOS 26.6.2, tmux 3.6a. The owner ran every step that registers or unregisters a login item; the auto-mode classifier blocks the agent from doing so. Raw log: `<scratchpad>/spike/spike-output.log`.

| # | Question | Verdict | Evidence |
| --- | --- | --- | --- |
| A1 | Does `register()` from a helper in `Contents/MacOS` work on a Developer-ID-signed bundle, and does launchd start the job? | **Yes** | `status = notFound` → `register ok -> enabled`, no approval prompt; `launchctl print`: `state = running`, `runs = 1`. |
| A2 | Does `KeepAlive {SuccessfulExit:false}` behave as needed? | **Yes** | Exit 1 → restarted in < 0.1 s (`runs = 2`, `last exit code = 1`). Exit 0 → `state = not running`, `job state = exited`, **`status` still `enabled`**. Unregister, 500 ms, register → running again (`runs = 1`). |
| A3 | Do tmux sessions survive `unregister()`? | **Yes** | The job logged `SIGTERM -> exit 0`. Its tmux server (own pgid, ppid 1) and pane survived; `tmux ls` still showed the session. |
| A4 | Does `ProcessType: Interactive` avoid throttling? | **Yes, required** | `spawn type = interactive (4)` vs `daemon (3)` unspecified. The tmux server and its pane run at **pri 31** with Interactive and **pri 20** without; panes inherit it. The CPU/IO benchmark didn't run (quoting bug), so the priority is the evidence. |
| A5 | Does an updater-style bundle swap (same path, id, team) keep the registration working? | **Yes** | The parked job saw `Info.plist`'s inode change → exit 75 → launchd restarted it from the new bundle 1.5 s later (`v=2`); `status` stayed `enabled`, no re-register. |
| A7 | Is the launchd environment enough? | **Yes** | `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `SSH_AUTH_SOCK`, `cwd=/`, no `LANG`. The same as a Finder-launched app, so `rehydratePath()` covers it the same way. |
| A8 | Can a second bundle with the same bundle id and a different label register? | **Registers, but approval is shared** | Both registered and ran. System Settings shows **one row** for the bundle id ("3 apps"). After toggling it off and on, the first bundle's labels read `notFound` while the second read `enabled`. |
| A9 | Does `requiresApproval` appear after a System Settings toggle, and does re-enabling restart the job? | **Yes, and yes** | Isolated single bundle: toggle off → `requiresApproval`, job SIGTERMed and unloaded. Toggle on → `enabled`, launchd restarted the job by itself about 1 s later, no re-register. The owner used the Login Items panel; `openSystemSettingsLoginItems()` landing is re-checked in QA. |

Not proven by the spike: A6 (DMG/translocated path; refused by rule anyway), A10 (Electrobun custom-menu clicks and ⌥⌘Q, verified from source only), A11 (installed-app notifier from a CLI daemon), and registration from a **disclaimed** child of the app (the spike registered from Terminal). All four are QA items, with the fallbacks in §8.

### 2.3 Web research (D13)

- Apple: put the agent plist in `Contents/Library/LaunchAgents`, use `BundleProgram` (bundle-relative), check `status` after `register()`, and send the user to `openSystemSettingsLoginItems()` on `requiresApproval` ([SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice), [Updating helper executables](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos)).
- [DTS 768592](https://developer.apple.com/forums/thread/768592): `register()` straight after `unregister()` can fail with `SMAppServiceErrorDomain Code=1 "Operation not permitted"`; a 500 ms delay avoids it. A helper outside `Contents/MacOS` fails with code 3 / -67028. Calling `register()` alone does not replace a running old process. The spike's back-to-back call succeeded on 26.6.2, but the plan keeps the 500 ms delay.
- [DTS 745412](https://developer.apple.com/forums/thread/745412) (FB13570494): a service "always points to the path where my app bundle was located in the time of registration". Re-registering from a different path did not move it. This is why registration is refused outside the Applications folders (C10), and why updates must keep the same path, which Electrobun's updater does (A5).
- [DTS 726826](https://developer.apple.com/forums/thread/726826), [727785](https://developer.apple.com/forums/thread/727785): status/exit 78 is `EX_CONFIG` (a plist or layout problem) and can follow a successful `register()`. That is why `verify-release` lints the plist and checks `BundleProgram` resolves.
- ⌥⌘Q is macOS's own "Quit and Keep Windows / Quit and Close All Windows" alternate of Quit ([MacMost](https://macmost.com/why-do-mac-windows-reappear-when-you-relaunch-an-app.html)). A custom ⌥⌘Q item may collide with it (§8 A10).
- Prior art: Electron's `app.setLoginItemSettings({ type: "agentService" })` uses the same bundle layout and warns that unsigned apps "may silently fail" ([Electron app API](https://www.electronjs.org/docs/latest/api/app)).

### 2.4 Owner decisions taken in this step

- **Canary data dir: option (a).** A canary- or dev-channel app defaults to `~/.agetor-dev` and port 4318 when `AGETOR_DATA_DIR` / `AGETOR_API_PORT` are unset, matching its launchd job (C11). Signed-build QA never touches the real `~/.agetor`.
- **Spike execution.** The owner ran every registration step from their own Terminal.

## 3. Approach & key decisions

### 3.1 Process model

```
launchd (gui/<uid>, label sh.alamops.agetor.daemon | sh.alamops.agetor.canary.daemon)
  └─ Contents/MacOS/agetor-login-item run        (Swift, BundleProgram; sets env, execv's bun)
       └─ Contents/MacOS/bun …/app/daemon/login-daemon.js   ("supervisor": no DB, no tmux, no port)
            └─ (when no live core owns the port) bun …/app/daemon/headless.js   (the core, AGETOR_LAUNCHED_BY=login-item)
```

- The **supervisor** is the launchd job's process for its whole life. Parking is the supervisor *not running a core child*; it never exits to park. That gives "park without exit" (C16) and keeps launchd's `KeepAlive` semantics clean: exit 0 = stop until next login (D5), non-zero = restart. It imports only leaf modules (`core-creds.ts`, `daemon-log.ts`, `login-daemon-state.ts`, `daemon-mode.ts`, `core-spawn.ts`) and must never import `db.ts`. *Rejected:* a booted core that tears itself down to park. That needs reversible teardown of tailers, timers, the pipeline runner and the DB, which nothing in the codebase supports. Also rejected: the Swift helper as the supervisor (not unit-testable from `bun test`). *(Reasoning.)*
- The **helper** exists because `ProgramArguments` aren't bundle-relative and a plist can't expand `$HOME` (W2, K18). It resolves its own bundle and picks the label and env by channel. *(Spike A1 + reasoning.)*
- **`ProcessType: Interactive`** is mandatory *(spike A4)*. **`KeepAlive {SuccessfulExit:false}` + `RunAtLoad`** *(spike A2)*. **`ExitTimeOut` 30** so the core's `shutdown()` finishes on SIGTERM.

### 3.2 Supervisor state machine (`login-daemon-machine.ts`, pure)

Tick every 1 s. Inputs: `liveCore` (creds file + `isPidAlive`, any kind), `stopRequested` (control file), `bundleChange` (`<bundle>/Contents/Info.plist` `ino:mtimeMs` differs from start, or is missing), `childExit` (code or signal), `sigterm`, `now`.

| State | Rule (checked in this order every tick) |
| --- | --- |
| any | `sigterm` → SIGTERM the core child, wait ≤ 25 s (then SIGKILL), write `lastExit:"sigterm"`, **exit 0**. |
| any | `stopRequested` (control file `{action:"stop"}`, consumed) → same as sigterm but `lastExit:"stop"`, **exit 0**. |
| any | `bundleChange` → wait until `Info.plist` exists and is unchanged across two ticks ≥ 2 s apart (give up waiting after 120 s), SIGTERM the core child if one is running, write `lastExit:"bundle-changed"`, **exit 75**. launchd restarts the job from the new bundle *(spike A5)*. |
| `waiting` (grace) | `liveCore` → `parked`. Deadline passed and no live core → boot the core (`running`). |
| `parked` | `liveCore` → stay. No live core → boot the core. |
| `running` | Child exit 0 → `lastExit:"stop"`, **exit 0** (stop until next login, D5/D7). Child exit **76** (`CORE_EXIT_PARK`, the core lost a bind race or got a handoff request) → `waiting` with a 15 s handoff grace. Any other exit → `lastExit:"crash"`, **exit 1**; launchd restarts it after its 10 s throttle (D3). |

Start of process: grace is **30 s** (D8) when the previous `lastExit` was `"bundle-changed"` or a handback marker `{reason:"update"}` younger than 120 s exists (consume it). Otherwise there is no grace: `parked` if a live core exists, else boot.

The supervisor writes `<dataDir>/login-daemon.json` (atomic tmp+rename, mode 0600) on every state change: `{pid, state:"parked"|"waiting"|"running"|"stopped", corePid, bundlePath, version, label, startedAt, updatedAt, lastExit?}`. The file is informational only; nothing treats it as authority. The core child's stdout and stderr go to `<dataDir>/daemon.log` (C13).

### 3.3 Interfaces pinned for parallel work

```ts
// src/bun/daemon-mode.ts (leaf; no imports besides node:*, ./dev-defaults.ts)
export type LaunchedBy = "login-item" | "cli";
export function launchedBy(env?: NodeJS.ProcessEnv): LaunchedBy;      // AGETOR_LAUNCHED_BY === "login-item"
export function resolveIdleTimeoutMs(env?: NodeJS.ProcessEnv): number; // AGETOR_DAEMON_IDLE_MS set → Number(it) (NaN→0); login-item → 0; else 300000
export const CORE_EXIT_PARK = 76;
export const SUPERVISOR_EXIT_BUNDLE_CHANGED = 75;
export const LOGIN_ITEM_LABELS = { stable: "sh.alamops.agetor.daemon", canary: "sh.alamops.agetor.canary.daemon" } as const;

// src/bun/login-daemon-state.ts (leaf; imports core-creds.ts only)
export interface LoginDaemonState { pid: number; state: "parked"|"waiting"|"running"|"stopped"; corePid: number|null;
  bundlePath: string; version: string; label: string; startedAt: number; updatedAt: number;
  lastExit?: "stop"|"sigterm"|"bundle-changed"|"crash" }
export function readLoginDaemonState(dataDir?: string): LoginDaemonState | null;
export function writeLoginDaemonState(s: LoginDaemonState, dataDir?: string): void;
export function liveSupervisor(dataDir?: string): LoginDaemonState | null;   // state file + isPidAlive(pid) && state !== "stopped"
export function requestSupervisorStop(dataDir?: string): void;               // writes login-daemon-control.json {action:"stop", at}
export function takeSupervisorStop(dataDir?: string): boolean;               // reads + deletes
export function writeHandbackMarker(reason: "update", dataDir?: string): void; // login-daemon-handback.json {reason, at}
export function takeHandbackMarker(maxAgeMs: number, dataDir?: string): { reason: "update"; at: number } | null;

// src/bun/channel-defaults.ts (leaf; imported FIRST by index.ts)
export function applyChannelDefaults(env: NodeJS.ProcessEnv, channel: string | null, home: string): string[]; // returns the keys it set
export function readBundleChannel(execPath?: string): string | null; // dirname(execPath)/../Resources/version.json
// canary|dev and unset → AGETOR_DATA_DIR=<home>/.agetor-dev, AGETOR_API_PORT="4318"; stable/null → nothing

// src/bun/core-creds.ts
export interface CoreCreds { …existing…; launchedBy?: "login-item" }   // optional; kind stays "cli-daemon" (C15)

// src/shared/types.ts
export type BackgroundRegistration = "enabled" | "requiresApproval" | "notRegistered" | "notFound";
export type BackgroundUnavailableReason = "not-macos" | "dev-build" | "unsigned" | "not-in-applications"
  | "helper-missing" | "other-install" | "helper-failed";
export type BackgroundState = "running" | "parked" | "starting" | "stopped" | "needs-approval" | "off" | "unavailable";
export interface BackgroundStatus {
  state: BackgroundState;
  registration: BackgroundRegistration | null;          // null when unavailable
  unavailableReason?: BackgroundUnavailableReason;
  detail?: string;                                      // last helper error / human detail
  label: string | null;
  supervisorPid: number | null;
  corePid: number | null;
  remoteAccess: boolean;
}
export interface RemoteAccessStatus { enabled: boolean; preview: true }
export const REMOTE_ACCESS_PREF_KEY = "remoteAccess";   // stored value "on" | "off"
// AppEvent additions:
//  quit_request gains  backgroundArmed: boolean; completely: boolean
//  | { type: "background_changed"; status: BackgroundStatus; ts: number }

// src/bun/login-item-helper.ts (imports core-spawn.ts, daemon-mode.ts, shared types; never db.ts)
export interface HelperInfo { bundlePath: string; bundleId: string; channel: string; label: string; plist: string;
  signed: boolean; teamId: string | null; location: "applications"|"user-applications"|"translocated"|"volume"|"other" }
export interface HelperResult { ok: boolean; registration: BackgroundRegistration; error?: { domain: string; code: number; message: string } }
export interface LoginItemHelper {
  info(): Promise<HelperInfo>; status(): Promise<BackgroundRegistration>;
  register(): Promise<HelperResult>; unregister(): Promise<HelperResult>; reregister(): Promise<HelperResult>;
  openSettings(): Promise<void>;
}
export function resolveLoginItemHelperPath(opts?: { forCli?: boolean }): string | null;
//   AGETOR_LOGIN_ITEM_HELPER → dirname(process.execPath)/agetor-login-item → (forCli) /Applications/Agetor.app/…, ~/Applications/Agetor.app/…
export function loginItemHelper(dataDir?: string): LoginItemHelper | null;
//   AGETOR_FAKE_LOGIN_ITEM=1 → file-backed fake at <dataDir>/fake-login-item.json (state + info overrides + a calls log)
//   else the Swift helper via coreSpawn (JSON on stdout, 15 s timeout); null when no helper resolves

// src/bun/background.ts (core-side; may import db.ts)
export function getBackgroundStatus(opts?: { fresh?: boolean }): Promise<BackgroundStatus>; // 2 s cache; reconciles remote (C3)
export function turnOnBackground(): Promise<BackgroundStatus>;     // app only (route enforces)
export function turnOffBackground(): Promise<BackgroundStatus>;    // also sets remote off (C3); unregister via a setsid'd helper
export function startBackgroundNow(): Promise<BackgroundStatus>;   // only when registration enabled and no live supervisor (C17)
export function openLoginItems(): Promise<void>;
export function getRemoteAccess(): RemoteAccessStatus;
export function setRemoteAccessOff(): void;
export function setRemoteAccessOnFromNativeBox(): void;            // only remote-access-box.ts calls this
export function subscribeBackgroundChanges(fn: (s: BackgroundStatus) => void): () => void;

// src/bun/server.ts — startApiServer deps grow:
//   notifications?: { post(n: Parameters<ApiNative["showNotification"]>[0]): void; remove(r: TaskNotificationRemoval): void }
//   onShutdownRequest?: (mode: "stop" | "handoff") => void
// POST /daemon/shutdown body: optional { mode?: "stop" | "handoff" } (absent or invalid → "stop")
```

**Swift helper contract** (`agetor-login-item <cmd>`): it prints one JSON line on stdout and exits 0 for every handled command, including a failed `register` (`{"ok":false,…}`). It exits 64 on usage errors and 70 on internal errors.

| Command | Behavior |
| --- | --- |
| `info` | The `HelperInfo` fields above. `signed` = team id present and not ad-hoc (`SecCodeCopySelf` + `SecCodeCopySigningInformation`). `location` comes from the bundle path. The label comes from `Contents/Resources/version.json` `channel`: `stable` → stable label, `canary` → canary label, else `dev` and no label. |
| `status` | `SMAppService.agent(plistName:)` status. |
| `register` | Calls `register()` and returns the resulting status. |
| `unregister` | **Calls `setsid()` first**, so a call made from inside the job isn't killed with its process group, then `unregister` with completion. |
| `reregister` | Unregister, wait 500 ms, register (DTS 768592, C17). |
| `open-settings` | `openSystemSettingsLoginItems()`. |
| `run` | Sets `AGETOR_LAUNCHED_BY=login-item`, `AGETOR_LOGIN_ITEM_BUNDLE=<bundle>` and `AGETOR_LOGIN_ITEM_LABEL=<label>`. For canary or dev it also sets `AGETOR_DATA_DIR=$HOME/.agetor-dev` and `AGETOR_API_PORT=4318` when unset. Then `execv(<bundle>/Contents/MacOS/bun, [bun, <bundle>/Contents/Resources/app/daemon/login-daemon.js])`. |

### 3.4 Status derivation (C9) in `background.ts`

1. Run the helper's `info`. Any of these makes the state `unavailable`, with the reason: `process.platform !== "darwin"`, channel `dev`, `!signed`, `location ∉ {applications, user-applications}`, no helper, the helper channel's data dir differing from this core's `dataDir` (`other-install`), or a helper crash/timeout (`helper-failed`).
2. Otherwise map the helper's `status`: `notRegistered`/`notFound` → `off`, `requiresApproval` → `needs-approval`.
3. When the status is `enabled`, look at the supervisor (`liveSupervisor()`): `running` (this core is the login-item core, or the supervisor reports `running` with a live `corePid`), `parked`, `starting` (supervisor `waiting`), or **`stopped`** when no supervisor is alive. The spike showed `status` stays `enabled` after a clean exit (A2).
4. Reconcile (C3): if remote access is on and the state is anything but `running`/`parked`/`starting`, set remote off and log one line.

### 3.5 Who may do what

| Action | App (master) | CLI token | Mechanism |
| --- | --- | --- | --- |
| Read background status | ✓ | ✓ | `GET /background`; the CLI with no core runs the installed helper itself |
| Turn background **on** | ✓ | ✗ (403 `desktop-only`) | `POST /background` (`callers:"app"`): 501 headless unless the fake seam is active |
| Turn background off | ✓ | ✓ | `DELETE /background` (C3 also turns remote off) |
| Start now (enabled + stopped) | ✓ | ✓ | `POST /background/start`; 409 unless registration is enabled and no supervisor is alive |
| Open Login Items | ✓ | ✗ | `POST /background/open-settings` (`app`, `headless501`) |
| Remote access **on** | menu box only | ✗ | Native message box (D10). `PUT /preferences/remoteAccess` refuses any value but `"off"` for **every** caller (C6) |
| Remote access off / read | ✓ | ✓ | `DELETE /remote-access`, `GET /remote-access` (`app+cli`). These are the only routes allowlisted in TT3(c), with no POST/PUT/PATCH (D11) |

`DELETE /background` on the login-item core itself replies `200 {status}` first, then runs the setsid'd `unregister` on the next tick. launchd then SIGTERMs the supervisor, and the supervisor SIGTERMs the core.

### 3.6 App side

- **Boot.** `import "./channel-defaults.ts"` is the **first** import of `index.ts` (ESM evaluates it before `db.ts`, option (a)). The bind goes through a new `app-takeover.ts` `acquireApiPort()`: try the bind. On failure: if the creds file names a live `cli-daemon`, POST `/daemon/shutdown {mode:"handoff"}`, wait ≤ 10 s for the port, then bind. If the port is held but no live creds can be read, retry the read and bind every 250 ms for ≤ 5 s (C16), covering the daemon's bind-to-creds-write window and the login race. Otherwise fail loudly as today.
- **Menu.** The Agetor submenu becomes: About · separator · **Remote Access…** (`action:"remote-access"`) · separator · Hide, Hide Others, Show All · separator · Quit (⌘Q) · **Quit Agetor Completely** (`action:"quit-completely"`, ⌥⌘Q). The click handler is `Electrobun.events.on("application-menu-clicked", …)` on `e.data.action`.
- **Remote Access… box** (`remote-access-box.ts`, takes `showMessageBox` and `background` as dependencies so it's testable):
  - **When off:** title "Remote access (preview)". Message: "Keep this Mac reachable for the Agetor Companion app." Detail: "This is a preview: pairing arrives in a later version, so no device can connect yet. Turning it on also turns on Keep Agetor running in the background." Buttons `["Turn On","Cancel"]`, default and cancel = Cancel.
    - On Turn On: if background isn't `enabled`, call `turnOnBackground()`. Only an `enabled` result calls `setRemoteAccessOnFromNativeBox()` (C5).
    - On failure, a second box gives the reason. When the result is `requiresApproval`, its buttons are `["Open Login Items","OK"]`.
    - When background is `unavailable`, the box explains why and shows OK only.
  - **When on:** "Remote access is on (preview)", buttons `["Turn Off","Keep On"]`.
  - The box is bracketed with `beginLagLabel("native message box")` like `confirmKeepOff`, and broadcasts `background_changed`.
- **Quit.** `before-quit` computes `backgroundArmed = liveSupervisor() !== null && state ∈ {parked, waiting}` synchronously; no helper spawn happens in `before-quit`.
  - "Quit completely" comes from the menu flag or from `/app/force-quit {completely:true}`. In that case, write `requestSupervisorStop()` before allowing the quit.
  - With no running runs, allow immediately (the handback happens because the supervisor sees the app's pid die).
  - With runs, broadcast `quit_request {runningRunCount, runningTaskTitles, backgroundArmed, completely}` and veto. `quit-guard.ts` gains `requestQuitCompletely()`/`consumeQuitCompletely()` and `armForceQuit({completely})`.
- **Update.** `updater.ts` `applyUpdate()` calls `writeHandbackMarker("update")` before `Updater.applyUpdate()` (D8).
- **Notifications.** The app passes `notifications: { post: taskNotifier.post, remove: taskNotifier.remove }` to `startApiServer`; `native.showNotification`/`removeTaskNotification` stay for the existing callers. After the bind, the app calls `getBackgroundStatus({fresh:true})` once (fire-and-forget) to run the C3 reconcile.

### 3.7 Headless notifications (D12/C19)

`headless-notifications.ts` exports a pure `headlessNotificationFor(ev, lookup)` and `installHeadlessNotifications({ post, lookupTask })`, which uses `subscribeGlobal`. The mapping mirrors the webview's OS notifications without the focus and selection rules:

| Event | Notification |
| --- | --- |
| `interaction` `pending` | "Waiting on you" (`waiting`) |
| `run-status` `succeeded` | "Task succeeded" (`succeeded`) |
| `run-status` `failed` / `orphaned` | "Task failed" (`failed`) |
| `run-status` `cancelled` | none |
| `column` → `blocked` | By reason, as in `App.tsx:1724-1742`: `api-error`, `session-ended`, `unknown-command`, else `blocked` |
| `files-sent` | `files-sent` |
| `pipeline` → `done` | "Pipeline finished" (`pipeline-finished`) |

Step events with `pipelineParentId` are retargeted to the parent (title = parent's, subtitle = step), as the app does. The parent's own `blocked`/pipeline reason is suppressed while a retargeted step entry is the reason (kept simple: post on the step's interaction, skip the parent's `reason:"pipeline"` column event).

`headless.ts` builds `createTaskNotifier({ plain: () => {} })`, so there's no plain fallback headless (C19 "otherwise none"), calls `seed()`, installs the removal hooks, and passes the same sink to `startApiServer`.

`resolveNotifier()` gains a last fallback to `resolveInstalledAppNotifier()`, which itself also checks `~/Applications/Agetor.app` (A11). The feature is off under `NODE_ENV=test` unless `AGETOR_HEADLESS_NOTIFICATIONS=1`, and `=0` disables it anywhere. `e2e/fixtures.ts` sets `0`.

### 3.8 CLI

| Command | Behavior |
| --- | --- |
| `agetor daemon status` | Adds a `background:` line. With a live core it reads `GET /background`; with none, the installed helper plus the state file (D2). `--json` adds `launchedBy` and a `background` object. |
| `agetor daemon start` | When no live core and the background is `stopped` (enabled, no supervisor): `helper.reregister()`, then wait ≤ 20 s for the core (C17). Otherwise as today. |
| `agetor daemon stop` | With a live core, POSTs `/daemon/shutdown` (no body = stop). For a login-item core it prints "stopped — the background core starts again at next login (turn it off with `agetor daemon background off`)". With no core but a live supervisor in `waiting`, it writes the stop control file. |
| `agetor daemon background status\|off` | `off` goes through `ensureCore` → `DELETE /background`. |
| `agetor remote status\|off` | `GET`/`DELETE /remote-access` via `ensureCore`. |

### 3.9 Build and release

- `native/login-item/main.swift` → `scripts/build-login-item.ts` → `vendor/login-item/agetor-login-item` + `vendor/login-item/LaunchAgents/*.plist`, after a `plutil -lint`. The script signs like `build-disclaim.ts`; Electrobun re-signs the helper inside `Contents/MacOS` anyway.
- `scripts/build-daemon-bundle.ts` → `vendor/daemon/login-daemon.js` and `vendor/daemon/headless.js` via `Bun.build({ target: "bun" })`. Migrations are inlined by the existing text imports.
- `electrobun.config.ts` copies:

  | Source | Destination |
  | --- | --- |
  | `vendor/login-item/agetor-login-item` | `../../MacOS/agetor-login-item` |
  | `vendor/login-item/LaunchAgents` | `../../Library/LaunchAgents` |
  | `vendor/daemon` | `daemon` |

- The `build`, `build:canary` and `build:stable` chains run `vendor:login-item` and `vendor:daemon` before `verify:vendor`.
- `verify-vendor-signing.ts` adds `login-item` to `OWNERS`.
- `verify-release.ts` extracts the inner bundle from the wrapper's `Resources/*.tar.zst` (`Bun.zstdDecompressSync` + `tar -x`) and checks:
  - the helper is Developer ID, hardened runtime and team ZQG3522LY7;
  - both plists pass `plutil -lint`, and their `BundleProgram`, `ProcessType=Interactive`, `KeepAlive.SuccessfulExit=false` and `AssociatedBundleIdentifiers` are right;
  - `BundleProgram` resolves to an existing file;
  - both daemon JS files exist.

  The plist is checked through its files: `status` can't verify it (investigation S2).

### 3.10 Evidence vs reasoning

- **Evidence (spike/web):** helper in `Contents/MacOS`, `KeepAlive` semantics, `ProcessType Interactive`, unregister SIGTERM + tmux survival, the bundle-swap restart, re-enable restarting the job, shared approval across same-id bundles, the 500 ms re-register delay, the plist lint.
- **Reasoning:** the supervisor/child split, grace windows (15 s handoff, 30 s update, 120 s stable bundle), `CORE_EXIT_PARK` = 76, the control-file stop, `setsid` in `unregister`, the notification mapping, and the channel-defaults import order (ESM evaluation order).

## 4. Work breakdown — implementation tasks

| ID | Goal | Owned files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Swift helper, both LaunchAgent plists, and the build script that compiles, signs and lints them into `vendor/login-item/` | `native/login-item/main.swift`, `native/login-item/LaunchAgents/sh.alamops.agetor.daemon.plist`, `native/login-item/LaunchAgents/sh.alamops.agetor.canary.daemon.plist`, `scripts/build-login-item.ts` | — | `bun scripts/build-login-item.ts` produces an arm64 binary (`lipo -archs`), cached by mtime + identity stamp like `build-disclaim.ts`. Every command in the §3.3 contract prints the pinned JSON. `unregister` calls `setsid()`. `run` sets the pinned env and `execv`s. Plists: Label, `BundleProgram Contents/MacOS/agetor-login-item`, `ProgramArguments [agetor-login-item, run]`, `RunAtLoad`, `KeepAlive {SuccessfulExit:false}`, `ProcessType Interactive`, `ExitTimeOut 30`, `AssociatedBundleIdentifiers [sh.alamops.agetor]`; both lint clean. Running `info` from an unbundled path prints `location:"other"` without crashing. Skipped (exit 0, empty dir) on non-darwin. |
| T2 | Leaf modules: launch mode, idle rule and exit codes; supervisor state, control and handback files; channel defaults | `src/bun/daemon-mode.ts`, `src/bun/login-daemon-state.ts`, `src/bun/channel-defaults.ts` | — | Exact §3.3 signatures. No module imports `db.ts` (U1 checks the import graph). Files are written atomically at 0600. `channel-defaults.ts` runs `applyChannelDefaults(process.env, readBundleChannel(), homedir())` as a side effect when imported (logging `[agetor] canary/dev build: using <dir>, port <n>` once when it sets something), and the pure functions stay exported. `readBundleChannel` returns null when `version.json` is absent (source runs). |
| T3 | Shared types and the creds field | `src/shared/types.ts`, `src/bun/core-creds.ts`, `src/bun/index.ts` (only the two placeholder fields in the `quit_request` broadcast) | — | `BackgroundStatus` and friends, `RemoteAccessStatus`, `REMOTE_ACCESS_PREF_KEY`, `quit_request` gains `backgroundArmed` and `completely`, the new `background_changed` AppEvent member, doc comments updated. `CoreCreds.launchedBy?: "login-item"`. `readCoreCreds` still accepts files without it and drops an invalid value (anything but `"login-item"`) rather than rejecting the file. `typecheck` is green, and every existing `quit_request` producer and consumer compiles: the fields are required, so T10/T11 fill them; in wave 1 the only producer is `index.ts`, which T3 updates with `backgroundArmed:false, completely:false` placeholders so the barrier compiles. |
| T4 | Helper client: path resolution, JSON parsing, timeouts, file-backed fake seam | `src/bun/login-item-helper.ts` | T2, T3 (pinned) | `loginItemHelper()` returns null with no helper. The real helper is run through `coreSpawn` with a 15 s timeout. A non-JSON or exit ≠ 0 output becomes a thrown `HelperError` carrying stderr. The fake (`AGETOR_FAKE_LOGIN_ITEM=1`) reads and writes `<dataDir>/fake-login-item.json` `{registration, info?, calls:[]}`: `register` → `enabled`, `unregister` → `notRegistered`, `reregister` → `enabled`, each call appended to `calls`. It imports no `db.ts`, so the CLI can use it offline. |
| T5 | Supervisor: pure machine + IO entry | `src/bun/login-daemon-machine.ts`, `src/bun/login-daemon.ts` | T2 | The machine is a pure `step(state, inputs) → {state, actions[]}` implementing the §3.2 table exactly, including the grace rules and exit codes. The entry runs a 1 s tick. It spawns the core with `coreSpawn([process.execPath, coreEntry], {env: childEnv({AGETOR_LAUNCHED_BY:"login-item"}), stdout/stderr: daemon.log fd})`, where `coreEntry = AGETOR_LOGIN_DAEMON_CORE ?? <bundle>/Contents/Resources/app/daemon/headless.js` and `<bundle> = AGETOR_LOGIN_ITEM_BUNDLE`. It handles SIGTERM/SIGINT and writes the state file on every transition. It logs through `daemonLog` with a `login-daemon:` prefix. Importing it opens no DB, which the I2 subprocess test checks by asserting no `agetor.sqlite` appears in a fresh data dir while parked. |
| T6 | Headless core: idle rule, `launchedBy` creds, park on lost bind or handoff, early signal handling, headless notifications | `src/bun/headless.ts` | T2, T3, T7, T9 (pinned) | The idle loop uses `resolveIdleTimeoutMs()`; the `daemonLog` boot line appends `launchedBy=…` and `idle=<ms\|off>` while keeping the existing strings ("cli-daemon starting", "cli-daemon listening", "port already owned by a live core — exiting quietly"). Creds gain `launchedBy` for a login-item core. Losing the bind to a live core exits `CORE_EXIT_PARK` when login-item, else 0 as today. SIGINT/SIGTERM handlers are installed at the start of `runDaemon`. `shutdown()` removes the creds file only when this process wrote it (`ownsCreds`). `startApiServer` gets `onShutdownRequest: (mode) => shutdown(mode, mode === "handoff" && isLoginItem ? CORE_EXIT_PARK : 0)` and `notifications` from T7's installer. The headless notifier is installed only when the env gate allows (§3.7). Existing `daemon-boot`/`daemon-handoff` tests stay green. |
| T7 | Headless notification policy and installer; notifier fallbacks; e2e gate | `src/bun/headless-notifications.ts`, `src/bun/notifier.ts`, `e2e/fixtures.ts` (add `AGETOR_HEADLESS_NOTIFICATIONS: "0"` to the backend env only) | T3 | `headlessNotificationFor` is pure and implements the §3.7 table, including the pipeline retargeting and hidden-step rules. `installHeadlessNotifications()` returns `{ sink, dispose }`, where `sink = {post, remove}` over `createTaskNotifier({plain: () => {}})`, seeds it, and installs `installNotificationRemovalHooks`. `isHeadlessNotificationsEnabled(env)` implements the gate. `resolveNotifier()` falls back to `resolveInstalledAppNotifier()`, which checks `/Applications` then `~/Applications`. Existing `notifier.test.ts` stays green. |
| T8 | Background controller | `src/bun/background.ts` | T2, T3, T4 | §3.3 signatures. Derivation follows §3.4, including the C3 reconcile. The status cache is 2 s; `fresh:true` bypasses it. `turnOn` calls `register` and maps a failure to a `detail`. `turnOff` sets remote off first, then unregisters. When `launchedBy() === "login-item"` it schedules the unregister on `setTimeout(0)` after the caller has its answer: the function returns the predicted `off` status, and the route sends it. `startNow` returns a 409-able error when its precondition fails. Every change notifies `subscribeBackgroundChanges` listeners. The remote preference is read and written through `preferences` with `REMOTE_ACCESS_PREF_KEY`. `AGETOR_FAKE_REMOTE_ACCESS=on` (honored only with `AGETOR_FAKE_LOGIN_ITEM=1`) seeds remote on once at first read. |
| T9 | Routes, policy and the policy test (TT3(c) allowlist), plus the quit-guard flags the routes arm | `src/bun/server.ts`, `src/bun/route-policy.ts`, `src/bun/route-policy.test.ts`, `src/bun/quit-guard.ts` | T3, T8 (pinned) | New routes per §3.5 with `ROUTE_POLICY` entries. `/background`: `GET: CLI, POST: APP, DELETE: CLI`. `/background/start`: `POST: CLI`. `/background/open-settings`: `POST: app({headless501:true})`. `/remote-access`: `GET: CLI, DELETE: CLI`. `POST /background` answers 501 when `!native` unless the fake seam is on. `GET` answers 200 everywhere; on non-darwin it reports `unavailable`. Each mutation broadcasts `background_changed` over `/app/events` (`broadcastAppEvent`). `PUT /preferences/remoteAccess` refuses any value but `"off"` for every caller (403 `{code:"native-only"}`), and `"off"` behaves like `DELETE /remote-access`. `/daemon/shutdown` parses `{mode}` and calls `deps.onShutdownRequest(mode)` when given (headless), else keeps today's behavior. `/app/force-quit` parses `{completely?: boolean}` and passes it to `armForceQuit({completely})`. `quit-guard.ts` gains `armForceQuit({completely})`, `consumeForceQuit() → {completely} \| null` (still one-shot; the unchanged `index.ts` truthiness check keeps compiling), and `requestQuitCompletely()`/`consumeQuitCompletely()` for the menu path T10 wires up. `startApiServer` accepts `notifications` and routes removal through `native?.removeTaskNotification ?? deps.notifications?.remove`. `route-policy.test.ts`: TT3(c) gets `REMOTE_ACCESS_ALLOWLIST = { "/remote-access": ["GET","DELETE"] }`, asserts the entry has exactly those methods (no POST/PUT/PATCH), and asserts no other banned segment. The desktop-only expectations and the client-call inventory gain the new routes. CLAUDE.md's list is D1's job. |
| T11 | Webview: Settings Background section, quit dialog, client methods, event handling | `src/mainview/components/settings/BackgroundSection.tsx` (new), `src/mainview/components/settings/SettingsDialog.tsx` (mount in `GeneralSection` only), `src/mainview/lib/background.ts` (new), `src/mainview/lib/quit-dialog.ts` (new), `src/mainview/components/QuitConfirmDialog.tsx` (new), `src/mainview/lib/api.ts`, `src/mainview/App.tsx` | T3, T9 (pinned) | **`lib/background.ts`:** `backgroundCopy(status)` returns label, detail, toggle enabled/checked and actions for all 7 states (C9 wording). **`BackgroundSection`:** loads `GET /background` on mount and re-reads it every 5 s while Settings is open and on a `background_changed` event. It renders: <ul><li>the switch (`background-toggle`), disabled when `unavailable` (reason text `background-unavailable`); turning it off asks a confirm when remote is on ("This also turns off remote access")</li><li>the state line (`background-state`)</li><li>[Open Login Items] (`background-open-login-items`) on `needs-approval`</li><li>[Start now] (`background-start-now`) on `stopped`</li><li>the remote row (`remote-access-state`), with [Turn off] (`remote-access-turn-off`) when on, else the hint "Turn it on from Agetor › Remote Access…"</li></ul>**`lib/quit-dialog.ts`:** `quitDialogModel(ev)` returns `{title, body, actions: ("quit"\|"quit-completely"\|"cancel")[]}` for armed, completely and plain (today's copy). `QuitConfirmDialog` renders it on the existing `Dialog` primitive (`quit-dialog`, `quit-dialog-quit`, `quit-dialog-quit-completely`, `quit-dialog-cancel`) and calls `api.forceQuit({completely})`. **`App.tsx`:** routes `quit_request` to it instead of `confirm()`, and forwards `background_changed` to the section through a small module store or a prop. **`api.ts`:** `getBackground`, `turnOnBackground`, `turnOffBackground`, `startBackground`, `openLoginItems`, `getRemoteAccess`, `turnOffRemoteAccess`, and `forceQuit(opts?)`. Tokens only from the semantic set (`text-warning`, `bg-info/10`…). |
| T12 | CLI: daemon status, start and stop changes, `daemon background`, `remote` | `src/cli/commands/daemon.ts`, `src/cli/commands/remote.ts` (new), `src/cli/daemon/supervisor.ts`, `src/cli/api-client.ts`, `src/cli/index.ts` | T3, T4, T9 (pinned) | Per §3.8. `api-client` methods: `getBackground`, `turnOffBackground`, `startBackground`, `getRemoteAccess`, `turnOffRemoteAccess`, plus `shutdownCore(mode?)`. `publicCore` adds `launchedBy`. Offline status uses `loginItemHelper()` with `resolveLoginItemHelperPath({forCli:true})` and `readLoginDaemonState()`. `stop` and `start` print the D5/C17 wording. Help blocks for `daemon background` and `remote` exist in `index.ts`, and `cmdDaemon`'s unknown-subcommand error lists `background`. Unknown flags and subcommands error the way the house commands do. |
| T10 | App main process: channel defaults first, takeover, menu, Remote Access box, quit/handback, update marker, notification sink | `src/bun/index.ts`, `src/bun/app-takeover.ts` (new), `src/bun/remote-access-box.ts` (new), `src/bun/updater.ts` | T2, T3, T8, T9 | Per §3.6. **`index.ts`:** imports `./channel-defaults.ts` first, replaces its `startApiServer` try/catch with `acquireApiPort()` (injected deps: `start`, `readCreds`, `probe`, `fetch`, `waitForPortFree`, `sleep`, `now`), adds the menu items and the click handler, and fills `before-quit` with `backgroundArmed`/`completely` and the stop-control write. It uses T9's `quit-guard.ts` flags (the menu item calls `requestQuitCompletely()` then `Utils.quit()`; `before-quit` reads `consumeQuitCompletely()` and `consumeForceQuit()?.completely`). **`updater.ts`:** writes the handback marker. **`remote-access-box.ts`:** exports `runRemoteAccessBox({showMessageBox, background, openLoginItems})`. The app passes the notification sink and runs the post-bind reconcile. A dev run (`bun run dev`) still boots (helper missing → `unavailable`). |
| T13 | Build wiring and release verification | `electrobun.config.ts`, `package.json`, `scripts/build-daemon-bundle.ts` (new), `scripts/verify-vendor-signing.ts`, `scripts/verify-release.ts` | T1, T5, T6 | `bun run vendor:login-item && bun run vendor:daemon` succeed. `bun vendor/daemon/headless.js` boots a core against a temp data dir (smoke run documented in the task). The copy entries from §3.9 are in place, and both vendor steps are in the three build chains. `verify:vendor` covers `vendor/login-item`. `verify-release.ts` fails on a missing or unsigned helper, a plist that fails lint or has a wrong key, or missing daemon JS, and prints a line per check. A built `build/canary-macos-arm64` app (owner QA) contains `Contents/MacOS/agetor-login-item`, `Contents/Library/LaunchAgents/*.plist` and `Contents/Resources/app/daemon/*.js`. |

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| U1 | unit | T2 | `src/bun/daemon-mode.test.ts`, `src/bun/login-daemon-state.test.ts`, `src/bun/channel-defaults.test.ts` | <ul><li>Idle rule matrix: unset → 300000; login-item → 0; explicit env wins both ways; NaN → 0.</li><li>`launchedBy`.</li><li>State, control and handback files: round-trip, 0600, atomic (no `.tmp` left), stale pid → `liveSupervisor` null, marker age limit, `takeSupervisorStop` consumes.</li><li>`applyChannelDefaults`: canary/dev/stable/null, never overrides a set env.</li><li>An import-graph check that `daemon-mode`, `login-daemon-state`, `login-item-helper` and `login-daemon` don't reach `db.ts` (static scan of import specifiers, or a subprocess import with a fresh `AGETOR_DATA_DIR` asserting no `agetor.sqlite`).</li></ul> |
| U2 | unit | T5 machine | `src/bun/login-daemon-machine.test.ts` | Every §3.2 row: <ul><li>park while a live core exists; boot when none</li><li>child exit 0 → exit 0; exit 76 → `waiting` 15 s, then boot or park</li><li>crash → exit 1</li><li>SIGTERM and stop request → forward, then exit 0</li><li>bundle change → stable-wait → exit 75; the 120 s give-up</li><li>update grace 30 s from `lastExit:"bundle-changed"` or the marker</li><li>the order of checks (stop wins over a boot in the same tick)</li></ul> |
| U3 | unit | T4, T8 | `src/bun/login-item-helper.test.ts`, `src/bun/background.test.ts` | Helper: path precedence (env, execPath sibling, installed apps for the CLI); JSON parse and error mapping with a stubbed binary (a script in a temp dir printing fixed JSON); timeout; fake seam calls log. Background: the full C9 derivation table, every unavailable reason, the C3 reconcile, `turnOff` sets remote off before unregistering, deferred unregister when login-item, `startNow` preconditions, the change listener fires, the 2 s cache and `fresh`. |
| U4 | unit | T7 | `src/bun/headless-notifications.test.ts`, `src/bun/notifier.test.ts` (extend) | The §3.7 table per event, including cancelled → none, hidden step → retargeted to the parent, pipeline done, files-sent, blocked reasons; the gate (`NODE_ENV=test`, `=0`, `=1`); `resolveNotifier` falls back to the installed app; `resolveInstalledAppNotifier` checks `~/Applications`. |
| U5 | unit | T10 pure parts | `src/bun/app-takeover.test.ts`, `src/bun/remote-access-box.test.ts` | Takeover: free bind; live cli-daemon → handoff POST body `{mode:"handoff"}` then bind; held port with no creds → retries for ≤ 5 s then succeeds once creds appear or the port frees; foreign holder → fails loudly; login-item creds treated as cli-daemon. Box: off → Turn On → enabled → remote on; register fails → remote stays off, error box; `requiresApproval` → Open Login Items button calls `openLoginItems`; unavailable → explanation and OK only; on → Turn Off → remote off; Cancel/Keep On → no change. |
| U6 | unit | T11 pure parts | `src/mainview/lib/background.test.ts`, `src/mainview/lib/quit-dialog.test.ts` | `backgroundCopy` for all 7 states and every unavailable reason; `quitDialogModel` armed, completely and plain (plain keeps today's sentence), singular and plural, title preview truncation as today. |
| I1 | integration | T9 (+T8 via the fake seam) | `src/bun/background-routes.test.ts` (new), `src/bun/headless-routes.test.ts` (extend) | An in-process `startApiServer` (with and without `makeTestNative`) and `AGETOR_FAKE_LOGIN_ITEM=1`: <ul><li>`GET /background` for the CLI and the app;</li><li>`POST /background` with the CLI token → 403 `desktop-only`; with the master and fake → `enabled`; headless with no fake → 501;</li><li>`DELETE /background` also turns remote off;</li><li>`POST /background/start` 409 unless stopped;</li><li>`open-settings` desktop-only;</li><li>`GET`/`DELETE /remote-access`; `PUT /preferences/remoteAccess` `"on"` → 403 for the master **and** the CLI, `"off"` → 204;</li><li>`background_changed` broadcast on `/app/events`;</li><li>`/daemon/shutdown {mode:"handoff"}` calls the injected `onShutdownRequest("handoff")`;</li><li>`/app/force-quit {completely:true}` arms completely.</li></ul>`headless-routes.test.ts` lists `POST /background/open-settings` among the 501s. |
| I2 | integration (subprocess) | T5, T6 | `src/bun/login-daemon.test.ts` (new), `src/bun/daemon-boot.test.ts` (extend), `src/bun/daemon-handoff.test.ts` (extend) | Uses fixed new ports (pick unused ones near 4473; grep the existing tests first), `AGETOR_LOGIN_DAEMON_CORE=src/bun/headless.ts`, a fake bundle dir with `Contents/Info.plist`, and a temp data dir:<ol><li>The supervisor boots the core; the creds carry `launchedBy:"login-item"`; the state file says `running`.</li><li>`POST /daemon/shutdown {mode:"handoff"}` → the core exits 76 → state `waiting` → a stand-in "app" (a tiny `Bun.serve` on the port plus a creds file `kind:"app"` with that test's pid) → `parked`; stop the stand-in → the supervisor boots the core again within ≤ 3 s (the handback).</li><li>No body → the core exits 0 → the supervisor exits 0 (`lastExit:"stop"`).</li><li>The stop control file while parked → exit 0.</li><li>SIGTERM → the core and supervisor exit 0.</li><li>Replacing `Info.plist` → exit 75.</li></ol>Plus: a login-item core logs `idle=off`; a CLI core keeps `idle=300000`; a login-item core that loses the bind to a live core exits 76, a CLI core exits 0. `daemon-boot` keeps its original assertions. |
| I3 | integration | T12 | `src/cli/daemon-background.test.ts` (new), `src/cli/remote.test.ts` (new), `src/cli/supervisor.test.ts` (extend) | Against a real in-process server (the house `*-daemon.test.ts` pattern) with the fake seam: `daemon status` shows background, offline status through the fake with no core, `daemon background off`, `remote status\|off`, the `daemon stop` wording for a login-item core, `daemon start` re-registering when stopped (fake `calls` shows `reregister`), and the `--json` shapes. `supervisor.test.ts` covers `shutdownCore("handoff")` sending the body. |
| E1 | e2e | T8, T9, T11 | `e2e/background-settings.spec.ts` (new) | `test.use({ backendEnv: { AGETOR_FAKE_LOGIN_ITEM: "1" } })`; the spec writes `<backend.dataDir>/fake-login-item.json` and `login-daemon.json` (its own `process.pid` as the live supervisor pid) before opening Settings:<ul><li>Off → toggle on → "On, parked while the app is open".</li><li>`needs-approval` → [Open Login Items] records `openSettings` in `calls`.</li><li>`stopped` → [Start now] records `reregister`.</li><li>Unsigned info → the switch is disabled with the reason.</li><li>A second describe with `AGETOR_FAKE_REMOTE_ACCESS: "on"` (both keys in one `test.use`, since the nested call replaces the object): the remote row shows on, Turn off → off, and turning the background off also clears remote (C3).</li></ul>Uses `data-testid`s from T11. |
| D1 | docs | all | `README.md`, `CLAUDE.md`, `docs/plans/companion-pairing-requirements.md`, `docs/qa/always-on-host-qa.md` (new) | **README:** the CLI daemon section (`:238`), `agetor daemon` (`:279`), `daemon.log` (`:330`), the `AGETOR_DAEMON_IDLE_MS` row (`:354`, now "CLI-spawned daemon; the background core never idle-exits"), a new "Keep Agetor running in the background" section, the `agetor remote` command, the new env vars (`AGETOR_HEADLESS_NOTIFICATIONS`, `AGETOR_FAKE_LOGIN_ITEM`, `AGETOR_FAKE_REMOTE_ACCESS`, `AGETOR_LOGIN_ITEM_HELPER`, `AGETOR_LOGIN_DAEMON_CORE`). **CLAUDE.md:** the route-policy paragraph (the `/background*` and `/remote-access` entries, the TT3(c) allowlist, `POST /background`/`open-settings` in the desktop-only list), the orchestration/daemon handoff (supervisor, parking, `CORE_EXIT_PARK`), confirm-on-quit (armed copy, Quit Completely), headless notifications, the canary data-dir default, the C21 rollback rule, and the env overrides. **companion-pairing-requirements.md:** rule 3 and rule 5 now name the allowlisted `GET`/`DELETE /remote-access` and the native-only "on". **QA checklist:** see §5.1. |

### 5.1 Owner's signed-build QA (`docs/qa/always-on-host-qa.md`, written by D1)

Build: `bun run build:canary` with the Developer ID env. Install the inner app (or drag it from the DMG) into `~/Applications`. It runs against `~/.agetor-dev` on port 4318. Check:

1. **Turn on.** The Settings switch shows the macOS "Background Items Added" notification, then state "On, parked while the app is open". `launchctl print gui/$UID/sh.alamops.agetor.canary.daemon` shows `spawn type = interactive`.
2. **⌘Q with no tasks.** The core is up within ~3 s (`agetor --data-dir ~/.agetor-dev daemon status` shows `cli-daemon · launchedBy login-item`). Reopening the app parks it again.
3. **⌘Q with a running claude task.** The dialog reads "They'll keep running in the background". After quitting, the task finishes and a "Task succeeded" notification arrives with the app closed. Clicking it opens the app on that task.
4. **⌥⌘Q (Quit Agetor Completely).** The menu item fires (A10); if ⌥⌘Q triggers macOS's Quit-and-Keep-Windows instead, note it. The core stops, the state says "stopped, starts again at next login", and [Start now] brings it back.
5. **Log out and in.** The core runs at login, with no app.
6. **System Settings › Login Items.** Toggle Agetor off → Settings shows "Needs approval" → [Open Login Items] lands on the right panel → toggle it on → the job restarts by itself.
7. **`agetor daemon stop`** while the background core runs → the D5 wording; stays stopped until login or Start now.
8. **Remote Access….** The box copy. Turn On → remote on + background on. Settings Turn off → off; CLI `agetor remote off` works; `PUT /preferences/remoteAccess on` is refused.
9. **Turning background off** with an agent running in tmux: the agent survives, and the next core reattaches it.
10. **Update:** install an older canary, update in-app → the job restarts from the new bundle, waits for the new app, and no second core appears.
11. **A DMG-mounted or translocated copy** shows the switch disabled ("Move Agetor to Applications first").
12. **TCC:** no "Agetor would like to access data from other apps" prompt from the background core during a task in `~/Documents` (disclaimed children).
13. **Dev and canary sharing approval (A8):** with both a stable release and a canary registered, toggling the shared row can leave one label `notFound`. Confirm Settings shows it honestly as Off, and turning it on again works.

### 5.2 E2e decision and run recipe

**E2e applies** to the Settings background and remote flows and to remote off: a UI flow across the webview → API → core boundary. The native parts (SMAppService, menu, message box, Electrobun quit) can't run in Playwright's headless backend. They are covered by unit tests of their pure parts (U5, U6), subprocess integration tests (I2) and the owner's signed-build QA (§5.1).

**Run recipe:**
1. `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`, then `bun install` (a fresh worktree has no `node_modules`).
2. Unit and integration: `bun run typecheck && bun test`. One file: `bun test src/bun/login-daemon.test.ts`.
3. E2e: `bun node_modules/@playwright/test/cli.js test e2e/background-settings.spec.ts`. `e2e/fixtures.ts` starts one `bun src/bun/headless.ts` per worker and the webview from the Vite build per `playwright.config.ts`. No credentials or seed data are needed; the spec writes its fake-seam files into `backend.dataDir`. Run one Playwright run at a time (port collisions).

## 6. Execution waves

| Wave | Tasks (parallel) | Barrier |
| --- | --- | --- |
| 1 | T1, T2, T3, T4 | `bun run typecheck && bun test` green; `bun scripts/build-login-item.ts` builds; commit checkpoint. |
| 2 | T5, T6, T7, T8, T9, T11, T12 | Typecheck + full `bun test` green, including the updated `route-policy.test.ts` (T9) and the unchanged daemon tests; commit. |
| 3 | T10, T13 | Typecheck + `bun test` green; `bun run vendor:login-item && bun run vendor:daemon` succeed; `bun run dev` boots (the switch shows `unavailable`); commit. |
| 4 | U1, U2, U3, U4, U5, U6, I1, I2, I3, E1, D1 | Full `bun test` + E1 green, docs updated; commit. Then the owner's signed-build QA (§5.1). |

**Collision check.** Every owned-files list above was checked: no path appears twice in one wave.
- Wave 2 hot files each have exactly one owner: `server.ts`, `route-policy.ts`, `route-policy.test.ts`, `quit-guard.ts` → T9; `App.tsx`, `api.ts`, `SettingsDialog.tsx` → T11; `src/cli/index.ts`, `api-client.ts` → T12; `e2e/fixtures.ts` → T7.
- `src/shared/types.ts` → T3 only (wave 1). `index.ts` → T3 (wave 1 placeholder fields) and T10 (wave 3), in different waves.
- Within a wave, T6 codes against T7's `installHeadlessNotifications` and T9's `startApiServer` deps; T11 and T12 code against T9's route shapes. All are pinned in §3.3 and §3.5.

## 7. Blast radius & risks

- **Callers of changed contracts.**
  - `CoreCreds` (+optional field): `core-creds.ts`, the CLI `discoverCore`/`publicCore`, `src/cli/tui` fixtures. Old CLIs ignore the field (K12).
  - `quit_request` (+2 required fields): `index.ts` producer, `App.tsx` consumer.
  - `startApiServer` deps (+2 optional): `index.ts`, `headless.ts`, tests that call it.
  - `/daemon/shutdown` (+optional body): `supervisor.ts`, `index.ts`. An older app or CLI sends no body → `stop`, which is today's behavior.
  - `/app/force-quit` (+optional body).
  - `resolveNotifier` (new fallback): `task-notifier.ts`, `index.ts`.
- **Respawn loop.** A core that can't bind to a foreign process exits 1 → the supervisor exits 1 → launchd retries every 10 s. `daemon.log` grows, but it's truncated past 5 MB once per process. Settings shows "starting". Accepted; the state line plus `detail` explain it.
- **Double reattach at login.** The login-item core can reconcile tmux sessions before losing the bind race to an app opened at login. The `(run_id, line_uuid)` dedup index absorbs duplicate events, and the same race exists today between the app and a CLI daemon. Accepted.
- **Agents can stop or park the core.** `/daemon/shutdown` and the control file are agent-reachable, as `/daemon/shutdown` already is (K13). The worst case is "stopped until next login" or a self-healing park.
- **Agents can turn background or remote off.** Removing authority only (rule 3). Agents cannot turn either on: `POST /background` is desktop-only, remote on is native-only, and the `PUT` value rule covers both callers.
- **Agent writes `remoteAccess=on` directly into SQLite.** The accepted residual from D10. It only keeps the core running while the background is enabled (C3 resets it otherwise), and Companion pairing will re-check presence.
- **Shared approval for same-id bundles (A8).** A canary and the release share one Login Items row. Owner-only (canary is never published), surfaced honestly in Settings, QA item 13.
- **The registration path is pinned to the install location (DTS 745412).** Refusing outside the Applications folders (C10) prevents a stale path. Moving Agetor after turning the setting on leaves a stale job, so QA item 11 and the Settings `detail` tell the user to turn it off and on again.
- **Version skew.** The CLI may be older or newer than the app. The CLI reads background status through routes when a core is live; the offline path only runs the installed helper's stable JSON contract.
- **Rollback (C21).** Reverting this change in a later build must keep the helper and call `unregister` on launch, or the old job keeps starting a `BundleProgram` that no longer exists (error 78 loop). D1 records this rule in CLAUDE.md. Turning the setting off is the per-user rollback.
- **Feature flags.** None. The switch defaults to off for everyone (C2), so the change is inert until a user turns it on.

## 8. Open questions / assumptions

| # | Assumption | Fallback if wrong | Checked by |
| --- | --- | --- | --- |
| A6 | A DMG or translocated copy would break the registration once moved. | None needed: refused by rule. | QA 11 |
| A10 | Electrobun 1.18.1 delivers `application-menu-clicked` with `data.action` for custom items (source-verified), and a custom ⌥⌘Q item wins over AppKit's Quit-and-Keep-Windows alternate. | Keep the item, drop its accelerator. If the click event never fires, put "Quit completely" only in the quit dialog and Settings, and ask the owner. | QA 4 |
| A11 | A CLI-spawned daemon can run `/Applications/Agetor.app`'s notifier (`agetor logs --notify` already does). | None — `resolveInstalledAppNotifier` already returns null without an installed app and posts nothing. | QA 3 |
| A12 | `register()` called from a **disclaimed** child of the app behaves like the spike's Terminal-launched call (SMAppService resolves by `Bundle.main`, not by the responsible process). | Run the helper un-disclaimed through a `spawn-exempt(login-item)` site (owner approval needed per the allowlist rule). | QA 1 |
| A13 | Spike results on macOS 26.6.2 hold on macOS 14 and 15 (the app's minimum is 14). | — | Unverified; no 14/15 machine available. Recorded, not blocking. |
| A14 | Electrobun's code signing covers a helper copied into `Contents/MacOS` through `build.copy` (K16 + `verify-vendor-signing.ts` comment). | `scripts.postBuild` signs it explicitly. | `verify-release.ts` (T13) |

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| Login item via SMAppService: helper, plists, build placement, signing checks (5.1) | In this run | T1, T13 |
| Login-item core never idle-exits; CLI daemon keeps 5 min; env override (5.2, C12) | In this run | T2, T6 |
| Parked supervisor, handback on quit, crash restart (5.3, D3) | In this run | T5, T6, T10 |
| App takeover parks instead of stopping; retry the bind at login (C16) | In this run | T10, T9 |
| Update handling: restart from the new bundle, 30 s wait (D8) | In this run | T5, T10 |
| `agetor daemon stop` = until next login (D5); `daemon start` re-registers (C17) | In this run | T12, T5 |
| Quit Agetor Completely ⌥⌘Q + reworded quit confirm with "Quit completely" (D6, D7, C20) | In this run | T10, T11, T9 |
| Settings → General background switch with all C9 states | In this run | T11, T8 |
| `agetor daemon background status\|off`, background line in `daemon status` (C8) | In this run | T12 |
| Remote access (preview): menu + native box, SQLite state, `GET`/`DELETE /remote-access`, `agetor remote status\|off`, Settings row, `PUT` value rule, TT3(c) allowlist (D9–D11, C5–C7) | In this run | T10, T8, T9, T11, T12 |
| Background off turns remote off (C3); remote off leaves background (C4) | In this run | T8 |
| Refuse outside the Applications folders (C10); unsigned and dev builds disabled (C11) | In this run | T1, T8 |
| Canary or dev app defaults to `~/.agetor-dev` and 4318 (option (a), this step) | In this run | T2, T10 |
| `ProcessType Interactive`, logs to `daemon.log` (C13) | In this run | T1, T5 |
| Second JS bundle run by the bundle's bun; one generic Swift helper (C14) | In this run | T13, T1 |
| `agetor-core.json` keeps `cli-daemon` + `launchedBy` (C15) | In this run | T3, T6 |
| Headless OS notifications for any headless core, removal hooks headless (4.2, D12, C19) | In this run | T7, T6 |
| `verify-vendor-signing` / `verify-release` checks for the helper, plists and daemon JS | In this run | T13 |
| Tests (C22): idle rule, parking state machine, routes incl. TT3(c) and the value rule, creds, e2e for Settings states and remote off | In this run | U1–U6, I1–I3, E1 |
| `headless-routes.test.ts` 501 list | In this run | I1 |
| README, CLAUDE.md, companion-pairing-requirements.md, QA checklist | In this run | D1 |
| Rollback rule for a build that drops the feature (C21) | In this run (documented; the unregister-on-launch code ships with that future build) | D1 |
| `POST /notifications` on a headless core (still 501; `agetor logs --notify` falls back to the helper directly, same per-task id) | Out of scope | Unchanged behavior, already covered by the CLI fallback; not part of 4.2 |
| Real Electrobun quit / menu / message box in e2e | Out of scope for automation | No native host in Playwright; covered by U5/U6 + QA §5.1 |
| Keep-awake while agents run (5.4) | Owner-deferred | Owner, grill C1 |
| Pairing, devices, relay or gateway, Noise sessions, push, Keychain identity (Tracks 6, 7, Phase 0) | Out of scope | Different Companion tickets |
| Notification router / presence (4.1, 4.3) | Out of scope | Different blueprint items |
| Linux/VPS always-on | Out of scope | Different platform |
| Re-checking user presence when remote access is used | Out of scope | Companion pairing (requirements rule 4); residual recorded in D10 |
| Verifying on macOS 14/15 | Out of scope for this run | No machine available; recorded as A13 |

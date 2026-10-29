# Grill — Always-on host (login item, no idle exit, handback on quit, remote-access switch)

| Field | Value |
| --- | --- |
| Date | 2026-10-29 |
| Source | Companion blueprint §03 row "Always-on host", §09, §12 items 4.2 and 5.1–5.4 (https://claude.ai/artifact/25cyTFUnoiRksPpD9CiiPy#readiness); investigation brief `docs/plans/always-on-host-investigation.md` |
| Mode | interactive, answered by the owner (5 question rounds) |
| Flags | none |

Grounding added in this step, beyond the brief:

- Only the stable channel is ever released (`scripts/release.ts:216` runs `build:stable` only; `upload-release.ts` takes only `stable-macos-arm64-*`). Canary is never published, so the "which channels" question reduces to signed vs unsigned builds.
- A parked `bun` process that polls a pid once a second measured **~21 MB RSS, 0.0 % CPU** (bun 1.3.10, this Mac).
- The blueprint wires all three items to remote access: §09 "Turning remote access off unregisters it", "Quitting the app with remote access on starts the daemon again"; Track 5.2 "Drive it from the remote-access setting". It also plans **one** Swift helper for SMAppService, Keychain and the power assertion (§03 "Native helpers").
- `companion-pairing-requirements.md` contradicts itself: rule 3 allows turning remote access off over HTTP/CLI, while rule 5 and `route-policy.test.ts` TT3(c) forbid any route with a `remote`/`remote-access` segment. The owner settled this in D9.
- The app already installs a native menu (`installNativeMenu`, `src/bun/index.ts:67-107`), and Electrobun has an `application-menu-clicked` event for custom items, so a "Quit Agetor Completely" item and "Agetor › Remote Access…" can be added. Native message boxes (`Utils.showMessageBox`) are already used by the disclaim prompt (`index.ts:168-180`).

## Decisions

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| D1 | Scope / trigger | What turns always-on mode on before Companion exists? | **Both**: (a) a "Keep Agetor running in the background" setting in Settings → General, which registers the login item, turns off idle exit and arms the handback; and (b) a **native-only "Remote access" on/off switch built in this change** (no pairing, no gateway). Remote access ON requires and turns on (a). | owner (rounds 1–2) |
| D2 | Authority / storage | Where does the background on/off state live, and who may change it? | **macOS is the source of truth**: no SQLite preference; the state is `SMAppService` status. Turning it **on** is app-only (desktop-only route plus native call). Turning it **off** and reading status work from the app and the CLI. | owner |
| D3 | Handback design | How does the port go back to the background core when the app quits? | **Parked daemon.** launchd keeps the job alive (`KeepAlive: {SuccessfulExit: false}`). While another live core owns the port, the daemon waits without opening the DB, tmux or the port, and it boots when that core exits. A crash restarts it. Cost: one idle process (~21 MB, 0 % CPU) while the app runs. | owner; measured |
| D4 | Verification | Run a real SMAppService spike? | **Yes, on the owner's Mac**, signed with the owner's Developer ID. It runs **at the start of the Planning step**, before the plan is final. The owner flips the item off and on in System Settings › Login Items when asked. | owner (rounds 1, 4) |
| D5 | `agetor daemon stop` | What does stop mean while the background setting is on? | **Stop until next login**: a clean exit stays stopped (launchd restarts only crashes). `agetor daemon status` says "stopped, starts again at next login". The app's takeover **parks** the daemon instead of stopping it. | owner |
| D6 | Quit confirm | The "N tasks running" confirm when the daemon is parked? | **Keep it, reworded**: "they'll keep running in the background", with a **"Quit completely"** button. When nothing is parked (setting off, stopped, needs approval), quit behaves as today. | owner (+ confirm list #20) |
| D7 | Full stop | How does a user stop Agetor entirely? | Add **"Quit Agetor Completely" (⌥⌘Q)** to the Agetor menu next to Quit: it quits the app and stops the background core until next login. ⌘Q keeps handing back. The reworded quit confirm also offers it. Turning the setting off always stops the core for good, and `agetor daemon stop` stops it until next login. | owner (raised it as a question in round 2, answered in round 3) |
| D8 | Updates | Background core behavior during an app update | **Restart fresh, stay parked**: the parked daemon exits when its bundle changes, so launchd restarts it from the new bundle. It then waits up to ~30 s for the new app to take the port before booting, which covers a relaunch that fails. | owner |
| D9 | Remote access: visibility | How does the remote switch appear before pairing exists? | **Visible, marked preview**: "Remote access (preview): keeps this Mac reachable for the Companion app; pairing arrives later". Turning it on turns on the background setting and stores the remote-access state the Companion work builds on. | owner |
| D10 | Remote access: turning on | How is "on" decided (native-only)? | **App menu "Agetor › Remote Access…" opens a native message box** (buttons only, like the disclaim prompt); no HTTP route and no webview for "on". The state is stored on disk. Accepted residual: an agent can flip it on by writing the DB, which today only keeps the core running, and Companion pairing will re-check that the user is present. | owner |
| D11 | Remote access: turning off | How does "off" work, given TT3(c)? | **Add allowlisted remote routes**: `DELETE /remote-access` (off) plus CLI `agetor remote off`, with `route-policy.test.ts` TT3(c) changed in this change to allowlist exactly these entries (the requirements doc says that test change is where the review happens). | owner |
| D12 | Headless notifications (blueprint 4.2) | Include OS notifications from the headless core? | **Yes, for any headless core**: the login-item core uses the notifier in its own bundle, and a CLI-spawned daemon uses the notifier of an installed Agetor.app (otherwise none). | owner (+ confirm list #19) |
| D13 | QA / research | How to dogfood and QA before release? | The planner and implementer **research the correct implementation on the web** (Apple docs, DTS forum threads, prior art). The **owner runs the signed-build tests** once the work is done. A `docs/qa/` checklist ships with the change (#22). | owner |
| C1 | Scope | Keep-awake (blueprint 5.4) | Out of scope; separate ticket. | owner (confirm list) |
| C2 | Defaults | Default state | The background setting is off for everyone; no onboarding prompt. | owner (confirm list) |
| C3 | Rules | Background turned off while remote is on | Remote access turns off too (this only removes authority). | owner (confirm list) |
| C4 | Rules | Remote turned off | The background setting stays on; the user turns it off separately. | owner (confirm list) |
| C5 | Remote on box | Copy and failure | The box says it is a preview, that no device can connect until pairing ships, and that it also turns on "Keep running in background". If login-item registration fails, remote access stays off. | owner (confirm list) |
| C6 | Remote storage | Where is the remote-access state? | In SQLite. `PUT /preferences/:key` refuses an "on" value for it; only the native box writes "on". An agent writing the DB directly is an accepted residual (D10). | owner (confirm list) |
| C7 | Remote routes | Status read and Settings UI | `GET /remote-access` (read-only) is allowlisted too; both routes are `app+cli`. CLI: `agetor remote status\|off`. Settings shows the remote state and a Turn off button; turning on points to Agetor › Remote Access…. | owner (confirm list) |
| C8 | Background CLI | CLI surface | `agetor daemon background status\|off`; `agetor daemon status` shows the background state; enabling is app-only (D2). | owner (confirm list) |
| C9 | Settings states | What Settings shows | On (running) / On (parked, app open) / Needs approval [Open Login Items] / On, stopped (starts at next login) [Start now] / Off / Unavailable (with reason). | owner (confirm list) |
| C10 | App location | Running from a DMG or a translocated path | Refuse to register outside `/Applications` or `~/Applications`: "Move Agetor to Applications first". | owner (confirm list) |
| C11 | Builds | Unsigned and dev builds | Unsigned builds show the switch disabled ("needs a signed build"). A signed dev build uses `~/.agetor-dev`, port 4318 and its own launchd label, chosen from the bundle's channel at launch, because a static plist can't expand `$HOME`. | owner (confirm list) |
| C12 | Idle rule | When is idle exit off? | The login-item core never idle-exits; this is decided by how the core was launched, not by a preference. A CLI-spawned daemon keeps the 5-minute idle exit, and `AGETOR_DAEMON_IDLE_MS` still overrides both. | owner (confirm list) |
| C13 | launchd job | Resource class and logs | `ProcessType: Interactive` (avoids the throttling that tmux and every agent would inherit, A4); logs go to `<dataDir>/daemon.log` with today's 5 MB truncation. | owner (confirm list) |
| C14 | Packaging | How the daemon runs | It runs the app's bundled `bun` with a second JS bundle (the headless entry plus parking), with no extra ~60 MB compiled CLI. One generic Swift helper in `Contents/MacOS` handles the login item now (Keychain and power assertion later, per the blueprint) and is also the launchd `BundleProgram`. | owner (confirm list) |
| C15 | Contracts | `agetor-core.json` | Keep `kind: "cli-daemon"` and add an optional field (e.g. `launchedBy: "login-item"`), so older installed CLIs, which validate `kind` strictly (`core-creds.ts:99`), keep working. | owner (confirm list) |
| C16 | Takeover | App launch versus the daemon | The app parks the daemon with a new handoff request (no exit). At login the app retries the bind for a few seconds, which covers a daemon that has bound but not yet written its creds. | owner (confirm list) |
| C17 | Start now | Starting a stopped job | "Start now" in Settings or `agetor daemon start` while stopped re-registers (unregister, wait ~500 ms, register). Otherwise the CLI spawns a daemon as today. | owner (confirm list) |
| C18 | Turning off | What happens to running work | Turning off unregisters and stops the core. Agents keep running in tmux and the next core reattaches them; the Planning spike verifies this. | owner (confirm list) |
| C19 | Notifications detail | How headless notifications behave | One notification per task through the notifier; a click opens the app on that task (the app takes over the port). While the app is closed, only the server-side removal triggers apply (seen, interaction resolved, column leaves blocked, archive and delete). | owner (confirm list) |
| C20 | Quit confirm copy | Wording | "they keep running in the background" plus a "Quit completely" button; when nothing is parked, quit behaves as today. | owner (confirm list) |
| C21 | Rollback | Dropping the feature later | A build that drops the feature unregisters the login item on launch. | owner (confirm list) |
| C22 | Acceptance | How "done" is verified | Unit and integration tests for the idle rule, the parking/handback state machine, routes (incl. the TT3(c) allowlist and the "on"-refusal value rule) and creds; e2e for the Settings states and remote-off through a fake login-item seam (headless has no native, so the seam stands in for `ApiNative`); a `docs/qa/` checklist for the owner's signed-build QA (login, approval, quit and handback, Quit Completely, update, Remote Access…, notifications with the app closed). | owner (confirm list) |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| Login item via SMAppService (5.1): helper, plist, build placement, signing checks | In this change | owner (D1, C14) |
| No idle exit for the login-item core (5.2) | In this change | owner (C12) |
| App → daemon handback on quit (5.3), parking, update handling | In this change | owner (D3, D8) |
| Native-only Remote access switch (menu + box), storage, `GET`/`DELETE /remote-access`, `agetor remote status\|off`, TT3(c) allowlist | In this change | owner (D9–D11, C5–C7) |
| Headless OS notifications for any headless core (4.2) | In this change | owner (D12, C19) |
| "Quit Agetor Completely" menu item and reworded quit confirm | In this change | owner (D6, D7, C20) |
| `agetor daemon background status\|off`, `agetor daemon status`/`start`/`stop` changes | In this change | owner (D5, C8, C17) |
| Settings → General UI for both switches with every status state | In this change | owner (C9) |
| `scripts/verify-vendor-signing.ts`, `verify-release.ts` checks for the helper and plist (file checks, not `status`, per investigation S2) | In this change | needed for release; reviewer would call it unfinished |
| Docs: README daemon/CLI sections, CLAUDE.md (route policy list, desktop-only list, daemon handoff, confirm-on-quit, notifications), `companion-pairing-requirements.md` (rule 3 vs 5 reconciled by the new allowlist), `e2e/fixtures.ts` idle note | In this change | completeness |
| Tests listed in C22 plus updates to `daemon-boot`, `daemon-handoff`, `headless-idle`, `route-policy`, `supervisor`, `cli-scope-daemon` tests | In this change | owner (C22) |
| `docs/qa/always-on-host-qa.md` checklist | In this change | owner (D13, C22) |
| Keep-awake while agents run (5.4) | Owner-deferred | owner (C1) |
| Pairing, devices, relay or gateway, Noise sessions, push dispatcher, Keychain core identity key (Tracks 6, 7 and Phase 0) | Out of scope | different tickets in the Companion blueprint; this change only provides the host and the remote-access state |
| Notification router / presence (4.1, 4.3) | Out of scope | different blueprint items; 4.2 is satisfied by running today's hooks in the headless core |
| Linux/VPS always-on (blueprint §09 alternative) | Out of scope | different platform; the macOS launchd mechanism doesn't apply |
| Canary channel login item | Out of scope | canary is never published (`scripts/release.ts`) |
| Re-checking user presence when remote access is used | Out of scope | belongs to Companion pairing (requirements rule 4); recorded as the accepted residual in D10 |

## Assumptions still open

All of these feed the **Planning-step spike (D4)**. It runs first, on the owner's Mac, signed with the Developer ID. Any result that breaks a decision goes back to the owner as a question before the plan is final.

- **A1. Registration works from a helper in `Contents/MacOS` on a Developer-ID-signed bundle, and launchd starts it.** If wrong, fall back to calling SMAppService from the app's own `bun` (ffi/objc) or to `SMAppService.mainApp`. C14 changes shape.
- **A2. `KeepAlive: {SuccessfulExit: false}` restarts a crash but leaves a clean exit stopped, and a parked process that is waiting counts as running.** D3 and D5 depend on it. If wrong, the handback falls back to "app spawns on quit".
- **A3. tmux and agent sessions survive `unregister()` and a stop at logout or by launchd.** C18 depends on it. Mitigations if wrong: `AbandonProcessGroup: true`, or a tmux server launched outside the job.
- **A4. `ProcessType: Interactive` removes the throttling for the tmux server and agents started by the job.** Check with `taskpolicy -G`/`ps` on the tmux server pid. C13 depends on it.
- **A5. The registration survives an updater-style bundle swap (same path, id and team), and the parked daemon notices its bundle changed.** D8 depends on it. If wrong, the app re-registers after every update.
- **A6. Registering from a DMG or translocated path breaks once the app moves.** C10 refuses it anyway; the spike only confirms the refusal message is needed.
- **A7. The launchd environment (minimal `PATH`, `HOME`) is enough after `rehydratePath()`.**
- **A8 (new). A signed dev build and the installed release can each register their own agent (same bundle id, different launchd labels) without confusing BTM.** C11 depends on it. If wrong, signed dev builds show the switch disabled like unsigned ones.
- **A9 (new). `requiresApproval` appears after the owner disables the item in System Settings, and `openSystemSettingsLoginItems()` lands on the right panel.** C9's "Needs approval" state depends on it.
- **A10 (new). Electrobun 1.18.1 custom menu items fire `application-menu-clicked` with a usable action id, and ⌥⌘Q is free as an accelerator.** D7 and D10 depend on it. The event is present in Electrobun's `ApplicationMenu.ts`/`ApplicationEvents.ts`; the click handling is unverified.
- **A11 (new). A CLI-spawned daemon can find and use the notifier in `/Applications/Agetor.app` the same way `agetor logs --notify` already does (`resolveInstalledAppNotifier`).** D12 depends on it.
- **Research mandate (D13):** before fixing the plist, helper and registration code, the planner checks Apple's current SMAppService and BTM docs and the DTS threads (error 78, -67028, unregister/register delay, re-register after a binary change) and records the sources in the plan.

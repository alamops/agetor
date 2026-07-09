# Plan — Native arm64 Swift notifier helper (out-of-box deep-link notifications)

| Field | Value |
| --- | --- |
| Date | 2026-07-07 |
| Source | `/implement` follow-up — "native support to keep arm64-only but with this feature" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | `agetor/2d65e29940e1-support-opening-task-by-native-macos-not` |
| Base SHA | `9cab33e` (tip after the PATH-notifier work) |
| Supersedes | the PATH `terminal-notifier` stopgap (decision `4b3cad44`); this decision `b93421ce` |

## 1. Objective & success criteria
Deep-link notifications work **out-of-box** on arm64 with **no third-party binary** and **no Rosetta**, by shipping our own native Swift helper.

Success:
- A task notification posted by agetor, when clicked, opens that task's `RunPanel` — via our bundled helper, no `brew install` required.
- 100% arm64; helper built with `swiftc` (no Xcode project); signed inside-out + notarized as part of `agetor.app`.
- Graceful fallback to `Utils.showNotification` if the helper is missing/unauthorized/fails.
- `bun run typecheck` + `bun test` green; the helper compiles + assembles locally.

## 2. Context & constraints (from research; sources in fleet decision `b93421ce`)
- **API:** `UNUserNotificationCenter` (UserNotifications.framework). The deprecated `NSUserNotification` is prompt-free but on Apple's removal path (Rosetta-class risk) — **rejected**.
- **Hard requirements:** UN must run inside a **signed `.app` with a bundle id** (not a bare CLI); must `requestAuthorization` → **one-time permission prompt** (user accepted); **no entitlement** for local notifications.
- **Click lifecycle:** UN delivers every click to the delegate `userNotificationCenter(_:didReceive:)` **in the posting process**; the process need not stay alive — **macOS relaunches it** on click if the delegate is set before launch completes. Delegate runs `NSWorkspace.open(agetor://task/<id>)` → LaunchServices routes to the **already-running agetor** → existing `open-url` → `open_task`.
- **Existing app wiring is done & unchanged:** `open-url` handler (`index.ts`), `open_task` AppEvent, webview modal open, `agetor://` scheme registration (`electrobun.config.ts urlSchemes`).
- **Build tooling present locally:** `swiftc` (Swift 6.3, arm64), Developer ID Application identity → can compile/assemble/dev-sign here; notarization is release-pipeline only.
- **Bundling pattern:** mirror `vendor/tmux/arm64` → `build.copy` → `Contents/Resources/app/bin` + `src/bun/tmux-resolution.ts` bundled-path resolution.

## 3. Approach & key decisions
- **Fire-and-forget + system-relaunch** (terminal-notifier/jamf-Notifier model). Fallback design: stay-alive-until-click (alerter model) only if relaunch proves flaky in QA.
- **Own bundle id** `sh.alamops.agetor.notifier`, **branded "Agetor"** (CFBundleName/DisplayName), **`LSUIElement=1`** (no Dock icon). Bundle id kept stable (TCC keys perms on it).
- **Helper CLI contract (ours):** `notifier --title <t> [--subtitle <s>] --message <m> [--url agetor://task/<id>] [--silent]`. Simpler than terminal-notifier's flags.
- **Replace** the PATH-`terminal-notifier` resolution with bundled-helper resolution; keep `Utils.showNotification` as the ultimate fallback.
- **Sign inside-out**, hardened runtime on the nested binary, notarize with the outer app.

## 4. Work breakdown — implementation tasks
| ID | Goal | Owns (files) | Deps |
| --- | --- | --- | --- |
| **N1** | Swift helper: parse args; set UN delegate in `applicationDidFinishLaunching`; if `--title`/`--url` args present → requestAuthorization → post `UNMutableNotificationContent` (title/subtitle/body, `sound=.default` unless `--silent`, `userInfo["url"]=url`) → exit after `add` (with a safety timeout); `didReceive` → `NSWorkspace.shared.open(userInfo["url"])` → `completionHandler()` → exit. `LSUIElement` NSApplication. Plus the bundle `Info.plist`. | `native/notifier/notifier.swift` (new), `native/notifier/Info.plist` (new) | — |
| **N2** | Build+package: `swiftc -O -target arm64-apple-macos13 -framework AppKit -framework UserNotifications` → assemble `AgetorNotifier.app` (`Contents/MacOS/notifier` + Info.plist + icon) into `vendor/notifier/`; codesign hardened-runtime with `$ELECTROBUN_DEVELOPER_ID` (ad-hoc `-` when unset, like `fetch-tmux`); idempotent. Wire `vendor:notifier` into `package.json` build chains; add `build.copy` `"vendor/notifier": "bin"`. | `scripts/build-notifier.ts` (new), `package.json`, `electrobun.config.ts` | N1 |
| **N3** | Bun integration: `notifier.ts` — `resolveNotifier()` → bundled `…/app/bin/AgetorNotifier.app/Contents/MacOS/notifier` (env override `AGETOR_NOTIFIER_BIN`, dev fallback `vendor/notifier/…`); `buildNotifierArgs` → the new `--title/--subtitle/--message/--url/--silent` format. `index.ts showTaskNotification` — spawn the helper exe directly (keep `child.exited` + try/catch → `Utils.showNotification` fallback; note exit code now reflects *post* success, not click). | `src/bun/notifier.ts`, `src/bun/index.ts` | N1 (contract) |
| **N4** | Tests: rewrite `notifier.test.ts` for the new `buildNotifierArgs` format + `resolveNotifier` (env override → bundled path via a temp layout → null). Keep deep-link/pending-open/notifications tests green. | `src/bun/notifier.test.ts` | N3 |

## 5. Execution
Mostly orchestrator-direct (delicate native code, compile-verified at each step): N1 → compile-smoke → N2 → assemble+dev-sign smoke → N3 → N4 → `bun test` + `typecheck`. Then code review (opus) on the diff, fix, re-test.

## 6. Blast radius & risks
- **Notarization of the nested `.app`** — must sign inside-out + hardened runtime; verified only on a real Developer-ID+notary build (release pipeline). **Manual QA.**
- **UN relaunch reliability for a nested standalone helper** — documented for apps generally; **smoke-test**; fall back to stay-alive-until-click if flaky.
- **Permission prompt** — one-time, expected; if the user denies, notifications silently don't post → the `Utils.showNotification` fallback should still fire (verify the helper signals failure so we fall back; or accept UN's own silent-drop). 
- **Notification identity** — posts under `…​.notifier` bundle id, branded Agetor; a distinct Settings row from the main app (acceptable).
- **Central path** — every task OS notification flows through the helper; fallback keeps notifications working if anything about the helper fails.

## 7. Open questions / assumptions
- **Assumption:** posting a notification and exiting (fire-and-forget) is acceptable; relaunch handles the click. Fallback ready.
- **Assumption:** helper spawned as the inner Mach-O directly (inside its `.app`) keeps the `.app`'s UN identity (`Bundle.main` = the `.app`). Verify in smoke test.
- **Deferred:** if the user denies notification permission, whether to detect+surface that in-app (today: silently no OS notification).

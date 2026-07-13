# Plan — Notification click should focus/raise the Agetor window

| Field | Value |
| --- | --- |
| Date | 2026-07-09 |
| Source | User report: "Clicking on the native macOS notification is not opening/focusing Agetor window. It's indeed opening the correct task, but is not opening/focusing the software. Consider support to multiple screens and desktops/docks as well" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | `agetor/dd57e65731fb-clicking-on-native-notifcation-doesnt-op` |
| Base SHA | `5df9a2ee26a150ee9ac398d3ac3d7be16b97b742` |

## 1. Objective & success criteria

Clicking a native macOS notification posted by `AgetorNotifier.app` must **raise, focus and (if needed) un-minimize** the Agetor window, in addition to selecting the right task — which already works.

Success criteria:

1. Window buried behind other apps → comes to the front, becomes key.
2. Window minimized to the Dock → is restored, then focused.
3. Window on a **secondary display** → is raised on that display, not teleported.
4. Window on **another Space** → macOS switches to it (owner's explicit choice; see §3).
5. Window fully closed (`exitOnLastWindowClosed:false`) → recreated and focused. *(Already works — `new BrowserWindow()` calls `showWindow(ptr, activate=true)`.)*
6. Remembered frame that no longer intersects any live display (monitor unplugged) → re-centered on the primary rather than opened off-screen.
7. Dock-icon click on a buried/minimized window → focuses it.
8. In-app toast "Open" button → actually raises the window.
9. `bun test` and `bun run typecheck` green. No regression in `window-lifecycle.test.ts`.

Non-goals: overlaying another app's **fullscreen** Space (Electrobun exposes no `.fullScreenAuxiliary`); persisting the window frame across process restarts; any change to how notifications are *posted*.

## 2. Context & constraints (grounded)

**Root cause.** `Electrobun.events.on("open-url")` (`src/bun/index.ts:471-486`) parses the deep link, calls `setPendingOpenTask` (`:475`), and then — when a window already exists — only `broadcastAppEvent({type:"open_task"})` (`:477`). It never asks macOS to activate anything. The `else` branch calls `windowLifecycle.createMainWindow()` (`:479`), which **returns early when a window is already registered** (`src/bun/window-lifecycle.ts:59`), so it is not a focus path either.

The only "focus" in the codebase is renderer-side `window.focus()` (`src/mainview/App.tsx:224,234,299`), whose own comment concedes it is "a no-op in many browsers". A WKWebView cannot activate its host NSApplication.

**Electrobun 1.18.1 surface** (verified against `node_modules/electrobun/dist/api/bun/`):

| Available | Anchor |
| --- | --- |
| `BrowserWindow.activate()` | `core/BrowserWindow.ts:279` → ffi `activateWindow` |
| `BrowserWindow.unminimize()` / `isMinimized()` | `:306` / `:310` → ffi `restoreWindow` |
| `BrowserWindow.setFrame()` / `getFrame()` | `:366` / `:371` |
| `BrowserWindow.setVisibleOnAllWorkspaces()` | `:342` (not used — see §3) |
| `Screen.getAllDisplays()` | `proc/native.ts:2208`, exported `index.ts:229` |

`BrowserWindow.focus()` (`:283`) is **deprecated** — it logs a warning and delegates to `activate()`. Use `activate()`.

**Absent, and unaddable:** standalone `NSApp.activate`, `moveToActiveSpace`, general `setCollectionBehavior`. The FFI table is one `dlopen` of a **prebuilt** `libNativeWrapper.dylib` (`proc/native.ts:82-723`); the npm package ships no native source, and `dlopen` throws on a missing symbol. Adding one means forking Electrobun.

A symbol dump of that dylib shows `activateWindow`, `restoreWindow`, `setWindowVisibleOnAllWorkspaces`, `getAllDisplays` all exported, and the binary references the ObjC selectors `activateIgnoringOtherApps:`, `makeKeyAndOrderFront:`, `deminiaturize:`, `setCollectionBehavior:`. So `activate()` *does* attempt an app-level activation.

**Cooperative activation (macOS 14+).** `activateIgnoringOtherApps:` is deprecated and its argument ignored; activation is now a *request* that the system denies for a background app with no user action behind it (denial ⇒ Dock bounce). A notification click makes the posting helper the active app, giving it an activation right it can yield onward. `NSWorkspace.open(_:configuration:)` with `activates = true` performs that yield implicitly; `NSApp.yieldActivation(to:)` (macOS 14+) does it explicitly. Our helper currently calls bare `NSWorkspace.shared.open(url)` (`native/notifier/notifier.swift:118`).

**Coordinate system — verified, not assumed.** Ran `getAllDisplays` against the prebuilt dylib on this machine:

```json
[{"id":1,"bounds":{"x":0,"y":0,"width":1728,"height":1117},"workArea":{"x":0,"y":33,...},"isPrimary":true},
 {"id":3,"bounds":{"x":-449,"y":-1080,"width":2560,"height":1080},"isPrimary":false},
 {"id":5,"bounds":{"x":-1366,"y":0,"width":1366,"height":1024},"isPrimary":false}]
```

Top-left origin, y grows downward, secondary displays carry **negative** origins — consistent with `DEFAULT_FRAME = {x:120,y:120,...}` (`window-lifecycle.ts:14`) landing below the menu bar. `workArea` excludes the menu bar. No coordinate flip is needed between `getFrame()` and display bounds.

`Screen.getAllDisplays()` returns `[]` when the native lib is absent (`proc/native.ts:2210-2213`) — i.e. under `bun test`. Frame repair must treat an empty list as "do nothing".

**Frame memory is in-memory only** (`window-lifecycle.ts:54`), reset to `DEFAULT_FRAME` per process, and is **never validated against connected displays** (`index.ts:386-393`).

**Testing reality.** `bun run dev` does not build the notifier (`package.json:8-9`), and `agetor://` only routes once the built `.app` is LaunchServices-registered. Per `docs/qa/native-notifier-qa.md:57-61`, the click loop is a **packaged-build manual test**. `bun run build` does run `vendor:notifier` (`package.json:13-14`). There is no CI (`.github/` holds only `FUNDING.yml`).

Test conventions: `bun:test`; `window-lifecycle.test.ts` uses pure dependency injection with a `{id} as any` fake window and no Electrobun runtime; `notifications.test.ts:20-31` uses `mock.module("electrobun/bun", …)` for server-level tests. Pure modules (`deep-link.test.ts`, `notifier.test.ts`, `pending-open.test.ts`) import no Electrobun at all.

## 3. Approach & key decisions

**Decision 1 — Spaces: let macOS switch (owner's call).** We call `unminimize()` + `activate()` and let macOS decide. The alternative — `setVisibleOnAllWorkspaces(true)` → `activate()` → `false` on a later tick — would pull the window to the user's current Space, but it is timing-sensitive, cannot enter another app's fullscreen Space, and is a behavior the owner explicitly did not want. **Rejected by the owner.** Consequence to accept: if the user's *Desktop & Dock → "switch to a Space with open windows"* setting is **off**, activating leaves the window invisible on its own Space. That is standard macOS app behavior and is the documented trade-off.

**Decision 2 — one shared focus routine, three call sites.** A single `focusWindow()` in a new `src/bun/window-focus.ts`, invoked from the `open-url` handler, the `reopen` handler, and a new `POST /window/focus` route.

**Decision 3 — `POST /window/focus` is a mechanism, not a feature.** The owner asked for the in-app toast "Open" button to raise the window. The toast lives in the webview, which reaches the Bun process only over HTTP. The route is the enabling transport, modeled on the existing `POST /window/toggle-zoom` (`server.ts:430-449`) — same `authed()` wrapper, same `503 {error:"no main window"}` shape. It also gives us the *only* way to exercise the focus sequence from `bun run dev`.

**Decision 4 — harden the helper, don't rewrite it.** Keep `NSWorkspace` as the delivery mechanism, but (a) yield activation explicitly to `sh.alamops.agetor` when running on macOS 14+, (b) open with `OpenConfiguration.activates = true`, (c) fall back to `NSRunningApplication.activate(options:)` if the open reports an error, (d) exit from the completion handler rather than a fixed 0.2 s timer, with a safety-net timeout. Guard the 14+ APIs with `if #available` — the helper targets `arm64-apple-macos13` (`scripts/build-notifier.ts:90-96`).

**Decision 5 — conservative frame repair.** Re-center **only** when the frame has no meaningful intersection with *any* live display. "Meaningful" = at least a 120×40 pt region, so the title bar stays grabbable. Empty display list ⇒ no-op. This keeps a legitimately-placed window on a negative-origin secondary display untouched.

## 4. Work breakdown — implementation tasks

| ID | Goal | Owns (exactly) | Depends on |
| --- | --- | --- | --- |
| **T1** | Pure display/frame geometry: `Rect`, `rectsIntersect`, `frameIsVisible`, `repairFrame`. Empty-display no-op; centers on primary `workArea`, clamping size. No Electrobun import (types only). | `src/bun/screen-frame.ts` *(new)* | — |
| **T2** | `focusWindow(win, deps)`: repair frame → `unminimize()` if `isMinimized()` → `activate()`. Each step individually try/caught so one failure can't skip `activate()`. `FocusableWindow` structural interface + injectable `getAllDisplays` so tests never load the native lib. Returns `false` when `win` is null. | `src/bun/window-focus.ts` *(new)* | T1 |
| **T3** | Helper activation hardening per Decision 4. Preserve the existing `url.scheme == "agetor"` defense-in-depth check and the exit-code contract (0 = posted, 2 = denied). | `native/notifier/notifier.swift` | — |
| **T4** | Wire `focusWindow` into `open-url` (warm path, `:476-477`) and `reopen` (`:442-446`). Repair the frame in `buildWindow` before `new BrowserWindow({frame})` so the cold path can't open off-screen. Pass the real `Screen.getAllDisplays`. | `src/bun/index.ts` | T1, T2 |
| **T5** | `POST /window/focus` route mirroring `/window/toggle-zoom`; `api.focusWindow()` client; toast `onOpen` + the two `open_task` handlers call it instead of `window.focus()`. | `src/bun/server.ts`, `src/mainview/lib/api.ts`, `src/mainview/App.tsx` | T2 |

File ownership is disjoint within each wave (see §6).

## 5. Work breakdown — test tasks

| ID | Covers | Owns (exactly) |
| --- | --- | --- |
| **TT1** | T1. Table-driven: window wholly inside primary; straddling two displays; on the negative-origin display above (`y:-1080`) and left (`x:-1366`); 1-px sliver ⇒ repaired; zero overlap ⇒ centered on primary `workArea`; oversized frame clamped; `displays: []` ⇒ identity; no-primary-flag ⇒ falls back to `displays[0]`. | `src/bun/screen-frame.test.ts` *(new)* |
| **TT2** | T2. Fake `FocusableWindow` recording calls: minimized ⇒ `unminimize` before `activate`; not minimized ⇒ no `unminimize`; off-screen frame ⇒ `setFrame` before `activate`; on-screen ⇒ no `setFrame`; `getFrame`/`isMinimized` throwing ⇒ `activate` still called; `null` window ⇒ `false`, no throw. | `src/bun/window-focus.test.ts` *(new)* |
| **TT3** | T5's route. Follows `notifications.test.ts:20-31` `mock.module("electrobun/bun", …)`. Asserts: 401 unauthed; 503 `{error:"no main window"}`; 200 + `activate()` called on the registered fake window. | `src/bun/window-focus-route.test.ts` *(new)* |

T3 (Swift) gets **no** automated test — there is no Swift test harness or CI in this repo. It is covered by an added section in `docs/qa/native-notifier-qa.md` (owned by T3).

## 6. Execution waves

- **Wave 1** — T1. *(Foundation; everything else imports it.)*
- **Wave 2** — T2 ‖ T3. *(Disjoint files, no interdependency.)*
- **Wave 3** — T4 ‖ T5. *(Disjoint files; both consume T2 but neither edits it.)*
- **Wave 4** *(Phase 6)* — TT1 ‖ TT2 ‖ TT3.

Barrier between waves. Checkpoint commit + `bun run typecheck` after each.

Note: `bun` is not on `PATH` in this environment — every command needs `export PATH="$HOME/.bun/bin:$PATH"` first. `node_modules/` was absent in this worktree and has been installed.

## 7. Blast radius & risks

| Risk | Mitigation |
| --- | --- |
| `getFrame()` returns a **bottom-left** y while display bounds are top-left, causing a valid window to be judged off-screen and yanked to the primary. | Repair only on **zero** meaningful intersection (Decision 5) — the failure mode requires the frame to miss *every* display. Verified that display bounds and `DEFAULT_FRAME` share a top-left origin; `setFrame`/`getFrame` are symmetric by construction. Flagged for manual QA on the three-display setup. |
| `activate()` denied by cooperative activation ⇒ Dock bounce instead of focus. | T3 yields activation from the helper, which holds the right by virtue of the click. Confirmed the dylib's `activateWindow` references `activateIgnoringOtherApps:`/`makeKeyAndOrderFront:`. |
| Swift helper regression breaks **all** notifications, not just focus. | Preserve the exit-code contract; keep bare `open(url)` reachable as a fallback path; the `showTaskNotification` fallback (`index.ts:148-205`) already degrades to `Utils.showNotification` on non-zero exit — but note **exit 2 deliberately does not fall back** (`:185-190`). Don't touch the exit-2 branch. |
| Helper exits before `NSWorkspace.open` completes. | Exit from the completion handler; retain a `scheduleExit(after: 5)` safety net. |
| `mock.module` in TT3 is process-wide (`notifications.test.ts:16-18`) and can leak into sibling tests. | Mirror the existing file's isolation exactly; run the full `bun test` suite, not just the new file. |
| Notifier change is unverifiable headlessly. | Owner runs `bun run build` + manual QA (their explicit choice). QA doc extended by T3. |

Rollback: the change is additive — three call sites and two new modules. Reverting T4/T5 restores today's behavior exactly.

## 8. Open questions / assumptions

Resolved with the owner before planning:

1. **Spaces** → let macOS switch to the window's Space; do *not* use the `visibleOnAllWorkspaces` trick.
2. **Triggers** → notification click, Dock-icon click, and the in-app toast "Open" button. (`POST /window/focus` follows necessarily from the third; the owner did not select it as a standalone item.)
3. **Multi-display** → yes, repair off-screen remembered frames.
4. **Verification** → unit tests + typecheck here; owner performs the packaged-build manual QA.

Remaining assumptions:

- `BrowserWindow.getFrame()` reports the same top-left coordinate space as `Screen.getAllDisplays()`. Verified for display bounds and for `setFrame` input; **not** directly verified for `getFrame` output (needs a live window). Mitigated by Decision 5.
- The main app's bundle id is `sh.alamops.agetor` (`electrobun.config.ts:6`); the helper's is `sh.alamops.agetor.notifier` and must stay stable (TCC keys the notification grant on it).

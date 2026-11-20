# Spike S1 — does an in-process copy of a just-picked protected-folder image raise a TCC prompt?

| Field | Value |
| --- | --- |
| Date | 2026-11-18 (Darwin 25.6.0, macOS arm64) |
| Plan | `docs/plans/picked-image-preview-tcc.md` §5 (S1), gate G1, grill D15, owner answers P1/P2 |
| Question | Does Agetor's own process (not the disclaimed `/bin/sh` + `cat` child) copy a `~/Desktop` image the user just picked, dragged or pasted without a macOS permission prompt? |
| Verdict | **G1 passes. Pick: no prompt. Drag: no prompt. Paste: no prompt where the core was asked to read, but see "Paste" below. Waves 2–3 proceed with all three gestures (owner decision P1).** |

## Method

- A throwaway worktree at `56630e9d` (this branch, wave 1) with one instrument patch to `src/bun/server.ts`: after the real work of `/refs/pick` (native panel), `/refs/drag` and `/refs/resolve` (app caller), copy every image ref in-process into `$AGETOR_DATA_DIR/previews-spike/<sha256(path)>.<ext>` with `fs/promises.open(path, O_RDONLY|O_NOFOLLOW|O_NONBLOCK)` + `readFile` + `writeFile` (the T6 primitive), and log `[s1] <gesture> <path> <ok|errno> bytes=<n> <ms>`. The worktree and the data written are removed.
- Built the dev bundle (`vite build` + `electrobun build`, dev env, ad-hoc signed `Agetor-dev.app`) and launched it with `open -n … --env AGETOR_DATA_DIR=$HOME/.agetor-dev --env AGETOR_API_PORT=4318` — through LaunchServices, so the responsible process is the dev app, not this shell's tmux (which already has Desktop access, so a child launch would be a false negative).
- Fresh files created for this test on `~/Desktop` (with the owner's consent): `agetor-s1-c07a13.png` (pick), `agetor-s1-c07a13.heic` (drag), `agetor-s1-c07a13-paste.png` and `-paste2.heic` (paste), `agetor-s1-c07a13-drop.png` (drop). None had been read by the dev app before its gesture.
- `log stream`/`log show --predicate 'subsystem == "com.apple.TCC"'` captured the TCC daemon's view. The owner performed each gesture in the dev window and reported whether a prompt appeared.

## Results

| Gesture (performed by the owner) | Prompt? (owner) | `[s1]` outcome | Copy vs. original |
| --- | --- | --- | --- |
| (a) Files Picker → `agetor-s1-c07a13.png` | **No** | `pick … ok bytes=26140 407ms` (a second identical call, 55 ms, was the panel result being re-requested) | `cmp` identical |
| (b) Finder drag of `agetor-s1-c07a13.heic` onto the composer (non-uploadable type → `/refs/drag`) | **No** | `drag … ok bytes=1268 9ms` | `cmp` identical |
| (c) Finder ⌘C of `agetor-s1-c07a13-paste.png`, ⌘V in the composer | **No** | no `[s1]` line: WebKit delivered the image **bytes**, which the webview uploads to `/screenshots`; `/refs/resolve` was never called | n/a |
| (d) Finder drag of `agetor-s1-c07a13-drop.png` | **No** | `drag … ok bytes=26465 3ms` (rung 2, `/refs/drag`; the png is then uploaded as a screenshot) | `cmp` identical |
| (e) Finder ⌘C of `agetor-s1-c07a13-paste2.heic`, ⌘V | **No** | no `[s1]` line: the heic was byte-copied through the attachment upload; `/refs/resolve` was never called | n/a |

TCC log (`/usr/bin/log show --last 30m`): the dev app's responsible process (`identifier=launcher`, pid of `Agetor-dev.app`, subject `sh.alamops.agetor`) issued 25 requests, for ScreenCapture only (3 "Failed to match existing code requirement for subject sh.alamops.agetor": the installed app's Developer-ID grants don't apply to the ad-hoc dev build). It issued **zero** `kTCCServiceSystemPolicyDesktopFolder` requests. Every `DesktopFolder` line in the window belongs to the installed Agetor's disclaimed `/bin/sh` → `/bin/cat` children (`Platform binary prompting is 'Deny'`, `authValue=0`), which is the 403 this plan fixes.

The files the owner picked, dragged and pasted carry `com.apple.macl` after the gesture (the user-intent grant); `agetor-s1-c07a13-paste2.heic`, which no panel or drag ever touched, has none.

## Validity checks

- Launched through LaunchServices (`open -n`), never as a child of this shell. ✔
- Fresh Desktop files the dev identity had never read. ✔
- `tccutil reset SystemPolicyDesktopFolder` was **not run**: the dev build shares the installed app's bundle id (`sh.alamops.agetor`), so a reset would have wiped the installed app's Desktop grant. The dev build is ad-hoc signed, so the installed app's Developer-ID grants don't match it (the log lines above show exactly that mismatch). ⚠ recorded, judged acceptable.
- An `Agetor` entry exists under Full Disk Access but is **disabled** (owner). ✔
- The webview of the dev window was served by another worktree's Vite dev server on `:5173` (the app prefers it when present); the gesture routes, which are what this spike tests, were the instrumented core's. The webview there is not this branch's, so the owner's two cursor-placement observations (the caret jumps to the start of the field after a paste or a drop) are about that UI and are not evaluated here.
- ⚠ The dev identity is ad-hoc, not the signed release identity. The MACL mechanism is the same for both, and V1 (plan §5) repeats the check on this branch's build; re-check on the first signed release.

## Paste

In WKWebView a Finder ⌘C / ⌘V of an image delivers its **bytes** (no `file://` URL), so the app uploads it (`/screenshots`) and the core never reads the Desktop original; the `capture-refs` rung-1 `/refs/resolve` call (the paste-twin trigger in the plan) was not reached by either paste. The primitive it would run, an in-process no-follow copy of a protected-folder file by the app's own process, is the one (a) and (b) proved prompt-free, in the same process and the same API. So no prompt was observed for the paste gesture and nothing contradicts keeping it; per the owner's decision P1 all three twin gestures ship, and the paste twin stays behind its `previewTwins: true` + app-caller guard. Verdict: **keep**, evidence for paste is "same primitive, not exercised by Finder ⌘V", recorded here rather than claimed.

## Cleanup

Dev app quit; scratch worktree removed; `~/.agetor-dev/previews-spike`, `s1.log` and the two test screenshots under `~/.agetor-dev/screenshots` deleted. The five `~/Desktop/agetor-s1-c07a13*` files are left for the owner to delete (not removed without asking).

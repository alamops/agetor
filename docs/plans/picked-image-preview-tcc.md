# Plan — Picked-image previews and honest attachment chips

| Field | Value |
| --- | --- |
| Date | 2026-11-18 |
| Source | The owner's report in the pipeline task prompt (restated in §1, per grill D19); investigation `docs/plans/picked-image-preview-tcc-investigation.md`; grill record `docs/plans/picked-image-preview-tcc-grill.md` (D1–D20, answers in `docs/plans/picked-image-preview-tcc-grill/round-1/answers.json`); two planning-time owner answers (§8 P1, P2) |
| Flags | none |
| Gates | Grilled (20/20 answered); 2 planning-time questions answered by the owner. The twin work (waves 2–3) is gated by the S1 spike (grill D15). |
| Status | implemented on the branch (waves 0–4 done; the §10.2 deviations apply). Tests extended and run 2026-11-18 (§10.4): typecheck clean, the targeted suites and the e2e run recipe green; the full `bun test` has 9 failures, none in this change's files (§10.4). V1, the live check on a signed build, is owner-assisted and still to do |
| Branch | `fix/agetor-broken-for-visibility-file` (the agetor task branch). Do **not** cut a new branch in this worktree: agetor re-checks out `task.branch` on the next run. |
| Base SHA | `4d7f8bfb` (HEAD when execution started; the planning docs are `0e168acb` on top of it) |

## 1. Objective & success criteria

**The symptom (restated in-repo, grill D19).** An image attached through the Files Picker (`/refs/pick`) from a macOS-protected folder (`~/Desktop`, `~/Documents`, `~/Downloads`, …) shows in the transcript as an amber "Image not found" chip. It has no thumbnail, and clicking it opens the *Attachment not found* dialog, so the file can't be opened from Agetor either. The owner's specimen is `~/Desktop/Screenshot 2026-11-18 at 2.40.41 PM.png` (U+202F before "PM"), attached to this pipeline's prompts. That screenshot is not committed. The report adds: "It might happen also in other file attachments."

**Root cause (proved by the investigation).**
- `GET /files/preview` reads through a disclaimed `/bin/sh` + `cat` child. Since #281 (`497f6d43`), TCC denies that child in protected folders without showing a prompt, so the route answers 403.
- The webview maps 403 to `error`, and `AttachmentChips` treats any non-ok thumbnail as "missing": it draws the amber chip and skips `/open-path` on click.
- Non-image chips open fine. The breakage covers every surface that *thumbnails* an image: attachment chips, markdown images, `SendUserFile` tiles, and the diff pane's image or PDF new side for `isolation: "none"` tasks.

**Objective.**
- A user-picked image in a protected folder gets its thumbnail back, through a path-keyed **preview twin** written at pick time (D1).
- Every image whose preview can't be read shows an **honest, neutral chip that still opens**. Amber "not found" is kept for a proven 404 only.
- D26(j) (`docs/architecture/security.md:67`) holds: no core read of a path that agent-writable data names, under Agetor's identity.

| # | Criterion | Production path that produces it | Proven by |
| --- | --- | --- | --- |
| C1 | A picked image in a protected folder renders a thumbnail in the user bubble's chip. | `ReferencesPicker` → `POST /refs/pick` → `refsFromPaths` → **`writePreviewTwinsForRefs`** (T6, wired by T8) → the prompt's `Referenced files/folders:` block → `AttachmentChips`/`ImageChip` → `AuthedImg` → `GET /files/preview` → `openFileBytes(original)` = `denied` → **`openFileBytes(twin, no-follow)`** (T8) → 200 | E1 case 4; U3 |
| C2 | A chip whose preview is blocked, unavailable or too large is **neutral**, carries the D9 tooltip, and a click reaches `/open-path`. | `/files/preview` 403 → `statusForHttp(403)` = **`denied`** (T1) → `ImageChip` failure branch (T2) → `handleClick` → `api.openPath` → `POST /open-path` | E1 cases 1–2; U1 |
| C3 | A deleted file still shows the amber chip, and a click opens the not-found dialog. | `/files/preview` 404 → `missing` → `ImageChip` amber branch (unchanged) | E1 case 3 |
| C4 | The `MdImage` final fallback, `SentFilesCard` tiles and `BinaryFilePreview` panes use the same 404-vs-other split and the D9 copy (D10, D14). | `statusForHttp` → `previewFailureTitle` (T1) → T3 / T4 / T5 | E2, E3, E4; U1 |
| C5 | The twin cache stays at or under 500 MB, evicting the oldest twins first. The sweep runs at boot and after each write (D5, D6). | `index.ts` / `headless.ts` → `requestPreviewTwinSweep` (T9); `writePreviewTwin` → `requestPreviewTwinSweep` (T6) | U2 |
| C6 | Twins appear only for the three user gestures in D2. They never appear for a CLI-token caller, for stat-only `/refs/resolve` callers (`SentFilesCard`, handoff chips, `@`-scope), or through a planted symlink. | The `/refs/pick`, `/refs/drag` (+`names`) and `/refs/resolve` (+`previewTwins: true`, app caller) handlers (T8); `capture-refs` (T7); the guards in `preview-twins.ts` (T6) | U2, U3 (incl. the call-site allowlist) |
| C7 | The D15 no-prompt evidence for each gesture is recorded **before** the twin code is built. The D13 cursor/fx read evidence is recorded, with a ticket if it is broken. | S1, S2 | The spike notes in `docs/plans/` |

## 2. Context & constraints

### Grounded findings (verified at `4d7f8bfb`)

**Webview**
- `src/mainview/lib/authed-blob.ts:30`: `AuthedBlobStatus = "loading" | "ok" | "missing" | "too-large" | "error"`. `statusForHttp` (`:46-50`) maps 404 → `missing`, 413 → `too-large`, everything else (403 included) → `error`. A failure isn't cached (`:202-208`).
- `src/mainview/components/ui/authed-img.tsx:40`: `onStatus(status: Exclude<AuthedBlobStatus, "loading">)`.
- `src/mainview/components/kanban/AttachmentChips.tsx`:
  - `:40`: the `missing` set.
  - `:62`: a click on a missing chip goes to the not-found dialog without calling the server.
  - `:149-189`: `ImageChip`. The amber branch at `:162-174` has the title `Image not found: …` at `:166`. `:181` reports any non-ok as `onMissing()`.
  - The chip renders under every user bubble (`RunPanel.tsx:7248, 7256, 7272`).
- `src/mainview/components/kanban/MdImage.tsx`:
  - `:81-82`: `FALLBACK_CHIP_CLASS` (amber).
  - `:109-127`: candidate state, and the `[source]` reset.
  - `:243-256`: the fallback chip (`data-reason` `not-found`/`too-large`, click opens).
  - `:285-295`: the candidate walk (any non-ok moves to the next candidate).
- `src/mainview/components/kanban/SentFilesCard.tsx`: `:100-125` (a failed preview only swaps the glyph, and the click still opens), `:212` (`previewFailed` set), `:276` (`markPreviewFailed`).
- `src/mainview/components/kanban/BinaryFilePreview.tsx`:
  - Images: `:112-147` (`ImageErrorKind`, an amber pane for every error).
  - PDFs: `:189`, `:226`, `:298-302`, `:346-353` (a neutral pane).
  - Callers: `DiffDialog.tsx:1013-1021`, local task diffs through `taskDiffBlobUrl`; and `GitHubDialog.tsx:9622`, PR blobs from the git host, **where a 403 is not a macOS block**.
- `src/mainview/lib/api.ts`: `:1011` `pickRefs`, `:1021` `resolveRefs`, `:1030` `dragRefs` (no body), `:2112` `filePreviewUrl`, `:2150-2159` `fetchBlobBytes` (404 → `"missing"`, 413 → `"too-large"`).
- `src/mainview/lib/capture-refs.ts`: `:14` `SCREENSHOT_UPLOADABLE` (a local copy). Rung 1's default resolver (`api.resolveRefs`) is set at `:266`. Rung 2 calls `dragRefsFn()` and filters uploadable images at `:303-304`.
- **`/refs/resolve` has callers besides paste:**
  - `SentFilesCard.tsx:223`, for the agent's `SendUserFile` paths.
  - `lib/use-artifact-stats.ts:12`, for agent-written handoff artifacts.
  - `lib/at-scope-targets.ts`, for `@` tokens.
  - `capture-refs.ts:266`, for paste and drop `file://` URLs.

  Only the last one is a user gesture.

**Core**
- `src/bun/server.ts`:
  - `:450-466`: `refsFromPaths` (in-process `statSync`, which is not TCC-gated).
  - `:478-496`: `refsFromPathsForCaller` (disclaimed probe for `cli`).
  - `:571-595`: `writeAttachmentAtomic` (the `wx` idiom).
  - `:7552-7598`: `/refs/pick`. It has a fake-dir seam branch at `:7572-7587` and a native branch at `:7588-7597`, both returning `refsFromPaths(...)`.
  - `:7607-7613`: `/refs/resolve`.
  - `:7620-7624`: `/refs/drag`.
  - `:7673-7720`: `/screenshots`, with its 25 MB cap at `:7686`.
  - `:7785-7860`: `/files/preview`. `openFileBytes(raw, { followSymlinks: true, … })` is at `:7809`, and 403 on `denied` at `:7817`.
- `src/bun/route-policy.ts`:
  - `:433-442`: `/open-path`, `/reveal-path`, `/refs/pick` (`app`, `headless501`), `/refs/resolve` (`cli({ pathParamsExempt: EXEMPT_REFS_RESOLVE })`, reason at `:144-145`), and `/refs/drag`, `/screenshots`, `/attachments`, `/files/preview` (`APP`).
  - `:550`: `callerOf(req)` returns `"app" | "cli" | null`. Test for `=== "app"`, never `!== "cli"`.
- `src/bun/core-file-read.ts:59-95`: the `FileBytesOpen` union and `openFileBytes(p, { followSymlinks, ifNoneMatch, maxBytes })`. It is disclaimed while `disclaimEnabled()` and in-process otherwise, and never throws.
- `src/bun/no-follow.ts`: `:37` `READ_NOFOLLOW` (`O_RDONLY|O_NOFOLLOW|O_NONBLOCK`), `:53` `openReadNoFollow` (sync), `:122` `isPlainDirBelow(base, dir)`.
- `src/shared/attachments.ts`: `:44-60` `isImagePath` (10 extensions), `:137` `MAX_FILE_PREVIEW_BYTES` (50 MB).
- `src/bun/worktree.ts:2224-2239`: the diff blob's new side is read with `readFileBytes(…, followSymlinks: false)`, and `denied` gives 403.
- `src/bun/drag-pasteboard.ts:156`: `setDragPasteboardReaderForTests`. `:167`: `readDragPasteboardPaths`.
- Boot hooks: `src/bun/index.ts:585` and `src/bun/headless.ts:502` (`scheduleRetention()`, after the API is up).

**Tests and e2e**
- `src/bun/files-preview-endpoint.test.ts:140-221`: the disclaim-stub idiom, plus 403 for a `chmod 000` image in both disclaim modes.
- `src/bun/native-pick-endpoint.test.ts:1-72`: a `makeTestNative` stub panel on port 4442.
- `src/mainview/lib/authed-blob.test.ts:49-66`: the status mapping.
- `src/mainview/lib/capture-refs.test.ts:113`: the `noDrag` stub.
- `e2e/fixtures.ts`: `:537` `fakePickDir`, `:690` `AGETOR_FAKE_PICK_REFS_DIR`, `:763-770` `plantPicks` (string content only), `:580` `AGETOR_CLAUDE_DRIVER: "fake"`. The backends are headless, so `/open-path` answers 501, and the open-error dialog `#attachment-open-error-title` proves a click reached `/open-path`.
- `e2e/markdown-images.spec.ts`: `:229-232` asserts `data-reason="not-found"` and `:338-340` asserts `"too-large"`; both must keep passing. `e2e/issue-task.spec.ts:1050-1122`: the pick-seam flow. Bubble locator idiom: `div.rounded-br-md` (`e2e/agent-profiles-launch.spec.ts:563`).

### Repo rules that bind this change

- `CLAUDE.md` → *Agent-writable files are read with the no-follow helpers…; agent-chosen bytes the webview fetches go through `core-file-read.ts`*; `docs/architecture/security.md:67` (D26(j)).
- `CLAUDE.md` → *Every route needs a `ROUTE_POLICY` entry*. No route is added here. `/refs/resolve` keeps `pathParamsExempt`, and its reason text is updated (T8).
- `CLAUDE.md` → *The Bun main thread is shared*. Twin I/O and the sweep use `fs/promises` (no synchronous loop over a directory).
- `CLAUDE.md` → UI conventions: semantic tokens only (`border-border/60 bg-muted/40 text-muted-foreground`, `text-warning`), never palette classes.
- `CLAUDE.md` → *Persisted events stay raw*. Old messages are not rewritten (D12).
- `CLAUDE.md` → Persistence/tests:
  - `db.ts`'s first import wins in `bun test`, so endpoint tests locate twins through the server's `dataDir` (imported from `./db.ts`), never their own `DATA_DIR`.
  - Unique `AGETOR_API_PORT` per test file. **4471 is free at planning time; re-check it.**
  - Cleanup goes through `rmTestDataDir`.
- `CLAUDE.md` → *`RunPanel` is one long-lived instance*. No new state lands in `RunPanelBody`. The new state lives in per-message `ImageChip`/`MdImage`/`SentFilesCard` instances that remount per message.
- Memory and process rules:
  - The PATH prefix and `bun install` for a fresh worktree.
  - Run Playwright with `bun node_modules/@playwright/test/cli.js test …`, one Playwright run at a time, and no `src` edits while a spec runs (Vite HMR).
  - No `git stash`, and no checkout of files another task owns.
  - Dogfood only against `~/.agetor-dev`.
  - The CLI smoke hits the prod core (S2 uses HTTP to its own core only).
  - Delete smoke tasks afterwards.

### Runtime and trust shape

- **Processes and callers.**
  - One core process: the desktop app, or a headless/login-item core that answers 501 for native routes.
  - The webview holds the master token and is the only `app` caller.
  - Agents hold the CLI token at most. Agents can write: their markdown, `SendUserFile` paths, handoff JSON, the claude session JSONL, `agetor.sqlite` (D26(i)), anything under `~/.agetor` (including `previews/`), **the general clipboard**, and the drag pasteboard (a race).
- **Native panel.** The open panel runs in the core process over FFI (`openFileDialogLabelled` → `native.openFileDialog`, `server.ts:1432`), so a pick-time copy runs in the process that receives the user-intent grant (`com.apple.macl`).
- **Disclaim switch.** It is ON in the owner's prod app (no `disclaimSpawnedAgents` row; the helper is present). With it off, or off darwin, `openFileBytes` reads in-process and the bug cannot occur.

### Spike verdicts carried in (investigation §2, Agetor.app helper 2026-11-13, macOS Darwin 25.6.0)

- The disclaimed `stat` + `cat` of the Desktop specimen does this: `stat` OK, then `cat: Operation not permitted`, immediately, no prompt → `denied`.
- The same script undisclaimed, or on a non-protected copy, reads fine.
- The path's U+202F is intact in `tasks.refs` and `run_events` (so it isn't a mangled path).
- Claude Code in Agetor's tmux reads the Desktop original (grill).
- Not yet proved, and gated by S1: Agetor's own process copies a just-picked protected file without a prompt.

## 3. Approach & key decisions

**Floor first, independent of the spike (D7–D10, D14) [owner decision].**
- Add `denied` to the blob vocabulary.
- Put the D9 copy in one webview module (`src/mainview/lib/preview-copy.ts`) and route all four surfaces through it.
- Amber is used only for `missing` (a 404).
- Every non-404 failure chip stays clickable and reaches `/open-path` or `openLocalPath`, so the user can always open the original through LaunchServices.

**Path-keyed preview twin, B′ (D1) [owner decision; evidence for viability is gated by S1].**
- The twin lives at `<dataDir>/previews/<sha256hex(utf8(ref.path))>.<lowercased ext>`.
- Its key is the exact `TaskReference.path` string the route returns, which is the same string the bubble carries and the chip fetches. U+202F is kept as is, and nothing is normalized [evidence: the investigation showed the path round-trips byte-exact].
- The prompt keeps the original path. There is no stored mapping and no migration.

**Writing a twin (T6) [reasoning, from the repo's no-follow rule].**
- Open the original with `fs/promises.open(p, READ_NOFOLLOW)`. A final-component symlink means no twin.
- `fstat` must show a regular file of at most 25 MB (D4; the same cap as `/screenshots`).
- Read the file whole (async I/O).
- Create `previews/` without `recursive`. Before any write, check `isPlainDirBelow(dataDir, previews)`; a symlinked or replaced directory means no write.
- Write `previews/.<hex>.<8-hex>.tmp` with flag `wx` and mode `0o600`, then `rename` it onto the final path. The rename replaces a planted symlink at the destination and never writes through it.
- Then call `requestPreviewTwinSweep`.
- It never throws, and it returns a `skipped` reason for tests.
- `/refs/pick` **awaits** the twin writes, one file at a time, before answering, so a twin exists by the time the webview can render the ref.
- Twins are written whatever the disclaim switch says (it can flip at runtime). Skipping them would save only disk inside the cap.

**Reading a twin (T8, D16) [owner decision + reasoning].**
- `/files/preview` tries the original exactly as today.
- **Only on `denied`** does it call `openFileBytes(twin, { followSymlinks: false, ifNoneMatch, maxBytes: MAX_FILE_PREVIEW_BYTES })`. That read is disclaimed while the switch is on and never follows a symlink.
- An `ok` or `not-modified` answer from the twin is served, with the original path's content type.
- Anything else answers the original 403.
- A readable original always wins. `missing` (404), `too-large` and `error` never fall back.
- So a twin planted by an agent can only show the bytes of a regular, non-protected file, which is the same posture as any agent markdown image.

**Eviction (T6, D5/D6) [planner's choice; the grill left the order to planning].**
- Twins are evicted oldest-`mtime` first, where `mtime` is the write time.
- A re-pick rewrites the twin, which refreshes it.
- A lookup does **not** refresh the twin. A lookup-time touch would change the ETag on every view, which defeats the 304s, and it would add an in-process write on a request path.
- The sweep:
  - Uses `fs/promises`, after the same `isPlainDirBelow` guard.
  - `lstat`s every entry.
  - `unlink`s symlinks and special files, which never follows them.
  - Removes `.tmp` files older than 1 h.
  - Then deletes the oldest regular twins until the total is at or under 500 MB.
- Sweeps are coalesced: one runs at a time, and at most one more is queued.
- They are triggered at boot (T9, fire-and-forget after `scheduleRetention()`) and after every write.

**Where twins are created — the three gestures of D2, each pinned to a user action [owner decision P1 + planner hardening].**
1. **`/refs/pick`, files mode, in both the native and the fake-dir branches.** The panel runs in Agetor's process and the user names the file.
2. **`/refs/drag`.** The webview now sends `{ names: string[] }`, the basenames of the `File`s the drop actually carried (rung 2 already cross-checks those). The core twins only file refs that are `isImagePath && !isScreenshotUploadablePath` (heic, svg, bmp, ico, avif) and whose basename is in `names`. That closes most of the "agent overwrites the drag pasteboard mid-drag" race [planner hardening]. A drag of png/jpg/gif/webp still uploads to `screenshots/`, unchanged.
3. **`/refs/resolve`, only when `callerOf(req) === "app"` and the body carries `previewTwins: true`, and only for a path whose basename is in the body's `names` (the carried `File`s, as on `/refs/drag`; added by code review M1, §10.2 item 6).** Only the new `api.resolveCapturedRefs` sends it, and only `capture-refs` rung 1 (a paste or drop of `file://` URLs) calls that.
   - **Why the flag [planner; required to keep D26(j)]:** `SentFilesCard`, the handoff artifact chips and the `@`-scope highlighter call `/refs/resolve` on *agent-chosen* paths with the app token, and with no user action. Twinning every app-caller resolve would read agent-named protected files in-process automatically. D2 meant "a paste of a Finder-copied file", which this implements.
   - **Accepted residual (owner, P1):** an agent can put a file reference on the general clipboard. If the user pastes it, the core copies that file into `previews/`, where the agent can read it. `security.md` documents this.
   - The `SCREENSHOT_UPLOADABLE` regex moves to `src/shared/attachments.ts` as `isScreenshotUploadablePath`, so the core and the webview share one implementation. That is the repo rule: extend `src/shared`, don't fork it.

**The spike gate (D15, owner P2).**
- S1 tests all three gestures on a dev build launched through LaunchServices.
- If the **pick** prompts, there is no twin work. Ship the floor and return to the owner about D1.
- If a **drag** prompts, drop the drag twin (P2).
- If a **paste** prompts, drop the paste twin by the same rule (planner's extension of P2, §8).

**`BinaryFilePreview` (D14) [owner decision + reasoning].**
- It gets a `localFiles?: boolean` prop. `DiffDialog` passes it; `GitHubDialog` does not.
- `denied` shows the macOS-privacy line only when `localFiles` is set; otherwise it shows the generic line. A git-host 403 must not blame macOS.
- `fetchBlobBytes` throws `"denied"` on a 403, so the PDF pane gets the same split.

**Tooltip format [planner; small extension of D9].** The first line is exactly the D9 copy. A second line carries the full path, which is what today's `ok` chip shows as its title. The amber copy stays exactly `Image not found: <path>`.

**Rejected alternatives** (grill §4 and D1):
- (A) Copy the file and reference the copy: it changes what the agent sees.
- (C) An in-memory provenance set: it is lost on restart.
- (D) Click-to-load: an agent can lure the user into the click.
- (E) Relax D26(j): that reopens the hole.
- (F) Honest chip alone: kept as the floor, but it gives no thumbnails.
- Also considered and dropped: reading a picked original in-process at preview time keyed by MACL. The path in the bubble is agent-forgeable, so "this path appears in a user bubble" proves nothing.

## 4. Work breakdown — implementation tasks

Interfaces pinned here, so tasks in the same wave can code against them:

```ts
// src/mainview/lib/authed-blob.ts (T1)
export type AuthedBlobStatus = "loading" | "ok" | "missing" | "too-large" | "denied" | "error";
// statusForHttp: 404 → "missing", 413 → "too-large", 403 → "denied", else "error"

// src/mainview/lib/preview-copy.ts (T1, new)
export type PreviewFailure = Exclude<AuthedBlobStatus, "loading" | "ok">; // missing | too-large | denied | error
export const PREVIEW_DENIED_COPY =
  "Preview blocked by macOS privacy — Agetor can't read files in this folder for previews.";
export const PREVIEW_UNAVAILABLE_COPY = "Preview unavailable.";
export const PREVIEW_TOO_LARGE_COPY = "Too large to preview.";
export function previewFailureTitle(failure: PreviewFailure, path: string): string;
//   missing   → `Image not found: ${path}`
//   denied    → `${PREVIEW_DENIED_COPY} Click to open.\n${path}`
//   too-large → `Too large to preview. Click to open.\n${path}`
//   error     → `Preview unavailable. Click to open.\n${path}`
export const NEUTRAL_CHIP_CLASS =
  "inline-flex max-w-full items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted/60";

// src/shared/attachments.ts (T7)
export function isScreenshotUploadablePath(path: string): boolean; // /\.(png|jpe?g|gif|webp)$/i on the basename

// src/mainview/lib/api.ts (T7)
dragRefs: (names: string[]) => Promise<TaskReference[]>;          // POST /refs/drag { names }
resolveCapturedRefs: (paths: string[], names: string[]) => Promise<TaskReference[]>; // POST /refs/resolve { paths, names, previewTwins: true } (names: §10.2 item 6)
// resolveRefs is unchanged and never sends previewTwins

// src/bun/preview-twins.ts (T6, new) — takes dataDir so tests don't need db.ts
export const PREVIEW_TWIN_DIR = "previews";
export const PREVIEW_TWIN_MAX_BYTES = 25 * 1024 * 1024;        // D4
export const PREVIEW_TWIN_CACHE_MAX_BYTES = 500 * 1024 * 1024; // D6
export function previewTwinPath(dataDir: string, originalPath: string): string | null; // null unless isImagePath
export type PreviewTwinWrite =
  | { kind: "written"; twinPath: string; bytes: number }
  | { kind: "skipped"; reason: "not-image" | "missing" | "symlink" | "not-regular" | "too-large" | "unreadable" | "unsafe-dir" | "error" };
export function writePreviewTwin(dataDir: string, originalPath: string): Promise<PreviewTwinWrite>; // never throws
export function writePreviewTwinsForRefs(
  dataDir: string, refs: readonly TaskReference[], accept?: (ref: TaskReference) => boolean,
): Promise<void>; // sequential; files only; isImagePath && accept(ref)
export function sweepPreviewTwins(dataDir: string, capBytes?: number):
  Promise<{ kept: number; evicted: number; removedOther: number }>; // never throws
export function requestPreviewTwinSweep(dataDir: string): void; // coalesced, fire-and-forget
export const __forTest: { idle(): Promise<void>; reset(): void };
```

| ID | Goal | Owned files | Depends on | Acceptance (scenarios) | Risk | Wired by |
| --- | --- | --- | --- | --- | --- | --- |
| **S1** | **D15 gate: prove that a pick-, drag- and paste-time in-process copy of a `~/Desktop` image raises no TCC prompt.** Owner-assisted. Recipe in §5. | `docs/plans/picked-image-preview-tcc-spike-pick.md` (new). A throwaway instrument patch lives only in a **separate scratch worktree** under the scratchpad, never in this worktree. | — | For each gesture (pick a fresh Desktop png; Finder-drag a Desktop `.heic`; Finder ⌘C + composer ⌘V of a Desktop png) the note records: whether a prompt appeared (owner), the instrument's `[s1]` outcome and ms, `cmp` of the copy against the original, the TCC log lines for the dev bundle id, and a verdict. The note also records the validity checks (LaunchServices launch, `tccutil reset`, fresh files, the dev app not in Full Disk Access). The scratch worktree is removed, `~/.agetor-dev/previews-spike` is deleted, and the owner is asked before the Desktop test files are deleted. | external | n/a (spike) |
| **S2** | **D13: can cursor and fx (ACP, spawned disclaimed, no tmux) read a picked Desktop file?** | `docs/plans/picked-image-preview-tcc-spike-acp.md` (new) | — | For each harness installed and logged in, the note records the task id, model, prompt, the run's verbatim answer or error, and a verdict (reads / denied / prompt). "Not installed" is recorded as such. If either is broken, a ticket draft with the evidence goes in the note and is surfaced in the PR body (owner-deferred fix, D13). Smoke tasks are deleted afterwards. | external | n/a (spike) |
| **T1** | Add the `denied` status and the shared copy module. | `src/mainview/lib/authed-blob.ts`, `src/mainview/components/ui/authed-img.tsx` (comment and doc only), `src/mainview/lib/preview-copy.ts` (new) | — | The pinned interface exists. `statusForHttp(403)` returns `"denied"` and 404/413/400/401/500 are unchanged. A `denied` settle is not cached (the next subscriber refetches), like `error`. `AuthedImg`'s doc lists `denied`. `bun run typecheck` passes. | none | Consumed by T2–T5 |
| **T2** | Give `AttachmentChips` the 404-vs-other split. | `src/mainview/components/kanban/AttachmentChips.tsx` | T1 (pinned) | `ImageChip`'s outer button always carries `data-testid="attachment-image-chip"` and `data-preview-state` (`loading`/`ok`/`missing`/`denied`/`error`/`too-large`). **missing:** the amber chip and the not-found short-circuit, unchanged. **denied, error, too-large:** a local `failure` state renders a `NEUTRAL_CHIP_CLASS` button with `ImageOff`, the basename and `title={previewFailureTitle(failure, path)}`; it does not call `onMissing`, and a click goes through `handleClick` → `api.openPath`. A later `/open-path` 404 still marks it missing (amber and the dialog). No palette classes. The file's header comment is updated to describe the split. | state | `RunPanel.tsx:7248/7256/7272` (existing) |
| **T3** | `MdImage` fallback: the reason split and the copy. | `src/mainview/components/kanban/MdImage.tsx` | T1 (pinned) | The candidate walk is unchanged: any non-ok outcome moves on, and 413 stops. New `sawDenied`/`sawError` flags are reset in the `[source]` effect. The final fallback's `data-reason` is one of four values, chosen by precedence: `too-large`, then `denied` (any candidate 403'd), then `unavailable` (any candidate errored), then `not-found` (every candidate 404'd). Only `not-found` keeps the amber `FALLBACK_CHIP_CLASS` and the exact `Image not found: <path>` title; the others use `NEUTRAL_CHIP_CLASS` + `previewFailureTitle`. The click still calls `openLocalPath`. The remote-image branch is unchanged. The existing `markdown-images.spec.ts` assertions (`not-found`, `too-large`) still pass. | state | `MdImage` (existing markdown renderer) |
| **T4** | `SentFilesCard` wording (D10). | `src/mainview/components/kanban/SentFilesCard.tsx` | T1 (pinned) | `previewFailed` becomes a `ReadonlyMap<string, PreviewFailure>`, and `onPreviewFail(path, status)`. A tile whose preview failed shows the muted `ImageOff` glyph (unchanged) and gets `title={previewFailureTitle(f === "missing" ? "error" : f, tile.path)}`. A thumbnail 404 never claims "not found"; the stat decides that, as today. Not-found gating and the click are unchanged. Every place that reads the set is updated. | none | `SentFilesCard` (existing) |
| **T5** | `BinaryFilePreview` copy for `denied` (D14), local only; PDF parity. | `src/mainview/components/kanban/BinaryFilePreview.tsx`, `src/mainview/components/kanban/DiffDialog.tsx` (one prop), `src/mainview/lib/api.ts` (`fetchBlobBytes` only) | T1 (pinned) | The image pane gains a `denied` kind. Copy: `PREVIEW_DENIED_COPY` when `localFiles`, else `"Couldn't load image"`. The `missing` pane stays amber; the `denied`, generic and too-large panes become neutral (`border-border/60 bg-muted/20 text-muted-foreground`). `fetchBlobBytes` throws `"denied"` on 403. The PDF side state maps `"denied"` to a `denied` kind with the same local/generic copy. `DiffDialog` passes `localFiles`. `GitHubDialog` is untouched, so a PR-blob 403 shows generic copy. | none | `DiffDialog.tsx:1016` (existing) |
| **T6** | The preview-twin module: path, write, sweep and coalescing. | `src/bun/preview-twins.ts` (new) | Gate G1 (S1: pick has no prompt) | The pinned interface exists, and every rule in §3 (write, eviction) holds. Only `fs/promises` I/O. No `Bun.file`/`statSync` of the original. No import of `db.ts`. Logs once per skip reason at `warn`, with the path. | trust, concurrency, state | T8 (routes), T9 (boot) |
| **T7** | Webview gesture plumbing for the twins. | `src/shared/attachments.ts` (`isScreenshotUploadablePath`), `src/mainview/lib/capture-refs.ts`, `src/mainview/lib/api.ts` (`dragRefs(names)`, new `resolveCapturedRefs`) | G1 | `capture-refs` imports `isScreenshotUploadablePath` and drops its local regex. Rung 1's default resolver is `api.resolveCapturedRefs`. Rung 2 calls `dragRefsFn(collected.map(c => c.file.name))`, and the `DragRefsFetcher` type takes `names`. `api.resolveRefs` still sends `{ paths }` only. **If S1 drops a gesture,** that gesture's half is left out: no `names` for drag, or rung 1 keeps `api.resolveRefs` for paste. | trust | T8 reads the new bodies; `capture-refs` is called by the composer's drop and paste handlers (existing) |
| **T8** | Server wiring: the twin writes on the three gestures and the `/files/preview` fallback. | `src/bun/server.ts`, `src/bun/route-policy.ts` (the `EXEMPT_REFS_RESOLVE` reason text only) | T6, T7 (same body shapes) | (a) `/refs/pick` calls `await writePreviewTwinsForRefs(dataDir, refs)` in **both** the fake-dir and the native branch before answering; folder mode is a no-op. (b) `/refs/drag` reads `names` (strings only, ≤ 256 entries) and twins refs that are `!isDirectory && isImagePath && !isScreenshotUploadablePath && names.has(basename)`. (c) `/refs/resolve` twins only when `callerOf(req) === "app" && body.previewTwins === true`. (d) In `/files/preview`, `opened` becomes `let`, and **only on `denied`** it tries `previewTwinPath` through `openFileBytes(twin, { followSymlinks: false, ifNoneMatch, maxBytes: MAX_FILE_PREVIEW_BYTES })`; `ok`/`not-modified` replace `opened`, anything else keeps the 403. The content type comes from `raw`. The route comment is updated. (e) The `EXEMPT_REFS_RESOLVE` reason gains: "an app caller with `previewTwins: true` also gets in-process preview twins (docs/architecture/security.md)". The response shapes of all three refs routes are unchanged. No new route. Gestures S1 dropped get no twin call. | trust | Route table (existing routes) |
| **T9** | The boot sweep. | `src/bun/index.ts`, `src/bun/headless.ts` | T6 | Right after each `scheduleRetention()` (`index.ts:585`, `headless.ts:502`), call `requestPreviewTwinSweep(dataDir)`, fire-and-forget, with `dataDir` imported from `./db.ts`. It never blocks boot or `markBootReady`. | concurrency | `index.ts` and `headless.ts` boot sequences |
| **T10** | Final refresh. | `docs/plans/picked-image-preview-tcc.md` (`Status`, `Branch`, `Base SHA`, and S1/S2 outcomes summarized in §8); the PR body | All | `Status` reflects the head. The PR body states: the S1 verdict per gesture, the S2 verdict (and its ticket draft if one exists), the paste residual accepted by the owner, the test counts by layer, the known pre-existing failures, and the list of D-decisions implemented. | none | n/a |

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| **U1** | unit | T1 | `src/mainview/lib/authed-blob.test.ts`, `src/mainview/lib/preview-copy.test.ts` (new) | `statusForHttp(403)` is `"denied"`, and 404/413/400/401/500 are unchanged (update the `"everything else error"` test and add a `[403, "denied"]` row to the settle table). A `denied` settle refetches on the next subscribe (copy the `error` no-cache test). `previewFailureTitle` returns the exact D9 strings for all four failures, with `missing` exactly `Image not found: <p>` and the others ending in `\n<p>`. |
| **U2** | unit | T6 | `src/bun/preview-twins.test.ts` (new; `mkdtemp` dataDir; no `db.ts` import) | `previewTwinPath` is deterministic, keeps U+202F (two paths differing only by U+202F vs space give different twins), lowercases the ext, and returns `null` for non-images and directories. A write copies the bytes exactly with mode `0600`. A re-write refreshes `mtime`. Skips: a file over 25 MB (sparse `truncate`) gives `too-large`; a final-component symlink gives `symlink` and the target is untouched; a FIFO gives `not-regular` without hanging (bound the test at 2 s); `chmod 000` gives `unreadable`; a missing file gives `missing`; `previews` as a symlink to another dir gives `unsafe-dir`, with nothing written there. A planted symlink at the final twin path is replaced, and its target is unchanged. The sweep, with a small `capBytes`, evicts the oldest `mtime` first down to at most the cap, unlinks planted symlinks without touching their targets, removes `.tmp` files over 1 h old and keeps fresh ones, and does nothing when `previews` is a symlink. Coalescing: 5 rapid `requestPreviewTwinSweep` calls run at most 2 passes (`__forTest.idle()`). |
| **U3** | integration | T8 (+T6) | `src/bun/preview-twins-endpoint.test.ts` (new, port **4471**, re-check that it is unique), `src/bun/preview-twins-callers.test.ts` (new) | Twins are located with `previewTwinPath(dataDir, p)`, where `dataDir` comes from `./db.ts`. **pick, native stub** (`makeTestNative`, as `native-pick-endpoint.test.ts`): an image gets a twin and a `.txt` does not; folder mode gets none; a symlinked png gets none. **pick, fake-dir seam** (set `AGETOR_FAKE_PICK_REFS_DIR` for one test and restore it after): an image gets a twin. **drag** (`setDragPasteboardReaderForTests`, reset in `afterEach`): a `.heic` named in `names` gets a twin; a `.heic` not named gets none; a `.png` gets none (uploadable). **resolve:** app without the flag gets none; app with `previewTwins: true` gets a twin; the CLI token with the flag gets none (the D17 requirement). **preview**, in both disclaim modes (reuse the stub idiom from `files-preview-endpoint.test.ts:140-221`): a readable original with a different twin serves the original's bytes; a `chmod 000` original with a twin returns 200 with the twin's bytes and an image content type; a `chmod 000` original without a twin returns 403; a missing original with a twin returns 404 (no fallback); a `chmod 000` original whose twin is a symlink to a readable png returns 403; `If-None-Match` with the twin's ETag returns 304. **Call-site allowlist:** `writePreviewTwin(sForRefs)?\(` appears only in `preview-twins.ts` and in exactly N call sites in `server.ts`. N is 4 when all gestures ship: pick's two branches, drag and resolve. Subtract one for each gesture S1 dropped. `previewTwins: true` appears in `src/mainview` only in `api.ts`'s `resolveCapturedRefs`, and `resolveCapturedRefs` is called only from `capture-refs.ts`; both assertions are left out if S1 dropped paste. Restore every `chmod` in `finally`. |
| **U4** | unit | T7 | `src/mainview/lib/capture-refs.test.ts` | Rung 2 calls `dragRefs` with the collected basenames, in order. Rung 1 uses the injected `resolver` (the default is `resolveCapturedRefs`, verified by a test that injects nothing but stubs `api`, or by the U3 allowlist). The existing `noDrag` stubs adapt to the new signature. The uploadable filter still excludes png/jpg/gif/webp through `isScreenshotUploadablePath`. |
| **E1** | e2e | C1, C2, C3 | `e2e/attachment-chips.spec.ts` (new), `e2e/fixtures.ts` (`plantPicks` accepts `string \| Uint8Array` values) | Each test plants a real PNG under a **unique** name (`<case>-<uuid>.png`; twins are keyed by path and `fakePickDir` is shared by the worker). It picks through `POST /refs/pick` with the master token (`backend.apiToken`), creates a task with `references` from the pick (`isolation: "none"`, a `mkdtemp` workdir), starts it (fake claude), opens the task and finds the chip inside `div.rounded-br-md`. **(1) Blocked:** `chmod 000` *before* the pick, so no twin is written. The chip's `data-preview-state="denied"`; its class has no `border-warning`; its `title` starts with `Preview blocked by macOS privacy`. **(2) Click:** `page.waitForRequest(/\/open-path/)` fires and `#attachment-open-error-title` shows (headless 501); `#attachment-not-found-title` count is 0. **(3) Missing:** pick, then delete the file → `data-preview-state="missing"`, the amber class, title `Image not found: <path>`; a click opens `#attachment-not-found-title` containing the path. **(4) Twin:** pick (twin written), then `chmod 000` → `data-preview-state="ok"` and an `<img>` with `naturalWidth > 0`. Under the floor-only outcome (G1 failed), case 4 is left out and the spec header says why. Restore permissions in `finally`. |
| **E2** | e2e | C4 (`MdImage`) | `e2e/markdown-images.spec.ts` (one new test) | After the md-image scenario renders, `chmod 000` the scenario's `shot.png` and `page.reload()`. Every `md-image-fallback` for that shot has `data-reason="denied"` and no `border-warning`; a click shows `#attachment-open-error-title`, not the not-found dialog. The existing tests are unchanged and green. Restore permissions in `finally`. |
| **E3** | e2e | C4 (`SentFilesCard`) | `e2e/sent-files.spec.ts` (one new test) | A sent image made `chmod 000` gives a tile whose `title` starts with `Preview blocked by macOS privacy`; the tile is not shown as not-found; a click still reaches `/open-path`. Restore permissions. |
| **E4** | e2e | C4 (`BinaryFilePreview`) | `e2e/binary-diff.spec.ts` (one new test) | In the local diff dialog, an `isolation: "none"` task whose changed image's new side is `chmod 000` shows the pane text `Preview blocked by macOS privacy`, in a neutral pane. If the spec's existing fixture can't express `isolation: "none"`, write the test in a new `e2e/binary-diff-denied.spec.ts` instead and record that in the PR. |
| **D1** | docs | D18 | `docs/architecture/security.md`, `docs/architecture/markdown-images.md`, `docs/architecture/testing-seams.md`, `docs/plans/improve-image-attached-message-ui.md` | **security.md:**<br>• The D26(j) paragraph (`:67`) names attachment chips, and states that a 403 is shown as an honest chip.<br>• A new "Preview twins" paragraph covers:<br>&nbsp;&nbsp;– the three gestures and their guards (`names`, `previewTwins` + app caller);<br>&nbsp;&nbsp;– the no-follow write and the `isPlainDirBelow` dir guard;<br>&nbsp;&nbsp;– the read (disclaimed, no-follow, only on `denied`, the original wins);<br>&nbsp;&nbsp;– the 500 MB oldest-first cache;<br>&nbsp;&nbsp;– that a twin is a pick-time snapshot;<br>&nbsp;&nbsp;– the residuals (the owner-accepted clipboard plant, 2026-11-18; the drag-pasteboard race narrowed by names);<br>&nbsp;&nbsp;– "never call `writePreviewTwin*` from any other route".<br>**markdown-images.md:** `:16`/`:20` gain the four `data-reason` values, with amber only for `not-found`.<br>**testing-seams.md:** `:6` notes that the pick seam also writes twins; the `chmod 000` idiom for chips; unique filenames per test.<br>**improve-image-attached-message-ui.md:** a dated (2026-11-18) note at `:17`/`:64` that the warning state is now 404-only, and that blocked/unavailable previews are neutral and open the file. |

**E2e decision: applies.** The change has user-visible flows (chips, fallbacks, panes) and crosses the webview → core → filesystem boundary.
- Headless backends can't produce TCC, so `chmod 000` stands in for the denial. It yields `denied` → 403 in both disclaim modes (pinned at `files-preview-endpoint.test.ts:176-221`).
- The real-TCC behavior is covered by S1 (pre-build) and V1 (post-build, owner-assisted).

**V1, live acceptance (owner-assisted, after wave 4, recipe as S1 steps 2–4 but using this branch's build):**
- Pick the owner's Desktop screenshot in the dev app: the thumbnail renders.
- An older message referencing the same path shows its thumbnail after the task is reopened (D12).
- A markdown image of a `~/Documents` file shows the neutral chip, and the chip opens the file.

The result goes in the PR body.

**Tests must be able to fail.** Each new test is shown failing against a broken copy of the behavior:
- U1/U3: revert `statusForHttp(403)`, or remove the fallback branch.
- E1 case 1 and E2: restore the old `onMissing` on any non-ok.
- E1 case 4: drop the pick-time write.

Record the red runs in the PR. Tests that need `chmod` semantics skip loudly (`test.skip` with a reason) when running as root. They never return early green.

**Run recipe.**
```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
bun install                                    # fresh worktree
bun run typecheck
bun test src/mainview/lib/authed-blob.test.ts src/mainview/lib/preview-copy.test.ts \
  src/mainview/lib/capture-refs.test.ts src/bun/preview-twins.test.ts \
  src/bun/preview-twins-endpoint.test.ts src/bun/preview-twins-callers.test.ts \
  src/bun/files-preview-endpoint.test.ts src/bun/native-pick-endpoint.test.ts \
  src/bun/route-policy.test.ts src/bun/drag-pasteboard.test.ts
bun test                                       # full suite; known pre-existing failures: tmux-socket ×2, reconcile cancel
# e2e — ONE Playwright run at a time, no src edits while it runs (Vite HMR):
bun node_modules/@playwright/test/cli.js test e2e/attachment-chips.spec.ts --reporter=list
bun node_modules/@playwright/test/cli.js test e2e/markdown-images.spec.ts e2e/sent-files.spec.ts \
  e2e/binary-diff.spec.ts e2e/issue-task.spec.ts --reporter=list
```
- `playwright.config.ts` starts Vite (`webServer`), and `e2e/fixtures.ts` boots one headless backend per worker on 4600+, with `AGETOR_CLAUDE_DRIVER=fake`, the `AGETOR_FAKE_PICK_REFS_DIR` seam and its own temp data dir. No credentials are needed.
- Leaked `headless.ts` backends on 4600+ make the fixture fail fast. Hand the owner `lsof -ti :<port> | xargs kill`.
- Under load, check `uptime` before blaming the change.
- Copy `test-results/**/error-context.md` to the scratchpad before a retry.

### S1 recipe (the D15 gate; owner-assisted; ask the owner once to take part)

1. **Isolated build.** Create `git worktree add <scratchpad>/s1-wt HEAD` (a throwaway that never shares files with wave 1), then `bun install` in it. Apply the instrument patch there. The patch, in `/refs/pick` native files mode, `/refs/drag` and `/refs/resolve` with an app caller, copies each image ref in-process into `dataDir/previews-spike/`. It uses `fs/promises.open(p, READ_NOFOLLOW)` + `readFile` + `writeFile` (the T6 primitive) and logs `[s1] <gesture> <path> <ok|errno> <ms>`. Build the dev bundle (`bunx vite build && bunx electrobun build`, dev env → `build/dev-macos-arm64/*.app`).
2. **Make the result meaningful.**
   - **Launch through LaunchServices, never as a child of this shell.** This shell lives in Agetor's tmux, whose responsible process can already read `~/Desktop` (the grill proved it), so a child launch would be a false negative. Use `open -n <app> --env AGETOR_DATA_DIR=$HOME/.agetor-dev --env AGETOR_API_PORT=4318 --stdout <scratch>/s1-app.log --stderr <scratch>/s1-app.log`. Quit any running dev app first.
   - Read `CFBundleIdentifier` from the built `Info.plist`, then run `tccutil reset SystemPolicyDesktopFolder <id>`.
   - The owner confirms the dev app is not listed under Full Disk Access.
   - Use **fresh** Desktop files that the dev identity has never been granted. The owner takes a new screenshot (⌘⇧3) for the pick and another for the paste, and the agent creates `~/Desktop/agetor-s1-<rand>.heic` with `sips -s format heic <fresh png> --out …`. Ask the owner before writing to their Desktop.
3. **Capture.** Run `log stream --style compact --predicate 'subsystem == "com.apple.TCC"' > <scratch>/s1-tcc.log` in the background during the gestures.
4. **Gestures (the owner performs them in the dev app; one at a time; the owner reports whether a prompt appeared):**
   - (a) Files Picker → pick the fresh png.
   - (b) Finder-drag the `.heic` onto the composer.
   - (c) Finder ⌘C on the other fresh png, then ⌘V into the composer.

   After each, check the `[s1]` line, `cmp` the copy against the original, and grep the TCC log for the bundle id or `DesktopFolder`.
5. **Verdicts → G1.**
   - Pick prompted, or its copy failed → **stop**: skip waves 2–3, ship the floor, and return to the owner about D1.
   - Drag prompted → leave out the drag twin.
   - Paste prompted → leave out the paste twin.
   - All clean → proceed.

   Quit the dev app and remove the scratch worktree.

### S2 recipe (D13)

- Run a headless core from this worktree at its base, against `~/.agetor-dev`, as `AGETOR_DATA_DIR=$HOME/.agetor-dev AGETOR_API_PORT=4319 AGETOR_API_TOKEN=<random hex> AGETOR_DAEMON_IDLE_MS=1800000 AGETOR_DISCLAIM_BIN=/Applications/Agetor.app/Contents/Resources/app/bin/disclaim bun src/bun/headless.ts`, in the background. **Disclaim must be active**, or the children inherit this tmux's access and the result is a false negative. Confirm that the helper path exists and that the core reports disclaim on.
- For each of cursor and fx that is installed and logged in, create an `isolation: "none"` task in the scratchpad with:
  - the reference `~/Desktop/Screenshot 2026-11-18 at 2.40.41 PM.png` (the owner's specimen; read-only);
  - the prompt "Read the referenced image and reply with its pixel dimensions, or the exact error if you cannot read it";
  - fx: `deepseek/deepseek-v4-flash`, Full access; cursor: its default, auto.
- Start each task. Read the answer from `~/.agetor-dev/agetor.sqlite` (read-only), or with `GET /tasks/:id/events`.
- Pace the turns at least 25 s apart (the fx free-tier limits).
- Afterwards, delete the tasks and stop the core with `POST /daemon/shutdown`.
- Use HTTP to this core only; never the `agetor` CLI (it would hit the prod core).

## 6. Execution waves

| Wave | Tasks (parallel unless noted) | Barrier |
| --- | --- | --- |
| 0 | Commit the three planning docs (investigation, grill folder, this plan) as one docs commit. | The tree is clean. |
| 1 | **S1** (in its own scratch worktree), **S2**, **T1**, **T2**, **T3**, **T4**, **T5**, **U1** | `bun run typecheck` is green, and `bun test` is green apart from the known pre-existing failures. Checkpoint commit ("floor"). **G1:** the S1 note is written, and the verdict decides waves 2–3 and the gesture subset. |
| 2 | **T6**, **U2**, **T7**, **U4** | Typecheck and `bun test` are green. Checkpoint commit. (Skipped if G1 failed.) |
| 3 | **T8**, **T9**, **U3** | Typecheck and `bun test` are green, including `route-policy.test.ts`. Checkpoint commit. (Skipped if G1 failed.) |
| 4 | **E1**, **E2**, **E3**, **E4** (written in parallel, **run one at a time**), **D1** | Every e2e spec in the run recipe is green. Checkpoint commit. |
| 5 | **V1** (owner-assisted), then **T10** | Review; final `bun test` + e2e; PR. |

- File ownership is disjoint within each wave. `api.ts` is owned by T5 in wave 1 and by T7 in wave 2. `server.ts` is untouched in waves 1–2 (S1's instrument lives in its own worktree) and owned by T8 in wave 3.
- **Delivery:** one PR, of about 1.5 k changed lines, mostly tests, with one commit per wave. There are no cross-repo dependencies.
- The floor stands alone. If G1 stops the twin work, waves 1 and 4 still ship a complete, reviewable fix of the reported behavior, without thumbnails.

## 7. Invariants, runtime shape & risks

**Invariants (each enforced in one place):**
- **No in-process read of a path named by agent-writable data.** Twin writes run only inside the three gesture handlers in `server.ts`: pick, drag (names-checked) and resolve (app + `previewTwins`, names-checked). This is pinned by the U3 call-site allowlist. Every other `/refs/resolve` caller goes through `api.resolveRefs`, which never sends the flag (also pinned by U3).
- **Every twin read is disclaimed while the switch is on, and never follows a symlink.** It happens at the single fallback call in `/files/preview` (`followSymlinks: false`).
- **No in-process write or sweep through a redirected `previews/`.** `isPlainDirBelow(dataDir, previews)` runs inside `preview-twins.ts` before every write and every sweep. The timing race between the check and the I/O is the same accepted residual `no-follow.ts:115-121` documents.
- **Twin writes never follow a destination symlink.** They write a `wx` temp file and then `rename`, in `writePreviewTwin`.
- **Amber and "not found" only for a proven 404.** `statusForHttp` and `previewFailureTitle` enforce this, and all four surfaces derive from them.
- **The route table is unchanged.** `/refs/drag` stays `APP`. `/refs/resolve` stays `cli({ pathParamsExempt })` with its reason updated. `names` and `previewTwins` are not path parameters.

**Runtime shape.**
- One core. A pick awaits its twin writes, which are serial and at most 25 MB each, so a multi-image pick answers a little later.
- A crash between the temp write and the rename leaves a `.tmp` file, which the sweep removes after 1 h. A crash mid-sweep is harmless.
- Two cores never serve at once, because the port bind is the ownership claim. A background core's sweep and the app's sweep are serialized by that handoff.
- With the disclaim switch off, the original is read in-process and wins, so twins sit unused, inside the cap.
- Headless cores: native `/refs/pick` answers 501, so only the e2e seam writes twins there. The boot sweep is harmless.
- There is no kill switch. Removing the twin is the rollback, and the chip then degrades to the honest state.

**Blast radius.**
- `statusForHttp(403)` changes for every `AuthedImg` and `useAuthedObjectUrl` consumer. All four are covered (T2–T5), and `GitHubDialog`'s PR panes keep generic copy, though now in a neutral pane.
- `/refs/drag` and `/refs/resolve` bodies grow an optional field each, and older webviews keep working (no field → no twins).
- `capture-refs` rung 1 now posts `previewTwins: true` and `names` (the basenames of the carried `File`s; see §10.2 item 6).
- `previews/` is new under `dataDir`. Nothing deletes it on task delete, by design (path-keyed, shared by tasks, capped).
- Rollback is a revert. A leftover `~/.agetor/previews/` is inert and can be deleted by hand.

**Risks.**
- S1 shows a prompt: the twin work stops (planned).
- The dev identity differs from the signed prod identity. MACL works the same way for both, and V1 on the branch build is a second check. Re-check on the first signed release (T10 notes this in the PR).
- HEIC in `<img>`: WKWebView decodes HEIC, but the Chromium e2e can't. E1 and U3 use PNG only; HEIC is exercised in S1 and V1.
- Load flakes in the e2e: see the run recipe.

## 8. Open questions / assumptions

**Owner decisions taken at planning (2026-11-18, through the question form):**
- **P1, entry points.** The owner chose "All three, as D2 decided": pick, drag and paste create twins. The clipboard-plant residual is accepted and documented in `security.md` (D1).
- **P2, a split spike.** The owner chose "Twins for pick only": if the drag prompts in S1, drop the drag twin and continue.

**Planner decisions and assumptions (proceeding on them; each is cheap to change):**
1. **The `previewTwins` flag on `/refs/resolve`.** It is required so that the stat-only callers (`SentFilesCard`, handoff chips, `@`-scope), which call the route with agent-chosen paths and the app token, never make the core read a protected file in-process. This implements D2's "paste of a Finder-copied file" as intended. It is a security narrowing, not a change of scope.
2. **The `names` cross-check on `/refs/drag`.** It hardens the drag pasteboard race. If a legitimate drag ever arrives without `File` entries, it loses only its thumbnail, and the chip shows the honest state.
3. **P2 extended to paste.** If the paste prompts in S1, drop the paste twin and continue. (P2 named drag; the same reasoning applies.)
4. **The tooltip carries a second line with the full path** after the exact D9 copy.
5. **Eviction by write-time `mtime`, with no lookup refresh** (§3). This changes the grill's tentative "refreshed on lookup", which the grill left to planning.
6. **Twins are written whatever the disclaim switch says.**
7. **An already-rendered chip in a failure state does not refetch** until it remounts (a task switch or reopen). The D12 "re-attach lights up old chips" happens after reopening, not live.
8. **`isPlainDirBelow` uses sync `lstat` on two path components.** This is acceptable on the request path (the same as existing callers).
9. **The S1 validity conditions** (§5): a LaunchServices launch, `tccutil reset`, fresh files, and the dev app not in Full Disk Access. If any can't be met, record it in the S1 note and ask the owner whether the verdict stands.
10. **Electrobun's open panel runs in the core process** (`server.ts:1432`). S1 confirms this indirectly: the copy runs in the same handler.

## 9. Completeness ledger

| Item | Disposition | Task / reason / who |
| --- | --- | --- |
| `AttachmentChips` 404-vs-other split, neutral chip, a click that opens | In this run | T2, E1 |
| `MdImage` final fallback reasons and copy (candidate walk unchanged) | In this run | T3, E2 |
| `SentFilesCard` failure wording | In this run | T4, E3 |
| `BinaryFilePreview` image pane `denied` copy (local only) | In this run | T5, E4 |
| `BinaryFilePreview` PDF pane `denied` copy (`fetchBlobBytes` 403) | In this run | T5 |
| PR-blob 403 must not claim macOS privacy | In this run | T5 (`localFiles` prop) |
| `AuthedBlobStatus` + `statusForHttp` + `AuthedImg` docs | In this run | T1, U1 |
| A shared copy module (one source of the D9 strings) | In this run | T1 |
| The twin module (path, write, guards, sweep, coalescing) | In this run (gated by G1) | T6, U2 |
| `/refs/pick` twins, native **and** fake-seam branches | In this run (gated) | T8, U3, E1 |
| `/refs/drag` twins, non-uploadable images, names-checked | In this run (gated, and dropped if S1 drag prompts) | T7, T8, U3, U4 |
| `/refs/resolve` twins for the paste gesture only (`previewTwins` + app) | In this run (gated, and dropped if S1 paste prompts) | T7, T8, U3 |
| Stat-only `/refs/resolve` callers never twin | In this run | T7 (`resolveRefs` unchanged), U3 allowlist |
| CLI-token `/refs/resolve` never twins | In this run | T8, U3 |
| `/files/preview` twin fallback, only on `denied` | In this run (gated) | T8, U3, E1 case 4 |
| Boot sweep in **both** `index.ts` and `headless.ts` | In this run (gated) | T9 |
| Sweep after each write | In this run (gated) | T6 |
| `SCREENSHOT_UPLOADABLE` single implementation in `src/shared` | In this run (gated) | T7 |
| `EXEMPT_REFS_RESOLVE` reason text | In this run (gated) | T8 |
| `plantPicks` binary content for e2e | In this run | E1 |
| The D15 pick/drag/paste no-prompt spike | In this run | S1 |
| The D13 cursor/fx read spike | In this run (spike only) | S2 |
| The cursor/fx read **fix**, if S2 shows it broken | Owner-deferred: a separate ticket with S2's evidence | owner, grill D13 (`round-1/answers.json#acp-read`) |
| Docs: security.md, markdown-images.md, testing-seams.md, improve-image-attached-message-ui.md | In this run | D1 |
| Live check on a real build | In this run | V1 |
| Plan status and PR body refresh | In this run | T10 |
| Thumbnails for already-sent messages (backfill) | Out of scope: owner accepted the honest chip; a path-keyed twin lights them up on re-pick | owner, D12 |
| Click-to-load or thumbnails for agent-chosen images | Out of scope: D26(j) kept on purpose | owner, D11 |
| CLI/TUI parity | Out of scope: no thumbnails there | owner, D20 |
| Remote markdown images (`<img onError>`, no HTTP status) | Out of scope: not a `/files/preview` surface; the fallback is unchanged | different mechanism, no status to split on |
| Cleanup of the unbounded `dataDir/screenshots` (573 files, 117 MB) | Out of scope: a different ticket (drag-upload retention) | grill dispositions (judgment, surfaced for a follow-up) |
| A twin of a file changed after the pick shows the pick-time bytes while the original is unreadable | Accepted behavior: a twin is a snapshot, and a re-pick refreshes it; documented in security.md | D1 |
| `CLAUDE.md` rule line for twins | Not needed: security.md is the subsystem doc that CLAUDE.md's topic map sends `server.ts` route work to | — |
| New per-task state in `RunPanelBody` | None added (state lives in per-message components) | — |

## 10. Execution record (2026-11-18)

### 10.1 Spike outcomes (G1)

- **S1** (`docs/plans/picked-image-preview-tcc-spike-pick.md`): **pick** and **drag** copy a fresh `~/Desktop` file in-process with no prompt (407 ms and 9 ms, byte-identical; zero `DesktopFolder` requests from the dev app in the TCC log). **Paste**: a Finder ⌘C/⌘V of a png or a heic delivers the *bytes* to WKWebView (no `file://` URL), so it is uploaded, and `/refs/resolve` was never called; a png drop also went through `/refs/drag`. Nothing contradicts the paste twin (same primitive), so per P1 all three gestures ship, with the paste twin behind `previewTwins: true` + the app caller. `tccutil reset` was not run: the dev build shares the installed app's bundle id. The five `~/Desktop/agetor-s1-c07a13*` test files are the owner's to delete.
- **S2** (`docs/plans/picked-image-preview-tcc-spike-acp.md`): **fx reads** a picked Desktop screenshot (through its shell tool, as a disclaimed child). **cursor cannot be tested**: every cursor task fails with `Invalid params` on `cursor-agent 2026.10.22`, with or without the file, before any read. Ticket draft is in the S2 note (owner-deferred, grill D13).

### 10.2 Deviations from the plan, each with its reason

1. **E4 uses a mocked 403, not `chmod 000`.** `git diff` has to read the working-tree file to list it, so an unreadable file never reaches the Diff dialog; the test fulfills the `side=new` blob route with a 403 through `page.route` and pins what the dialog does with it. The core's own 403 (`taskDiffBlob` `denied`) is covered by the existing server tests.
2. **`MdImage` keeps `Image too large to preview: <path>` as the `too-large` title**, because `e2e/markdown-images.spec.ts` asserts that exact string and the plan says that spec stays unchanged. The chip is neutral (the plan's rule), only the wording is kept.
3. **Port 4469, not 4471**, for `preview-twins-endpoint.test.ts` (`daemon-boot.test.ts` already uses 4471). `__forTest` gained `passes()` so the coalescing test can count sweep passes.
4. **`ImageChip` reports `data-preview-state` `loading` until the thumbnail settles** (the plan's list), and `ok` only once it has.
5. E1's blocked cases `chmod 000` the planted file *before* the pick (as the plan says) inside a `pickImage` helper; the twin case chmods after it.
6. **`/refs/resolve` also takes `names`, and twins only a path a name vouches for** (code review M1, 2026-11-18). Rung 1 collects `file://` lines from `text/plain` too, and the composer's drop wrappers capture any drop that bubbles up from the textarea, so dragging agent output that names a protected path would otherwise have made the core copy that file in-process (a silent read or a prompt in Agetor's name, and a copy under `previews/` the agent can read). `capture-refs` now sends the basenames of the `File`s the same drop/paste carried, and the handler applies the same check as `/refs/drag`. A text-only drop carries no `File`, so it still gets its reference (a stat) but never a twin. The `previewTwins: true` flag and the app-caller guard stay. Pinned by `preview-twins-endpoint.test.ts`, `capture-refs.test.ts` and `preview-twins-callers.test.ts`.

### 10.3 Still open

- **V1** (plan §5): the live check on this branch's build (the owner's Desktop screenshot gets its thumbnail; an older message lights up after reopening the task; a `~/Documents` markdown image shows the neutral chip and opens). Needs the owner at the keyboard.
- Re-check the no-prompt result on the first signed release (the dev build is ad-hoc signed).
- The cursor `Invalid params` ticket (S2 note).

### 10.4 Test results (Test Writer step, 2026-11-18, at `c130ea77` + the uncommitted test additions)

Machine load 25–40 throughout; e2e on private ports (`CI=1 AGETOR_E2E_VITE_PORT=5473 AGETOR_E2E_PORT_OFFSET=2600`, one worker) because two other worktrees were running Playwright on the default ports.

- **Typecheck:** clean (`tsc --noEmit` covers `src` and `e2e`).
- **Targeted suites** (the run recipe's list plus `src/mainview/lib/api-preview-twins.test.ts` and `src/shared/attachments.test.ts`): 12 files, **359 pass, 0 fail**.
- **E2e run recipe:** `attachment-chips.spec.ts` **6/6**; `markdown-images`, `sent-files`, `binary-diff`, `issue-task` **31/31**.
- **Can fail:** 21 mutations of `preview-twins.ts`, `server.ts`, `api.ts` and `capture-refs.ts` and 5 of `AttachmentChips`, `MdImage`, `SentFilesCard` and `BinaryFilePreview` were each caught by a new test.
- **Full `bun test`:** 545 files, **13,682 pass, 32 skip, 9 fail** (1,200 s). None is in a file this change touches:
  - `at-file-filter.test.ts` (perf ceiling, 20 ms vs 15 ms), `orchestrator-checkout-branch.test.ts`, `orchestrator-opencode-server.test.ts`, `orchestrator-hold-scope-claim.test.ts` (hook timeout): each **passes when run alone** (load flakes).
  - `github-network.test.ts` ×5 ("… without a network call when unauthenticated"): **fail alone too, and are environment-dependent**: the tests delete `GITHUB_TOKEN`/`GH_TOKEN`, but `gh` is logged in on this machine, so the code under test still finds a token and calls the API. This branch changes no GitHub code.
  - The previously known failures (tmux-socket ×2, reconcile cancel) did not fail in this run.

Tests added in this step:
- `src/bun/preview-twins.test.ts` (+11): the inclusive 25 MB cap, `ENOTDIR` as `missing`, `previews` as a plain file (`unsafe-dir`), the 0700 cache dir, `writePreviewTwinsForRefs` continuing past a failed ref, one warning per skip reason (none for a non-image), a FIFO and a subdirectory planted in the cache, a fresh `.tmp` never counted, and coalescing (exactly one follow-up pass, against the latest data dir).
- `src/bun/preview-twins-endpoint.test.ts` (+18): a folder-mode pick never twins even a file, a multi-image pick, a cancelled pick, the CLI token refused on pick and drag, pick → `chmod 000` → preview 200 through the real routes, every image type on drag (5 twinned, 5 uploadable), a directory or symlink on the pasteboard, the 256-name cap, no coercion of non-string names, missing/directory paths on resolve, an unchanged response shape, a twin that is a directory or over the preview cap keeping the 403, the exact-path key (U+202F vs space) end to end, and the requested path's content type.
- `src/mainview/lib/api-preview-twins.test.ts` (new): the wire bodies of `resolveCapturedRefs`, `resolveRefs` and `dragRefs`, and `fetchBlobBytes` mapping 403 → `denied`.
- `src/mainview/lib/capture-refs.test.ts` (+1): the default `api.dragRefs` receives the carried names.
- E2e (+5): a 500 and a 413 attachment chip (neutral, own copy, still opens); a blocked chip whose `/open-path` answers 404 turning amber, then retrying after the dialog closes; the `MdImage` `unavailable` fallback; a `SentFilesCard` thumbnail 404 reading "Preview unavailable", never "missing"; and the PDF pane's `denied` line in the local diff.


### 10.5 Test Loop (pipeline step 9, 2026-11-18, at `c130ea77` + the uncommitted additions)

An independent code review (round 3) found **no must-fix items**. Four hardening nits were fixed in this step:
- **N2.** The sweep re-`lstat`s a victim (ino + mtime) before unlinking it. A re-pick that renamed a fresh twin over the old name between the listing and the eviction no longer loses the newest twin (`preview-twins.ts`).
- **N5.** `preview-twins.test.ts` awaits `__forTest.idle()` before `reset()`. A sweep loop from an earlier test or file could otherwise survive the reset and add a pass to the next test's count. `preview-twins-endpoint.test.ts` awaits the sweep and removes its data dir with `rmTestDataDir`.
- **N3.** `preview-twins-callers.test.ts` pins the exact import lines of `preview-twins.ts` (`server.ts`, `index.ts`, `headless.ts`). This catches an aliased import (`writePreviewTwin as w`) that the call-count regex would miss. A mutation proved the test fails on one.
- **N1.** The sync-I/O wording in `docs/architecture/security.md` is corrected.

Left for the owner, because each one revisits a grill decision:
- **S1.** Every picked or dragged image is twinned, even when the original is readable. Also, `O_NOFOLLOW` guards only the last path component, which leaves a narrow race on a pick inside an agent-writable folder. Probing first would twin only originals that come back `denied`, but that costs one disclaimed spawn per gesture, and the twin e2e could no longer simulate a denial with `chmod`.
- **S2.** Twins have no age bound; only the 500 MB cap (D6) evicts them.
- **S3.** No proven production gesture reaches the `/refs/resolve` twin path after M1 (D2 "paste").
- **N4.** There is no count cap for many tiny twins.
- **Q1.** `/open-path`'s in-process `existsSync` on a denied path. This predates the branch.
- **Q2.** Whether the NFD and NFC forms of a name match between `File.name` and the pasteboard path. Add an accented name to V1.

Results:
- **Typecheck:** clean. The webview production build (`vite build`) succeeds.
- **Targeted suites** (the 12 files in §10.4): **360 pass, 0 fail**.
- **Full `bun test`**, before the fixes (load 25): 545 files, **13,683 pass, 32 skip, 8 fail**. None is in a file this change touches:
  - `github-network.test.ts` ×5 depends on the environment (`gh` is logged in).
  - `orchestrator-hold-scope-claim.test.ts` (hook timeout), `orchestrator.test.ts` ("sendInput folds a follow-up") and `cli/tui/Dashboard.test.tsx` ("resumed replay_meta") **each pass when run alone** (load flakes).
- **E2e** on private ports (`CI=1 AGETOR_E2E_VITE_PORT=5473 AGETOR_E2E_PORT_OFFSET=2600`):
  - The run recipe passes **37/37**: `attachment-chips` 6, and `markdown-images`, `sent-files`, `binary-diff` and `issue-task` 31.
  - The neighbouring specs on the composer drop/paste, markdown and handoff surfaces pass **72/72**: `at-file-autocomplete`, `pasted-content`, `no-query-token`, `quote`, `markdown-readability`, `formatted-handoff` and `bundle-export-import`.
  - No test needed a retry.
- **Full `bun test` after the fixes** (final run, load 13–25): 545 files, **13,685 pass, 32 skip, 7 fail, 1 unhandled error**. None is in a file this change touches. `github-network.test.ts` ×5 depends on the environment. `orchestrator-hold-scope-claim.test.ts` (hook timeout) and `pipeline-stop-spawn-claim.test.ts` (5 s timeout; its `waitFor` rejection is the unhandled error) each **pass when run alone**. `orchestrator-hold-scope-claim` timed out under load in all three full runs (§10.4 and both of this step's), so it is a load flake that predates this branch.

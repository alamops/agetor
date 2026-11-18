# Investigation — broken preview for images attached with the Files Picker

| Field | Value |
| --- | --- |
| Date | 2026-11-18 |
| Change | Fix the transcript's attachment chip, which shows a picked image as an amber "Image not found" chip that can be neither previewed nor opened. Decide how a user-picked file in a macOS-protected folder (Desktop, Documents, Downloads, …) gets a thumbnail without reopening the confused-deputy hole that `docs/plans/master-token-agent-read.md` D26(j) closed. |
| Agents | none (this pipeline step forbids delegation); 1 inline spike, read-only checks of the prod DB and file xattrs, 2 web searches |
| Flags | none |

## TL;DR

- **Root cause (proved):** `GET /files/preview` reads the image through a *disclaimed* child (`/bin/sh` → `stat` → `exec /bin/cat`, `src/bun/core-file-read.ts`). That child is responsible for itself, so macOS TCC judges it as `/bin/sh`/`cat`, which has no access to `~/Desktop`. `stat` succeeds and `cat` fails at once with `Operation not permitted`. No prompt is shown. The core answers **403**, and the webview maps 403 to `"error"`.
- **Why it can't be opened either:** `AttachmentChips`' `ImageChip` treats *any* non-ok thumbnail status as "missing". It renders the amber `ImageOff` chip titled "Image not found", and a click on a "missing" chip goes straight to the *Attachment not found* dialog **without calling `/open-path`**. That route would open the file fine, since it only `existsSync`s in-process and hands off to LaunchServices.
- **Why "Files Picker" specifically:** the picker (`/refs/pick`) and a paste of a Finder-copied file (`file://` → `/refs/resolve`) reference the file **by its original path**. A Finder *drag* of a png/jpg/gif/webp is instead uploaded as bytes to `dataDir/screenshots` (`capture-refs.ts` rung 3), and a clipboard image goes to `dataDir/attachments`. Both copies live outside protected folders and preview fine.
- **Regression:** introduced by #281 (`497f6d43`, 2026-10-28). Before it, the route read in-process (`statSync` + `Bun.file`) under Agetor's identity, which holds user-intent access to the files the user picked. The D26(j) docs scope the disclaimed read to *agent-chosen* paths (markdown images, `SendUserFile` tiles). User-picked attachment chips go through the same route and were caught by accident.

## 1. What we know

**The rendering path**

- The chip in the screenshot is `ImageChip`'s missing branch: amber `border-warning/40 bg-warning/10`, `ImageOff`, title `Image not found: <path>` (`src/mainview/components/kanban/AttachmentChips.tsx:162-174`).
- `ImageChip` fetches `api.filePreviewUrl(path)` through `AuthedImg` and calls `onMissing()` on **any** status other than `ok` (`AttachmentChips.tsx:176-187`).
- A click on a chip in `missing` opens the not-found dialog without calling the server (`AttachmentChips.tsx:61-65`). Closing the dialog clears `missing`, the chip remounts, re-fetches, gets 403 again and turns amber again (`:125-138`).
- The file's own comment for `openPath` says only a 404 proves a file is gone, and that anything else "says nothing about whether the file exists, so don't poison the thumbnail over it" (`:73-87`). The thumbnail path breaks that rule.
- The original spec (`docs/plans/improve-image-attached-message-ui.md:17`) also limited the warning state to "If the file no longer exists".
- `statusForHttp` maps 404 → `missing`, 413 → `too-large`, and **everything else, 403 included, → `error`** (`src/mainview/lib/authed-blob.ts:46-50`). A failure isn't cached: the next consumer retries (`authed-blob.ts:204-208`).
- The chip is rendered for every user bubble's trailing `Referenced files/folders:` block: the launch prompt, plain follow-ups and command messages (`src/mainview/components/kanban/RunPanel.tsx:7248, 7256, 7272`). The block is built by `appendReferences`/`formatReferences` (`src/shared/refs.ts:15-29`) and parsed by `src/shared/user-message.ts:114-140`.

**The server path**

- `/files/preview` (`src/bun/server.ts:7785-7860`, desktop-only `GET: APP` at `src/bun/route-policy.ts:442`) calls `openFileBytes(raw, { followSymlinks: true, … })` (`server.ts:7809`) and answers 403 on `denied` (`server.ts:7817-7819`).
- `openFileBytes` goes disclaimed whenever `disclaimEnabled()` is true (`src/bun/core-file-read.ts:90`). The script (`core-file-read.ts:256-275`) runs `stat` and then `exec /bin/cat`. The core waits for the first body byte because "`stat` answers for a protected file that `cat` can't read" (`:404`), and `DENIED_RE` turns `Operation not permitted` into `denied` (`:277`).
- `disclaimEnabled()` = darwin && in-memory switch (default ON) && helper present (`src/bun/disclaim.ts:40-49, 103-122`). **Prod check:** `preferences` has no `disclaimSpawnedAgents` row, so the switch is ON, and `/Applications/Agetor.app/Contents/Resources/app/bin/disclaim` exists. The switch is therefore active in the user's app.
- Before #281: `git show 497f6d43^:src/bun/server.ts` lines 6453-6500 show the route as `statSync(raw)` + `new Response(Bun.file(raw))`, in-process, and the chip as `<img onError={onMissing}>`. The "any failure = missing" handling is old, but it only became visible once 403 started happening on every protected-folder image.

**Where attached paths come from**

- **Files Picker:** `POST /refs/pick` (`server.ts:7552-7598`) opens the native NSOpenPanel and returns `refsFromPaths(pickedPaths(...))`, the **original absolute paths**. Nothing is copied. Test seam: `AGETOR_FAKE_PICK_REFS_DIR`.
- **Drop/paste** (`src/mainview/lib/capture-refs.ts:176-304`):
  - Rung 1: `file://` URLs → `/refs/resolve` → original path. This is mainly a paste of a Finder-copied file.
  - Rung 2: drop only, the drag pasteboard (`/refs/drag`). It excludes `SCREENSHOT_UPLOADABLE` (`png|jpe?g|gif|webp`, `capture-refs.ts:14, 304`) images, so those fall to rung 3.
  - Rung 3: image bytes are uploaded to `POST /screenshots` (`server.ts:7673`, `dataDir/screenshots`), other bytes to `POST /attachments` (`server.ts:7732`, `dataDir/attachments`).
  - So **a Finder drag of a Desktop png already becomes a copy, while picking the same png keeps the Desktop path.** The entry points are inconsistent today.
- Pipeline step tasks carry the parent's references plus runner-written handoff JSON refs (`src/bun/pipeline-runner.ts:1406-1408`), so a picked image shows on every step's prompt bubble. This step's own bubble is the screenshot.

**The specimen (prod DB, read-only)**

- Task `ed2a8d91…` (this pipeline) and its step task `80f55b17…` store `refs` = `/Users/<u>/Desktop/Screenshot 2026-11-18 at 2.40.41 PM.png`.
- The step run `afd82bed…`'s `user` events 1533494/1533500 hold the same bytes after `Referenced files/folders:\n- `. **U+202F (the narrow no-break space macOS puts before AM/PM in screenshot names) is preserved end to end**, so a mangled path, which would give a 404, is ruled out.

**Who else uses `/files/preview` or the disclaimed reader**

- `SentFilesCard` (`src/mainview/components/kanban/SentFilesCard.tsx:100-125`) already does it right: a failed preview only swaps the glyph (`isPreviewFailed`), only a 404 from open or a stat gates the click to "not found", and the click still opens the file.
- `MdImage` (`src/mainview/components/kanban/MdImage.tsx:236-290`): a failure walks to the next candidate. When every candidate fails it shows a fallback chip titled **"Image not found"** even for a 403, but its click still calls `openLocalPath`, so open works there.
- `BinaryFilePreview` (`useAuthedObjectUrl`, `src/mainview/components/kanban/BinaryFilePreview.tsx:127`) reads the diff blob's new side through `readFileBytes` (`src/bun/worktree.ts:2219-2225`). A task with `isolation: "none"` whose workdir is under `~/Documents`/`~/Desktop` would 403 the same way. A worktree under `~/.agetor/worktrees` is not affected.
- Handoff artifact chips and `HandoffFileChip` don't fetch bytes. They use `/refs/resolve` + `/open-path` and are not affected.

**Non-image attachments ("might happen in other file attachments")**

- Non-image chips are icon buttons that call `/open-path` (`server.ts:7444-7485`): `existsSync` in-process, then `native.openPath` through LaunchServices. `stat` is not TCC-gated (the spike shows the disclaimed `stat` succeeding), so **opening non-image attachments works**. The breakage is limited to *thumbnailed* (image) refs: attachment chips, markdown images, `SendUserFile` tiles and binary-diff new sides in protected folders.
- One related risk outside the reported symptom (§3): harnesses spawned disclaimed *without* tmux (cursor ACP, fx ACP) read a picked Desktop file under their own TCC identity.

**Contract, standards, runtime and trust**

- **Contract:** the owner's report is in the task prompt plus the screenshot `~/Desktop/Screenshot 2026-11-18 at 2.40.41 PM.png`, which is **outside the repo**. The plan should restate the symptom in-repo.
- **Standards that apply:**
  - `CLAUDE.md` → "Agent-writable files are read with the no-follow helpers…, and agent-chosen bytes the webview fetches go through `src/bun/core-file-read.ts`" and "Every spawn goes through `coreSpawn`".
  - `docs/architecture/security.md:67`, D26(j).
  - New UI uses the semantic status tokens (`text-warning` etc.), never palette classes (`CLAUDE.md` UI conventions).
  - A route change needs its `ROUTE_POLICY` entry (`route-policy.ts`); `/files/preview` stays `APP`.
  - `src/shared/` stays free of runtime imports.
  - Persisted events stay raw: don't rewrite old messages' paths.
- **Runtime and trust shape:**
  - One core process: the desktop app, or a headless core that answers 501 for native routes.
  - The webview holds the master token and is the only caller of `/files/preview`. Agents hold at most the CLI token, which gets 403 `desktop-only`.
  - The D26(j) threat is an agent getting the core to read a protected path under **Agetor's** TCC identity, either provoking an "Agetor would like to access…" prompt or silently using Agetor's grant, by putting a path where the webview will auto-fetch it. Agents control markdown, `SendUserFile` paths, the claude session JSONL that user bubbles are rebuilt from, and `agetor.sqlite`, which D26(i) treats as agent-writable.
  - **So "this path appears in a user bubble" is not proof the user picked it.** A forged JSONL user record or a DB edit can put any path there.

## 2. What we proved

| Question | Verdict | Evidence (command → output) | Versions | Artifact |
| --- | --- | --- | --- | --- |
| Does the disclaimed `/files/preview` read fail for a picked `~/Desktop` image? | **Yes**: `stat` OK, `cat` EPERM, immediately (0 s, no prompt) → `denied` → 403 | `disclaim /bin/sh -c "$(cat open.sh)" sh "<Desktop>/Screenshot … PM.png" "" 1` → stdout `O 12941 1795030847.124956539\n` with no body; stderr `cat: …: Operation not permitted`; exit 1 | Agetor.app helper built 2026-11-13, macOS Darwin 25.6.0 | `<scratchpad>/spikes/disclaimed-desktop-read/open.sh` (verbatim copy of `OPEN_SCRIPT` minus the INM/limit branches) |
| Same bytes outside a protected folder? | **Reads fine** (control) | same command on a scratchpad copy → `O 12941 …\n` followed by `\x89PNG…` | same | `<scratchpad>/spikes/disclaimed-desktop-read/control.png` |
| Same script, undisclaimed (this session's identity)? | **Reads fine** | `/bin/sh -c "$(cat open.sh)" …` → `O 12941 …\n\x89PNG` | same | same |
| Could the 404 come from a mangled path (U+202F → space)? | **No.** U+202F is intact in `tasks.refs` and in the `run_events` user text | `sqlite3 -readonly ~/.agetor/agetor.sqlite "select hex(data) from run_events where id=1533494"` → `…2.40.41\xe2\x80\xafPM.png` | prod DB | n/a |
| Do picked files carry a user-intent grant? | **Consistent with yes, not proved for Agetor specifically.** Both picked screenshots carry a `com.apple.macl` xattr (one identical entry) | `xattr -px com.apple.macl "<Desktop>/Screenshot …"` → `00 C1 CE 98 42 86 5F 2A …` | macOS 26 | n/a |

Not run: the "would the tests notice?" spike. The reading already shows that **nothing pins the chip's behaviour on a 403**:

- There is no component or e2e test of `AttachmentChips`. A grep for `AttachmentChips`/`Referenced files/folders` over `e2e/` and the test files finds only three lib tests (`message-history`, `shorten-task-paths`, `event-dedup`).
- `src/bun/files-preview-endpoint.test.ts:221` pins the server's 403 for an unreadable (`chmod 000`) image in both disclaim modes.
- `src/mainview/lib/authed-blob.test.ts:50-54` pins `statusForHttp(4xx/5xx)`.
- A naive fix stays green without proving the UI. The plan must add a UI-level test.

## 3. What we're assuming

1. **Agetor's own process can read a user-picked file in a protected folder without a prompt** (user intent through NSOpenPanel, recorded as `com.apple.macl`). Two things support this: the in-process route worked for these thumbnails before #281, and the files carry MACL. Web sources say an NSOpenPanel pick grants a non-sandboxed app access by inferred intent ([Apple forums](https://developer.apple.com/forums/thread/124121), [Eclectic Light 2026-04-20](https://eclecticlight.co/2026/04/20/privacy-how-locations-are-protected/), [2025-02-24](https://eclecticlight.co/2025/02/24/gaining-access-to-privacy-protected-folders/)). *If wrong:* every in-process fix (provenance, click-to-load, copy-on-pick) would itself raise an "Agetor would like to access Desktop" prompt, and the copy must happen in the same process as the panel, at pick time.
2. **The amber chip in the screenshot came from the 403 path, not a 404 or a timeout.** The spike reproduces it exactly, and the path is intact. A 10 s timeout (`error`) would look the same in the UI; the fix covers both.
3. **The Electrobun native panel runs in the core (Bun) process**, so the user-intent grant belongs to the process that serves `/files/preview`. Not verified; it matters only for in-process designs.
4. **The disclaimed child is denied without a prompt on other users' machines too.** The bg-spawn "attribution chain" reports ([mjtsai](https://mjtsai.com/blog/2025/07/07/the-curious-case-of-the-responsible-process/), [Apple forums](https://developer.apple.com/forums/thread/731504)) suggest a silent default-deny. *If a prompt does appear for "sh"/"cat"* elsewhere, the 10 s budget expires (`error`), and the same UI fix still applies.
5. **ACP harnesses (cursor, fx) spawned disclaimed without tmux may be unable to read a picked Desktop file at all.** This is adjacent to the report, not part of it, and was not tested. Copying the file at pick time would fix it as a side effect.

## 4. What we must ask the owner

1. **The thumbnail mechanism for user-picked images in protected folders** is a security-posture decision against D26(j). The options:
   - **(A) Copy at pick time, and reference the copy.** `/refs/pick`, and the paste-of-a-Finder-file rung, would treat images the way a Finder drag already does: copy the bytes into `dataDir/screenshots` or `attachments` in-process, at pick time, and put the copy's path in the prompt.
     - For: consistent with drops, every harness can read the copy, and the disclaimed reader stays the only reader.
     - Against: the agent sees `~/.agetor/…` rather than the original location, edits to the copy don't touch the original, and copies need a lifecycle.
   - **(B) Copy a preview twin at pick time but keep the original path in the prompt.** Needs a stored mapping. A forged mapping is harmless because the twin is still read disclaimed, but the mapping adds state, and old messages have none.
   - **(C) An in-memory provenance set** of paths returned by `/refs/pick` (and app-caller `/refs/resolve`/`/refs/drag`), read in-process. It can't be forged, but it is lost on restart, so older chips fall back to "preview unavailable".
   - **(D) Click-to-load.** On 403, show "Preview blocked by macOS privacy · click to load", and a user click triggers one in-process read. Agents can't click, but they can lure a user into clicking.
   - **(E) Relax D26(j) for references-block paths.** Reopens the hole, because user bubbles and the DB are agent-writable.
   - **(F) No thumbnail.** Only an honest "preview unavailable" chip that still opens.

   *Recommendation:* (F) as the floor, always, plus (A) for new picks, since it matches what drag-and-drop already does. (C) or (D) are the fallback if changing the agent-visible path is unacceptable.
2. **Fix the UI contract everywhere?** Split "not found" (404) from "preview unavailable or blocked" (403 and other errors) in `AttachmentChips` (click must still call `/open-path`), in `MdImage`'s fallback title (today "Image not found" for a 403), and possibly `BinaryFilePreview`'s copy. Should a 403 get its own blob status (`"denied"`) with protected-folder wording, or reuse `error`?
3. **Agent-chosen images in protected folders** (markdown `![](~/Documents/x.png)`, `SendUserFile` of a Desktop file) are broken *by design* under D26(j). Keep them as honest "blocked" chips that still open, or offer click-to-load (D) there too?
4. **Messages already sent** with protected-folder refs, including this pipeline's own prompts: is "preview unavailable, click opens" acceptable for them, or must they get thumbnails back (needs C/D, since persisted events stay raw)?
5. **If (A) or (B):**
   - Which extensions get copied: the 10-entry `isImagePath` set or the 4 `SCREENSHOT_UPLOADABLE` types?
   - What size cap? `MAX_FILE_PREVIEW_BYTES` is 50 MB.
   - Does the paste of a Finder-copied file (rung 1) get the same treatment?
   - What is the copy's lifetime: kept forever like `screenshots/` today, or removed with the task?
6. **Is `BinaryFilePreview` for `isolation: "none"` tasks in protected folders in scope** for this fix?

## 5. Completeness inventory

**Callers and consumers**
- Direct: `AttachmentChips.tsx:178` (`ImageChip`), `SentFilesCard.tsx:111`, `MdImage.tsx:269`, all through `api.filePreviewUrl` (`src/mainview/lib/api.ts:2112`).
- `BinaryFilePreview.tsx:127` via `api.taskDiffBlobUrl` → `worktree.ts:2225` `readFileBytes`.
- Server readers: `server.ts:7809` (`openFileBytes`), `worktree.ts:2225` (`readFileBytes`).

**Click and open paths**
- `AttachmentChips.tsx:61-88` (missing short-circuit).
- `/open-path` and `/reveal-path` (`server.ts:7444, 7487`).
- `AttachmentDialogs.tsx` (`AttachmentNotFoundDialog`, `AttachmentOpenErrorDialog`).

**Entry points new code would be wired into**
- `/refs/pick` (`server.ts:7552`), `/refs/resolve` (`:7607`, app+cli, so check `callerOf(req)` before conferring provenance), `/refs/drag` (`:7620`).
- `/screenshots` (`:7673`) and `/attachments` (`:7732`) writers (`writeAttachmentAtomic`).
- `capture-refs.ts` rungs 1-3.
- `ReferencesPicker.tsx` (picker buttons) and `NewTaskForm`/`RunPanel` send paths (`RunPanel.tsx:3427, 3583`), and `orchestrator.ts:2688-2813` (launch prompt `appendReferences`).
- `ROUTE_POLICY` for any new route (`route-policy.ts:433-442`).

**Propagation surface**
- `AuthedBlobStatus` union + `statusForHttp` (`authed-blob.ts:30, 46`).
- `AuthedImg.onStatus` (`authed-img.tsx:40`).
- `TaskReference` (`src/shared/types.ts`).
- `isImagePath` / `contentTypeForPreviewPath` (`src/shared/attachments.ts`).
- `SCREENSHOT_UPLOADABLE` (`capture-refs.ts:14`).
- The CLI's `agetor send` (`cmdSend`, `src/cli/commands/lifecycle.ts:135`) builds the same block but never render thumbnails, so there is no TUI parity surface for previews.

**Existing data**
- Persisted user events and `tasks.refs` hold original protected-folder paths (this pipeline's rows are examples).
- Events stay raw, so no backfill: old messages rely on the UI fallback (or C/D).

**Docs and config that describe current behaviour**
- `docs/architecture/security.md:67` (D26(j) scope: list attachment chips explicitly).
- `docs/architecture/markdown-images.md`.
- `docs/plans/improve-image-attached-message-ui.md:17, 54, 64` (warning state = "no longer exists").
- `docs/plans/master-token-agent-read.md` D26(j).
- `docs/architecture/testing-seams.md` (`AGETOR_FAKE_PICK_REFS_DIR`).
- `docs/plans/non-image-file-folder-drop-refs.md` (drop ladder rationale).

**What the change would orphan:** nothing identified. Under (A), `/refs/pick` keeps returning original paths for non-images.

## 6. Runnability

- **Environment:** `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`. A fresh worktree needs `bun install`.
- **Start locally:** `bun run dev:hmr` (UI work) or `bun run dev` (requires `bun run build`). Data goes to `~/.agetor-dev`. Never point a branch build at prod `~/.agetor`.
- **Unit tests:**
  - `bun test src/bun/files-preview-endpoint.test.ts src/bun/core-file-read.test.ts src/mainview/lib/authed-blob.test.ts`
  - The full suite is `bun test`, plus `bun run typecheck`.
  - Known pre-existing failures: tmux-socket ×2 and a reconcile cancel on main.
- **E2E harness:**
  - Playwright, Chromium, headless backend per worker: `bun node_modules/@playwright/test/cli.js test e2e/<spec>` (not `bunx`), one run at a time.
  - Seams: `AGETOR_FAKE_PICK_REFS_DIR` drives `/refs/pick`, set by `e2e/fixtures.ts:690`. A `chmod 000` image reproduces the 403 `denied` path in both disclaim modes, the idiom at `files-preview-endpoint.test.ts:221`.
  - Siblings to copy from: `e2e/sent-files.spec.ts`, `e2e/markdown-images.spec.ts`.
  - There is no `AttachmentChips` e2e today.

## 7. Risks and blast radius

- **Security regression:** any in-process read keyed on data an agent can write (bubble text, `tasks.refs`, a DB mapping) reopens D26(j). Provenance must come from app-only native routes, or the bytes must be copied into a non-protected location and still read disclaimed.
- **Copy-on-pick (A):**
  - Changes what the agent receives for picked images, which is visible in every harness's prompt.
  - Adds storage under `dataDir` that no retention job cleans today.
  - Must run in the pick handler's process, while the user-intent grant applies (assumption 1).
  - Big files need a cap.
- **UI split:** `MdImage` relies on "any non-ok → next candidate", so keep the candidate walk and change only the final label and copy. `SentFilesCard` is the pattern to copy. `RunPanel` is a single long-lived instance, so new per-task state in a child needs the `[task.id]` reset (`docs/architecture/run-panel.md`).
- **Tests:** UI behaviour on a 403 is unpinned, so add an e2e: fake pick dir with a `chmod 000` png → chip shows the "preview unavailable" state, and a click reaches `/open-path` rather than the not-found dialog.
- **Platform:** headless or non-darwin cores read in-process (`disclaimEnabled()` false), so the bug is macOS-desktop-only and e2e must force the denied path with `chmod`, not TCC.

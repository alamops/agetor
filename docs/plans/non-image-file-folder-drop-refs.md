# Plan — Non-image file & folder drops attach path references

| Field | Value |
| --- | --- |
| Date | 2026-08-20 |
| Source | /implement task: "fix agetor not accepting dropping different file types than images…" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Flags | none |
| Gates | grilled + approved by owner (with modification: image drops unchanged) |
| Branch | fix/other-file-types-drop (existing agetor worktree branch) |
| Base SHA | 8a7e4b0 |

## 1. Objective & success criteria

Dropping any file (not just images) or a folder from Finder onto the New Task prompt or the Task Details (RunPanel) composer attaches a **reference to its original absolute path** (chip + `[basename]` marker + `Referenced files/folders:` bullet), exactly like the manual picker does. When the original path is unrecoverable: files fall back to a byte-copy under the data dir (like screenshots today); folders show a hint pointing at the folder picker (never copied).

Success = drop a `.txt`/`.pdf`/folder on either surface → correct ref chip appears; `bun run typecheck` green; `bun test` green.

## 2. Context & constraints (grounded)

- All 4 drop/paste surfaces (ReferencesPicker inline+expandable, NewTaskForm aside, RunPanel composer) funnel through `captureDroppedOrPastedItems` — `src/mainview/lib/capture-refs.ts:158`. One choke point fixes all.
- Generalized drop support was *intended* since PR #26 (`de72a89`): `extractFilePaths` reads `file://` URLs off the DataTransfer → `POST /refs/resolve`. **In the real WKWebView this channel yields nothing** — owner confirms non-image drops today hit the `{skipped}` branch and show the "Nothing to attach" hint (`capture-refs.ts:206`). Images only "work" via the blob-upload fallback (`POST /screenshots`, image-only by design, `server.ts:3847`).
- **Spike (measured, this machine, Darwin 25.5):** the Bun main process CAN read the macOS **drag pasteboard** (`NSPasteboard` named `"Apple CFPasteboard drag"`) via `bun:ffi` + `/usr/lib/libobjc.A.dylib` + AppKit `NSApplicationLoad()`, no compiled helper. `NSFilenamesPboardType` returns a plist XML containing the **absolute POSIX path(s)** of the last drag; `public.file-url` returns file-id URLs (`file:///.file/id=…`, would need NSURL resolution — we prefer the plist). The spike observed the owner's own failed repro (a dragged `.txt`) still on the pasteboard. Artifact: scratchpad `spikes/drag-pasteboard/read-drag-pb.ts`.
- Staleness: the webview `drop` event fires as the drag ends, so the drag pasteboard necessarily holds *this* drag. Belt-and-braces: cross-check returned basenames against the dropped `File` names when the DataTransfer carried any.
- `isTransientPath` (`capture-refs.ts:91`) must keep screenshot-thumbnail drags (paths under `/var/folders/...`) on the upload path — apply it to pasteboard-recovered paths too.
- **Pastes must NOT consult the drag pasteboard** (a paste is unrelated to the last drag → stale attach). The capture helper must learn its source kind.
- `refsFromPaths` (`server.ts:243`) is the existing normalizer (statSync → isDirectory, drops nonexistent) — reuse it.
- `/screenshots` conventions to mirror for the new generic upload: 25MB cap w/ Content-Length pre-check, unique timestamped filename, dataDir subfolder (`server.ts:3847-3893`).
- Do NOT touch `/screenshots` (image gate intentional) or `/files/preview` (thumbnail-only, image gate intentional).
- macOS-only is fine: releases are arm64 macOS by design. Non-darwin → pasteboard reader returns `[]`.

## 3. Approach & key decisions

1. **Primary channel (new): server-side drag-pasteboard read** — new module `src/bun/drag-pasteboard.ts` (FFI bridge, lazy dlopen, darwin-only) + route `POST /refs/drag` returning `refsFromPaths(pasteboardPaths)`. *Rests on spike evidence.* Chosen over: (a) Electrobun native drop API — doesn't exist; (b) copying bytes always — owner wants original paths.
2. **Fallback for path-less files: generic byte-copy upload** — new route `POST /attachments` (any content type, original filename preserved/sanitized/uniquified, `${dataDir}/attachments/`). Keeps non-Finder drag sources and pasted non-image blobs working as copies.
3. **Folders never copied** — unresolvable folder drops count as `skippedFolders` and surface a picker-pointing hint (owner decision).
4. **Image drops are UNCHANGED (owner decision at approval)** — image files recovered from the pasteboard are excluded from the ref set (`!isDirectory && isImagePath(path)` per `src/shared/attachments.ts`) so their `File` blobs continue through the existing `/screenshots` upload path exactly as today. The legacy `extractFilePaths` (`file://` URL) channel keeps its existing semantics untouched — it's dead in practice and changing it would churn passing tests for zero behavior change.
5. Keep the existing `file://`-URL extraction as first preference (it's free and would win if WebKit ever populates it); pasteboard is the second preference; blob upload third.

Risk noted: macOS pasteboard-privacy prompts currently target the *general* pasteboard, not the drag pasteboard (spike ran promptless). If a future macOS gates it, the copy fallback keeps drops functional.

## 4. Work breakdown — implementation tasks (one wave, file-disjoint)

**Contract fixed by this plan** (lets A/B/C run in parallel):
- `POST /refs/drag` → `{ refs: TaskReference[] }` (no body required; reads pasteboard, normalizes via `refsFromPaths`).
- `POST /attachments?name=<basename>` (raw bytes body) → `{ path, basename }`; 25MB cap; sanitize `name` to a basename (strip separators/`..`), fallback `attachment`; uniquify on collision; 400 empty body, 413 oversize.
- `api.dragRefs(): Promise<TaskReference[]>`, `api.uploadAttachment(blob, name): Promise<{path, basename}>`.
- `captureDroppedOrPastedItems(source, opts?)` where `opts = { kind: "drop"|"paste", uploader?, resolver?, dragRefs?, attachmentUploader? }` — **breaking signature change**; `kind` defaults to `"drop"` only if keeping old positional args is impossible; callers pass it explicitly. `CaptureResult` gains `skippedFolders: number`.
- Client capture order (drop): extractFilePaths → (if empty & DataTransfer had files) `dragRefs()` filtered by basename-match (when collected names exist), `isTransientPath`, and **image exclusion** (`!ref.isDirectory && isImagePath(ref.path)` → excluded so the blob uploads as today). Collected files whose name matched an accepted pasteboard ref are consumed; the rest run the per-file fallback: image→screenshot upload (unchanged), non-image file→attachment upload, folder→`skippedFolders++`. Paste: never calls `dragRefs()`; non-image blob now uploads via `/attachments` instead of skipping.

- **T1 (bun side)** — files: `src/bun/drag-pasteboard.ts` (new), `src/bun/server.ts`. FFI module with pure, exported `parseFilenamesPlist(xml): string[]` + `readDragPasteboardPaths(): string[]` (try/catch → `[]`, non-darwin → `[]`, injectable override for tests) + the two routes per contract. Acceptance: routes wired with `authed` + `corsHeaders` like siblings.
- **T2 (mainview logic)** — files: `src/mainview/lib/capture-refs.ts`, `src/mainview/lib/api.ts`. Implement contract above; preserve sync-before-await DataTransfer discipline; keep console.warn breadcrumb.
- **T3 (callers)** — files: `src/mainview/components/kanban/ReferencesPicker.tsx`, `NewTaskForm.tsx`, `RunPanel.tsx`. Pass `kind` at each call site (drop vs paste); render folder-specific hint when `skippedFolders > 0` ("Folders can't be attached from this source — use the folder picker."); keep existing hints otherwise.

## 5. Work breakdown — test tasks

- **TT1** — files: `src/bun/drag-pasteboard.test.ts` (new): `parseFilenamesPlist` fixtures (single, multiple, empty, malformed → []); `readDragPasteboardPaths` returns array without throwing; injectable override works.
- **TT2** — files: `src/bun/attachments-endpoint.test.ts` (new, mirrors `refs-endpoint.test.ts` style): `/attachments` name sanitization (`../evil` → basename), uniquification, 400/413, bytes round-trip; `/refs/drag` with injected pasteboard override (real file + folder + nonexistent + transient path passthrough — transient filtering is client-side, server returns it).
- **TT3** — files: `src/mainview/lib/capture-refs.test.ts` (extend): drop consults injected `dragRefs` only when no `file://` URLs; basename validation rejects stale pasteboard entries; folder-only drop (no collected names) accepts pasteboard refs; transient pasteboard path falls through to upload; **image pasteboard ref is excluded and its blob still goes through the screenshot uploader (image behavior unchanged)**; paste never calls `dragRefs`; non-image blob → attachment uploader; folder blob → `skippedFolders`.
- **E2e: not applicable** — real Finder `file://`/pasteboard drags can't be simulated by Playwright's synthetic DataTransfer; coverage stays at the unit/integration layer (existing repo convention for this feature area). Manual verification recipe: `bun run dev:hmr` (data dir `~/.agetor-dev`), drag a `.txt` + a folder onto both surfaces.

## 6. Execution waves

- Wave 1: T1 ∥ T2 ∥ T3 (file-disjoint; contract pinned above). Checkpoint: typecheck + commit.
- Wave 2 (tests): TT1+TT2 (one agent, bun side) ∥ TT3 (mainview). Checkpoint: full `bun test` + commit.
- Review (Phase 5, opus) between waves 1 and 2 per skill order.

## 7. Blast radius & risks

- `captureDroppedOrPastedItems` signature change → all 4 call sites updated in T3 (same wave).
- Image drops deliberately unchanged (owner decision) — no interaction with the screenshot/thumbnail/dedup pipeline.
- New FFI in the Bun process: lazy-loaded, darwin-guarded, try/catch → `[]`; a failure degrades to today's behavior (copy/skip), never crashes the server.
- Pasteboard staleness → mitigated by drop-only consultation + basename cross-check.
- `${dataDir}/attachments/` is a new owned namespace; nothing deletes it (screenshots/ has the same property).

## 8. Open questions / assumptions

- Assumes WKWebView exposes dropped folders as DataTransfer items (name available for basename match); if a folder drop carries zero collected Files, we accept pasteboard refs unvalidated (still drop-scoped). Low risk.
- Pasteboard-privacy: drag pasteboard reads currently prompt-free (spike-verified on this exact OS build); fallback path covers a future regression.

# Plan — Image-attached message UI: dedup + attachment thumbnails

| Field | Value |
| --- | --- |
| Date | 2026-07-29 |
| Source | /implement request: fix duplicate rendering of image-attached user messages; add attachment thumbnails with click-to-open and a missing-file fallback dialog |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/improve-image-attached-message |
| Base SHA | ce9177b |
| Mode | **Autonomous** — grill + plan-approval gates bypassed (user not available mid-task); all assumptions logged in §8 |

## 1. Objective & success criteria

1. A user message with an image attachment renders **once** in the task stream (today it renders as three rows: the live echo, claude's JSONL twin with `[Image #N]`, and a `[Image: source: …]` status breadcrumb).
2. Referenced attachments render as **chips below the message body** instead of a raw `Referenced files/folders:` text block — image refs get a real **thumbnail**, other refs keep the house icon-chip idiom.
3. Clicking a thumbnail/chip **opens the file** with the OS default app.
4. If the file no longer exists, the thumbnail slot shows a **warning state** (icon + basename), and clicking it (or a failed open) surfaces an **"Attachment not found"** dialog.
5. `bun run typecheck` green; `bun test` green; zero behavior change for ordinary messages without attachments.

## 2. Context & constraints (grounded findings)

Captured from a live repro (prod DB run `c230916e…`, JSONL session `cd1db86f…` under `~/.agetor/harnesses/<alias>/projects/…`):

- **Live copy** (agetor records at send): `[screenshot-….png] I got this\n\nReferenced files/folders:\n- /Users/…/screenshots/screenshot-….png`
  Emitted at `orchestrator.ts:827` (task creation), `orchestrator.ts:1549` (fold-while-busy), `orchestrator.ts:1584` (idle follow-up).
- **JSONL twin** (claude's TUI rewrite): text block = `[Image #1][screenshot-….png] I got this\n\nReferenced files/folders:\n-` — `[Image #N]` prepended (N is **session-wide**, e.g. `[Image #3]` for the 2nd message), and the image path is stripped from the bullet leaving a bare `-`. Emitted at `claude-tmux.ts:808-809` (human-turn text blocks). Image blocks silent (`claude-tmux.ts:811`).
- **Third row**: claude also injects an `isMeta: true` user entry with text `[Image: source: /abs/path]`, which the mapper demotes to a `status` breadcrumb (`claude-tmux.ts:748-772`) — the uppercase caption seen in the screenshot.
- **Dedup**: client-side only — `eventDedupKey` (`src/mainview/lib/event-dedup.ts:44-48`) keys user events on `user|runId|canonicalizeUserText(normalized).slice(0,200)`. The `[Image #N]` + stripped-bullet rewrite makes the two keys diverge → duplicate bubble. Both copies are persisted server-side by design (precedent: #27 CR/LF fix, #68 durable-set fix, #122 XML canonicalization).
- **Refs block parsing already exists**: `splitReferences` in `src/mainview/lib/command-message.ts:86-110` (strict trailing-paragraph parse; bare `-` bullet currently fails the parse → whole block unsplit).
- **Rendering**: `UserMessageBlock` in `src/mainview/components/kanban/RunPanel.tsx:2689-2821`. Command branch already renders reference chips (`:2778-2795`); ordinary branch (`:2797-2807`) renders raw text incl. the refs block via ReactMarkdown — the gap. Status events render via `case "status"` at `:2460`.
- **No route serves image bytes** to the webview today; `POST /screenshots` is write-only (`server.ts:3441-3487`). `isAuthorized()` (`server.ts:251-256`) already accepts `?token=` (used by SSE/WS) → an `<img src>` can authenticate. No CSP blocks localhost images. `POST /open-path` (`server.ts:3335-3367`) opens any absolute path with the OS default app and 404s with `{error: "path does not exist: …"}` when missing.
- **Image extension canon**: `IMAGE_PATH_RE` in `claude-tmux.ts:4853-4854` — `png|jpe?g|gif|webp|svg|bmp|ico|avif|heic` — kept in sync by comment with `IMAGE` in `src/mainview/lib/file-icons.tsx`. This is the set claude's TUI actually inlines/rewrites.
- **Testing conventions**: no React component tests — parsing/dedup logic goes in React-free `lib`/`shared` modules with `bun:test` suites; endpoint tests follow `refs-endpoint.test.ts` idiom (top-level `AGETOR_DATA_DIR`/`AGETOR_API_PORT`, `beforeAll` dynamic imports + `startApiServer()`).
- **UI conventions**: shared `<Dialog>` primitive (focus-trap/stacking), `useConfirm()` for promise-driven confirms, chip idiom `inline-flex items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground`, lucide icons `size-3/4`, semantic tokens only.

## 3. Approach & key decisions

1. **One shared pure module owns the attachment grammar** — `src/shared/attachments.ts` (no runtime imports from either process; both sides import it, like `shared/refs.ts`). It defines: image-extension detection, the `[Image #N]` placeholder regex + stripper, the `[Image: source: …]` meta-entry matcher, and `canonicalizeAttachmentText()` which reduces BOTH copies of an image-attached send to one canonical form (strip placeholders; in a trailing refs block, drop bullets that are bare `-` **or** an image path; drop the heading if no bullets remain). Identity for text with no placeholders and no image/bare bullets. *Alternative considered*: patching only `canonicalizeUserText` in `command-message.ts` — rejected because the bun side (breadcrumb suppression) and mainview side (dedup + rendering) both need the same grammar, and `command-message.ts` is mainview-scoped.
2. **Dedup stays client-side** (house precedent) — compose the new canonicalizer into `eventDedupKey`'s user branch: `canonicalizeAttachmentText(canonicalizeUserText(normalizeForKey(data)))`.
3. **Kill the third row at the source** — in the `isMeta` demotion path of `mapParsedEventToChunks`, an entry matching `[Image: source: …]` emits nothing (the live message already shows the attachment; with thumbnails it's pure noise). Also filter it at render time so *historical* persisted rows disappear too.
4. **Thumbnails via a new authed read route** — `GET /files/preview?path=<abs>` serving image bytes (extension-gated, existence-checked, `?token=` auth). Serving *any* absolute image path is the same trust level as the existing `POST /open-path` (opens any path) in an app whose agents run unsandboxed with the user's shell privileges; the per-launch bearer token is the boundary. Restricting to `~/.agetor/screenshots/` was rejected — Finder-dragged refs (e.g. `~/Desktop/…png`) legitimately live elsewhere.
5. **Rendering**: extract refs for ordinary messages with the existing `splitReferences`, render the body without the refs block, and mount a new `AttachmentChips` component (thumbnail for image refs, icon chip otherwise) used by BOTH the ordinary and the command branches. Click → `POST /open-path`; load-error or open-404 → "Attachment not found" dialog.
6. **Tolerate the twin shape defensively in rendering**: strip `[Image #N]` from the rendered body. Post-dedup the live copy (which has no placeholders) renders because it arrives/replays first (lower `run_events.id`), but if a twin ever renders alone it should still look sane.

## 4. Work breakdown — implementation tasks

**T0 — shared attachment grammar** *(wave 1)*
Files owned: `src/shared/attachments.ts` (new), `src/shared/attachments.test.ts` (new).
Exports: `isImagePath(path)`, `IMAGE_PLACEHOLDER_RE`, `stripImagePlaceholders(text)`, `imageSourceMetaPath(text): string | null`, `canonicalizeAttachmentText(text)`.
Acceptance: golden tests using the exact captured live/twin shapes converge to one string; identity on ordinary text, non-image refs, and command XML; mixed image+dir refs keep the dir bullet. Tests land with this task (deviation from phase 6 — the canonicalization contract IS the spec).

**T1 — preview endpoint** *(wave 2)*
Files owned: `src/bun/server.ts`.
`GET /files/preview?path=<abs>`: token-authed (header or `?token=`), 400 non-absolute or non-image extension, 404 missing file, else bytes with correct `Content-Type` + `Cache-Control: private, max-age=300`. Available headless (no native host requirement). Route follows the object-style `routes` API.

**T2 — breadcrumb suppression** *(wave 2)*
Files owned: `src/bun/claude-tmux.ts`.
In the `isMeta === true` branch: if the joined text matches `imageSourceMetaPath` → emit nothing, `return { endOfTurn: false, lineUuid: uuid }`.

**T3 — webview dedup + attachment UI** *(wave 2)*
Files owned: `src/mainview/lib/event-dedup.ts`, `src/mainview/lib/api.ts`, `src/mainview/components/kanban/AttachmentChips.tsx` (new), `src/mainview/components/kanban/RunPanel.tsx`.
- `event-dedup.ts`: compose `canonicalizeAttachmentText` into the user key.
- `api.ts`: `filePreviewUrl(path)` builder (mirrors the SSE `?token=` pattern).
- `AttachmentChips.tsx`: props `{ references: string[] }` (dirs keep trailing `/`). Image ref → thumbnail button (`<img>` ~`h-16 max-w-40 rounded-md border border-border/60 object-cover`, `title` = full path); `onError` → warning chip (lucide `ImageOff`, amber-toned, basename). Non-image ref → existing icon-chip idiom as a button. Click: known-missing → not-found dialog; else `api.openPath` and on rejection → same dialog. Dialog: `useConfirm()` if it renders acceptably as single-action info, else a small local `<Dialog>` (header idiom from DiffDialog) saying the attachment was not found, showing the full path.
- `RunPanel.tsx`: ordinary branch — normalize CRs, `splitReferences`, body = `stripImagePlaceholders(args)` through ReactMarkdown, chips below; command branch — replace inline chip map with `AttachmentChips`; `renderEvent` `status` case — return nothing for `imageSourceMetaPath` matches.

## 5. Work breakdown — test tasks (phase 6)

**TT1** (owns `src/bun/files-preview-endpoint.test.ts`, new): endpoint auth (401 no token), 400 relative/non-image, 404 missing, 200 + content-type for a real temp PNG; `refs-endpoint.test.ts` idiom. Covers T1.
**TT2** (owns `src/bun/claude-tmux.test.ts`): `mapJsonlEventToChunks` — isMeta `[Image: source: …]` entry emits no chunks; other isMeta entries still emit status. Covers T2.
**TT3** (owns `src/mainview/lib/event-dedup.test.ts`): live + twin (exact captured shapes) collapse to one accept; ordinary-message keys unchanged; command-XML-with-image-refs twin collapses. Covers T3 dedup.

## 6. Execution waves

- **Wave 1**: T0 alone (everything downstream imports it). Checkpoint: typecheck + `bun test src/shared/attachments.test.ts`, commit.
- **Wave 2**: T1 ∥ T2 ∥ T3 (file-disjoint). Checkpoint: typecheck, commit.
- **Phase 5**: opus review of `git diff ce9177b...HEAD`.
- **Phase 6**: TT1 ∥ TT2 ∥ TT3 (file-disjoint). Phase 7: full `bun test` (haiku). Phase 8 as needed.

## 7. Blast radius & risks

- `eventDedupKey` affects ALL user-message dedup → canonicalizer must be strict-identity on non-matching text (mirrors `canonicalizeUserText`'s contract); TT3 guards regressions. Over-collapse of two same-text-different-image sends in one run is accepted (precedent: identical sends already intentionally collapse — `event-dedup.ts:36-42`).
- New read endpoint = new file-read surface; bounded by token auth + image-extension gate + 127.0.0.1 bind; equal trust to `/open-path`.
- Claude may place `[Image #N]` mid-text at paste position (observed at start); stripper is position-agnostic.
- `[Image: source:]` suppression loses the JSONL-side record of the original path in the stream; the live copy retains it. Codex path untouched.
- Existing persisted duplicate rows are collapsed at render time by the new key — history self-heals without migration.

## 8. Open questions / assumptions (autonomous mode)

1. Serving any absolute image path (not just the screenshots dir) via the preview route — assumed acceptable given `/open-path` precedent and the app's no-sandbox philosophy.
2. Thumbnails added in the **stream** only; the composer's `ReferencesPicker` chips stay icon-only (follow-up candidate).
3. The not-found dialog is informational (single OK action), no "remove ref" affordance.
4. Historical `[Image: source: …]` status rows are hidden at render (no DB migration/cleanup).
5. Thumbnail size ~4rem tall, object-cover — reviewer/user can bikeshed later.

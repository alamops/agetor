# Plan — Binary file previews (images & PDFs) in diff views

| Field | Value |
| --- | --- |
| Date | 2026-08-12 |
| Source | /implement — "load binary files in the Task Details Diff Modal and Git Integration diffs; images and PDFs old vs new side by side, styled" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/load-binary-files-on-diff-modal-and-git |
| Base SHA | 2a4f1a1f3eb8a88aae8bd9581592a5c109d87a85 |
| Mode | Autonomous — Phase 2 grill and Phase 3 approval gates self-resolved; assumptions logged in §8 |

## 1. Objective & success criteria

When a diff contains a binary file that is an image or a PDF, both diff surfaces render an
old-vs-new side-by-side preview instead of the current italic "Binary file — no textual diff."
placeholder:

- **Task Details Diff Modal** (`DiffDialog.tsx`) — worktree diffs.
- **Git Integration modal PR diff** (`GitHubDialog.tsx` → `PullDiff` → `DiffFileBlock`) — GitHub PRs in v1; GitLab/Bitbucket keep the placeholder (§8).

Success = images render 2-up with dimension labels, checkerboard behind transparency, and
one-sided panes for added/deleted files; PDFs render 2-up paged canvases (pdf.js) with synced
page controls; both themes look right using semantic tokens; oversized/missing blobs degrade to
a friendly state; diff line-selection machinery is untouched; typecheck + unit + e2e green.

## 2. Context & constraints (Phase 1 findings)

- `TaskDiff`/`DiffFile` (src/shared/types.ts:1672-1709) is the shared shape for task diffs AND
  all provider PR diffs; `binary: true`, `hunks: ""` for binaries (src/bun/git-diff.ts:54,84).
- Task diff: `getTaskDiff` (src/bun/worktree.ts:847) diffs `task.baseRef ?? "HEAD"` against the
  working tree in `task.worktreePath` (isolation=worktree) or `HEAD` in `task.workdir`
  (isolation=none). Untracked files come via `git diff --no-index /dev/null <f>` → status added.
- PR diff: `getGitHubPullDiff` (src/bun/github.ts:1655) fetches the whole-PR `.diff` media type
  (a three-dot diff, i.e. **against the merge base**) → `parseGitDiff`. No per-file shas reach
  the client. The Bun side holds the token (`githubToken`, github.ts:843); `fetchGitHub`
  (github.ts:1011) is the generic fetch helper; Contents-API precedent at github.ts:718,1907.
- Byte transport precedent: `GET /files/preview` (src/bun/server.ts:3725) — token in query for
  `<img>` (isAuthorized accepts `?token=`, server.ts:273-279), extension allowlist via
  `isImagePath` (src/shared/attachments.ts:57), `st.isFile()`, `nosniff`, ETag. Fleet decision
  3b94b2ec records the rationale; mirror the guardrails.
- Binary placeholders to replace: DiffDialog.tsx:828-829 (FileBlock binary branch) and
  GitHubDialog.tsx:8958-8966 (DiffFileBlock binary branch). Both live OUTSIDE the DiffBody row
  list — previews must stay out of the `data-diff-path`/`data-diff-index` row-index space so
  drag/shift-click selection math is untouched.
- WKWebView (`bundleCEF: false`) inline `<embed>`/`<iframe>` PDF rendering is unreliable →
  pdf.js canvas rendering; Vite worker wiring via `?url` import (pdfjs-dist v6,
  `pdf.worker.min.mjs`). Lazy-load via dynamic import so board load cost is zero.
- UI conventions: semantic tokens only (`text-success`/`text-danger`/`bg-muted/40`…), collapsible
  file blocks, sticky header pattern in GitHubDialog (two-layer opaque bg), dialog primitives in
  components/ui/.
- Tests: bun test colocated `*.test.ts` (worktree.test.ts, git-diff, diff-rows/diff-selection,
  /files/preview tests); Playwright e2e in `e2e/` with per-worker backends (e2e/fixtures.ts),
  run via `bunx playwright test`; no React component-test harness.

## 3. Approach & key decisions

1. **One shared preview component** (`BinaryFilePreview`) consumed by both dialogs — the two
   renderers already duplicate the placeholder; do not add a third copy. (Reasoning + fleet
   knowledge 1821c945.)
2. **Bytes over HTTP routes, not JSON/base64** — mirrors `/files/preview` decision. Images use
   `<img src>` with `?token=`; PDFs use `fetch` with `Authorization: Bearer` → ArrayBuffer →
   pdf.js `getDocument({ data })` (no token in URL where a fetch is possible anyway).
3. **Task diff blobs**: new route `GET /tasks/:id/diff/blob?path=<repo-rel>&side=old|new`.
   old = `git show <resolvedBase>:<path>` in the task's git cwd; new = on-disk file in that cwd
   (that is literally what `git diff` compared). isolation=none → cwd=workdir, base=HEAD.
4. **GitHub PR blobs**: new route `GET /github/pull-blob` (params mirror `/github/pull-diff`,
   plus `path`, `side`). Server resolves pull → head sha + base; **old side anchors at the
   merge base** (compare API, cached in-memory per (host,repo,number,headSha)) because the
   `.diff` the UI shows is a three-dot diff — `base.sha` would show a wrong "old" when the base
   branch moved. Blob bytes via Contents API `Accept: application/vnd.github.raw` at a ref.
   Dispatch through `git-host.ts` `pullBlob`; GitLab/Bitbucket return `unsupported` in v1.
5. **Previewable = extension-based**: images reuse shared `IMAGE_EXTENSIONS`; add `pdf`.
   New shared helper `binaryPreviewKind(path): "image" | "pdf" | null` in
   src/shared/attachments.ts. Other binaries keep today's placeholder.
6. **Caps & guardrails**: `MAX_BLOB_PREVIEW_BYTES = 20_000_000` on both routes (413 → UI
   "too large to preview"); extension allowlist on both routes (keeps them from becoming
   generic file/blob readers, per fleet decision); repo-relative path validation (reject
   absolute + `..`); `nosniff`; ETag (old side keyed by resolved sha:path → long cache; new
   side size-mtime → must-revalidate, matching /files/preview).
7. **PDF UX**: per-side paged canvas, page controls synced across old/new (single control bar:
   ‹ page n / max(oldPages,newPages) ›), rendered at pane width; loading skeleton + error state.
   pdfjs-dist pinned, dynamic-imported, worker via `?url`.
8. **Image UX** (GitHub 2-up): checkerboard background, `naturalWidth×naturalHeight` caption,
   Before/After header chips (danger/success tokens), one-sided layout for added/deleted,
   `onError` → missing state (AttachmentChips precedent).

## 4. Work breakdown — implementation

**Contracts (agreed up front so wave-1 tasks compile together):**

```ts
// src/shared/attachments.ts
export type BinaryPreviewKind = "image" | "pdf";
export function isPdfPath(p: string): boolean;
export function binaryPreviewKind(p: string): BinaryPreviewKind | null;

// src/bun/git-host.ts
export type PullBlobResult =
  | { ok: true; bytes: Uint8Array; contentType: string }
  | { ok: false; error: string; status?: number }; // status 413 for too-large, 404 missing, 501 unsupported provider
pullBlob(opts: PullBlobOpts): Promise<PullBlobResult>  // PullBlobOpts mirrors pullDiff's opts + { path: string; side: "old" | "new" }

// src/bun/worktree.ts
export async function getTaskDiffBlob(task: Task, relPath: string, side: "old" | "new"):
  Promise<{ ok: true; bytes: Uint8Array; etag: string } | { ok: false; error: string; status: number }>;

// src/mainview/lib/api.ts
taskDiffBlobUrl(taskId: string, path: string, side: "old" | "new"): string   // ?token= for <img>
pullBlobUrl(opts /* same identifying params getGitHubPullDiff uses */ & { path; side }): string
fetchPdfBytes(url: string): Promise<ArrayBuffer>  // Bearer-header fetch, throws typed TooLarge/NotFound
```

| ID | Goal | Owns (exact files) | Deps |
| --- | --- | --- | --- |
| T1 | Shared previewable helpers; task-blob server support: `getTaskDiffBlob` (git show + disk read, path validation, 20MB cap, etag) and BOTH routes in server.ts (`/tasks/:id/diff/blob`, `/github/pull-blob` — the latter written against T2's contract); extend content-type map with pdf | src/shared/attachments.ts, src/bun/worktree.ts, src/bun/server.ts | — |
| T2 | GitHub blob fetch: pull detail → head/base, merge-base resolution w/ in-memory cache, Contents API raw fetch w/ cap; `pullBlob` dispatch (gitlab/bitbucket → 501 unsupported) | src/bun/github.ts, src/bun/git-host.ts | — |
| T3 | `BinaryFilePreview` component (image 2-up + pdf 2-up w/ synced pager, all states: loading/missing/too-large/one-sided), pdf.js lazy loader, api.ts url/fetch helpers, add pdfjs-dist dep | src/mainview/components/kanban/BinaryFilePreview.tsx (new), src/mainview/lib/pdf.ts (new), src/mainview/lib/api.ts, package.json (+ lockfile via bun install) | — |
| T4 | Wire preview into DiffDialog FileBlock binary branch (kind-gated; keep placeholder for non-previewable) | src/mainview/components/kanban/DiffDialog.tsx | wave 1 |
| T5 | Wire preview into GitHubDialog DiffFileBlock binary branch: thread provider/repo/number identifiers from GitHubItemDetail → PullDiff → DiffFileBlock; GitHub-only gate, others keep placeholder | src/mainview/components/kanban/GitHubDialog.tsx | wave 1 |

## 5. Work breakdown — tests

| ID | Goal | Owns | Covers |
| --- | --- | --- | --- |
| T6 | Unit: attachments kind helpers; `getTaskDiffBlob` against a temp git repo (modified/added/deleted/renamed binary, traversal + cap + missing rejections); `/tasks/:id/diff/blob` route (auth, allowlist, content-type, 413) following the existing /files/preview test style; github pull-blob unit only if fetch is cleanly mockable per existing github.ts test conventions | src/shared/attachments.test.ts (new or extend), src/bun/worktree.test.ts, src/bun/server.test.ts (or the file housing /files/preview tests) | T1, T2 |
| T7 | e2e (Playwright, extends e2e/fixtures.ts pattern): temp git repo with a committed PNG modified in the working tree → create isolation=none task via API → open Task Details → Diff modal → assert 2-up images render (both `<img>` loaded, checkerboard/dimension caption present); PDF variant asserting canvases render | e2e/binary-diff.spec.ts (new) | T1, T3, T4 |

**E2e applies**: user-visible flow crossing webview→API→git; harness exists (per-worker
backends). GitHub-PR-side e2e is NOT covered (needs a live GitHub PR) — covered by unit tests
+ manual verification instead; recorded as an open item.

## 6. Execution waves

- Wave 1 (parallel): T1, T2, T3 — file-disjoint (server.ts owned solely by T1; api.ts solely by T3).
- Wave 2 (parallel): T4, T5 — each owns exactly one dialog file.
- Review (Phase 5) → Wave 3 (parallel): T6, T7 (disjoint test files).
- Phase 7: `bun run typecheck`, `bun test`, `bunx playwright test`.

## 7. Blast radius & risks

- DiffDialog selection machinery: previews render outside DiffBody rows — no `data-diff-index`
  rows added, so drag/shift-select math untouched. Verify in review.
- GitHubDialog is a very large file with a view union + resetComposers choke point; T5 adds no
  composer-like state, so no resetComposers change — only prop threading into sibling sections.
- New deps: pdfjs-dist only (webview-side). No native binaries, no Electrobun packaging impact
  beyond Vite bundle (mitigated by dynamic import + `?url` worker asset).
- pdf.js on WKWebView: pdf.js supports Safari; if the modern build misbehaves on WKWebView,
  fall back to `pdfjs-dist/legacy`. e2e validates our wiring in Chromium, not WKWebView itself —
  manual check in the real app recommended post-merge.
- Security posture: routes are token-gated, extension-allowlisted, size-capped, path-validated —
  equal trust to /files/preview per fleet decision 3b94b2ec.
- GitHub API rate: +≤2 requests per blob side (merge-base cached per PR-head); acceptable for
  modal-scoped, user-initiated views.

## 8. Open questions / assumptions (autonomous mode)

1. GitLab/Bitbucket PR previews deferred to a follow-up; they keep today's placeholder (shared
   component makes wiring later small). — assumption
2. Old side of PR previews anchors at the merge base (correctness over the cheaper base.sha). — decision
3. 20MB per-blob preview cap. — assumption
4. PDF viewer = synced paged canvases (no zoom/thumbnails in v1). — assumption
5. SVG previews allowed (already in IMAGE_EXTENSIONS; served with nosniff as today). — assumption
6. No new caching layer beyond HTTP ETags; blobs load lazily when a binary file block is
   expanded and visible. — assumption

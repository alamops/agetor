# Plan — Render markdown images in agent transcripts

| Field | Value |
| --- | --- |
| Date | 2026-09-09 |
| Source | `/implement image rendering in cursor harness` + screenshot `~/.agetor/screenshots/screenshot-2026-09-09_23-27-17-9215ca3a.png` (a cursor-agent transcript whose `![alt](/tmp/…png)` screenshots rendered as broken-image boxes) |
| Config | AGENTS_CONFIG.yml (balanced: investigate/implement/tests sonnet, review opus, test-running haiku, planning self) |
| Flags | none |
| Gates | grilled + approved by owner (Phase 2 answers in §8) |
| Branch | `feature/cursor-image-rendering` (agetor-created; already checked out) |
| Base SHA | `c652464` (release v0.1.7), clean tree |

## 1. Objective & success criteria

When an agent's markdown output contains an image reference that points at a file on this machine, the run panel renders the actual image instead of the browser's broken-image glyph.

Done means:

1. `![alt](/abs/path.png)` (cursor's ground-truth shape), `![alt](docs/shot.png)` (Claude Code's ground-truth shape, resolved against the task's worktree then workdir), and `![alt](file:///abs/path.png)` all render as a real inline image, served through the existing token-gated `GET /files/preview`.
2. A rendered image is capped at 24rem tall / container width, shows its alt text as a caption + tooltip, and a click opens it with the OS default app (same path as sent-files tiles and attachment chips, same not-found / couldn't-open dialogs).
3. A reference that can't render — missing file, non-image extension (`.pdf`), a relative path with no task roots, or a `src` react-markdown blanked (`data:`, `C:\…`) — degrades to a labeled chip, never a broken-image glyph.
4. The override applies to every markdown surface in the webview: assistant + user bubbles, tagged-message segments, claude's plan-approval preview, the plan dialog, and GitHub PR/issue/comment bodies. Remote `https://` images keep loading exactly as today, plus the same sizing cap.
5. The three byte-serving routes (`/files/preview`, `/tasks/:id/diff/blob`, `/github/pull-blob`) answer with a `Content-Security-Policy: sandbox; default-src 'none'` header so the "img-only consumption" mitigation for agent-writable SVG is enforced by the response, not by convention.
6. Unit tests cover the classifier/transform and the fake-driver scenario; a Playwright spec proves the real assistant-stream path (via a new fake-driver prompt marker) and the user-bubble path end to end. Typecheck, `bun test`, and the affected e2e specs are green.

## 2. Context & constraints (grounded)

- **Ground truth from the local DB** (`~/.agetor/agetor.sqlite`, read-only query): the cursor run's `assistant` event is plain markdown — `![LAN host PARTY](/tmp/rby_mmo_e2e_review/mmo/host-party-menu.png)` — absolute POSIX paths, files still on disk. Six claude-code assistant events in the same DB use **relative** paths (`![…](docs/screenshots/servers-autojoin.png)`). So the fix is harness-agnostic and relative resolution is a real requirement.
- **All drivers funnel into one renderer.** cursor (`src/bun/cursor-tmux.ts:158-164` joins only `type:"text"` blocks), codex, gemini, fx and claude all emit joined text on the `assistant` stream → `RunEventList` (`RunPanel.tsx:4342`) → `AssistantBlock` (`RunPanel.tsx:4852-4859`) → `ReactMarkdown` with `ASSISTANT_MD_COMPONENTS`. No structured image blocks exist on cursor's `stream-json` (official docs: `assistant.message.content[]` is `type:"text"` only). Claude's `type:"image"` content blocks are a separate, unrendered `[image]` placeholder (`claude-tmux.ts:1300-1305`) — out of scope, §9.
- **react-markdown 10.1.0** (`node_modules/react-markdown/lib/index.js:346-385, 421-444`): `urlTransform` is applied to the hast tree **before** `toJsxRuntime`, so a `components.img` override receives the already-transformed `src`. `defaultUrlTransform` returns colon-less values (absolute + relative paths) unchanged and blanks anything whose scheme isn't `https?|ircs?|mailto|xmpp` — `file://…`, `data:…`, `C:\…` all arrive as `src=""`. `file://` support therefore needs a custom `urlTransform`; nothing inside the component can recover the raw value.
- **Component maps**: `USER_MD_COMPONENTS` / `ASSISTANT_MD_COMPONENTS` (`md-components.tsx:139-153`) override only `a`/`code`/`pre`; `GH_MD_COMPONENTS` (`GitHubDialog.tsx:171-177`) is a separate map with the same shape. No consumer passes `urlTransform`. `ReactMarkdown` call sites: `RunPanel.tsx:4831` (user), `:4855` (assistant), `:6323` (plan-approval preview inside `TmuxPromptCard`); `PlanDialog.tsx:395`; `MessageSegments.tsx:194, 264`; `GitHubDialog.tsx:6439, 6553, 6647, 6969` + the ad-hoc suggestion map at `:9204-9244` (falls back to `GH_MD_COMPONENTS`).
- **Task roots**: `pathRoots = [task.worktreePath, task.workdir]` (`RunPanel.tsx:2648`) reaches `RunEventList` (`:4142-4146`, currently "display-only") and `UserMessageBlock` only; `AssistantBlock` has no task context. `PlanDialog` receives `task` directly (`PlanDialog.tsx:95`). `GitHubDialog` has no task.
- **Reusable plumbing**: `api.filePreviewUrl(path)` (`api.ts:1486`), `api.openPath({path, taskId})` (`/open-path` resolves a relative path against `worktreePath ?? workdir`, 404 when missing, 501 headless), `api.openExternal`, `isImagePath` / `IMAGE_EXTENSIONS` (`src/shared/attachments.ts:44-60`), `iconForRef` / `refBasename` (`src/mainview/lib/file-icons.tsx`), `AttachmentNotFoundDialog` / `AttachmentOpenErrorDialog` (`AttachmentDialogs.tsx`, closed while `path === null`). `ImageChip` (`AttachmentChips.tsx:135-174`) and `SentFilesCard`'s `Tile` are the house idiom: `<img src={api.filePreviewUrl(p)} loading="lazy" decoding="async" onError=…>`, warning-tone `ImageOff` chip when missing, click → `openPath`, 404 → not-found dialog, anything else → open-error dialog.
- **`/files/preview`** (`server.ts:4292-4353`): absolute path + `isImagePath` + regular-file checks, ETag/304, `x-content-type-options: nosniff`, `cache-control: private, max-age=0, must-revalidate`. No CSP header anywhere in `server.ts`. Trust posture (comment `:4284-4291`): same tier as `/open-path`; two prior plans (#172, #218) explicitly declined further hardening. Sibling byte routes with the same `nosniff` line: `:992` (`/github/pull-blob`) and `:3764` (`/tasks/:id/diff/blob`).
- **`.agetor-md` CSS** (`index.css:145-195`) has no `img` rule. Gotchas on record: the owl spacing rule `.agetor-md > * + *` is defeated by wrapper divs and by per-element margin resets — the image override must return inline content (`<img>`, `<span>`, `<button>`), never a `<div>` inside the markdown `<p>` (also a DOM-nesting warning).
- **Path folding**: `UserMessageBlock` runs `shortenTaskPaths` (`src/mainview/lib/shorten-task-paths.ts`) over user text, folding absolute paths under the task roots to the `@rel` mention form. If a user bubble carries `![x](/worktree/shot.png)` that becomes `![x](@shot.png)` before rendering — the classifier must treat a leading `@` on a relative `src` as that mention form and strip it.
- **Test seams**: `makeFakeAgent` (`src/bun/agents.ts:909+`) selects scenarios by prompt marker (`FAKE_CLAUDE_TODOS_PROMPT_MARKER`, `FAKE_CLAUDE_SENT_FILES_PROMPT_MARKER` at `:829-841`, …); the sent-files branch (`:1237-1362`) writes a real 1×1 PNG under `<cwd>/agetor-sent/` and emits chunks via `after(ms, …)`. The generic fallback emits on `stdout` (RawText), which is why `e2e/markdown-readability.spec.ts` uses the prompt-echo trick (task prompt → `user` event → `USER_MD_COMPONENTS`). Unit template: `src/bun/agents-fake-sent-files.test.ts`. e2e template: `e2e/sent-files.spec.ts` (per-worker headless backend from `e2e/fixtures.ts` with `AGETOR_CLAUDE_DRIVER=fake`, task created with `isolation:"none"` + a `mkdtemp` workdir, `runPanel(page) = page.locator("aside").last()`, `openTask`). Run one Playwright invocation at a time: `bun node_modules/@playwright/test/cli.js test e2e/<spec>`.
- **Runnability**: `bun run dev:hmr` (data dir `~/.agetor-dev`, port 4318); `bun run typecheck`; `bun test`. `export PATH="$HOME/.bun/bin:$PATH"` first in this worktree.
- **Peer coordination**: another agent (fix/fix-fx-harness) is editing `RunPanel.tsx` (run-row chips, paused badge) — our RunPanel edits are confined to the three `ReactMarkdown` call sites, the `RunEventList` return wrapper, and the `pathRoots` doc comment; they were notified.

## 3. Approach & key decisions

| # | Decision | Alternatives considered | Basis |
| --- | --- | --- | --- |
| D1 | **Rendering-only, client-side, all harnesses.** Persisted events stay raw; historical transcripts upgrade for free. | Server-side rewrite of event data (leaves old rows broken; rejected by #130/#218 for the same reason). | Prior art (#130, #218), ground truth shows claude + cursor both affected. |
| D2 | **One `img` override, `MdImage`, shared by `USER_MD_COMPONENTS`, `ASSISTANT_MD_COMPONENTS` and `GH_MD_COMPONENTS`.** | Per-surface overrides (drift). | Owner: apply to GitHub bodies too. |
| D3 | **Custom `urlTransform` (`MD_URL_TRANSFORM`)** passed at every `ReactMarkdown` call site: for `key === "src"` on an `img` node, a `file://` URL is unwrapped to a POSIX path (percent-decoded, `localhost` host accepted); everything else defers to `defaultUrlTransform` (so `data:`/`C:\` stay blanked, links unchanged). | Loosening the default transform globally (README: XSS vector); pre-rewriting the markdown text (would touch code spans). | Measured: transform runs before the override (§2). |
| D4 | **Task scope via React context** `MdImageScopeContext = { taskId?, roots }`, provided once around `RunEventList`'s body (covers assistant/user/segments/plan-preview without prop threading) and once in `PlanDialog`; `GitHubDialog` renders with the empty default scope. | Threading `taskId`/`pathRoots` into `AssistantBlock`, `MessageSegments`, `TmuxPromptCard` (four prop chains for one value). | Codebase brief §4. |
| D5 | **Relative resolution = ordered candidates** `[worktreePath, workdir]` → `join(root, rel)` (leading `./` and a leading `@` mention marker stripped, `.`/`..` segments normalized, duplicate roots deduped); `MdImage` tries them in order via `onError`, then falls back to the chip. | Only the first root (misses a task whose worktree was torn down while the source repo still has the file). | Owner Q2. |
| D6 | **Click = OS open.** `api.openPath({ path: <the absolute candidate that loaded, or the first>, taskId })`; 404 → `AttachmentNotFoundDialog`; any other failure → `AttachmentOpenErrorDialog`. Remote image click → `api.openExternal(url)`. `<img role="button" tabIndex=0>` + Enter/Space, no `<button>` wrapper (an image may sit inside a markdown link). | In-app lightbox (owner declined, consistent with #218). | Owner Q1. |
| D7 | **Fallback chips, never a broken glyph**: non-image extension → `iconForRef` file chip (basename, tooltip = full path, click = openPath); image whose candidates all failed / no candidates → warning-tone `ImageOff` chip; blank `src` → muted `ImageOff` + alt text (no click). All inline elements. | Leave the browser's broken icon. | Owner Q3. |
| D8 | **Sizing + caption via Tailwind classes on the `<img>`**: `max-h-96 max-w-full h-auto object-contain rounded-md border border-border/60 align-middle cursor-pointer`; alt text rendered as a small muted caption `<span>` under the image (inline-flex column wrapper) and as `title` fallback; markdown `title` wins for the tooltip when present. No `index.css` change. | A `.agetor-md img` CSS rule (also hits `<img>`s no one overrides, e.g. future raw HTML). | Owner Q4; `.agetor-md` gotchas. |
| D9 | **CSP header on all three byte routes** — `content-security-policy: sandbox; default-src 'none'` on the 200 responses of `/files/preview`, `/tasks/:id/diff/blob`, `/github/pull-blob`. Ignored by `<img>` consumption, enforced if the URL is ever navigated to or framed. | Preview route only (inconsistent posture across identical routes). | Owner Q3; web brief Q4. |
| D10 | **Fake-driver seam** `FAKE_CLAUDE_MD_IMAGE_PROMPT_MARKER = "__agetor_fake_claude_md_image__"`: writes `<cwd>/agetor-md-images/shot.png` (the same 1×1 PNG) and emits one assistant chunk carrying an absolute ref, a relative ref, a missing ref and a `.pdf` ref (exact text in T3). Placed before the env-gated sent-files branch, per that branch's ordering comment. | Prompt-echo only (never exercises `AssistantBlock`). | Owner Q3. |

## 4. Work breakdown — implementation tasks

**Wave 1** (parallel, disjoint files)

- **T1 — classifier + transform + component.** Owns `src/mainview/lib/md-image.ts` (new), `src/mainview/components/kanban/MdImage.tsx` (new), `src/mainview/components/kanban/md-components.tsx`.
  - `md-image.ts` (pure, no React, no DOM):
    - `export type MdImageSource = { kind: "remote"; url: string } | { kind: "local"; path: string; candidates: string[] } | { kind: "file"; path: string; candidates: string[] } | { kind: "empty" }` — `local` = `isImagePath(path)`; `file` = anything else local; `candidates` are absolute paths to try in order (may be empty for a relative path with no roots); `path` is the display path (first candidate, or the raw relative text).
    - `export function fileUrlToPath(value: string): string | null` (`file:///a%20b.png` → `/a b.png`; `file://localhost/x` ok; any other host → `null`).
    - `export function classifyMdImageSrc(src: string | null | undefined, roots: readonly (string | null | undefined)[]): MdImageSource` — `^https?:` → remote; `file://` → path via `fileUrlToPath`; leading `/` → absolute (one candidate); otherwise relative: strip one leading `@` (mention form) and any `./`, normalize `.`/`..` segments after joining to each non-empty root (deduped, order kept), never produce a candidate for an empty root list.
    - `export const mdUrlTransform: UrlTransform` (type from `react-markdown`) — D3.
  - `MdImage.tsx`: `export interface MdImageScope { taskId?: string; roots: readonly (string | null | undefined)[] }`, `export const EMPTY_MD_IMAGE_SCOPE`, `export const MdImageScopeContext`, `export const MdImage` (the `img` component, D5–D8). Test ids: `data-testid="md-image"` on a rendered `<img>` (with `data-path` = the candidate currently shown, `data-md-src` = raw src), `md-image-caption`, `md-image-file` (non-image chip), `md-image-fallback` (failed/missing image chip), `md-image-empty`. State: candidate index + failed flag, reset when `src` changes; per-instance `notFoundPath` / `openError` driving the two shared dialogs. Uses `loading="lazy" decoding="async"`.
  - `md-components.tsx`: add `img: MdImage` to both maps; `export { MdImageScopeContext, EMPTY_MD_IMAGE_SCOPE, type MdImageScope } from "./MdImage"`; `export { mdUrlTransform as MD_URL_TRANSFORM } from "@/lib/md-image"`. Update the header comment.
  - Acceptance: `bun run typecheck` green with only these files changed (no consumer passes `urlTransform` yet — that's T4; the maps compile standalone).
- **T2 — CSP header.** Owns `src/bun/server.ts` only. Add `"content-security-policy": "sandbox; default-src 'none'"` next to the `x-content-type-options: nosniff` line of the three 200-response header blocks (`:992`, `:3764`, `:4345`), plus a one-line comment on the preview route explaining why (self-enforcing img-only mitigation). Touch nothing else. Acceptance: existing `src/bun/files-preview-endpoint.test.ts` and `src/bun/server-blob.test.ts` still pass.
- **T3 — fake-driver scenario.** Owns `src/bun/agents.ts` only. Export `FAKE_CLAUDE_MD_IMAGE_PROMPT_MARKER` (doc comment in the house style, next to the other markers); add a marker-gated branch **before** the sent-files branch that, on turn 1: `mkdirSync(<cwd>/agetor-md-images)`, writes `shot.png` (reuse the base64 1×1 PNG constant — hoist it to module scope if the sent-files branch inlines it), then `after(5, …)` emits exactly one `assistant` chunk:

    ```
    Here are the screenshots.

    ![Absolute shot](<cwd>/agetor-md-images/shot.png)

    ![Relative shot](agetor-md-images/shot.png)

    ![Missing shot](<cwd>/agetor-md-images/missing.png)

    ![The report](<cwd>/agetor-md-images/report.pdf)
    ```

    then `after(10, …)` `status: "turn complete"` + `resolveDone(0)`. Acceptance: `bun test src/bun/agents-fake-sent-files.test.ts` still passes (ordering untouched).

**Wave 2** (after wave 1)

- **T4 — wire the surfaces.** Owns `src/mainview/components/kanban/RunPanel.tsx`, `PlanDialog.tsx`, `MessageSegments.tsx`, `GitHubDialog.tsx`.
  - Every `ReactMarkdown` call site listed in §2 gets `urlTransform={MD_URL_TRANSFORM}`.
  - `RunEventList`: `const mdImageScope = useMemo(() => ({ taskId, roots: pathRoots ?? EMPTY }), [taskId, pathRoots])`; wrap the returned `<div className="flex flex-col gap-4">` in `<MdImageScopeContext.Provider value={mdImageScope}>`; amend the `pathRoots` prop doc (it is now also consulted by `MdImage` for relative image resolution — keep the "chips/previews use real absolute paths" sentence, it's still true for attachment chips).
  - `PlanDialog`: provide `{ taskId: task.id, roots: [task.worktreePath, task.workdir] }` (memoized) around its markdown.
  - `GitHubDialog`: `GH_MD_COMPONENTS` gains `img: MdImage`; the ad-hoc suggestion map (`:9204-9244`) gains the same key. No provider (empty scope).
  - Acceptance: typecheck green; `bun run build`-free — just `bun run typecheck` + the vite dev server compiles.
- **T5 — docs.** Owns `CLAUDE.md` only. Add item **14. Markdown images in transcripts** to the orchestration-flow list, in the house style (one dense paragraph): the shared `MdImage` override + `MD_URL_TRANSFORM` at every call site, the `MdImageScopeContext` providers (RunEventList, PlanDialog; GitHubDialog empty scope), the candidate order and `@`-mention strip, the fallback chips, click = `openPath`, the CSP header on the three byte routes, the `FAKE_CLAUDE_MD_IMAGE_PROMPT_MARKER` seam, and `e2e/markdown-images.spec.ts`. Reference this plan.

Every task carries the completeness clause: no `TODO`/`FIXME`/stubs for in-scope work; remainder outside the owned files is reported back, not patched across.

## 5. Work breakdown — test tasks

Parallel, disjoint files. Unit tests use `bun:test`, e2e extends the existing Playwright harness.

- **TT1 — `src/mainview/lib/md-image.test.ts`** (covers T1's pure module): remote http/https passthrough; absolute path → one candidate, `local` vs `file` by extension (case-insensitive, `.pdf` → file, trailing `/` → file); `file://` unwrap incl. percent-decoding, `localhost`, foreign host → `empty`; relative with roots `[null, "/w"]` → `["/w/rel"]`, with `["/wt", "/w"]` → both in order, duplicates deduped, `./` and `@` prefixes stripped, `..` normalized; relative with no roots → `local` with `candidates: []`; empty/undefined → `empty`; `mdUrlTransform`: `file://` on `img`/`src` → path, same value on `a`/`href` → `""` (default behavior), `https` passthrough, `data:` → `""`, `C:\x.png` → `""`.
- **TT2 — `src/bun/files-preview-endpoint.test.ts` + `src/bun/server-blob.test.ts`** (covers T2): assert the CSP header value on a 200 from each route (extend existing suites; the blob test already boots the server).
- **TT3 — `src/bun/agents-fake-md-image.test.ts`** (new, mirrors `agents-fake-sent-files.test.ts`; covers T3): the marker writes `shot.png` under `<cwd>/agetor-md-images/`, emits one `assistant` chunk containing the four refs (absolute path present verbatim, the relative one as `agetor-md-images/shot.png`), then resolves exit 0; a prompt without the marker keeps the generic fallback.
- **TT4 — `e2e/markdown-images.spec.ts`** (covers T1+T3+T4; template `e2e/sent-files.spec.ts`; literal copy of the marker string):
  1. *Assistant stream*: create + start a task with the marker (isolation none, mkdtemp workdir); open it; in the run panel expect two `md-image` images whose `src` contains `/files/preview?path=` + the encoded absolute path (the relative one resolved to `<workdir>/agetor-md-images/shot.png`), each with `naturalWidth > 0` (poll); the captions "Absolute shot"/"Relative shot" visible; `md-image-fallback` chip with text `missing.png`; `md-image-file` chip with text `report.pdf`.
  2. *Click behavior (headless)*: clicking a rendered image opens the "couldn't open" dialog (`#attachment-open-error-title`, `/open-path` answers 501 headless); clicking the missing chip opens the not-found dialog (`#attachment-not-found-title`).
  3. *User bubble + `file://`*: a task whose prompt is `![u1](file://<abs png outside the workdir>)` and `![u2](<abs png outside the workdir>)` (write the PNG into a second mkdtemp dir so `shortenTaskPaths` can't fold it); the user bubble's `.agetor-md` shows two loaded `md-image`s. Use the same PNG bytes as the fake driver.
  4. *Regression*: `e2e/markdown-readability.spec.ts`'s single `.agetor-md` assumption still holds — no new `.agetor-md` containers are introduced by `MdImage` (it renders spans only).

**E2E applies** (user-visible transcript flow across webview → API → filesystem) and the harness exists. Run recipe: `export PATH="$HOME/.bun/bin:$PATH"; bun node_modules/@playwright/test/cli.js test e2e/markdown-images.spec.ts e2e/sent-files.spec.ts e2e/markdown-readability.spec.ts` from the worktree root — the config boots the Vite server and per-worker headless backends itself; no credentials or services. One Playwright run at a time on this machine.

## 6. Execution waves

| Wave | Tasks | Barrier |
| --- | --- | --- |
| 1 | T1, T2, T3 | typecheck + `bun test src/bun/agents-fake-sent-files.test.ts src/bun/files-preview-endpoint.test.ts`; commit `wave 1: …` |
| 2 | T4, T5 | typecheck; commit `wave 2: …` |
| Review | Phase 5 on `git diff c652464...HEAD` | must-fixes → Phase 8 |
| Tests | TT1, TT2, TT3, TT4 in parallel | commit `tests: …` |
| Run | typecheck, `bun test`, the three e2e specs | fixes loop (≤3 rounds) |

## 7. Blast radius & risks

- **Every markdown surface** now carries an `img` override and a custom `urlTransform`. Links, code, headings are untouched; `defaultUrlTransform` still decides everything except `img` `src` `file://` unwrapping. Remote images render as before but capped at 24rem.
- **`<p>` content model**: `MdImage` returns only inline elements, so no DOM-nesting warnings and the `.agetor-md` owl spacing is unaffected.
- **Memoized transcript blocks**: `AssistantBlock` stays `memo`'d on `text`; the context value is memoized on `taskId`/`pathRoots` so it only re-renders consumers when the task's roots change (rare).
- **Network**: one lazy `<img>` request per local reference; a missing file costs a 404 per candidate, per mount. No polling, no new endpoints.
- **Security**: agent-authored markdown can now point `/files/preview` at any image path on the machine — the same tier the route already granted `SendUserFile` paths (agent-chosen too) and `/open-path`. Rendering happens only inside the user's own local webview; the CSP header removes the one convention-only mitigation. `file://` unwrapping never reaches links.
- **GitHub bodies**: repo-relative image refs GitHub would have resolved itself now render as a basename chip (previously a broken image) — an improvement, noted in docs.
- **Peer branch** (fix/fix-fx-harness) edits `RunPanel.tsx` elsewhere; our hunks are small and localized, merge risk low.
- **Rollback**: revert the branch; no migrations, no persisted-shape changes.

## 8. Open questions / assumptions

Grill (owner answered 2026-09-09):

| Question | Answer |
| --- | --- |
| Click on a rendered image | Open with OS default app (not a lightbox) |
| Relative paths | Resolve against worktree, then workdir; also unwrap `file://` |
| Extras | Fallback chips for non-image/missing; CSP sandbox header on `/files/preview`; fake-driver seam + e2e for the assistant stream; also apply to GitHub PR/issue bodies |
| Max inline size | 24rem tall, full width |

Assumptions proceeding on:

- A1 — `file://` unwrapping is `img`-only; `[text](file://…)` links keep today's blanked behavior.
- A2 — A relative candidate that normalizes outside the roots (`../../x.png`) is still requested; `/files/preview` deliberately has no cwd containment (precedent #130/#172/#218).
- A3 — `GitHubDialog` runs with the empty scope; relative refs there become chips.
- A4 — e2e proves the assistant path through the claude fake driver; the cursor driver is unchanged and funnels through identical code, so no `AGETOR_CURSOR_DRIVER=fake` fixture wiring is added.
- A5 — CSP value `sandbox; default-src 'none'`, applied to the 200 branches only (a 304 has no body).
- A6 — `~/`-prefixed paths are not expanded (no HOME in the webview); they fall to the chip.

## 9. Completeness ledger

| Candidate remainder | Disposition | Owner / task |
| --- | --- | --- |
| Assistant bubbles (all harnesses) | in this run | T1, T4 |
| User bubbles + tagged segments (`MessageSegments`) | in this run | T4 |
| Claude plan-approval preview (`TmuxPromptCard`) + `PlanDialog` | in this run | T4 |
| GitHub PR/issue/comment bodies incl. the suggestion map | in this run | T4 (owner Q3) |
| Relative paths, `@`-mention form, `file://` | in this run | T1 |
| Non-image / missing / blank fallbacks + dialogs | in this run | T1 |
| CSP header on `/files/preview` **and** the two blob routes | in this run | T2 |
| Fake-driver seam + unit test + e2e | in this run | T3, TT3, TT4 |
| CLAUDE.md architecture entry | in this run | T5 |
| CLI `agetor logs` / TUI | no change needed — they print the markdown text verbatim, which already reads as a path; verified in Phase 1 | — |
| Claude inline `type:"image"` content blocks (`[image]` placeholder) | out of scope — different ticket: needs the bytes persisted, no path exists | — |
| In-app lightbox / zoom | out of scope — owner chose OS-open (Q1), consistent with #218 | — |
| `data:` image URIs | out of scope — react-markdown blanks them by design; rendering base64 from agent output is a separate decision | — |
| `~/` expansion, Windows drive paths | out of scope — macOS-only app, no HOME in the webview | — |
| Remote-image privacy policy (agent output can embed a tracking pixel) | out of scope — pre-existing behavior, unchanged by this run | — |
| `AGETOR_CURSOR_DRIVER=fake` e2e fixture wiring | out of scope — driver unchanged (A4) | — |
| Owner-deferred | none | — |

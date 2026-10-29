# Plan — Formatted handoff card in agent transcripts

| Field | Value |
| --- | --- |
| Date | 2026-10-29 |
| Source | Pipeline "Alamo Pipeline (No Video)" goal; `docs/plans/formatted-handoff-investigation.md`; `docs/plans/formatted-handoff-grill.md` (D1–D23) |
| Flags | none |
| Gates | grilled + approved by owner (2026-10-29, "Approve as written"; A1 answered: Gemini stays raw) |
| Branch | `feature/formatted-handoff` (this worktree) |
| Base SHA | `0a2e636e26e85e85b5c8257e1646d58b7325cd03` (release v1.1.0), confirmed at execution start; tree clean apart from the three plan docs |

## 1. Objective & success criteria

A pipeline step agent ends its final message with `<handoff>{json}</handoff>`. Today that block renders as one escaped text node with the JSON collapsed onto a single wrapped line (investigation §2, spike 1). After this change:

1. **Transcript card.** In a pipeline step task's main stream, the last real handoff block of an assistant message renders as a compact card: status chip, `→ next`, an **Open** button, a 4-line summary preview, up to 6 artifact chips then `+N`, and the open-question count. Prose before and after the block renders as today. An unparsable block renders as a danger-toned **Invalid handoff** card. (D3, D8, D9, D13–D15, D20)
2. **Modal.** **Open** shows a window-wide modal (portaled to `document.body`, built on the shared `Dialog`). It has formatted sections, pipeline context (step, where `next` resolves, Used / Not used), **Copy JSON**, and a **Formatted / Raw** toggle. (D4, D5, D21)
3. **Artifacts.** Path and URL artifacts are clickable. A path opens in the OS default app, and a context menu offers Open, Reveal in Finder and Copy path. A URL opens in the browser. Free text shows in the modal only, with Copy. Relative paths resolve on the client against `[worktreePath, workdir]`. One cached, batched `/refs/resolve` per card dims missing chips. (D6, D7, D20)
4. **Other surfaces.** The run view's history row replaces its raw-JSON `<pre>` with the same card (D1a). In the next step's prompt bubble, each nonce-matched untrusted span becomes a card labelled `Handoff from "<step>" · untrusted` (D1b, D17). The handoff-file reference chip opens the modal (D1c, D18). `agetor logs` prints a multi-line `handoff›` digest and the TUI prints one line (D1d, D19).
5. **Runner bug fixed.** A tag inside an inline code span or a fenced code block never counts as a handoff, for the runner and the UI alike, through one shared locator. A step whose message mentions `` `<handoff>` `` in prose before its real block now advances without a spurious reminder. A block wrapped entirely in a fence is `handoff-missing` and gets the one reminder. (D2, D12)
6. **Search.** For step tasks, message search matches handoff field values, not JSON keys. A jump onto a match that only shows in the modal makes the card show an "in handoff" hint. (D10)

**Done means:** `bun run typecheck` and `bun test` pass, the new e2e spec `e2e/formatted-handoff.spec.ts` passes, `e2e/pipelines-run.spec.ts` and `e2e/pipeline-scroll-memory.spec.ts` still pass, and README plus CLAUDE.md item 19 describe the new behaviour (D22, D23).

## 2. Context & constraints

Grounded at `0a2e636e`. All anchors are `file:line`.

**Shared parser (`src/shared/pipeline.ts`)**
- `HANDOFF_TAG` `:28`. The untrusted-span markers: `handoffUntrustedBeginMarker` `:122` (`--- BEGIN untrusted handoff <nonce> from "<step>" ---`) and `handoffUntrustedEndMarker` `:127`. `escapeHandoffMarkerPhrases` `:141`.
- `findLastHandoffBlock` `:205-244` is the linear scanner. An open tag pairs with the first close after it, the last pair wins, and only the trailing `PIPELINE_LIMITS.handoffScanTailBytes` are scanned. It has **no code-span awareness**: that is the bug (investigation §2, `mismatch.ts`).
- `stripCodeFence` `:599`, `extractBalancedObject` `:609`, `normalizeHandoff` `:748`, `parseHandoff` `:781-813`, `classifyStepResponse` `:831-855`, `renderHandoffFile` `:873`, `resolveNextSteps` `:900` (single edge → next ignored; `transition:"all"` → every target; several edges → name, then id, then label match).
- `composeStepPrompt` `:1052`. The untrusted spans are emitted at `:1088-1112`: a fenced ```` ```json ```` block, or the placeholders `(handoff too large to inline — saved to <path>)`, `(handoff too large to inline; no file available)` and `(handoff saved to <path>)`.
- The module imports only types and `PIPELINE_LIMITS` from `./types.ts` (`:10-21`), so the webview and the CLI can import it.
- The existing tests are `src/shared/pipeline.test.ts` `describe("parseHandoff")` `:744-958`, including the linear-time pin "50,000 unclosed <handoff> opens … well under 100 ms" (`:947`).

**Runner (`src/bun/pipeline-runner.ts`)**
- `mainStreamEventsForRun` `:443`. `assistantTextFrom` `:450-455` joins the main-stream `assistant` rows with `"\n"`.
- `parsedRunResponse` `:488-517` calls `classifyStepResponse` (`:504-508`) and caches by `runId` + `maxEventId`.
- Handoff files are named `handoff-${(run.startedAt ?? 0).toString(36)}-${seq}-from-${p.seq}.json` under `pipelineRunsDir(parent.id)` (`:1139-1147`). `harnesses.getByIdOrKind` is already imported (`:42`).
- The runner test pattern is `src/bun/pipeline-runner.test.ts:1896-1945` (`:invalid-then-done`).

**Delta-streaming harnesses.** Gemini emits one `assistant` event per `delta:true` message chunk (`src/bun/gemini-tmux.ts:157`). Antigravity emits one per `text_delta` (`src/bun/antigravity-tmux.ts:164`). So a block spans many events there. Every other driver emits message-level events: claude JSONL, codex `item.completed` (`codex-tmux.ts:163`), cursor (`cursor-tmux.ts:307`), copilot (`copilot-tmux.ts:524`), opencode (`opencode-tmux.ts:306`), and fx through its `FxTextCoalescer`.

**Fake driver (`src/bun/agents.ts`)**
- `FAKE_CLAUDE_HANDOFF_PROMPT_MARKER` `:1309` and its suffix regex `:1314`. `FAKE_HANDOFF_TWO_TURN_RE` `:1576` (`missing|invalid`). `fakeTerminalHandoffText` `:1597`.
- The handoff branch is `:2412-2530`, with the emission at `:2499-2524`. It always emits `artifacts: []` and `openQuestions: []`. `fakeOpts.cwd` is the task cwd (precedent: the md-image scenario `:2964-2967` writes files into it).

**Webview**
- `RunPanel.tsx` (8,394 lines). `AssistantBlock` `:6344` (props: `text` only, `memo`). `RunEventList` `:5319`; its `renderEvent` assistant case is `:5578` and user case `:5568-5575`; the `blocks` memo with the `wrap(..., data-evid)` carrier is `:5536-5560`; `MdImageScopeContext` is provided at `:5735-5749`.
- `UserMessageBlock` `:6099`: the ordinary-branch `ReactMarkdown` is at `:6316-6324`, the tagged branch uses `<MessageSegments>` (`:6303-6309`), and both render `<AttachmentChips references taskId>`.
- Pipeline strip: `pipelineStripCacheRef` and its effect `:2827-2878` fetch `api.getPipelineRun(parentId)` (the **full** run, untrimmed) and cache only `{pipelineName, graph}`. The `[task.id]` reset effect is around `:895-935` (`setPipelineStrip(null)` `:924`).
- Other RunPanel anchors: `pathRoots` memo `:3565`; `RunEventList` mount `:4178-4189`. Search: `matches = findMatchingEventIds(displayedEvents, searchQuery)` `:1895-1898`; the explicit-jump `EXPAND_EVENT` dispatch `:1986`; the per-tab gate `activeStream` `:730` and `displayedEvents` `:1873`. `homeDir` is already a `RunPanel` prop (`:246`, `:369`); `kind` is the task's harness kind in `RunPanelBody`.
- `MessageSegments.tsx:327-337` renders text segments with `ReactMarkdown` + `USER_MD_COMPONENTS`.
- `AttachmentChips.tsx` (176 lines) opens chips via `api.openPath({path, taskId})`, maps 404 to `AttachmentNotFoundDialog` and anything else to `AttachmentOpenErrorDialog`. It has no context menu.
- `SentFilesCard.tsx` `:217-236` is the batched `api.resolveRefs` pattern ("unknown is never missing"), and `:324-350` is the Open / Reveal / Copy path `ContextMenu` pattern.
- `lib/md-image.ts:147` `classifyMdImageSrc` is the roots-candidate rule. `normalizePosixPath` `:40` is module-private. `MdImage.tsx:307-334` portals its dialogs to `document.body`.
- `lib/event-search.ts:67` `searchableEventText` and `:151` `findMatchingEventIds`. `lib/expand-on-jump.ts` defines `EXPAND_EVENT`; `lib/use-expand-on-jump.ts` takes `onExpand()` with no arguments.
- `components/ui/dialog.tsx` renders `role="dialog" aria-modal="true"`; RunPanel's Escape and Cmd+F bail on it (`RunPanel.tsx:515`, `:2037`, `:2071`) and so does the run view's (`PipelineRunView.tsx:120`). `components/ui/context-menu.tsx` portals and carries `data-popover-open`.
- `PipelineRunView.tsx` `HistoryRow` `:1238-1320`: the raw `<pre data-testid="pipeline-run-history-handoff">` is at `:1311-1318`. It is mounted from `App.tsx:2773-2782`, and App holds `homeDir` state (`App.tsx:356`).
- Routes, unchanged by this plan: `/open-path` checks the path exists (404) **before** the headless 501 (`server.ts:6306-6337`); `/reveal-path` has the same contract; `/refs/resolve` takes absolute paths and drops missing ones (`server.ts:6469-6475`; for the app caller this is an in-process stat, the same tier as `SentFilesCard`).

**CLI / TUI**
- `src/cli/commands/logs.ts`: `createEventFormatter()` `:211` (assistant → raw `e.data` `:238`), `hidden = task.pipelineParentId != null` `:75`. Tests are in `src/cli/logs.test.ts`.
- `src/cli/tui/Dashboard.tsx`: `Detail` `:656` builds primitive-per-event maps (`buildSentFilesLines` `:679`, `:818`); `EventLine` `:880` (assistant → truncated `Text` `:917`). Tests are in `src/cli/tui/Dashboard.test.tsx`.
- Terminal escaping helpers are in `src/shared/terminal-text.ts` (`escapeControlChars` `:226`, `escapeFreeText` `:241`). `PlainLine` is in `src/shared/user-message.ts:1056`. An ordinary user message is **one** `PlainLine` with multi-line `text`.

**Spike verdicts (investigation §2; react-markdown 10.1.0, remark-gfm 4, React 19.2, bun 1.3, the repo at `0a2e636e`)**
- A per-event, code-span-aware splitter agrees with the runner on 1,481 of 1,484 real events. The one disagreement is the runner bug. It costs 0.064 ms per event on average and 2.4 ms at most.
- Real artifact shapes: relative path 70%, absolute path 19%, URL 6%, free text 3.5%, path + note ~2%, `path:line` 0.4%.
- Real handoffs: p50 4.4 KB, max 12 KB. In 7 events prose follows `</handoff>`, and 24 events contain several tag occurrences.

**E2E harness.** Playwright with one shared Vite server and one headless backend per worker (`e2e/fixtures.ts`). The fixture sets `AGETOR_CLAUDE_DRIVER=fake` (`:517`). Pipeline REST helpers are in `e2e/scroll-memory-helpers.ts` (`createProfileRest`, `makeStep`, `createPipelineRest`, `startTaskRest`, `waitForPipelineRest`, `gotoAppSubscribed`). Search-jump precedent: `e2e/compaction-summary.spec.ts`. Clipboard precedent: `e2e/bundle-export-import.spec.ts:321-331` (`context.grantPermissions`). Headless open dialogs precedent: `e2e/markdown-images.spec.ts:241-271`.

## 3. Approach & key decisions

**K1 — One locator module, two scan modes (evidence + D2).** Move the scanner out of `pipeline.ts` into `src/shared/handoff-locator.ts`, a module with no dependencies except `PIPELINE_LIMITS`. `pipeline.ts` re-exports `HANDOFF_TAG` from it, so every current importer keeps working. Two modes:
- **Code-aware (default).** Prose is scanned as Markdown. A tag inside an inline code span or a fenced block is not an open tag. Once a real open tag is found, the scanner switches to block mode: it looks for the first close tag and ignores Markdown entirely (so a ```` ```json ```` fence or backticks *inside* the block don't matter), then resumes prose scanning after the close with a fresh code state. Code state resets at every **segment start** (one segment = one event), matching react-markdown, which renders each event on its own. A block may still pair across segments, which keeps today's cross-event pairing.
- **Legacy (`codeAware: false`).** Exactly today's `findLastHandoffBlock` tokenization, byte for byte.

Rules pinned by unit tests:
- A backtick run opens an inline code span only when a closing run of the **same length** exists later in the same paragraph, i.e. before the next blank line, segment start or fence-opener line. The earliest-starting span wins (CommonMark precedence). An unmatched run is literal.
- A fence opener is a line whose content, after optional `>` blockquote markers and any leading whitespace, starts with ≥3 backticks (with no backtick in the rest of the line) or ≥3 tildes. It closes at a line with the same character repeated at least as many times, followed only by whitespace. An unclosed fence runs to the end of its segment.
- Indented (4-space) code blocks are **not** treated as code (assumption A3).
- All work is linear. Backtick runs are paired through a per-paragraph "next run of the same length" table, and every jump moves forward. The scanner keeps the tail window, the `<handoffx>` rejection, attribute tolerance and close-tag whitespace tolerance.

**K2 — Delta-streaming harnesses stay on the legacy scan, and the webview renders no cards for them (evidence; extends D11).** Per-segment code resets would break a fence that a gemini/antigravity delta splits across events. That could turn a handoff the runner finds today into `handoff-missing`, a regression. So `HANDOFF_DELTA_STREAM_KINDS = {gemini, antigravity}` (in `pipeline.ts`): the runner parses those runs with `codeAware: false` (today's behaviour, unchanged), and the webview's card gate excludes those kinds. Message-level kinds get the bug fix. The owner deferred Antigravity (D11) and confirmed the same for Gemini at plan approval (§8 A1). *Rejected:* a code-aware scan of the joined text for every kind. The runner and the UI would then disagree whenever an earlier event left a fence unclosed (violates D2), and gemini/antigravity would carry a new fence risk from the `"\n"` joins.

**K3 — The runner parses segments.** `assistantTextFrom` becomes `assistantSegmentsFrom` (string[]). `parseHandoff`/`classifyStepResponse` accept `string | readonly string[]`; an array is joined with `"\n"` (the same joined text as today) and its element offsets become the segment starts. A bare `string` is one segment, so every existing caller and test keeps its meaning. The handoff file name gets a shared builder, `handoffFileName`, and a parser, `parseHandoffFilePath`, both in `pipeline.ts`, so D18's lookup can never drift from what the runner writes.

**K4 — One shared message splitter for every surface.** `splitHandoffMessage(text)` (in `pipeline.ts`) returns `{ before, after, block: { inner, result } | null }` for the **last** real block of one message (code-aware, one segment). It is used by the webview card, search, the CLI digest and the TUI line. The prompt-span splitter `splitHandoffPromptSpans(text)` also lives in `pipeline.ts`, next to the private marker builders, and is round-trip-tested against `composeStepPrompt`. The Begin and End markers must carry the same `[0-9a-f]{8}` nonce. A span whose body is neither a parseable ```` ```json ```` block nor one of the three placeholders stays as text.

**K5 — Modal per card, portaled (answers the grill's open question 2).** Each card, the D18 chip and the history row own their modal state and render `HandoffDialog` through `createPortal(…, document.body)` only while it is open (the `MdImage` pattern). This adds no `RunPanelBody` state, no namespaced keyed sibling and no `[task.id]` reset line for the modal. The modal closes by itself on a task switch, because the switch unmounts the old events' cards. React context crosses the portal, so `MdImageScopeContext` and the handoff context still reach the modal. *Rejected:* a `RunPanelBody`-level modal. It needs a `handoff-…` keyed sibling plus reset wiring, and the run view would need a second copy anyway.

**K6 — Context, not prop threading.** A `HandoffViewContext` is provided in `RunPanelBody` around `RunEventList`. It carries `enabled`, `taskId`, `parentId`, `roots`, `homeDir`, `stepId`, `stepName`, `graph`, `run`, `record` and `settledRunIds`. `AssistantBlock`, `UserMessageBlock`'s markdown body, `MessageSegments`' text segments and `AttachmentChips` read it. With `enabled: false` (any non-step task, a subagent tab, a delta kind), every one of them renders exactly what it renders today. `RunEventList` computes each assistant event's usage (D21) as a **primitive** prop, so `AssistantBlock`'s `memo` keeps working.

**K7 — The parent's run is kept live on step panels.** The strip effect already fetches the full parent run. It now also stores that run in new per-task state, `stepPipelineRun`, which is reset in the `[task.id]` effect. While a step task is open, a `pipeline` global event for its parent triggers a debounced (500 ms, trailing) refetch. This is one GET, not a second stream (WKWebView connection budget, CLAUDE.md item 18).

**K8 — Caching keeps the render cost flat.** The webview wraps `splitHandoffMessage` in a 512-entry LRU keyed by the event text string. JS strings are shared, so the cache adds Map overhead only. The per-run "last event holding a real block" index and search reuse that cache, so a new streamed event costs one new scan. Artifact existence uses `useArtifactStats`: one `/refs/resolve` per unique sorted candidate set, a module cache with a 30 s TTL, in-flight de-duplication, and failures never cached.

**K9 — `next` label semantics (refines D14; evidence).** With the graph loaded, the label shows what `resolveNextSteps(graph, fromStepId, handoff)` actually resolves, because a single outgoing edge ignores `next` in the runner:
- `steps` → `→ A` (or `→ A, B` for a fan-out)
- `terminal` → `Last step`
- `unknown` → `→ <next> · unknown step` (warning tone)
- `ambiguous` → `→ ? · no next step chosen` (warning tone)

Before the graph loads, or when the source step can't be found: `next` shows verbatim, and `null` shows `Last step` (D14).

**K10 — The CLI and TUI gate on step tasks only (D19).** The CLI has no cheap harness-kind lookup, and a delta event almost never holds a whole block. The CLI/TUI also collapse the prompt's untrusted spans into digest lines, which brings D1b's prompt rendering to the terminal (assumption A10).

Evidence vs reasoning: K1's rules and linearity rest on the spike's 1,481/1,484 agreement plus new pathological tests. K2 and K3 rest on the driver code anchors. K5, K6, K8 and K10 are design reasoning within the grill's constraints.

## 4. Work breakdown — implementation tasks

Interfaces every downstream task codes against (written by T1; signatures are binding):

```ts
// src/shared/handoff-locator.ts
export const HANDOFF_TAG = "handoff";
export interface HandoffBlockSpan { start: number; openEnd: number; closeStart: number; end: number }
/** Real blocks in `text`, in order, within the trailing PIPELINE_LIMITS.handoffScanTailBytes.
 *  Offsets index into `text`. codeAware defaults to true. */
export function findHandoffBlocks(
  text: string,
  opts?: { segmentStarts?: readonly number[]; codeAware?: boolean },
): HandoffBlockSpan[];

// src/shared/pipeline.ts (additions; HANDOFF_TAG re-exported from the locator)
export type HandoffParseResult =
  | { ok: true; handoff: Handoff }
  | { ok: false; error: string; raw: string | null };
export function parseHandoffInner(inner: string): HandoffParseResult;            // fence strip → JSON → balanced fallback → normalizeHandoff
export function parseHandoff(text: string | readonly string[], opts?: { codeAware?: boolean }): HandoffParseResult;
export function classifyStepResponse(input: {
  runStatus: "succeeded" | "failed" | "cancelled" | "orphaned";
  assistantText: string | readonly string[];
  pendingInteractions: number;
  codeAware?: boolean;
}): { kind: StepResponseKind; handoff: Handoff | null; error: string | null };
export interface HandoffMessageSplit {
  before: string;
  after: string;
  block: { inner: string; result: HandoffParseResult } | null;
}
export function splitHandoffMessage(text: string): HandoffMessageSplit;          // last real block, code-aware, one segment
export const HANDOFF_DELTA_STREAM_KINDS: ReadonlySet<AgentKind>;                  // gemini, antigravity
export function handoffScanIsCodeAware(kind: AgentKind | null | undefined): boolean;
export function handoffFileName(generation: string, seq: number, fromSeq: number): string; // "handoff-<gen>-<seq>-from-<fromSeq>.json"
export function parseHandoffFilePath(path: string, parentId: string):
  { generation: string; seq: number; fromSeq: number } | null;                    // parent dir === parentId AND grandparent === "pipeline-runs"
export function findHandoffRecordForFile(
  run: PipelineRunState | null | undefined,
  file: { generation: string; fromSeq: number },
): PipelineStepRecord | null;                                                    // (run.startedAt ?? 0).toString(36) === generation && record.seq === fromSeq && record.handoff
export type HandoffPromptPart =
  | { kind: "text"; text: string }
  | { kind: "handoff"; fromStep: string; nonce: string; handoff: Handoff }
  | { kind: "handoff-file"; fromStep: string; nonce: string; filePath: string | null; tooLarge: boolean };
export function splitHandoffPromptSpans(text: string): HandoffPromptPart[];

// src/mainview/lib/handoff-artifacts.ts (T4a)
export type HandoffArtifact =
  | { kind: "url"; raw: string; url: string; note: string | null }
  | { kind: "path"; raw: string; display: string; candidates: string[]; line: string | null; note: string | null }
  | { kind: "text"; raw: string; text: string };
export function classifyHandoffArtifact(
  entry: string,
  ctx: { roots: readonly (string | null | undefined)[]; homeDir: string | null },
): HandoffArtifact;
export function cardArtifacts(list: HandoffArtifact[], limit?: number): { chips: HandoffArtifact[]; hiddenCount: number }; // first `limit` (6) non-text entries; hiddenCount = list.length − chips.length

// src/mainview/lib/handoff-view.ts (T4b)
export function handoffStatusChip(h: Handoff): { status: "done" | "blocked"; label: "Done" | "Blocked"; tone: "success" | "warning" };
export function handoffNextLabel(h: Handoff, graph: PipelineGraph | null, fromStepId: string | null):
  { text: string; tone: "default" | "warning"; kind: "steps" | "last" | "unknown" | "ambiguous" | "unresolved" };
export function handoffUsage(input: {
  record: PipelineStepRecord | null;
  eventRunId: string;
  isLastBlockOfRun: boolean;
  runSettled: boolean;
}): "used" | "not-used" | null;
export function handoffMatchLocation(h: Handoff, query: string, opts?: { chipLimit?: number; roots?: readonly (string | null | undefined)[]; homeDir?: string | null }): "card" | "modal" | null;
export function searchableHandoffText(h: Handoff): string;   // purpose, summary, reason, next, artifacts, openQuestions — values only
export function splitHandoffMessageCached(text: string): HandoffMessageSplit;   // 512-entry LRU
export function indexLastHandoffEventByRun(events: readonly { runId: string; stream: string; data: string; subagentId?: string | null }[]): Map<string, number>;
export function handoffCardsEnabled(input: { isStepTask: boolean; kind: AgentKind | null | undefined; mainStream: boolean }): boolean;
export function stepIdForName(graph: PipelineGraph | null, name: string): string | null; // stepNameKey match

// src/mainview/lib/event-search.ts (T4b) — new optional trailing argument, backward-compatible
export function searchableEventText(stream: RunEventStream, data: string, opts?: { handoffCards?: boolean }): string | null;
export function findMatchingEventIds(events: ReadonlyArray<{ stream: RunEventStream; data: string }>, query: string, opts?: { handoffCards?: boolean }): readonly number[];

// src/mainview/lib/expand-on-jump.ts / use-expand-on-jump.ts (T5) — backward-compatible
export interface ExpandOnJumpDetail { query?: string }
export function useExpandOnJump(rootRef: RefObject<HTMLDivElement | null>, onExpand: (detail: ExpandOnJumpDetail) => void): void;
```

Test ids (binding for the e2e):
- Card: `handoff-card` (`data-variant="transcript|prompt|history"`, `data-status="done|blocked"`), `handoff-card-status`, `handoff-card-next` (`data-next-kind`), `handoff-card-open`, `handoff-card-summary`, `handoff-card-artifact` (`data-artifact-kind`, `data-missing`), `handoff-card-more`, `handoff-card-questions`, `handoff-card-not-used`, `handoff-card-search-hint`.
- Invalid card: `handoff-invalid-card`, `handoff-invalid-raw`.
- Prompt placeholder and D18 chip: `handoff-file-card`, `handoff-file-chip`.
- Modal: `handoff-dialog`, `handoff-dialog-step`, `handoff-dialog-next`, `handoff-dialog-usage` (`data-usage`), `handoff-dialog-view-formatted`, `handoff-dialog-view-raw`, `handoff-dialog-raw`, `handoff-dialog-copy`, `handoff-dialog-artifact`, `handoff-dialog-artifact-text`, `handoff-dialog-artifact-copy`, `handoff-dialog-questions`.
- Artifact context menu: `handoff-artifact-menu`.
- Kept: `pipeline-run-history-handoff`, now on the history card's wrapper.

| ID | Goal | Owned files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| **T1** | Shared code-aware locator (K1), segment-aware `parseHandoff`/`classifyStepResponse` (K3), `parseHandoffInner`, `splitHandoffMessage` (K4), `splitHandoffPromptSpans` (K4), the delta-kind set and `handoffScanIsCodeAware` (K2), and the file-name builder, parser and record lookup (K3). `HANDOFF_TAG` moves to the locator and is re-exported from `pipeline.ts`. The old `findLastHandoffBlock` is deleted; its tokenization survives as `codeAware: false`. | `src/shared/handoff-locator.ts` (new), `src/shared/handoff-locator.test.ts` (new), `src/shared/pipeline.ts`, `src/shared/pipeline.test.ts` | — | Every existing `describe("parseHandoff")`/`classifyStepResponse`/`composeStepPrompt` test passes unchanged. The new tests (U1) pass. Every new pathological case runs in < 100 ms. `bun run typecheck` is green. |
| **T3** | Fake-driver suffixes. `rich`: writes `<cwd>/agetor-handoff/notes.md` and `<cwd>/agetor-handoff/report.txt`, then emits the canonical rich handoff (below), `status:"done"`, `next:null`. `rich-blocked`: the same, `status:"blocked"`. `mention`: ``I checked the `<handoff>` contract and its `{schemaVersion, …}` shape before finishing.`` followed by a valid terminal block. The `{…}` in the prose is required: without it the legacy balanced-object fallback would rescue the JSON and the bug wouldn't reproduce (this matches the real event's `Expected '}'`). `fenced`: a valid block wrapped entirely in a ```` ``` ```` fence. `FAKE_HANDOFF_TWO_TURN_RE` widened to `^(missing\|invalid\|fenced)-then-(.+)$`. The two artifact lists are exported as `fakeRichHandoffArtifacts(cwd)` for the unit test. | `src/bun/agents.ts`, `src/bun/agents-fake-handoff.test.ts` (new) | — | U3 passes. Existing suffixes are byte-identical (U3 asserts `done`/`missing`/`invalid` output unchanged). |
| **T4a** | Artifact classifier (D6/D7/D20). URL: `https?://`/`mailto:` head token, note after ` (`/` — `/` - `. Path: starts with `/`, `~/`, `./`, `../`, `file://`, or a head token with a `/` or a file extension and no spaces; `:N`, `:N-M`, `#LN`, `#LN-LM` are stripped into `line`; the note splits on ` (` (trailing `)` dropped), ` — `, ` - ` or `: `. Relative paths get candidates `[worktreePath, workdir]` (normalized, de-duplicated; `@` and `./` stripped); `~/` gets `homeDir` (with no `homeDir` → `text`); `file://` is percent-decoded. Anything else is `text`. Includes a local `normalizePosixPath` copy, or `md-image.ts` exports it — see note. | `src/mainview/lib/handoff-artifacts.ts` (new), `src/mainview/lib/handoff-artifacts.test.ts` (new) | — | U4a passes: all 9 spike shapes plus `~/`, `file://`, `mailto:`, empty and whitespace entries, a URL with a trailing `)`. |
| **T2** | Runner on segments. `assistantSegmentsFrom(events): string[]` replaces `assistantTextFrom`. `parsedRunResponse` passes the segments and `codeAware: handoffScanIsCodeAware(harnesses.getByIdOrKind(row.agent)?.kind)`. The `:1147` template becomes `handoffFileName(generation, seq, p.seq)`. No other runner behaviour changes. | `src/bun/pipeline-runner.ts`, `src/bun/pipeline-runner-handoff-locator.test.ts` (new) | T1, T3 | U2 passes. `bun test src/bun/pipeline-runner.test.ts src/bun/pipeline-runner-checkout-branch.test.ts` stays green. |
| **T4b** | View-model helpers (D13, D14/K9, D21, D10) and search. `searchableEventText`: assistant + `handoffCards` + a real block → `before + searchableHandoffText + after` (an invalid block → `before + raw + after`); user + `handoffCards` → text parts plus span values (A4). Without the flag, output is byte-identical. `findMatchingEventIds` forwards the flag. | `src/mainview/lib/handoff-view.ts` (new), `src/mainview/lib/handoff-view.test.ts` (new), `src/mainview/lib/event-search.ts`, `src/mainview/lib/event-search.test.ts` | T1 | U4b passes. The existing `event-search.test.ts` passes unchanged. |
| **T7** | CLI and TUI digest (D19, K10). `src/shared/handoff-digest.ts`: `HANDOFF_DIGEST_LABEL = "handoff›"`; `handoffDigestLines(split): PlainLine[]` (first line `✓ done → <next\|last step>` or `⚠ blocked → …`, then `purpose:`, `summary:`, `reason:`, `artifacts:` one `- ` line each, `open questions:` one `- ` line each; every line goes through `escapeControlChars(line, true)` after splitting on `\r\n\|\r\|\n`; an invalid block → `✗ invalid handoff — <escapeFreeText(error)>`); `handoffDigestLine(split): string` (`✓ done → Grilling · 7 artifacts · 10 questions`, `escapeFreeText` on `next`); `collapseHandoffPromptSpans(text): string` (spans → indented digest text labelled `from "<step>" · untrusted`). `logs.ts`: `createEventFormatter({ handoffDigest: hidden })`; assistant → `before` raw, digest lines, `after` raw; a `you›` line's text → `collapseHandoffPromptSpans`. `Dashboard.tsx`: `buildHandoffLines(events, enabled)` → primitive `string \| null` per `eventKey`; `EventLine` renders the prose before the block (truncated) plus the `handoff›` line; `Detail` passes `task.pipelineParentId != null`; `you›` lines collapse spans the same way. `--json` is unchanged. | `src/shared/handoff-digest.ts` (new), `src/shared/handoff-digest.test.ts` (new), `src/cli/commands/logs.ts`, `src/cli/logs.test.ts`, `src/cli/tui/Dashboard.tsx`, `src/cli/tui/Dashboard.test.tsx` | T1 | U7 passes. A non-step task's `logs` and TUI output is byte-identical (asserted). |
| **T5** | Webview components (D3–D8, D13–D15, D17, D18, D20, D21, D10 hint). `handoff-context.tsx` (`HandoffViewContext`, `HandoffViewValue` per K6, `useHandoffView()`). `use-artifact-stats.ts` (K8). `HandoffArtifactChips.tsx`: card variant (chips, note as `title`, `+N` → `onMore`) and list variant (notes muted beside the path, `line` in the label, text rows with Copy). Open picks the first candidate `/refs/resolve` confirmed, else tries the candidates in order and only a 404 on all of them shows the not-found dialog; other failures → `AttachmentOpenErrorDialog`; dialogs portaled. Context menu: path → Open / Reveal in Finder / Copy path; URL → Open link / Copy link. Directory icons come from the stats. `HandoffDetails.tsx`: purpose, summary, reason as markdown (`ASSISTANT_MD_COMPONENTS` + `MD_URL_TRANSFORM`), artifacts (list variant), numbered open questions. `HandoffDialog.tsx`: `Dialog` portaled to `document.body`; header (title, `untrusted` badge for prompt-sourced data, status chip, Copy JSON with a "Copied" state, Formatted/Raw toggle, Close); context block (step, `next` per K9, usage when non-null); Raw = `JSON.stringify(handoff, null, 2)` in a `<pre>`. `HandoffCard.tsx`: `HandoffCard` (variants transcript/prompt/history; `line-clamp-4` summary; `? N open questions`; `Not used` chip; owns its dialog per K5; registers `useExpandOnJump` → shows `handoff-card-search-hint` when `handoffMatchLocation` says `"modal"`), `InvalidHandoffCard` (danger tone, error text, raw in a collapsed `<details>`), `HandoffFileCard` (prompt placeholders; Open → D18 lookup → modal, else `api.openPath`; the no-file variant has no button). `HandoffMessage.tsx`: `AssistantHandoffMessage({text, usage})` (before markdown → card or invalid card → after markdown, through `splitHandoffMessageCached`; with the context disabled or no block → the exact current `AssistantBlock` markdown) and `UserHandoffMarkdown({text})` (splits spans when enabled, else the exact current `ReactMarkdown` with `USER_MD_COMPONENTS`). `HandoffFileChip.tsx` (D18: label `Handoff from "<step>"` when the record resolves, else the basename; click → modal or OS-open; context menu Open file / Reveal in Finder). `expand-on-jump.ts` + `use-expand-on-jump.ts`: `detail` passed through. Semantic tokens only; no `bg-popover`. | `src/mainview/components/handoff/handoff-context.tsx`, `src/mainview/components/handoff/HandoffCard.tsx`, `src/mainview/components/handoff/HandoffDialog.tsx`, `src/mainview/components/handoff/HandoffDetails.tsx`, `src/mainview/components/handoff/HandoffArtifactChips.tsx`, `src/mainview/components/handoff/HandoffMessage.tsx`, `src/mainview/components/handoff/HandoffFileChip.tsx`, `src/mainview/lib/use-artifact-stats.ts` (all new), `src/mainview/lib/expand-on-jump.ts`, `src/mainview/lib/use-expand-on-jump.ts` | T4a, T4b | `bun run typecheck` is green. The existing callers of `useExpandOnJump` compile unchanged. Visual behaviour is verified by E1 (no jsdom in this repo). |
| **T6** | RunPanel wiring. The strip effect also sets `stepPipelineRun` (K7), with a debounced refetch on the parent's `pipeline` events and a reset at `:924`. `handoffView` memo per K6: `enabled = handoffCardsEnabled({isStepTask, kind, mainStream: activeStream === "main"})`; `record = run.history.find(h => h.taskId === task.id)`; `settledRunIds` from `runs`. `<HandoffViewContext.Provider>` wraps `RunEventList`. In `RunEventList`: an `indexLastHandoffEventByRun` memo (when enabled); the assistant case renders `<AssistantBlock text usage>`. `AssistantBlock` → `AssistantHandoffMessage`. `UserMessageBlock`'s ordinary branch → `UserHandoffMarkdown`. `findMatchingEventIds(..., { handoffCards: enabled })`. The `EXPAND_EVENT` dispatch carries `detail: { query: searchQuery }`. `MessageSegments`: text segment → `UserHandoffMarkdown`. `AttachmentChips`: when enabled and `parseHandoffFilePath(path, parentId)` matches → `<HandoffFileChip>`. | `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/components/kanban/MessageSegments.tsx`, `src/mainview/components/kanban/AttachmentChips.tsx` | T5 | Typecheck is green. A non-step task renders identically (E1 negative case). Existing e2e specs that touch RunPanel stay green (run `tagged-user-messages`, `markdown-images`, `sent-files`, `compaction-summary`, `pasted-content`). |
| **T8** | Run view and the e2e assertion. `HistoryRow`'s `<pre>` → `<div data-testid="pipeline-run-history-handoff">` holding `<HandoffCard variant="history">`. The context comes from a local `HandoffViewContext.Provider` per row, with `taskId = record.taskId`, roots from the parent task, `homeDir`, the graph and `stepId = record.stepId`. `MdImageScopeContext` uses the parent's roots (`allowLocal: true`). `PipelineRunView` gets a `homeDir` prop, passed in `App.tsx:2773`. `e2e/pipelines-run.spec.ts:365` `toContainText("schemaVersion")` → `toContainText("fake summary for")`. | `src/mainview/components/pipelines/PipelineRunView.tsx`, `src/mainview/App.tsx`, `e2e/pipelines-run.spec.ts` | T5 | Typecheck is green. `e2e/pipelines-run.spec.ts` and `e2e/pipeline-scroll-memory.spec.ts` pass (the test id is kept and stays visible on expand). |
| **T10** | Docs (D23). README "Structured handoffs" (`README.md:188`) and the "Handoff format and run control" `<details>` (`:199-215`): the card, the modal, artifacts, the run-view card, the prompt card, the `handoff›` digest, and the code-span rule (a fenced or inline-code tag is not a handoff). CLAUDE.md item 19 (`CLAUDE.md:59`): a new **Formatted handoff** paragraph (shared locator and its two modes plus the delta kinds; `splitHandoffMessage`/`splitHandoffPromptSpans`; `HandoffViewContext`; per-card portaled modal; usage rule; test ids; `:rich`/`:rich-blocked`/`:mention`/`:fenced` fake suffixes). Also edit the run-view history sentence (the `<pre>` is gone) and the reminder display paragraph (the reminder still renders as today). | `README.md`, `CLAUDE.md` | T6, T8 | Docs describe the shipped behaviour; no stale `<pre>` or "raw JSON" claims remain (grep `pipeline-run-history-handoff`, `JSON.stringify(record.handoff`). |

**Canonical rich handoff (T3 emits it; E1 copies it literally).** `purpose`: `"e2e rich purpose"`. `summary`: `"**Rich** handoff with \`code\` and a list:\n- one\n- two\n- three\n- four\n- five"`. `reason`: `"e2e rich reason uniquetoken-reason"`. `next`: `null`. `openQuestions`: `["First e2e question?", "Second e2e question?"]`. `artifacts`, in order:
1. `agetor-handoff/notes.md`
2. `<cwd>/agetor-handoff/report.txt`
3. `https://example.invalid/pr/1`
4. `agetor-handoff/notes.md (the plan)`
5. `agetor-handoff/notes.md:12`
6. `agetor-handoff/missing.md` (never written)
7. `jubarteai:00000000-0000-4000-8000-000000000000 (note)`
8. `commit 1234abc on feature/example`

So the card shows 6 chips plus `+2`, and the modal lists 2 text rows.

Note for T4a: `normalizePosixPath` is private in `lib/md-image.ts`. T4a keeps its own small copy, so `md-image.ts` is not touched in a wave where it isn't owned.

## 5. Work breakdown — test tasks

Unit and integration tests are written by the implementation task that owns the module (the same agent, same wave). That keeps each wave's barrier green.

| ID | Layer | Covers | Owned files (written by) | Acceptance |
| --- | --- | --- | --- | --- |
| **U1** | unit | T1 | `src/shared/handoff-locator.test.ts`, additions to `src/shared/pipeline.test.ts` (T1) | Locator, all synthetic: inline-code mention before a real block (the bug; the fixture includes a `{…}` in the prose between them, so the legacy mode fails as the real event did) → found; ``` ``<handoff>`` ``` → skipped; unmatched backtick in the same paragraph and no partner → found; unmatched backtick in an earlier paragraph plus a backtick inside the JSON → found; earliest-starting span swallowing the open tag → not found (A3); whole block in a ```` ``` ```` or `~~~` fence → not found; ```` ```json ```` inside the tags → found; unclosed fence before the block → not found; fence indented in a list item and behind `> ` → still a fence; 4-space indented block → **found** (A3); quoted tag inside a JSON string pairs as today; several real blocks → all returned, last wins; segments `["```\nunclosed", "<handoff>{…}</handoff>"]` → found, and the same text as one string → not found; open tag in segment 1 with close in segment 2 → found; tail window respected. `codeAware:false` reproduces every pre-change `parseHandoff` test and still gets the inline-mention case wrong (pins the legacy mode). Linear time, each < 100 ms: 50k unmatched backtick runs cycling lengths 1–50; 50k fence-like lines; 50k `` `<handoff>` `` mentions; the existing 50k unclosed opens. `pipeline.test.ts`: `parseHandoffInner` cases; `parseHandoff([...])` equals `parseHandoff(joined)` on code-free input; `splitHandoffMessage` (before/after/no block/invalid block with `raw`); `splitHandoffPromptSpans` round-trips `composeStepPrompt` output (inline JSON, too-large-with-file, too-large-no-file, saved-to-file, several previous steps, a lookalike `END-untrusted-handoff` inside JSON, mismatched nonces stay text, unparseable fenced body stays text); `handoffFileName` ↔ `parseHandoffFilePath` round trip, a wrong parent → null, a non-matching name → null; `findHandoffRecordForFile` (matching generation and seq, wrong generation → null, `record.handoff` null → null); `handoffScanIsCodeAware` (gemini/antigravity false, others and null true). |
| **U2** | integration (bun, real runner + fake driver) | T2 | `src/bun/pipeline-runner-handoff-locator.test.ts` (T2) | `:mention` → the run reaches `done`, the record has `responseKind:"handoff"` and `reminder` null, and no reminder `user` event exists. `:fenced-then-done` → `reminder.reason === "handoff-missing"`, then `done`. The runner writes handoff files whose names `parseHandoffFilePath` accepts. The suite calls `initPipelineRunner()`, uses `mkdtemp` data dirs and `rmTestDataDir`, and polls `pipelineRun` (CLAUDE.md item 19). |
| **U3** | unit | T3 | `src/bun/agents-fake-handoff.test.ts` (T3) | `rich`/`rich-blocked` emit text whose `splitHandoffMessage` result matches the canonical handoff, and both files exist in cwd. `mention` text, under the code-aware parser → ok; under `codeAware:false` → not ok. `fenced` → `handoff-missing`. `fenced-then-done` turn 2 → valid. `done`/`missing`/`invalid` output is unchanged. |
| **U4a** | unit | T4a | `src/mainview/lib/handoff-artifacts.test.ts` (T4a) | Every shape and rule in T4a's row, with synthetic paths only; `cardArtifacts` with 8 entries (6 chips, `hiddenCount` 2) and with fewer than 6. |
| **U4b** | unit | T4b | `src/mainview/lib/handoff-view.test.ts`, `src/mainview/lib/event-search.test.ts` (T4b) | Status chip (absent → done); next label for every `resolveNextSteps` outcome plus graph-null and unknown-step-id; `handoffUsage` truth table (D21: no record, null `handoffRunId`, different run, same run last block, same run earlier block, unsettled run); `handoffMatchLocation` (chip label → card, reason → modal, 7th artifact → modal, no hit → null); `indexLastHandoffEventByRun` skips subagent events and blocks in code; LRU returns the same object for the same text; `handoffCardsEnabled` truth table. Search: `schemaVersion` no longer matches a step task's assistant event with `handoffCards`, a summary word does, prose around the block still matches, a non-step task matches the raw text as before, and a user prompt's span matches values not keys. |
| **U7** | unit | T7 | `src/shared/handoff-digest.test.ts`, `src/cli/logs.test.ts`, `src/cli/tui/Dashboard.test.tsx` (T7) | Digest lines for done, blocked, `next:null`, multi-line summary, and control characters escaped (ESC shown as `\u001b`, bidi override escaped); the one-line form; invalid form; `collapseHandoffPromptSpans`. `cmdLogs --rebuild` on a step task prints the `handoff›` digest and on a non-step task prints the raw text (byte-identical). `buildHandoffLines` returns primitives, null for non-block events and for disabled. |
| **E1** | e2e (Playwright) | T5, T6, T8 (and T1–T3 end to end) | `e2e/formatted-handoff.spec.ts` (new; its own task in wave 5) | Scenarios below. |

**E2e decision: applies.** The change is a user-visible flow across the webview, the API and the runner.

**Run recipe:**
- Setup: `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"; bun install` (this worktree has no `node_modules`).
- Run: `bun node_modules/@playwright/test/cli.js test e2e/formatted-handoff.spec.ts`, then `e2e/pipelines-run.spec.ts` and `e2e/pipeline-scroll-memory.spec.ts`, then the RunPanel specs named in T6's acceptance. Run **one Playwright invocation at a time** (port collisions).
- The fixture starts Vite and the headless backends itself, with `AGETOR_CLAUDE_DRIVER=fake`. No credentials and no network.
- Seed data: REST helpers from `e2e/scroll-memory-helpers.ts`. The spec builds its own task-create helper that passes a `mkdtempSync(join(tmpdir(), "agetor-handoff-e2e-"))` workdir with `isolation:"none"`, so the fake writes `agetor-handoff/*` into a per-test directory and `missing.md` is truly missing. Use `test.use({ backendEnv: { AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS: "300" } })`.

**E1 scenarios** (each one asserts the test ids above):
1. **Card.** Two-step pipeline A (`:rich`) → B (`:done`). Wait for `done`, open the run view, click node A. In A's panel:
   - `handoff-card` has `data-status="done"`, `handoff-card-next` reads `→ B` (single edge, K9), `handoff-card-summary` contains "Rich", 6 `handoff-card-artifact` + `handoff-card-more` reads `+2`, and `handoff-card-questions` reads `? 2 open questions`.
   - The prose "Here is the rich handoff." renders above the card.
   - The card's `[data-evid]` wrapper contains no literal `</handoff>`. Scope this to the wrapper: the step's prompt bubble legitimately quotes the tag in its contract text.
2. **Modal.** `handoff-card-open` → `handoff-dialog` shows:
   - step "A", next "B", `handoff-dialog-usage` with `data-usage="used"`;
   - 2 `handoff-dialog-artifact-text` rows, 2 questions.
   - Raw toggle shows `"schemaVersion": 1`.
   - Copy JSON, with clipboard permissions granted → the clipboard JSON parses and its `reason` is `e2e rich reason uniquetoken-reason`.
   - Escape closes only the modal; the panel stays open.
3. **Artifacts.**
   - The missing chip gets `data-missing="true"`; clicking it opens the not-found dialog.
   - Clicking an existing chip opens the 501 "couldn't open" dialog.
   - Right-click → `handoff-artifact-menu` → "Reveal in Finder" → the 501 dialog.
   - The URL chip has `data-artifact-kind="url"`.
4. **Run view.** Expand A's history row: `pipeline-run-history-handoff` contains `handoff-card[data-variant="history"]` and the text "Rich"; Open → `handoff-dialog`.
5. **Prompt card + D18.** In B's panel:
   - `handoff-card[data-variant="prompt"]` contains `Handoff from "A" · untrusted`.
   - `handoff-file-chip` → `handoff-dialog` showing A's reason.
6. **Invalid.** Single step `:invalid-then-done`: `handoff-invalid-card` is visible with `handoff-invalid-raw` collapsed, and a valid `handoff-card` follows the reminder bubble.
7. **Blocked.** Single step `:rich-blocked`: `handoff-card[data-status="blocked"]`.
8. **Search.** In A's panel, Cmd+F and type `uniquetoken-reason`, Enter → the matched `[data-evid]` wrapper contains the card, and `handoff-card-search-hint` is visible. (Don't assert on `schemaVersion` here: the prompt's contract text contains it. U4b covers the key rule.)
9. **Gating.** A plain (non-pipeline) task whose prompt carries `__agetor_fake_claude_handoff__:rich` shows raw text and no `handoff-card`.
10. **Mention.** Single step `:mention`: the card renders, the history row has no `pipeline-run-reminder` chip, and the run reaches `done`.

## 6. Execution waves

| Wave | Tasks (parallel) | Barrier |
| --- | --- | --- |
| 1 | T1, T3, T4a | `bun run typecheck` + `bun test src/shared src/bun/agents-fake-handoff.test.ts src/mainview/lib/handoff-artifacts.test.ts` green, then the full `bun test`. Checkpoint commit. |
| 2 | T2, T4b, T7 | Full `bun test` + typecheck green. Checkpoint commit. |
| 3 | T5 | Typecheck green; `bun test src/mainview` green. Checkpoint commit. |
| 4 | T6, T8 | Typecheck + `bun test` green. Run `e2e/pipelines-run.spec.ts` and `e2e/pipeline-scroll-memory.spec.ts`, then T6's RunPanel spec list. Checkpoint commit. |
| 5 | E1, T10 | `e2e/formatted-handoff.spec.ts` green, the wave-4 specs re-run green, and the docs grep in T10 clean. Final commit. |

Owned-file cross-check:
- **Wave 1:** T1 {`handoff-locator.ts`, `handoff-locator.test.ts`, `pipeline.ts`, `pipeline.test.ts`}, T3 {`agents.ts`, `agents-fake-handoff.test.ts`}, T4a {`handoff-artifacts.ts`, `handoff-artifacts.test.ts`}. Disjoint.
- **Wave 2:** T2 {`pipeline-runner.ts`, `pipeline-runner-handoff-locator.test.ts`}, T4b {`handoff-view.ts`, `handoff-view.test.ts`, `event-search.ts`, `event-search.test.ts`}, T7 {`handoff-digest.ts`, `handoff-digest.test.ts`, `logs.ts`, `logs.test.ts`, `Dashboard.tsx`, `Dashboard.test.tsx`}. Disjoint.
- **Wave 4:** T6 {`RunPanel.tsx`, `MessageSegments.tsx`, `AttachmentChips.tsx`}, T8 {`PipelineRunView.tsx`, `App.tsx`, `e2e/pipelines-run.spec.ts`}. Disjoint.
- **Wave 5:** E1 {`e2e/formatted-handoff.spec.ts`}, T10 {`README.md`, `CLAUDE.md`}. Disjoint.

No barrier is knowingly red. `e2e/pipelines-run.spec.ts:365` breaks only when the history `<pre>` is replaced, and T8 changes both in the same task.

## 7. Blast radius & risks

- **Runner classification change (behavioural).** It only affects message-level harnesses, and only messages with a tag inside inline code or a fence. A mention before a real block now advances: the bug fix, seen once in the owner's data. A fully fenced block becomes `handoff-missing` → one reminder; there are 0 such blocks in the data. Risk: a stray unmatched backtick in the same paragraph as `<handoff>` plus a backtick in the JSON → `handoff-missing` → one reminder. The reminder arrives as a new message, so the fresh code state finds the block (benign; pinned in U1). Persisted `responseKind` values are not rewritten (D16).
- **Delta kinds.** Gemini and antigravity keep the legacy scan (no change) and get no cards. Their existing `"\n"` join weakness is untouched (out of scope).
- **Callers of `parseHandoff`/`classifyStepResponse`:** `pipeline-runner.ts`, `pipeline.test.ts`, `pipeline-runner.test.ts` (comments), `bundle.test.ts` (normalize only), `db.ts` (comment). All accept `string` as before. `HANDOFF_TAG` stays importable from `pipeline.ts` (re-export), which `agents.ts` and the tests rely on.
- **RunPanel invariants.** One new per-task state (`stepPipelineRun`) gets a reset line. No new keyed child in `RunPanelBody`'s fragment (K5). `AssistantBlock`'s `memo` gets primitive props only. The `blocks` memo gains the usage index as a dependency, which recomputes only on event changes. Non-step tasks are byte-identical by construction (the context is disabled).
- **Performance.** The locator is about 0.06 ms per event, and the LRU means a streamed event costs one scan. Cards fetch nothing per render: one cached `/refs/resolve` per card set. The parent-run refetch is debounced 500 ms and only runs while a step panel is open.
- **Connection budget (WKWebView ~6).** No new stream. One extra GET per `pipeline` event burst, only on step panels.
- **Security / trust.** The same tier as today. Artifacts open through the existing desktop-only `/open-path`, `/reveal-path` and `/open-external` (http, https and mailto only). `/refs/resolve` stats agent-chosen absolute paths in-process for the app caller, as `SentFilesCard` already does; a `stat` doesn't raise a TCC prompt. Prompt-sourced cards carry an **untrusted** badge (D17). Handoff markdown renders through the existing components (no `rehype-raw`). The modal shows normalized data (≤ 64 KB).
- **E2E surfaces touched:** `pipelines-run.spec.ts:365` (changed by T8), and `pipeline-scroll-memory.spec.ts` (test id kept). Specs asserting step prompt text (the `## Delegation` lines) keep passing, because spans don't cover that text.
- **Rollback.** No migration and no API change. Reverting the commits restores the old behaviour. Nothing persisted changes shape.

## 8. Open questions / assumptions

- **A1 — Gemini handoffs: decided by the owner at approval (2026-10-29).** Gemini delta-streams exactly like Antigravity (`gemini-tmux.ts:157`). Owner's answer: "Stay raw, like Antigravity". Gemini keeps the legacy runner scan and renders no cards (owner-deferred, same as D11).
- **A2 — `next` label** follows what `resolveNextSteps` resolves (K9), so a single-edge step with `next:null` reads `→ B`, not `Last step`. This refines D14 using the runner's own semantics.
- **A3 — Code-span rules** (K1) as pinned by U1:
  - inline spans are paragraph-bounded, with earliest-start precedence;
  - fences are detected at any indentation and behind blockquote markers;
  - 4-space indented code is not treated as code.
  The runner and the UI share them, so they can't disagree. Only fidelity to react-markdown's rendering is at stake. Synthetic fixtures only.
- **A4 — Search on the prompt bubble.** D10's "values, not keys" rule also applies to the untrusted spans in a step's prompt bubble, consistent with D10's intent.
- **A5 — Modal per card, portaled** (K5). This answers the grill's open question 2.
- **A6 — Chip counting.** The card's 6 chips are the first 6 *non-text* artifacts, and `+N` counts every remaining entry, free text included (D20: free text is modal-only).
- **A7 — `~/` artifacts** expand against `homeDir` (RunPanel already has it; the run view gets a prop). With no `homeDir`, they render as copy-only text.
- **A8 — "Run not settled"** (D21) comes from RunPanel's polled `runs`. A run still `running` shows no usage chip.
- **A9 — CLI/TUI gating** is step-task only (K10). A delta-kind step whose single event happens to hold a whole block would print a digest. That is harmless, and the runner reads the same block.
- **A10 — CLI/TUI prompt spans** are collapsed into digest text (T7). That brings D1b to the terminal for completeness; `--json` stays raw.

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| Shared code-aware locator; runner inline-mention bug; fenced block → missing | In this run | T1, T2 (D2, D12) |
| `parseHandoff`/`classifyStepResponse` segment support; legacy mode kept | In this run | T1 |
| Runner file-name builder shared with the D18 parser | In this run | T1, T2 |
| Fake driver `rich`, `rich-blocked`, `mention`, `fenced`, `fenced-then-*` | In this run | T3 (D22) |
| Artifact classifier (9 shapes + `~/`, `file://`, mailto) | In this run | T4a |
| View-model helpers (status, next, usage, match location, cache, gate) | In this run | T4b |
| Search indexes field values; jump hint (D10) | In this run | T4b, T5, T6 |
| `expand-on-jump` detail carrying the query | In this run | T5 (hook), T6 (dispatch) |
| Transcript card, invalid card, modal, chips, context menu, stats | In this run | T5, T6 (D3–D8, D13–D15, D20, D21) |
| Prompt-bubble cards incl. placeholders (ordinary + tagged branches) | In this run | T5, T6 (D1b, D17) |
| Handoff-file chip → modal (D18) | In this run | T5, T6 |
| Run-view history `<pre>` → card + modal; `homeDir` prop | In this run | T8 (D1a) |
| Parent run kept live on step panels (refetch on `pipeline` events) | In this run | T6 (K7) |
| `agetor logs` + TUI `handoff›` digest | In this run | T7 (D19) |
| CLI/TUI prompt-span collapse | In this run | T7 (A10) |
| `e2e/pipelines-run.spec.ts:365` `schemaVersion` assertion | In this run | T8 |
| `e2e/pipeline-scroll-memory.spec.ts` test id | In this run (kept, verified) | T8 |
| New e2e spec | In this run | E1 |
| README + CLAUDE.md item 19 | In this run | T10 (D23) |
| Orphaned code: run-view `<pre>`; old `findLastHandoffBlock` | In this run (removed) | T8, T1 |
| Existing data backfill | None needed | Render-only; persisted `responseKind` stays as recorded (D16) |
| Antigravity delta-streamed handoffs stay raw | Owner-deferred | Owner, grill D11 |
| Gemini delta-streamed handoffs stay raw | Owner-deferred | Owner, at plan approval on 2026-10-29 (A1); same mechanism as D11 |
| Delta kinds' `"\n"`-join JSON corruption in the runner | Out of scope | A pre-existing runner limitation of gemini/antigravity, unrelated to rendering; changing it alters classification for those harnesses (a different ticket) |
| In-app text/markdown preview of artifacts | Out of scope | Owner chose OS-open (D7); needs a new D26 reader route |
| Jump to a line for `path:N` | Out of scope | `/open-path` takes no line; owner decided label-only (D20) |
| Cards in non-step tasks and subagent tabs | Out of scope | Owner gating (D9) |
| `agetor pipeline status` handoff content | Out of scope | Prints none today; the `logs` digest covers the CLI (grill ledger) |
| Telling agents in the contract or the reminder not to fence the block | Out of scope | The contract already prescribes the exact unfenced format and the reminder repeats it (D12); the data has 0 fenced blocks |

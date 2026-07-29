# Plan — Search in the task details message stream

| Field | Value |
| --- | --- |
| Date | 2026-07-29 |
| Source | /implement "Add Search support in task details messages" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/task-details-messages-search |
| Base SHA | ce9177b34816982f2aeebbba15fefb8dde8bd827 |
| Mode | **Autonomous** — grill and plan-approval gates bypassed; all assumptions logged in §8 |

## 1. Objective & success criteria

Add an in-panel search over the task details modal's unified message stream (RunPanel):

- A search toggle (Search icon) in the panel header opens a search bar; Cmd/Ctrl+F also opens it while the panel is open.
- Typing a query matches events in the **currently displayed stream** (main tab or the active subagent tab) case-insensitively against their human-visible text.
- The bar shows `current/total` match count with prev/next navigation (buttons + Enter / Shift+Enter); navigating scrolls the matched event block into view and visually highlights it (ring on the block — no intra-markdown `<mark>` in v1).
- Escape closes the search bar (and only then, on a second Escape, the panel). Closing clears the highlight.
- `bun run typecheck` and `bun test` green.

## 2. Context & constraints (Phase 1 findings)

- `RunPanel.tsx` holds `events: StreamEvent[]` (`RunEvent & { id: number }`, client-assigned monotonic ids) at `RunPanel.tsx:258`; `displayedEvents` (`RunPanel.tsx:666-671`) is what the active tab renders — search must operate on exactly this slice.
- `RunEventList` (`RunPanel.tsx:2368-2517`) groups events into sections split on `user` messages via a perf-critical `sections` useMemo; block components are module-scope `memo()` wrappers. **No per-event DOM identity exists** — scroll-to-match needs a `data-evid` attribute added at render time.
- Autoscroll: two pin-to-bottom effects (`RunPanel.tsx:539-556`) gated on `nearBottomRef` (updated by native `onScroll`). Jumping to a mid-stream match moves scrollTop away from bottom, which flips `nearBottomRef` false via onScroll — no explicit suppression needed, but scrollIntoView must use the log container, `block: "center"`.
- Markdown perf trap: `ReactMarkdown` `components` maps are hoisted for identity stability (`RunPanel.tsx:2644-2687`). Per-keystroke intra-markdown highlighting would defeat this → **out of scope for v1**.
- Event shapes (`src/shared/types.ts:1660-1698`): `user|assistant|thinking` carry markdown text in `data`; `tool_use|tool_result|interaction` carry JSON strings; `status|stderr|stdout` plain text; `interaction|interaction_resolved|subagent` streams are not rendered in the log list.
- Repo conventions: pure logic in `src/mainview/lib/*.ts` (no React imports) + co-located `bun:test` file; no DOM test harness exists. Header button row at `RunPanel.tsx:1355-1418`; existing search-input visual pattern in `KanbanFilters.tsx:110-118` (relative div + `Search` icon + `Input` with `pl-8`).
- Escape-to-close-panel document keydown listener exists (`RunPanel.tsx:176-186` area); search's Escape handling must take precedence when the bar is open.
- Active peer `large-fern-b9b5` is working on an "Open PR" button feature that may also touch RunPanel — messaged; merge conflicts, if any, resolve at PR time.

## 3. Approach & key decisions

- **Match on extracted searchable text, event-level granularity.** A pure helper extracts a searchable string per event (markdown/plain text verbatim; tool events → tool name + input/result text best-effort from JSON). Matches are event ids; navigation steps between matched events, not per-occurrence. Alternative (per-occurrence with intra-text `<mark>`) rejected for v1 due to the ReactMarkdown identity/perf constraint.
- **Active-tab scope.** Search runs over `displayedEvents` only; switching tabs recomputes matches automatically (useMemo dep) and resets the active index. Cross-tab search deferred.
- **Highlight = ring on the active matched block wrapper** (`data-evid` div gets a highlight class when active). Cheap, no markdown re-render.
- **Matching recomputes per keystroke** in a useMemo (O(total text)); acceptable for realistic log sizes; the extraction of searchable text is a per-event pure function so it can be trivially cached later if needed.
- Search is read-only → **no `activeStream === "main"` gating** (works on subagent tabs and archived tasks).

## 4. Work breakdown — implementation tasks

### Task A (single implementation agent — sequential internally, disjoint from nothing else in flight)
1. **`src/mainview/lib/event-search.ts`** (new): pure module, no React imports, top-of-file "why" comment. Exports:
   - `searchableEventText(stream: RunEventStream, data: string): string | null` — null for non-rendered streams (`interaction`, `interaction_resolved`, `subagent`); tool events parse JSON best-effort (never throw) and concatenate name/input/result text.
   - `findMatchingEventIds(events: ReadonlyArray<{ id: number; stream: RunEventStream; data: string }>, query: string): number[]` — trimmed, case-insensitive substring; empty query → `[]`.
   - `stepMatchIndex(matchCount: number, current: number, dir: 1 | -1): number` — wraparound navigation; `resolveActiveMatchIndex(matches: number[], prevActiveId: number | null): number` — keep the previously-active match selected across recomputes when still present, else clamp to last/first sensibly.
2. **`src/mainview/components/kanban/RunPanel.tsx`** wiring:
   - State: `searchOpen`, `searchQuery`, `activeMatchId: number | null`.
   - `matches = useMemo(findMatchingEventIds(displayedEvents, searchQuery), [displayedEvents, searchQuery])`.
   - Header: Search icon toggle button (ghost, before close X), tooltip/`title="Search messages"`.
   - Search bar row rendered between header and the log scroller when open: Input (auto-focused, `KanbanFilters` visual pattern), `n/N` counter, ChevronUp/ChevronDown prev/next buttons, X close. Enter → next, Shift+Enter → prev, Escape → close (stopPropagation so the panel stays open).
   - Panel-level Cmd/Ctrl+F keydown → open + focus (preventDefault); guard consistent with existing Escape listener's dialog guards.
   - `RunEventList`: wrap each rendered event block in a `div` carrying `data-evid={e.id}` and a conditional highlight class when `e.id === activeMatchId` (pass `activeMatchId` as a prop; sections useMemo gains that dep — keep the ring styling on the wrapper so memoized block components are untouched).
   - Effect: on `activeMatchId` change, `logRef.current?.querySelector('[data-evid="..."]')?.scrollIntoView({ block: "center" })`.
   - Reset `activeMatchId` on tab switch / task switch; closing search clears query + highlight.

Acceptance: typecheck green; behavior per §1.

## 5. Work breakdown — test tasks

### Task T1 — `src/mainview/lib/event-search.test.ts` (new)
`bun:test` over the pure module: extraction per stream type (markdown passthrough, tool_use/tool_result JSON incl. malformed JSON, null streams), match filtering (case-insensitivity, trim, empty query, no matches), navigation math (wraparound both directions, active-match preservation across recompute, clamping when matches shrink).

## 6. Execution waves

- Wave 1: Task A (one sonnet agent).
- Phase 5: opus review of the diff vs `ce9177b`.
- Phase 6: Task T1 (one sonnet agent) — file-disjoint from nothing in flight.
- Phase 7: haiku agent runs `bun run typecheck` + `bun test`.
- Phase 8: fixes if needed.

## 7. Blast radius & risks

- `RunEventList` sections useMemo gains an `activeMatchId` dep — changing the active match re-renders the section list wrapper divs, but memoized block components keep bailing out (props unchanged). Risk: accidental prop identity churn — reviewer should check.
- Wrapper `div` per event block changes DOM nesting inside sections — verify no CSS relies on direct-child selectors there.
- Escape precedence vs the existing panel-close listener; and Cmd+F must not fire while other dialogs (diff, confirm) are open.
- Autoscroll: while a run is streaming, a new event burst pins to bottom only when `nearBottomRef` is true; after jumping to a match the user is mid-stream so pinning stays off — matches existing reading behavior.
- Peer branch may conflict in RunPanel at merge time (coordinated via fleet message).

## 8. Open questions / assumptions (autonomous mode — gates bypassed)

1. **Scope**: active tab only; no cross-subagent-tab search. (Assumed simplest v1.)
2. **Granularity**: event-level matches, not per-occurrence text highlighting; no `<mark>` inside markdown in v1 (perf constraint).
3. **Persistence**: search state is ephemeral — resets on panel close/task switch; not persisted like the composer draft.
4. **Match source**: raw event text (plus tool JSON best-effort), not post-`prompt-noise`/`command-message` transformed text; acceptable v1 approximation.
5. **Shortcut**: Cmd/Ctrl+F is intercepted only while the task panel is open and no other dialog is open.

# Plan — Collapsible tool-call blocks in the task-details message stream

| Field | Value |
| --- | --- |
| Date | 2026-08-08 |
| Source | /implement — "tool calls are being very noisy in the messages, let's make them collapsible, default to collapsed/closed" + screenshot |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/make-tools-collapisable-in-task-details |
| Base SHA | ce9a842b093219cdb278fdc540cc1a47c25596a9 |

## 1. Objective & success criteria

Tool-call cards (`tool_use` + folded `tool_result`) in the RunPanel message stream currently render their full args JSON and result body inline, which drowns the conversation. Make each tool-call card collapsible, **collapsed by default**: only the compact header row (icon, tool name, badges, `· summary`) is visible until the user clicks to expand.

Success criteria:
- A tool-call card renders only its header row by default; clicking the header toggles the args body (+ result section) open/closed.
- Interactive tool calls (`AskUserQuestion`, `ExitPlanMode`) **stay expanded while unresolved** (their call-to-action banner must remain visible); once resolved they behave like any other collapsed card. (Owner-confirmed.)
- A card whose result `isError` still defaults to collapsed but shows a visible error flag in the collapsed header. (Owner-confirmed.)
- Search-jump (Cmd+F) onto a match inside a collapsed card **auto-expands** it so the matched text is visible. (Owner-confirmed.)
- No behavior change for other event kinds (user / assistant / thinking / status / stderr / interaction cards).
- No perf regression: the `sections` memo (`RunPanel.tsx:3591`) gains **no new deps**; expand state is component-local and survives 2s polls and event appends.

## 2. Context & constraints (Phase 1 findings)

All relevant code is in `src/mainview/components/kanban/RunPanel.tsx` (file-local components, one call site):

- `renderEvent` (`RunPanel.tsx:3624-3672`) renders `tool_use` as `<ToolUseBlock call result>`; a well-formed `tool_result` renders **nothing** of its own — it's folded into the owning block via the `resultByToolId` map (`:3544`). Orphan results render `<ToolResultBlock>` (`:4201`).
- `ToolUseBlock` (`:4157-4199`, `memo`'d): header row div (`:4173-4187`) → `ToolInputBody` (always visible today) → optional `ToolResultBody` (has its own `▶ result` fold, default closed, `:4545`) → interactive-pending banner (`:4190-4196`).
- Collapse idiom in this file is hand-rolled: `useState(false)` + full-width `<button>` with unicode `▶`/`▼` glyphs (`ThinkingBlock` `:4132`, `ToolResultBody` `:4545`). No shared Collapsible primitive exists; icon library is lucide but these toggles use text glyphs.
- **Perf trap (fleet knowledge, verified):** the `sections` memo must not take per-interaction state as a dep — search's active-match highlight is applied *imperatively* via `classList` on the `[data-evid]` wrapper (`:1296-1323`) precisely to avoid rebuilding the section tree. Auto-expand must use the same imperative channel, not props.
- React reconciles blocks by array position + stable key (`${e.ts}-${i}`), so `useState` inside `ToolUseBlock` survives polls/appends — local state is safe.
- Subagent (background-agent) tabs feed the same `<RunEventList>`; the change applies there automatically. `DiffDialog` is unrelated.
- Mainview test convention: pure-logic `.ts` modules under `src/mainview/lib/` with `bun test` (no React render testing exists; no jsdom/@testing-library in deps).

## 3. Approach & key decisions

1. **Local `useState(false)` in `ToolUseBlock`; effective expansion = `open || (isInteractive && !result)`.** Forced-open while an interactive call is pending (banner stays visible); when the result lands, the forced term drops and the card collapses like the rest. No persistence (matches `ThinkingBlock`/`ToolResultBody` precedent; per-block localStorage keying would be overkill — decision).
2. **Header row becomes the toggle button.** Convert the header div to a full-width `<button type="button">` prepending the `▶`/`▼` glyph (matching the file's idiom), keeping icon, MCP badge, name, `server` badge, and summary exactly as-is. `border-b` on the header renders only when the card is expanded (no dangling divider on a collapsed card).
3. **Error flag:** when `result?.isError` and the card is collapsed, append a `<span className="text-destructive">· error</span>` to the header (expanded cards already show the `error result` section label).
4. **Search auto-expand via a bubbling CustomEvent — the imperative channel.** New pure module `src/mainview/lib/expand-on-jump.ts`: exports `EXPAND_EVENT` name constant and `isExpandTargetFor(target: unknown, root: Element | null): boolean` (target is a Node that contains root). The active-match highlight effect (`RunPanel.tsx:1305-1323`) additionally dispatches `new CustomEvent(EXPAND_EVENT, { bubbles: true })` on the matched `[data-evid]` element. A tiny hook `useExpandOnJump(rootRef, onExpand)` (defined in `RunPanel.tsx`, next to the blocks) registers a document-level listener and calls `onExpand()` when `isExpandTargetFor(evt.target, rootRef.current)`. Wired into:
   - `ToolUseBlock` → opens the card;
   - `ToolResultBody` → opens the result fold (search folds result text into the owning tool_use, so the outer card alone isn't enough);
   - `ThinkingBlock` → fixes the same preexisting gap for thinking matches at near-zero cost.
   This keeps `sections`-memo deps untouched and adds no props to memo'd components (rests on the verified imperative-highlight design at `:1296`).
5. **Out of scope:** expand-all/collapse-all control; persistence of expand state; any change to `ExpandableBlock`, orphan `ToolResultBlock` chrome, or other event kinds.

## 4. Work breakdown — implementation tasks

| ID | Goal | Files owned | Deps | Acceptance |
| --- | --- | --- | --- | --- |
| I1 | Collapsible ToolUseBlock + header toggle + error flag + expand-on-jump wiring (incl. ToolResultBody & ThinkingBlock listeners) + new `expand-on-jump.ts` helper | `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/lib/expand-on-jump.ts` | — | Criteria §1; `bun run typecheck` green |

Single task — the components are file-local and interdependent; splitting would force two agents into one file.

## 5. Work breakdown — test tasks

| ID | Goal | Files owned | Covers | 
| --- | --- | --- | --- |
| T1 | Unit tests for `isExpandTargetFor` (node containing root, node === root wrapper, unrelated node, null root, non-Node target) | `src/mainview/lib/expand-on-jump.test.ts` | I1 |

**E2e: not applicable.** The mainview has no render/e2e harness (no jsdom, no @testing-library, no browser test runner) — repo convention is pure-logic extraction + `bun test`, with visual QA via `bun run dev:hmr`. The JSX changes get manual visual verification; standing up a render harness for one toggle is out of proportion (recorded decision).

## 6. Execution waves

- Wave 1: I1 (one implementation agent, sonnet).
- Review: full diff vs base (opus).
- Wave 2: T1 (one test agent, sonnet) → run `bun test` + `bun run typecheck` (haiku).

## 7. Blast radius & risks

- `ToolUseBlock` is file-local with a single render path; subagent tabs inherit the change (intended).
- Header→button conversion: keep inner elements non-interactive (no nested buttons — the header currently has none) to avoid invalid DOM.
- Collapsed-by-default shrinks stream height; bottom-pin uses a ResizeObserver (prior fix) so auto-scroll is unaffected.
- Forced-open interactive cards: `isInteractive && !result` is the existing banner condition (`:4190`) — reuse it verbatim so the two can't drift.
- Document-level listeners: one per mounted block; removed on unmount via the hook's cleanup. Long streams mount hundreds of blocks — listener work is O(blocks) only on a jump (rare, user-initiated), negligible.

## 8. Open questions / assumptions

- Assumption: no persistence of per-block expand state across reloads (session-local only). Not raised by owner; matches all sibling toggles.
- Assumption: unicode `▶`/`▼` glyphs (file idiom) rather than lucide chevrons.

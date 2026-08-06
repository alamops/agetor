# Plan — Task Details opens with the messages list pinned to the bottom

| Field | Value |
| --- | --- |
| Date | 2026-07-30 |
| Source | /implement: "when opening Task Details, we must load the messages list already auto scrolled to the bottom" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/missing-auto-scroll-to-bottom |
| Base SHA | ce9177b34816982f2aeebbba15fefb8dde8bd827 |
| Mode | Autonomous — grill and plan-approval gates bypassed; assumptions logged in §8 |

## 1. Objective & success criteria

Opening the Task Details slide-over (RunPanel) must land the unified message
stream at the very bottom (latest message) and stay there through the initial
load, regardless of conversation length, async layout growth, or how long the
event replay takes. A user who scrolls up must still never be yanked back down
(existing `nearBottomRef` contract preserved).

## 2. Context & constraints (Phase 1 findings)

The panel already has two pin paths, both from `8f9c0cf` — the first attempt at
this same bug:

- Path 1 (`RunPanel.tsx:539-543`): post-commit pin on
  `[events, rebuilt, interactions.length, activeStream]`.
- Path 2 (`RunPanel.tsx:545-556`): a rAF loop pinned for a **fixed 600ms
  window anchored to `task.id` mount time**.

Root causes of the remaining misses (ranked, from investigation):

1. **Above-the-fold async layout** — `SubagentTabs` (`:1440`) and friends mount
   from `api.listRuns` / `api.listSubagents` resolutions; neither pin path
   watches those, and when they land after the 600ms window the log viewport
   shrinks with no re-pin.
2. **`UserMessageBlock.needsToggle`** (`:2712-2719`) — collapsed user bubbles
   measure themselves post-mount and add "Show more" buttons; local child
   state, invisible to path 1's deps; only path 2's expiring window covers it.
3. **The 600ms deadline races unrelated async work** — SSE connect + replay
   flush cadence (`event-buffer.ts`, `FLUSH_FALLBACK_MS = 250`) can consume
   the window before content has settled.

Constraints:

- No DOM test harness (no jsdom/happy-dom/testing-library; zero `*.test.tsx`).
  Fleet precedent: scroll fixes in this file are verified manually in
  `bun run dev:hmr`.
- WKWebView (Electrobun) — `ResizeObserver` fully supported.
- The `logRef` container renders three conditional content states with no
  single inner wrapper (`:1473-1507`).
- `pendingAdjustRef` collapse compensation (`:2721-2726`) adjusts `scrollTop`
  synchronously in a layout effect; its scroll event re-derives
  `nearBottomRef` before any observer fires, so the two mechanisms stay
  consistent (observer only pins when still near-bottom afterwards).

## 3. Approach & key decisions

**Chosen: ResizeObserver-driven pin (Option A).** Replace the fixed-window rAF
loop with a `ResizeObserver` that re-applies `scrollTop = scrollHeight`
whenever `nearBottomRef.current` is true and either (a) the scroll container's
own box changes (viewport shrink — covers SubagentTabs/terminals mounting
above), or (b) the content's height changes (covers markdown/toggle/replay
growth). Event-driven, cause-agnostic, self-healing against future async
widgets. Keep pin path 1 (post-commit pin avoids a one-frame lag on streamed
events).

**Rejected: broaden dependency arrays + extend window (Option B)** — still
enumerative; every future async layout source would need manual registration,
which is exactly how root cause #1 crept in after `8f9c0cf`.

No feedback-loop risk: assigning `scrollTop` changes no element's size, so the
observer does not re-fire from its own pin; the programmatic scroll event
recomputes `nearBottomRef` to `true` (we are at the bottom), preserving the
gate.

## 4. Work breakdown — implementation tasks

**T1 — ResizeObserver pin in RunPanel** (single task; one file)
- Owns: `src/mainview/components/kanban/RunPanel.tsx` only.
- Add `logContentRef` and wrap **all three** conditional content states inside
  `logRef` in one plain `<div ref={logContentRef}>` (no classes needed beyond
  what layout requires — must not break `min-w-0` shrink behavior or the
  sticky user-bubble positioning; the wrapper spans full content height so
  sticky containment is unchanged).
- Replace the 600ms rAF-loop effect (`:545-556`) with a `ResizeObserver`
  effect: observe `logRef.current` and `logContentRef.current`; on any resize,
  if `nearBottomRef.current`, set `el.scrollTop = el.scrollHeight`.
  Disconnect on cleanup. Mount-scoped deps (`[]`) are correct — both DOM nodes
  persist across task switches (RunPanelBody does not remount on task change);
  the initial `observe()` callback delivers once per element, giving the
  mount-time pin.
- Keep pin path 1 and the `nearBottomRef` re-arm on `[task.id]` untouched.
- Acceptance: opening a long task with subagent tabs + long user messages
  lands at bottom; scrolling up during streaming is never overridden;
  `bun run typecheck` green.

## 5. Work breakdown — test tasks

No new DOM tests possible (no harness — see §2). Verification is:
- **T2** — run `bun run typecheck` and the full `bun test` suite (regression
  gate on the pure-helper tests that share this file's imports).
- Manual visual verification in `bun run dev:hmr` is required post-merge
  (documented in the final report; consistent with fleet precedent for scroll
  work in this file).

## 6. Execution waves

- Wave 1: T1 (one implementation agent, sonnet).
- Wave 2: code review (opus), then T2 (haiku).

## 7. Blast radius & risks

- `RunPanel.tsx` only. The new wrapper div sits between `logRef` and the
  content — risk points: sticky user-bubble containment (mitigated: wrapper is
  full content height), horizontal shrink (`min-w-0` lives on the container;
  a plain block div doesn't reintroduce overflow), and the collapse
  `pendingAdjustRef` compensation (consistent — see §2).
- Removing the rAF loop: its only non-subsumed behavior was pinning during
  600ms even with zero size changes — a no-op case by definition.

## 8. Open questions / assumptions (autonomous mode)

- Assumed "Task Details" = the RunPanel slide-over (the only messages list
  opened per task; branch name matches).
- Assumed replacing the rAF loop (not stacking a third mechanism) is desired —
  smallest surviving mechanism count, per investigation recommendation.
- Assumed no new test infra (happy-dom) should be introduced for this fix —
  matches repo convention; can be revisited separately.

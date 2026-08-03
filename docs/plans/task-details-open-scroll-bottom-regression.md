# Plan — Task Details opens mid-scroll despite #132 pin (scroll-anchoring de-arm)

| Field | Value |
| --- | --- |
| Date | 2026-08-03 |
| Source | agetor task: "everytime when opening its task details it loads mid scroll rather than on the bottom of the scroll for showing the most recent message" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/task-not-opening-in-most-recent-message |
| Base SHA | 03b2328 |
| Mode | Autonomous /implement run — grill + plan-approval gates bypassed; assumptions logged in §8 |

## 1. Objective & success criteria

Opening a task's details panel (RunPanel) must land the message log pinned to the bottom — the most recent message visible — every time, including for tasks whose latest run is finished and triggers the auto-rebuild-from-JSONL snapshot swap. Success: the deterministic mid-scroll landing no longer occurs; `bun run typecheck` and `bun test` stay green; no change to deliberate user-scroll behavior (scrolling up to read history must still prevent yank-to-bottom).

## 2. Context & constraints (grounded findings)

The #132 ResizeObserver pin is present and unchanged on HEAD (verified: `git diff fix/missing-auto-scroll-to-bottom HEAD` shows no scroll-code delta; the installed Aug-1 app bundle contains post-#132 strings). The bug still reproduces because of an uncontrolled `scrollTop` writer the pin design never accounted for:

- On open, three async paths race: SSE replay (server caps at `EVENTS_REPLAY_LIMIT=800`, one coalesced flush via rAF/250ms — `RunPanel.tsx:695-785`), the `runs` fetch, and — once `runs` resolves with a finished claude run — the auto-rebuild fetch (`RunPanel.tsx:1067-1117`).
- The rebuild swap replaces `displayedEvents` wholesale (`RunPanel.tsx:1186-1192`). Rebuilt events carry synthetic `ts = run.startedAt + i` (`src/bun/server.ts:4009-4021`) and `RunEventList` keys are `` `${e.ts}-${i}` `` (`RunPanel.tsx:3594-3596`) → every key changes → full transcript unmount/remount in one commit.
- No `overflow-anchor` override exists anywhere in the repo, so WebKit scroll anchoring (present in current WKWebView) responds to the remount by adjusting `scrollTop` to keep some arbitrary new anchor node stationary. That adjustment dispatches a native scroll event ahead of ResizeObserver delivery and React effects.
- `onScroll` (`RunPanel.tsx:2454-2457`) latches `nearBottomRef` from any scroll event regardless of origin. The anchor-driven event computes dist ≥ 80 → `nearBottomRef=false` → path 1 (`RunPanel.tsx:1020-1024`) and path 2 (`RunPanel.tsx:1026-1047`) both bail on their first guard, permanently. Nothing re-arms the ref except a task/tab switch.
- Ruled out: `pendingAdjustRef` (user-click only), search-jump effect (`activeMatchId` null on open), scroll-restore effect (user "Load earlier" only), sibling sections writing scrollTop (none do), the initial replay flush itself (appends into an empty tree; keys stable; pins fire correctly).

Constraints: no DOM test harness in this repo (no jsdom/happy-dom — precedent in prior scroll-fix knowledge); WKWebView is the only target engine; keep the existing pin design (two paths + two guards) intact.

## 3. Approach & key decisions

Two surgical changes in `RunPanel.tsx`, no control-flow redesign:

1. **`overflow-anchor: none` on the log scroll container** (`logRef` div, ~line 2471) via Tailwind arbitrary property `[overflow-anchor:none]`. The component implements its own bottom-anchoring; the browser's anchoring is a competing writer and this is the documented escape hatch. Removes the root cause: no anchor adjustment → no spurious scroll event → `nearBottomRef` never falsely latched.
2. **Convert pin path 1 from `useEffect` to `useLayoutEffect`** (~line 1020). Belt-and-braces: on the rebuilt-swap commit the pin then runs synchronously before paint and before any browser-generated scroll event can dispatch, so even an engine that anchors despite (1) (or a future violent commit) gets pinned first and the subsequent scroll event re-confirms `nearBottomRef=true`. Also removes any one-frame flash of the wrong position on swap commits that only path 1 covers.

Alternatives considered: stable React keys across the live↔rebuilt swap (fixes the remount violence but is a larger, riskier change to event identity — deferred); asymmetric `onScroll` latching (changes user-scroll semantics near the suppression window — rejected as scope creep).

## 4. Work breakdown — implementation tasks

- **T1** (single task, one agent): in `src/mainview/components/kanban/RunPanel.tsx` — (a) add `[overflow-anchor:none]` to the `logRef` container className; (b) change the path-1 pin effect to `useLayoutEffect` (add import if not present); (c) update the adjacent design comment (lines ~973-1019) to document the scroll-anchoring writer and why both changes exist. Owns only `RunPanel.tsx`. Acceptance: typecheck green; comment explains the anchor-de-arm mechanism.

## 5. Work breakdown — test tasks

No DOM harness exists (repo precedent: prior scroll-pin fix shipped with dev:hmr visual verification only). No new unit-test surface is created (CSS class + hook-timing change). Test phase = run the full existing suite (`bun test`) + `bun run typecheck`. Manual visual pass in `bun run dev:hmr` is listed as the user-facing follow-up.

## 6. Execution waves

Wave 1: T1 (implementation, sonnet). Then review (opus), then `bun run typecheck` + `bun test` (haiku).

## 7. Blast radius & risks

- `useLayoutEffect` fires synchronously per commit of `[events, rebuilt, interactions.length, activeStream]` — a single scrollTop assignment, negligible cost; it may pin marginally earlier than the RO path on growth commits, which is behavior-equivalent.
- `overflow-anchor:none` also disables anchoring for a user parked mid-history while content streams in below: without anchoring, appended content below the viewport doesn't move the viewport (scrollTop is retained) — that is exactly the pre-anchoring behavior the pin design was written against, and content is only ever appended below (prepends via "Load earlier" have their own explicit scrollTop compensation at `RunPanel.tsx:963-970`).
- Older WKWebViews without `overflow-anchor` support ignore the property — and also lack the anchoring that causes the bug.

## 8. Open questions / assumptions (autonomous run)

- Assumed the user runs the Aug-1 build of Agetor.app (contains #132) — verified via bundle string fingerprints; version string still says 0.0.17 because the version was never bumped for the local build.
- Assumed WKWebView scroll anchoring as the de-arming writer based on convergent static analysis (no live WKWebView instrumentation performed); the fix is safe even if a second violent-commit variant exists, since path-1-as-layout-effect pins before paint regardless.
- Final visual confirmation in `bun run dev:hmr` is left to the user (cannot drive the WKWebView UI from this environment).

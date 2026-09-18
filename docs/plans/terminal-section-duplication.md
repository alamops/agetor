# Plan — Stop the run panel from stacking duplicate TERMINAL sections

| Field | Value |
| --- | --- |
| Date | 2026-09-18 |
| Source | Owner task + screenshot (`screenshot-2026-09-18_15-59-50`): ~17 collapsed `TERMINAL` rows stacked under the runs list of a running task |
| Config | AGENTS_CONFIG.yml (balanced, legacy v1 schema — loads as-is) |
| Flags | none |
| Gates | self-resolved — the session has no `ask_user` tool and the harness declares the owner unavailable, so the grill (§8) and approval were run autonomously |
| Branch | fix/spam-of-terminal-sections-in-task-detail |
| Base SHA | 4f2624d |

## 1. Objective & success criteria

The task-details panel renders exactly ONE `Terminal` section, no matter how
often `RunPanelBody` re-renders, for every task — including tasks that have
saved backlog drafts. No React "two children with the same key" warning comes
out of the panel. Per-task remount semantics of both keyed children (#230)
are preserved.

## 2. Context & constraints

- `RunPanel.tsx:3582` renders `<TerminalsSection key={task.id} …/>` and
  `RunPanel.tsx:3749` renders `<BacklogTray key={task.id} …/>`. Both are
  direct children of the SAME fragment in `RunPanelBody`, and both keys were
  introduced together in eb74ab5 (#230, shipped in v0.1.9). A third keyed
  child lives in that same fragment: `<PlanDialog key={openPlan.id}>`
  (`RunPanel.tsx:4095`). It cannot collide today — a plan id is 16 hex chars
  of a sha256 (`src/bun/task-plans.ts:27`), never UUID-shaped — but it is the
  same trap, found in review after the first sweep grepped only `task.id`.
- React 19.2.8 reconciler, verified in
  `node_modules/react-dom/cjs/react-dom-client.development.js`:
  - `reconcileChildrenArray`'s fast path `break`s on the first `null`/`false`
    child (`if (null === newFiber) … break`, ~L6641). `RunPanelBody`'s first
    conditional child (`{searchOpen && …}`) is normally `false`, so every
    update takes the map-based slow path.
  - `mapRemainingChildren` (~L6187) does `existingChildren.set(key, fiber)`,
    so with two same-key siblings the later one (`BacklogTray`) overwrites
    the earlier one (`TerminalsSection`).
  - The new `TerminalsSection` element then looks up `task.id`, finds the
    `BacklogTray` fiber, mismatches on type and MOUNTS A NEW fiber. The old
    `TerminalsSection` fiber was never in the map, so it is never deleted:
    its `<details>` stays in the DOM and its effects never clean up.
- Net effect: while the tray is mounted (Main tab + at least one saved
  draft), EVERY `RunPanelBody` re-render (SSE event, 2 s polls) leaks one more
  `TERMINAL` section, each holding a live `TerminalView` (list fetch +
  sockets when open). That is the "random" trigger: only tasks with saved
  drafts, growing with activity. The #230 e2e test never seeded a draft, so
  it could not see it.
- e2e runs against the Vite dev server, i.e. React's development build, so
  the duplicate-key console warning is observable from Playwright.

## 3. Approach & key decisions

Give the colliding children distinct, namespaced keys: `terminals-${task.id}`
and `backlog-${task.id}`, and namespace the third keyed sibling the same way
(`plan-${openPlan.id}`) so the fragment has one uniform rule — every keyed
child carries its component's name. Rests on the source reading above, proven by a
failing-then-passing e2e test. Alternatives passed on: dropping one key and
resetting that child's state by effect (re-opens the leak #230 closed);
wrapping each child in its own keyed Fragment (same effect, more noise).

Add `data-testid="terminals-section"` to the `<details>` so the test does not
depend on rendered uppercase text.

## 4. Work breakdown — implementation tasks

- **I1** `src/mainview/components/kanban/RunPanel.tsx`: namespace all three
  keys, add the test id, extend the call-site comments with the sibling-key
  trap.
- **I2** `CLAUDE.md` ("Things that will trip you up" RunPanel bullet): update
  the two key spellings and state the rule — sibling keys share one namespace,
  so never reuse a bare `task.id`.

## 5. Work breakdown — test tasks

- **T1** `e2e/task-switch-during-restore.spec.ts`, in the existing
  "terminals section is scoped per task" describe: start a fake claude task,
  seed a backlog draft via `POST /tasks/:id/backlog`, open the panel, force
  re-renders deterministically by typing into `send-textarea` (the composer
  draft is `RunPanelBody` state, so each keystroke re-renders it), then assert
  exactly one `terminals-section`, and no page-wide console message matching
  `same key`. Must FAIL on the base SHA and pass after I1. The existing
  per-task-scope test in that describe keeps covering the remount semantics.
- Unit layer: not applicable — the repo has no jsdom/testing-library; webview
  rendering is covered by Playwright by convention.

Run recipe: `bun node_modules/@playwright/test/cli.js test <spec>` (starts
Vite via `webServer`, one headless backend per worker). `bun run typecheck`.

## 6. Execution waves

Single wave, done inline by the orchestrator (3 files, ~15 changed lines — a
fan-out would cost more than the change). Order: T1 first and observe it fail,
then I1, re-run to green, then I2. Review (opus, `code-review` skill) and the
test run go to sub-agents.

## 7. Blast radius & risks

Changing a key remounts that child once at upgrade time only (page load
anyway). `BacklogTray`'s `editingId` reset and `TerminalsSection`'s
open-state/socket reset per task are unchanged because the key still varies
with `task.id`. No server, DB, CLI or TUI surface is involved.

## 8. Open questions / assumptions — self-answered grill

| Question | Answer | Source | Confidence |
| --- | --- | --- | --- |
| Is the duplicate key the real cause, or a coincidence next to it? | Real cause; mechanism traced line by line, and T1 must fail before the fix | React source + e2e | high |
| Why "random"? | Needs a saved backlog draft on the Main tab; grows per re-render | `RunPanel.tsx:3742` gate | high |
| Must both children keep remounting per task? | Yes — #230 added the keys to stop state/socket leaks across task switches | `RunPanel.tsx` comments, plan for #230 | high |
| Do leaked sections need server-side cleanup? | No — PTYs live bun-side by design; leaked webview sockets die with the page | `TerminalsSection` doc comment | medium |
| Any other same-key siblings in the webview? | One more keyed sibling, `PlanDialog key={openPlan.id}`; no live collision, namespaced anyway. Every other `key=` is a `.map()` list key, which gets its own implicit fragment | review sweep of `src/mainview` | high |
| Should every e2e spec fail on React key warnings? | Not in this run — separate hardening ticket with its own flake risk | judgment (narrower option) | medium |
| Any one-way decision? | None | — | high |

## 9. Completeness ledger

| Candidate remainder | Disposition |
| --- | --- |
| Both colliding keys renamed, not just one | in this run — I1 |
| Third keyed sibling `PlanDialog` left on a bare id (review finding) | in this run — I1 |
| Regression test that seeds a draft (the gap that hid the bug) | in this run — T1 |
| CLAUDE.md still documents the bare `key={task.id}` spellings | in this run — I2 |
| Historical plan docs quoting the old keys | out of scope — point-in-time records of #230 |
| Fleet-wide "fail any spec on a React key warning" fixture | out of scope — different ticket (harness hardening) |

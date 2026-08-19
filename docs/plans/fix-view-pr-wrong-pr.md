# Plan — Fix "View PR" opening the wrong PR after switching tasks

| Field | Value |
| --- | --- |
| Date | 2026-08-18 |
| Source | /implement invocation (bug report with repro steps) |
| Config | AGENTS_CONFIG.yml (balanced preset, host: claude_code) |
| Flags | none |
| Branch | fix/view-pr-bug |
| Base SHA | 295d91eb0c6ca10e0a6e4b79103551941f6c7b49 |
| Mode | Autonomous — grill + plan-approval gates self-resolved; assumptions logged in §8 |

## 1. Objective & success criteria

Clicking "View PR" on task B after previously viewing task A's PR (and closing the modal) must open **task B's** PR detail. Success: the repro (open A → View PR → close → open B → View PR) shows B's PR; `bun run typecheck` and `bun test` stay green; detail-view survival on *generic* dialog reopens (GitHub button, no prefill) is unchanged.

## 2. Context & constraints (Phase 1 findings)

- Click wiring: `RunPanel.tsx:2398-2407` → `onViewPullRequest({ projectPath: task.workdir, prUrl })` → `App.tsx:1184-1198` builds a **fresh** `githubPullDetailPrefill` object per click and opens the dialog. This side is correct.
- `GitHubDialog.tsx` is an App-level singleton that **stays mounted when closed**. Its close-reset effect (`GitHubDialog.tsx:1200-1208`) pops only a `compose` view back to list; `detail`/`panel` views deliberately survive close/reopen.
- Detail-prefill is consumed in two effects: part 1 (`:854-861`) sets `projectPath`/`kind`; part 2 (`:1161-1187`) fetches the PR and calls `setView(openDetail(item))` — but only after the guard `if (cancelled || viewRef.current.kind !== "list") return;` (`:1170`).
- **Root cause:** on the repro, `view` still holds `{kind:"detail", item: A}` from the previous open (survives close by design), and because task B is in the same project, part 1's `setProjectPath`/`setKind` are value-no-ops, so the `[projectPath, kind, …]` view-reset effect (`:1042`) never fires. Part 2 fetches B's PR successfully, then the `:1170` guard sees `viewRef.current.kind === "detail"` and **silently discards the fetched data**. The modal reopens showing A's PR.
- Introduced whole-cloth in commit `3d57071` (Jul 31 2026) — a day-one design gap, not a regression.
- Sibling precedent: the compose-prefill part 2 (`:1132-1141`) calls `setView(openCompose())` **unconditionally** — a prefill click is a navigation command that clobbers any stale view. The detail path should behave the same.
- Fleet knowledge: entry `38346db8` documents the stays-mounted reset gotcha; entry `f3c354dc` warns not to touch `resetComposers()` semantics (draft survival) — this fix doesn't.

## 3. Approach & key decisions

**Fix: in detail-prefill part 1 (`:854-861`), when consuming a fresh prefill, also pop the view back to the list** — `setView((cur) => (cur.kind === "list" ? cur : backToList()))`.

Why this shape (decision rests on code-reading evidence, not spikes — none needed):

- It preserves the deliberate "detail views survive close/reopen" behavior for generic opens (the close-reset effect stays untouched), unlike the alternative of popping `detail` → list on close, which would regress that feature.
- It preserves part 2's `:1170` race guard with its original meaning: "the user navigated away while the fetch was in flight". By the time the fetch resolves, the re-render from part 1's `setView` has committed and `viewRef.current.kind === "list"`, so the guard passes; if the user genuinely navigates mid-fetch, it still protects them. Worst theoretical case (fetch resolving before the re-render commits) degrades to "dialog shows the list" — benign, never the wrong PR.
- It mirrors the sibling compose-prefill semantics (navigation command wins) and fixes the same false-trip for stale `panel` and `compose` views, not just `detail`.
- Visible-state bonus: while the fetch is in flight the dialog shows the list instead of flashing task A's stale PR.

Alternative considered and rejected: removing the `viewRef` guard from part 2's success path — loses mid-flight-navigation protection and leaves the stale PR visible during the fetch.

## 4. Work breakdown — implementation tasks

- **T1** — Apply the fix + comment updates. Owns `src/mainview/components/kanban/GitHubDialog.tsx` only. Add the `setView` pop to detail-prefill part 1 and extend its comment to say why (stale surviving view would false-trip part 2's list guard); amend the close-reset comment's "that's unrelated to this cleanup" claim to point at part 1 as the place that handles prefill-driven reopens. Acceptance: typecheck green; the part-1 effect pops any non-list view exactly when a fresh prefill is consumed.

Single task, single wave — no partitioning needed.

## 5. Work breakdown — test tasks

- **No new automated tests.** `src/mainview` has no React component/rendering harness (no jsdom/happy-dom/@testing-library — only pure-logic `.ts` tests like `github-dialog-view.test.ts`). The fix is a one-line effect change inside `GitHubDialog.tsx`; the pure helpers it uses (`backToList`) are already covered. Standing up a component-test harness unilaterally is out of scope per skill policy ("don't invent heavyweight infrastructure").
- **e2e: not applicable** — no e2e harness exists in this repo (recorded decision, not an omission). Verification = full existing suite (`bun test`) + `bun run typecheck`; manual repro verification noted as a follow-up for the user (needs the running app + real GitHub PRs).

## 6. Execution waves

Wave 1: T1. Then review (opus) → test run (haiku, `bun test` + `bun run typecheck`) → fixes if needed.

## 7. Blast radius & risks

- Surfaces touched: only the detail-prefill part-1 effect. Consumers: "View PR" from RunPanel header (the only `pullDetailPrefill` producer, `App.tsx:1184-1198`).
- Behaviors that must not change: generic-open detail survival (close-reset untouched); compose-prefill flow (untouched); `resetComposers` draft semantics (untouched, per fleet decision `f3c354dc`); Escape/back navigation (`resolveEscape`, untouched).
- Risk: another effect ordering surprise — mitigated by keeping the change inside the existing two-effect consumption pattern and not touching dep arrays.

## 8. Open questions / assumptions (autonomous mode)

- **A1:** A "View PR" click should always navigate to that PR, discarding whatever subpage the dialog was left on — assumed yes (matches the compose sibling's semantics and the user's bug report).
- **A2:** Detail-view survival across *generic* (non-prefill) close/reopen remains desired — assumed yes (explicitly documented as deliberate in the code).
- **A3:** No component-test harness should be introduced for this fix — assumed yes (repo-wide convention; would be a scope change).

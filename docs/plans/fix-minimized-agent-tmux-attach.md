# Plan — Fix "minimized" agent rendering on tmux attach (heal stuck window-size)

| Field | Value |
| --- | --- |
| Date | 2026-08-05 |
| Source | Task "the agent runs in a minimized way — Agetor not identifying the task is still running" + screenshot (tmux status line `[agetor-eb0:…`, claude TUI squashed to a small strip) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/recognize-agent-and-shell (agetor-managed worktree, pre-existing) |
| Base SHA | 7d28f2a071bcbdcd474887f956a030992983a6b0 |
| Mode | **Autonomous** — Phase 2 grill and Phase 3 approval gates bypassed; all assumptions logged in §8 |

## 1. Objective & success criteria

When the user clicks **Attach** on a claude-code task (Terminal.app + `tmux attach`), the agent's TUI must fill the terminal window — never render pinned to a small region with the rest blank — regardless of whether an agetor crash/kill previously interrupted the AskUserQuestion pane-grow cycle.

Success:
- A session whose tmux `window-size` option was left stuck on `manual` (small) is healed to `latest` before the user's client attaches, and on boot reattach.
- The crash window that produces the stuck state in the first place is closed (atomic resize/restore).
- `bun test` and `bun run typecheck` green; no behavior change to the pane scraper's normal 80-col regime.

## 2. Context & constraints (Phase 1 findings)

- Two terminal surfaces exist; the bug is in the **Attach** flow, not the sidebar PTY tabs: `RunPanel.tsx:4816-4839` → `POST /tasks/:id/open-tmux` (`server.ts:3294`) → osascript opens Terminal.app running `tmux attach -t agetor-<taskId12>`. The screenshot's `[agetor-eb0:` session name proves this path (`sessionNameFor`, `claude-tmux.ts:361`).
- The "auto mode on · 1 shell · 1 agent" bar in the screenshot is **claude-code's own TUI status line** (its background-shell / Task-subagent counts), not agetor UI. Agetor has **no** code path that varies attach behavior by run state — the user's "Agetor doesn't see it running" hypothesis has no matching code path and is explained by the rendering bug.
- `spawnClaudeViaTmux` creates sessions detached with no `-x/-y` → tmux `default-size` 80×24, `window-size latest`. Verified empirically (PTY harness): with `latest`, a real client attach **does** renegotiate the window to the client size — so a plain small session self-heals on attach.
- The **only** code that sets `window-size manual` is the AskUserQuestion pane-grow scraper: `resizePane`/`restorePaneSize` (`claude-tmux.ts:2385-2399`), driven by `collectAskQuestionsFromPane` (`:2471+`) to grow the pane to ≥120×100 and restore in a `finally`. Each helper issues **two separate tmux invocations**; a Bun-process crash/kill between them leaves the session **permanently pinned `manual`** (potentially at 80×24 — e.g. death between `restorePaneSize`'s shrink and its `latest` flip). Sessions survive agetor restarts by design, so the pin persists.
- Verified empirically: attaching a real 200×49 client to a session pinned `manual` at 80×24 keeps the window at 80×24 — content confined to a small strip, remainder blank. **Exact match for the screenshot.**
- **Width constraint (fleet knowledge):** claude's modal TUI renders a side-by-side preview column at wide widths, and the parser bleed-fix for that layout was never merged to main; the modal parser's proven regime is the 80-col default. Therefore we must **not** change the default session size (rejects the "copy codex's `-x 200 -y 50`" option).
- `tmux()` helper (sync, argv array) at `claude-tmux.ts:1098`. tmux supports chaining multiple commands in one client invocation with a literal `;` argv element — the whole batch reaches the tmux server in one process, immune to our process dying between commands.
- Env gotchas: `bun`/`tmux` not on non-interactive PATH (`~/.bun/bin`, `/opt/homebrew/bin`); this worktree needs `bun install` before `bun run typecheck`; tests must use isolated tmux sockets (`AGETOR_TMUX_SOCKET`, see `tmux-resolution.ts:73-85`) — never the user's default socket.

## 3. Approach & key decisions

1. **Heal at attach (primary, evidence-backed):** before spawning the Terminal.app attach, reset the session's `window-size` to `latest` so any stuck `manual` pin self-heals and tmux renegotiates to the real client size. Implemented as an exported `healWindowSize(taskId)` in `claude-tmux.ts` (the module owns session state), called from the `open-tmux` route. **Skipped while a pane-grow is in flight** (new per-session flag set/cleared around the grow cycle) so we never fight the scraper; the scraper's own `finally` restores `latest` in that case.
2. **Heal at boot reattach:** `reattachSession` also resets `window-size latest` — a crashed previous process is exactly when the pin strands.
3. **Close the race:** make `resizePane` and `restorePaneSize` each a **single** tmux invocation using `;`-chained commands, so process death can no longer strand the session between `set-window-option` and `resize-window`.
4. **Not changing default session size** — rejected due to the wide-width modal-parser hazard (§2). Decision rests on fleet knowledge + spike-verified tmux behavior (`latest` self-heals on attach, so a small-but-unpinned session is fine).
5. No UI changes. No change to codex (`-x 200 -y 50`, never sets `manual`, one-shot sessions).

## 4. Work breakdown — implementation tasks

- **I1** — Heal + atomicity in the tmux driver and route.
  Owns: `src/bun/claude-tmux.ts`, `src/bun/server.ts`.
  - Rewrite `resizePane`/`restorePaneSize` as single chained tmux invocations.
  - Add per-session `paneGrowInFlight` guard set/cleared (try/finally) around the grow cycle in `collectAskQuestionsFromPane`.
  - Export `healWindowSize(taskId)`: no-op if session missing or grow in flight; else `set-window-option -t <session> window-size latest` (best-effort, never throws).
  - Call it from `reattachSession` and from the `open-tmux` route (before osascript).
  Acceptance: typecheck green; existing claude-tmux tests green; no scraper behavior change at default size.

## 5. Work breakdown — test tasks

- **T1** — Unit + integration tests. Owns: `src/bun/claude-tmux.test.ts` (extend), optionally a new `src/bun/window-size-heal.test.ts`, `src/bun/codex-tmux.test.ts` (one assertion).
  - Unit (fake `PaneIo` / recorded tmux argv): resize/restore each issue exactly one tmux invocation with the chained command shape; heal no-ops during an in-flight grow.
  - Integration (real tmux on an **isolated socket**, temp `AGETOR_DATA_DIR`): create a session, pin `window-size manual` small, call `healWindowSize`, assert `show-options` reports `latest`. Skip gracefully if tmux is unavailable.
  - Codex regression guard: assert `-x`/`-y` present in codex `new-session` argv (currently untested).
- **E2E: not applicable as automation** — the full symptom needs Terminal.app + a real claude REPL attach; recorded here as a manual runbook instead: start a claude task, run `tmux set-window-option -t agetor-<id12> window-size manual; tmux resize-window -t agetor-<id12> -x 80 -y 24`, click Attach → TUI must fill the window.

## 6. Execution waves

- Wave 1: I1 (single agent — changes concentrate in two files with one owner).
- Review (opus) on the diff.
- Wave 2: T1 (single agent).
- Test run (haiku): `bun test` + `bun run typecheck` (after `bun install`; export PATH with `~/.bun/bin` and `/opt/homebrew/bin`).

## 7. Blast radius & risks

- `open-tmux` route: heal adds one best-effort tmux call; failure must not block the attach.
- Scraper: guard flag must be cleared in `finally`, else heal is permanently disabled for that session.
- Chained tmux commands: `;` must be its own argv element (not shell-quoted `\;` — no shell involved).
- Reattach: heal runs once at boot per reattached session; harmless if already `latest`.
- Tests: real-tmux tests must use `AGETOR_TMUX_SOCKET` isolation (prior incident: a test killed the user's shared tmux server).

## 8. Open questions / assumptions (autonomous mode log)

- **A1:** The screenshot's symptom is the `window-size manual` pin (empirically reproduced) and/or small-session attach; the user's "not identifying running" phrasing is the perception, not a distinct state bug — no such code path exists.
- **A2:** Chose heal-on-attach + atomicity over enlarging default session size, to protect the width-sensitive modal parser (preview-column bleed fix never merged).
- **A3:** Branch `fix/recognize-agent-and-shell` (agetor's task worktree) is used as-is; no new branch.
- **A4:** Phase 2/3 human gates bypassed — user unavailable mid-task; this plan is self-approved.
- **A5:** Whether claude's Ink TUI fully repaints newly exposed area after a large post-attach resize is unverified against a real binary; with `latest` restored, an actively-streaming agent repaints continuously, so residual blank scrollback (old 80-col history) is cosmetic and out of scope.

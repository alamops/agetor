# Plan — `@`-file highlight backdrop: mirror metrics on a co-mounted textarea

| Field | Value |
| --- | --- |
| Date | 2026-09-09 |
| Source | `/implement` task "fix the highlight box position in the @ files in the taskdetails message input" + owner screenshot (`~/Desktop/Screenshot 2026-09-09 at 9.07.22 PM.png`) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Flags | none |
| Gates | grilled + approved by owner |
| Branch | fix/fix-file-reference-highlight-box |
| Base SHA | c652464 (`release v0.1.7`) |

## 1. Objective & success criteria

In the task-details (RunPanel) send composer, the `@`-token highlight boxes painted by
`AtHighlightBackdrop` render to the right of — and taller than — the tokens they mark. The
screenshot shows `@CHANGELOG.md @manifest.json` with the first box starting at `.md` and
the second box floating entirely past the text.

Done means:

- Every composer that mounts `AtHighlightBackdrop` paints each `<mark>` exactly under its
  token: the RunPanel send dock, the backlog-tray inline editor, the DiffDialog compose box,
  `CreateTaskFromIssueDialog`, `ResolveConflictsDialog`, and the New Task form.
- A regression test in `e2e/at-file-autocomplete.spec.ts` fails on today's code and passes
  on the fix: the backdrop's computed font/box metrics equal the textarea's on every surface,
  and on the RunPanel dock the mark's left edge and width match the token's measured text
  position within a small tolerance.
- `bun run typecheck` green; the mainview unit suite green; the `@`-reference e2e spec green.

## 2. Context & constraints

Grounded findings (Phase 1 research + a live spike in both engines):

- `src/mainview/components/kanban/AtHighlightBackdrop.tsx:118-129` reads the textarea's
  computed metrics (`MIRRORED_PROPERTIES`, lines 26-48) inside a `useLayoutEffect` keyed on
  `[textareaRef]`, bailing with `if (!el) return;` when `textareaRef.current` is null, and
  attaches the `ResizeObserver` in that same effect. `style` starts as `{}` (line 101).
- **Root cause (spike-verified):** React attaches refs and runs layout effects in one
  tree-order pass, so when the backdrop and its later-sibling `<textarea>` mount in the same
  commit, the backdrop's layout effect runs *before* the textarea's ref is attached. The
  effect bails on the null ref, its deps are a stable ref object, and nothing ever re-runs
  it — neither the metrics read nor the `ResizeObserver` subscription ever happens. The
  mirror keeps `style={}` and inherits the ambient 16px/24px font with zero padding/border,
  while the textarea renders at `text-xs` (12px/16px) with `px-3 py-2` + 1px border.
- Spike evidence (Playwright 1.62.1; Chromium 151.0.7922.34 and WebKit 26.5, identical
  numbers in both): on the RunPanel dock `backdrop.getAttribute("style") === null`;
  computed `font-size` 12px (textarea) vs 16px (backdrop), `line-height` 16px vs 24px,
  padding 8/32/8/12px vs 0, border 1px vs 0; marks land +70px / +95px right of the tokens
  and 6-7px high. On the New Task form every one of 30 compared properties is equal and the
  mark geometry delta is 0.000px — because that form's `fileScope` only exists once a
  workdir is chosen (`NewTaskForm.tsx:177` starts `workdir` at `""`), so its backdrop mounts
  *after* the textarea and the ref is already attached. Spike files:
  `<scratchpad>/spikes/highlight-metrics/` (spec, config, `results-{chromium,webkit}.json`,
  screenshots).
- Owner screenshot pixel pass agrees: box height ≈ 21px vs the textarea's 16px line, and
  box x-positions fit a mirror with zero padding and a ~1.27× wider layout.
- Git history: the wave-2 commit (`db5c326`) also had a second layout effect keyed on
  `value` that re-read metrics on every keystroke — that masked the race. The review-fix
  commit `a6980ca` removed it ("backdrop metrics on mount/resize only") for the right
  performance reason but exposed the ordering bug on every co-mounted surface.
- Co-mount sites (all affected today): `PromptComposer.tsx:773` when `fileScope` is known
  at first render — RunPanel dock (`RunPanel.tsx:3155`, scope from the task), issue dialog
  (`CreateTaskFromIssueDialog.tsx:92/309`), resolve-conflicts dialog
  (`ResolveConflictsDialog.tsx:404/540`) — plus the two manual mounts `RunPanel.tsx:3618`
  (tray editor) and `DiffDialog.tsx:754` (compose box). Immune by timing only: New Task form.
- The `font` shorthand in `MIRRORED_PROPERTIES`: both engines return a full string for
  `getComputedStyle().font`; Chromium re-serializes the inline style as one `font:`
  declaration, WebKit expands it into ~20 longhands. Spike-verified benign — computed values
  end up identical on the surface where the read actually runs. Not touched by this plan.
- Test seam: no jsdom/testing-library in this repo — webview behavior is covered by
  Playwright (`e2e/`), Chromium project, `bun run hmr` as `webServer` (reuses a running
  one), one headless Bun backend per worker (`e2e/fixtures.ts`), fake claude driver. Run
  with `bun node_modules/@playwright/test/cli.js test e2e/at-file-autocomplete.spec.ts`
  (never `bunx`); `bun` needs `export PATH="$HOME/.bun/bin:$PATH"` in agetor worktree
  shells; only one Playwright run at a time on this machine (shared port 5173). The spec is
  `mode: "serial"` and its RunPanel/tray/diff scenarios share `startedTaskId` from the
  "Start: @README.md expands…" scenario.

## 3. Approach & key decisions

1. **Read metrics in a passive `useEffect`, not `useLayoutEffect`** (owner-approved). Passive
   effects run after the whole commit, when every ref — including a later sibling's — is
   attached. The `ResizeObserver` subscription moves with it. Rests on spike evidence (the
   null inline style) plus React's documented commit order. Alternative rejected: threading
   the live element through a callback ref/state at all three mount sites — more surface for
   the same outcome.
2. **Paint no `<mark>` until the first metrics read succeeds** (owner-approved). `style`
   becomes `null` until read; the container `<div>` still renders (so `backdropRef` and the
   scroll-sync effect keep working), but its children render only once metrics are known.
   A box can therefore never paint against the wrong metrics, even for the one frame a
   non-discrete mount could take.
3. **Regression coverage that would have caught this** (owner-approved: geometry + style
   parity on all surfaces): a shared e2e helper asserts the backdrop's computed
   `font-size`/`line-height`/`font-family`/padding/border equal the textarea's; the RunPanel
   dock additionally asserts the mark's left edge and width against the token's text
   position measured with canvas `measureText` from the textarea's own computed font
   (single-line text so the measurement is exact; ~3px tolerance vs a 70px bug).
4. Docs follow the code: CLAUDE.md §12's sentence about when metrics are re-read, and a
   follow-up section in `docs/plans/at-file-references.md` (house style: §11-§18 are
   follow-ups).

## 4. Work breakdown — implementation tasks

| ID | Goal | Owns (exclusively) | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Fix the metrics read timing + withhold marks until ready | `src/mainview/components/kanban/AtHighlightBackdrop.tsx` | — | Metrics read + `ResizeObserver` live in a `useEffect`; `style` state is `null` until the first successful read; children (marks/text/sentinel) render only when ready; container div always renders so scroll-sync keeps its ref; `stylesEqual` identity preservation kept; comment explains the sibling-ref ordering; typecheck green. No behavior change for the late-mount (New Task) path beyond the one-effect delay. |
| T2 | Update docs to match | `CLAUDE.md` (§12 sentence only), `docs/plans/at-file-references.md` (append §19 follow-up) | T1 (wording) | CLAUDE.md §12 states the metrics read is a passive effect, why (co-mount ref ordering, which surfaces co-mount), and that marks are withheld until the first read; plan addendum records the bug, cause, fix, and coverage. |

T1 and T2 touch disjoint files; they run as one wave, grouped into a single agent brief
(trivially small).

## 5. Work breakdown — test tasks

E2E applies: the defect is a rendering/wiring bug only observable in a real browser, and the
repo's Playwright harness already drives every affected composer. No unit seam exists
(no jsdom).

| ID | Goal | Owns | Covers |
| --- | --- | --- | --- |
| TT1 | Regression coverage in the existing spec | `e2e/at-file-autocomplete.spec.ts` | T1 |

TT1 details:
- Add a helper `expectBackdropMirrors(textarea: Locator)` that locates the backdrop as the
  previous sibling inside the textarea's `relative` wrapper, reads the textarea's computed
  `font-size`, `line-height`, `font-family`, `padding-left/right/top`, `border-left-width`
  via `evaluate`, and `expect(backdrop).toHaveCSS(...)` each.
- RunPanel dock scenario ("RunPanel composer: a follow-up @ reference…"): after the popover
  Enter commits `and @src/app.ts `, before the sending Enter: mark count 1, parity helper,
  and geometry — expected left = textarea rect left + border-left + padding-left +
  `measureText("and ")` − `scrollLeft`, expected width = `measureText("@src/app.ts")`,
  both via a canvas whose `font` is built from the textarea's computed style; assert
  `|Δ| ≤ 3px`.
- Backlog tray editor scenario and DiffDialog composer scenario: parity helper after their
  existing `toHaveCount(1)` assertions.
- New Task form ("Highlighting: only @ tokens that resolve…"): parity helper — pins the
  late-mount path too.
- Dialog surfaces (issue dialog scenario exists; resolve-conflicts lives in another spec):
  parity helper in the issue-dialog scenario if a mark can be produced there cheaply;
  otherwise rely on the shared component + the four surfaces above (record in §9).

Run recipe (Phase 7): `export PATH="$HOME/.bun/bin:$PATH"`; `bun run typecheck`;
`bun test src/mainview src/shared`; `bun node_modules/@playwright/test/cli.js test
e2e/at-file-autocomplete.spec.ts` (Vite starts via `webServer`, backend per worker; port 5173
must be free or an existing dev server is reused). The CLI test dir is skipped on purpose —
nothing in `src/cli` is touched and that suite is known to stall under load.

## 6. Execution waves

- Wave 1 (Phase 4): T1 + T2 — one implementation agent (`sonnet`).
- Phase 5: code review of `git diff c652464...HEAD` (`opus`, code-review skill rubric).
- Wave 2 (Phase 6): TT1 — one test agent (`sonnet`).
- Phase 7: one background runner (`haiku`) for typecheck + unit + the e2e spec.
- Phase 8: fixes if needed, re-run.

## 7. Blast radius & risks

- Single component change; every consumer benefits without edits. The late-mount path
  (New Task form) changes only in that marks appear after the passive effect instead of the
  layout effect — for discrete-event renders React flushes that before paint anyway.
- Risk: geometry assertion brittleness (font hinting / canvas vs DOM metrics). Mitigated by
  single-line text and a 3px tolerance; the parity check is the primary, exact guard.
- Risk: `toHaveCSS` value formats (e.g. `font-family` quoting) differing between what
  `evaluate` reads and what Playwright normalizes — the helper compares strings read from
  the same `getComputedStyle` API, so formats match.
- No server, DB, or CLI surface is touched. Rollback = revert one commit.

## 8. Open questions / assumptions

- Assumption: the owner's app ran at the default font-size; the fix is independent of that
  (a root font-size change resizes the textarea and re-fires the observer once it is
  actually attached).
- Assumption: the `font` shorthand in `MIRRORED_PROPERTIES` stays (spike-verified benign in
  both engines); dropping it is a separate cleanup nobody asked for.
- The shipped app is WKWebView; the spike used Playwright's WebKit 26.5, the closest
  automatable engine, and found identical numbers to Chromium — the bug is engine-agnostic.

## 9. Completeness ledger

| Candidate follow-up | Disposition |
| --- | --- |
| Backlog-tray editor, DiffDialog composer, issue dialog, resolve-conflicts dialog also co-mount and are equally broken | **In this run** — T1 (shared component); tray/diff/New Task pinned by TT1 |
| e2e coverage never asserted mark position on any surface | **In this run** — TT1 |
| CLAUDE.md §12 describes the old "mount + ResizeObserver" timing | **In this run** — T2 |
| `docs/plans/at-file-references.md` lacks the follow-up record | **In this run** — T2 |
| Resolve-conflicts dialog e2e (`e2e/resolve-conflicts*.spec.ts`) has no @-highlight scenario | **Out of scope** — same shared code path as the issue dialog; adding a PR-conflict fixture flow for a parity assertion is a different ticket |
| `font` shorthand in `MIRRORED_PROPERTIES` (engine-specific inline serialization) | **Out of scope** — spike-verified harmless; not created by this change |
| Fleet knowledge entry for the sibling-ref ordering gotcha | **In this run** — orchestrator, after verification |

# Plan — Remove macOS autocorrect from the identifier search boxes (Project / Branch pickers)

| Field | Value |
| --- | --- |
| Date | 2026-09-03 |
| Source | `/implement remove the autocorrector from the project and branch pickers in the new task panel` |
| Config | AGENTS_CONFIG.yml (balanced preset, schema v1) |
| Flags | none |
| Gates | grilled + approved by owner |
| Branch | `fix/remove-auto-corrector-from-project-and-b` (agetor-created task branch, not the default branch) |
| Base SHA | `3a771b3f94988af1a1dfb9a6bf2dcff74a093cb2` (tree clean apart from this untracked plan file) |

## 1. Objective & success criteria

Typing a project name or a branch name into the New Task panel's pickers is
currently mangled by macOS text services: WebKit applies the system's
"Correct spelling automatically" / "Capitalize words automatically" behaviour
to any editable field that doesn't opt out, so `agetor` becomes `actor`,
`feat` becomes `feet`, and the first letter gets capitalized. The search boxes
hold identifiers, never prose, so autocorrect is always wrong there.

Done means:

- Every identifier search box (`SearchSelect` and `MultiSearchSelect`) and the
  New Task panel's branch-name input render with `autocorrect="off"`,
  `autocapitalize="off"`, `spellcheck="false"`, and `autocomplete="off"`.
- The opt-out lives in one place, so a future identifier input can adopt it
  in one line instead of re-deriving the attribute set.
- `bun run typecheck` and `bun test` are green; a new Playwright spec asserts
  the attributes on each affected surface; the existing e2e suite still passes.

## 2. Context & constraints (Phase 1 findings)

- **Both pickers are one primitive.** `ProjectPicker`
  (`src/mainview/components/kanban/ProjectPicker.tsx:101`) and `BranchPicker`
  (`src/mainview/components/kanban/BranchPicker.tsx:281`) render `SearchSelect`.
  Its search box, `src/mainview/components/ui/search-select.tsx:152-158`, is a
  bare `<Input>` (`ui/input.tsx`, a `forwardRef` that spreads every prop onto
  the native `<input>`) with no autocorrect / autocapitalize / spellcheck /
  autocomplete attributes.
- **Reach.** `ProjectPicker` is used only by `NewTaskForm.tsx:583`.
  `BranchPicker` is used only by `WorktreeOptions.tsx:277`, which is rendered
  by `NewTaskForm`, `CreateTaskFromIssueDialog` (live variant) and
  `ResolveConflictsDialog` (locked variant — read-only `<Input readOnly>`, no
  picker, unaffected). Fixing `SearchSelect` therefore fixes every instance.
- **Sibling with the identical defect.** `MultiSearchSelect`
  (`src/mainview/components/ui/multi-search-select.tsx:145-151`) has the same
  bare search `<Input>`; consumers are `KanbanFilters.tsx` (harness / project /
  status / type filters) and `WorktreesDialog.tsx` (project / status filters).
- **The Mode dropdown is unaffected**: `NewTaskForm.tsx:669` passes
  `searchable={false}`, so no input is rendered.
- **Branch-name input** (`WorktreeOptions.tsx:308-322`, test id
  `branch-name-input`, shown while Isolate is on — the default) already sets
  `spellCheck={false}` but not autocorrect / autocapitalize / autocomplete.
  Same for `BranchNamingDialog.tsx:151` (the naming-pattern input reached from
  the branch-name field's settings button).
- **Repo precedent.** `spellCheck={false}` on identifier inputs
  (`WorktreeOptions`, `BranchNamingDialog`, `GitHubTokensSection`) and
  `autoComplete="off"` on the token input (`GitHubTokensSection.tsx:224`).
  Nothing in the codebase sets `autoCorrect` yet.
- **Platform facts (web research).** The HTML `autocorrect` global attribute
  applies to `<input>` / `<textarea>` / contenteditable; `"off"` disables
  correction. Safari on macOS has honoured it since 14.1 (caniuse,
  `mdn-html_global_attributes_autocorrect`), Chrome since 152, Firefox since
  136. The app ships in the system WKWebView (macOS 26), so support is a given.
  `@types/react` 19.2 declares `autoCorrect?: string`, `autoCapitalize`,
  `spellCheck?: Booleanish`, `autoComplete` on input attributes.
- **Testing surface.** `bun test` (root `src/`) has no component harness —
  existing webview tests are pure `lib/` modules. Playwright (Chromium, one
  headless backend per worker via `e2e/fixtures.ts`) already drives the
  branch search box: click the trigger via
  `getByTitle(BRANCH_PICKER_TITLE)`, then `getByPlaceholder("Search
  branches…")` (`e2e/issue-task.spec.ts:589-593`). Note the Kanban filter bar
  also uses the placeholder `Search projects…`, so a spec must scope the New
  Task panel's picker to its container. Run with
  `bun node_modules/@playwright/test/cli.js test <spec>`; only one Playwright
  run at a time (shared Vite :5173 / HMR).

## 3. Approach & key decisions

1. **One shared attribute set, spread at each site.** Add
   `src/mainview/lib/identifier-input.ts` exporting
   `IDENTIFIER_INPUT_PROPS = { autoCorrect: "off", autoCapitalize: "off",
   spellCheck: false, autoComplete: "off" } as const` with a doc comment
   explaining the WebKit/macOS behaviour it defeats. Each identifier input
   spreads it (`{...IDENTIFIER_INPUT_PROPS}`). *Alternative considered:*
   inline the four attributes at each site — rejected because four sites
   already drifted (three had `spellCheck`, one also had `autoComplete`, none
   had `autoCorrect`), and a constant is the cheapest way to stop that drift
   and give the unit layer something real to assert. Rests on reasoning, not
   spike evidence.
2. **Fix the primitives, not the pickers.** The opt-out goes on
   `SearchSelect`'s and `MultiSearchSelect`'s search `<Input>` rather than on
   a new prop set from `ProjectPicker` / `BranchPicker`. There is no consumer
   of either primitive where autocorrecting a filter query is desirable, and
   the owner chose the all-search-boxes scope at the grill.
3. **All four attributes, not just `autocorrect`.** `spellcheck=false` removes
   the red-underline markers and (on WebKit) the correction pass that rides on
   spell checking; `autocorrect=off` is the explicit switch; `autocapitalize=off`
   defeats the separate "Capitalize words" service; `autocomplete=off` stops
   form-autofill suggestions over the popover. Belt and braces is cheap here and
   matches the existing token-input precedent.
4. **Prose fields keep autocorrect.** Title and Prompt are natural-language
   inputs; the owner confirmed they stay as they are.
5. **Unverified assumption, stated.** Whether the WKWebView in Electrobun
   honours these attributes exactly like Safari cannot be automated (it needs
   the packaged app plus the OS setting). The e2e layer asserts the DOM
   attributes are present; behaviour in the real app is a manual check.

## 4. Work breakdown — implementation tasks

Single-agent wave — the whole change is ~15 lines across five files, so one
`implementation` runner does T0–T3 sequentially (no fan-out; see §6).

| ID | Goal | Owns (exact files) | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T0 | Add the shared opt-out constant | `src/mainview/lib/identifier-input.ts` (new) | — | Exports `IDENTIFIER_INPUT_PROPS` (`as const`, typed to satisfy `React.InputHTMLAttributes`) with a doc comment naming the macOS/WebKit behaviour and pointing at the consumers. |
| T1 | Opt `SearchSelect`'s search box out | `src/mainview/components/ui/search-select.tsx` | T0 | The `<Input ref={searchRef} …>` at ~L152 spreads `IDENTIFIER_INPUT_PROPS`; a one-line comment says why. No other change. |
| T2 | Opt `MultiSearchSelect`'s search box out | `src/mainview/components/ui/multi-search-select.tsx` | T0 | Same as T1 for the `<Input>` at ~L145. |
| T3 | Opt the branch-name, naming-pattern, and Settings host inputs out | `src/mainview/components/kanban/WorktreeOptions.tsx`, `src/mainview/components/settings/BranchNamingDialog.tsx`, `src/mainview/components/settings/GitHubTokensSection.tsx` | T0 | `branch-name-input` (~L308), the pattern input (~L151), and the GitHub host input (~L200, the `spellCheck`-only one — NOT the `type="password"` token input) replace their bare `spellCheck={false}` with the spread; every other prop untouched. |

Conventions for the agent: match surrounding style (2-space, double quotes,
trailing commas), keep comments in the repo's "why, not what" voice, no new
dependencies, no `TODO`s, don't touch `input.tsx`, the pickers, or any test.
`bun run typecheck` must be green after the wave.

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Owns | Notes |
| --- | --- | --- | --- | --- |
| TT1 | unit (`bun test`) | T0 | `src/mainview/lib/identifier-input.test.ts` (new) | Asserts the exact attribute set (`autoCorrect === "off"`, `autoCapitalize === "off"`, `spellCheck === false`, `autoComplete === "off"`) and that it has no extra keys, so a future edit can't silently widen or narrow it. |
| TT2 | e2e (Playwright) | T1, T2, T3 | `e2e/identifier-inputs.spec.ts` (new) | One spec file, modelled on `e2e/font-size.spec.ts` / `issue-task.spec.ts`: (a) New Task panel → click the Project picker trigger (by its title "Pick the working directory the agent runs in…") → assert the `Search projects…` box **inside the New Task panel** carries `autocorrect="off"`, `autocapitalize="off"`, `spellcheck="false"`, `autocomplete="off"`; press Escape. (b) Click the Branch picker trigger (`getByTitle` with the isolated-mode title, as in `issue-task.spec.ts:95`) → same assertions on `Search branches…`. (c) `getByTestId("branch-name-input")` → same assertions (Isolate defaults on). (d) Kanban filter bar → click the "All harnesses" trigger → same assertions on `Search harnesses…` (covers `MultiSearchSelect`). Use `toHaveAttribute`, no sleeps, no screenshots. |

**E2E applies** — the change is user-visible DOM in a real webview flow and
the repo has a working Playwright harness. Run recipe (from Phase 1):
`export PATH="$HOME/.bun/bin:$PATH"`; `bun install` already done; the
Playwright `webServer` block starts `bun run hmr` (Vite :5173) itself and the
`backend` fixture spawns a headless Bun API per worker — no manual services,
no credentials. Command: `bun node_modules/@playwright/test/cli.js test
e2e/identifier-inputs.spec.ts` (then the full `e2e/` run). One Playwright run
at a time.

## 6. Execution waves

- **Wave 1 (Phase 4):** one `implementation` agent (sonnet) does T0 → T1 → T2 → T3 in order. No parallel agents — the files are tiny and a fan-out would cost more than it saves.
- **Barrier:** typecheck green, wave committed.
- **Wave 2 (Phase 6):** one `tests_creation` agent (sonnet) writes TT1 + TT2 (disjoint from every wave-1 file).
- **Phase 5** (opus reviewer) runs between the waves on the wave-1 diff; **Phase 7** (haiku) runs `bun run typecheck`, `bun test`, the new spec, then the full e2e suite.

## 7. Blast radius & risks

- **Every `SearchSelect` / `MultiSearchSelect` search box** changes — Project,
  Branch (New Task + issue dialog), Kanban filters, Worktrees dialog. The only
  observable change is the four attributes; filtering, focus-on-open, Escape,
  and the `data-popover-open` marker are untouched.
- **Chromium (e2e) ignores `autocorrect` below v152** — irrelevant to the
  assertions, which check attribute presence, not behaviour.
- **No server, DB, API, CLI, or shared-types impact.** Nothing to migrate,
  nothing to roll back beyond reverting the commit.
- **Risk:** the WKWebView could in theory ignore the attributes (see §3.5).
  Mitigation: the attribute set is the documented, standard remedy with
  Safari 14.1+ support; manual verification in the packaged app is the
  residual check.

## 8. Open questions / assumptions

- Owner confirmed at the grill: "autocorrector" = macOS text autocorrect (not
  the pickers' auto-selection); scope = all identifier search boxes + the
  branch-name input, prose fields untouched; acceptance = e2e attribute
  assertions.
- Assumption A1 (unverified, no spike possible): Electrobun's WKWebView
  honours `autocorrect="off"` / `autocapitalize="off"` / `spellcheck="false"`
  like Safari does. Blast radius if wrong: the fix is inert, nothing breaks.

## 9. Completeness ledger

| Candidate remainder | Disposition | Owner / reason |
| --- | --- | --- |
| `SearchSelect` search box (Project + Branch pickers, issue-dialog branch picker) | **in this run** — T1 | the request itself |
| `MultiSearchSelect` search box (Kanban filters ×4, Worktrees dialog ×2) | **in this run** — T2 | owner chose "all identifier search boxes" at the grill |
| Branch-name input (`WorktreeOptions`) | **in this run** — T3 | owner chose it explicitly at the grill |
| Branch naming-pattern input (`BranchNamingDialog`) | **in this run** — T3 | reached from the branch-name field's settings button; same identifier semantics, already had a partial (`spellCheck`-only) opt-out — leaving it would be the drift the constant exists to end |
| Existing `spellCheck={false}` / `autoComplete="off"` on the above sites | **in this run** — T3 replaces them with the spread (no duplicate attributes) | consistency |
| GitHub tokens section host input (`GitHubTokensSection`, `spellCheck`-only today) | **in this run** — T3 | owner swept it in at the approval gate. The `type="password"` token input stays as-is: autocorrect is inherently off on password fields |
| Title input and Prompt textarea in the New Task panel | **out of scope** | prose fields; owner confirmed autocorrect stays on |
| Free-text filter boxes (`Search title, prompt, workdir, branch…`) in KanbanFilters / WorktreesDialog | **out of scope** | they search prose (titles, prompts) as well as identifiers; not asked for, and not a "remainder" of this change |
| Docs / CLAUDE.md | **out of scope** — nothing describes the old behaviour | — |
| Owner-deferred | none | — |

## 10. Wave 3 addendum — post-review sweep (2026-09-03)

The wave-1 review (opus, `code-review` skill; 0 must-fix, 4 should-fix, 2 nits)
found identifier inputs the §2 survey missed because they are raw `<input>`s
or live in surfaces outside the New Task flow. The owner was asked once more
and chose the **full identifier sweep**. Commit `63a8889`.

**Review fixes applied**

- Spread-first convention: `{...IDENTIFIER_INPUT_PROPS}` is the first prop at
  every site (after `ref` / `data-testid` / `id` when present) so an explicit
  local prop always wins; the duplicated inline comments in the two `ui/*-select`
  primitives were removed (the constant's doc comment carries the rationale).
- Datalist rule (documented in `identifier-input.ts`): an input with `list="…"`
  spreads the constant then sets `autoComplete={undefined}` — `autocomplete="off"`
  can suppress `<datalist>` suggestions in some engines, and React omits
  undefined props. Applied to the Settings host input and the GitHub dialog's
  Labels and Tag-name inputs.
- Doc-comment site count removed (it was already wrong and would rot).

**Ledger additions (all *in this run*, owner-approved at the review gate)**

| Surface | Sites |
| --- | --- |
| `kanban/ExtensionPicker.tsx` search box (MCP / skills / plugins / prompts names) | 1 |
| `settings/SettingsDialog.tsx` additional-harness editor: Id/slug, HOME path, Bin override (not the display Label) | 3 |
| `kanban/GitHubDialog.tsx` — every input that must match a remote identifier exactly: labels, assignees, milestone number (×2 composers), item search query, assignee, head/base branch, reviewers (×2), teams, label name + hex (create + edit), tag name, ref, workflow-dispatch input name, `#number` (×2), transfer owner/repo | 24 |

Still **out of scope** (prose): every Title / Description / Release-title
input, the workflow-dispatch "Value" input, date inputs, textareas, prompt
names, and the free-text "Search title, prompt, …" filter boxes. Password
inputs never autocorrect.

**Tests (wave 4)**: `e2e/identifier-inputs.spec.ts` extended to the Extensions
search box and the Settings host input (asserting autocorrect/autocapitalize/
spellcheck present and `autocomplete` absent — the datalist rule), plus the
harness editor and GitHub-dialog inputs where reachable with existing fixtures.

**Phase 7 first pass** (before wave 3): typecheck 0, bun suite all green,
Playwright 48 passed / 3 failed / 12 skipped. `font-size.spec.ts` failed at the
worker fixture's port pre-flight (a leaked worker backend on :4600 from an
earlier single-spec run; the 12 skips are that worker's remaining tests) —
environmental. `fx-interactions.spec.ts` and `resolve-conflicts.spec.ts` each
had one failure whose artifacts were lost to a retry; both are re-triaged in
the Phase 8 re-run.

## 11. Wave 4 addendum — search/filter rule + wave-3 review (2026-09-03)

The wave-3 review (opus, `code-review` skill; 0 must-fix, 2 should-fix, 1 nit)
pointed out that the GitHub item-search box had opted out while its two
structurally identical siblings (the Kanban and Worktrees free-text filter
boxes) had not, with no recorded rule separating them. Resolution — the rule
is now written into `identifier-input.ts`: **identifier inputs AND
search/filter boxes opt out** (a box whose text is matched against existing
content never wants correction; a corrected query just finds nothing);
**composition fields keep autocorrect** (titles, descriptions, notes, prompts,
prompt names). Consequently three more sites were swept in:

| Surface | Sites |
| --- | --- |
| `kanban/KanbanFilters.tsx` free-text filter ("Search title, prompt, workdir, branch…") | 1 |
| `worktrees/WorktreesDialog.tsx` free-text filter ("Search title, branch, project, path…") | 1 |
| `kanban/RunPanel.tsx` transcript search ("Search messages") | 1 |

This flips the §9 row "Free-text filter boxes — out of scope" to *in this
run*, by the orchestrator under the completeness contract (the owner chose the
widest scope at all three gates); it's a one-line revert per site if unwanted.

**Datalist carve-out kept, honestly labelled.** The review noted the HTML
spec says `autocomplete` shouldn't gate `<datalist>` suggestions and asked for
an empirical check in the packaged app. That check can't be automated here,
so the three `autoComplete={undefined}` overrides stay as the conservative
choice (the datalist behaves exactly as it did before this change) and the
doc comment now says so and names the removal condition. **Manual check for
the owner:** in the packaged app, Settings → Git host tokens → does the
detected-hosts dropdown still appear? If yes, the overrides can go.

The three inline datalist comments were unified to the one-line
cross-reference. Tests: the unit-test docstring lists the search/filter boxes;
`e2e/identifier-inputs.spec.ts` gains an assertion on the Kanban free-text
box (six e2e tests in the file now). Total spread sites: 36.

# Plan — Task Details message readability QoL

| Field | Value |
| --- | --- |
| Date | 2026-08-12 |
| Source | `/implement` — "more space between the paragraphs and add some margin to the titles in the messages of Task Details… and other QoL UI improvements to make the messages better readable" |
| Config | AGENTS_CONFIG.yml (balanced, v1 schema) |
| Branch | feature/some-minor-ui-improvements-for-text |
| Base SHA | 2a4f1a1f3eb8a88aae8bd9581592a5c109d87a85 |
| Mode | **Autonomous** — no live owner; grill + plan-approval gates self-resolved, assumptions logged in §8 |

## 1. Objective & success criteria

Make agent/user message markdown in the Task Details stream easier to read:
- Headings ("titles") get visible breathing room — clearly more space above a heading than between two paragraphs, snug space below (heading binds to its own section).
- Paragraph-to-paragraph spacing loosens modestly.
- Related small QoL: slightly roomier list items, `hr` spacing consistent with the new rhythm, slightly more generous line-height.
- No perf regression (no new inline objects in the react-markdown component maps), no theme breakage, values stay in `rem`.

## 2. Context & constraints (Phase 1 findings)

- All block typography for message markdown lives in the global `.agetor-md` class, `src/mainview/index.css:134-185` — **not** in `USER_MD_COMPONENTS`/`ASSISTANT_MD_COMPONENTS` (`src/mainview/components/kanban/md-components.tsx:129-142`, which only override `a`/`code`/`pre`). The CSS class is the whole change surface.
- Current rules: container `line-height: 1.55`; the only inter-block spacing is the lobotomized-owl `> * + * { margin-top: 0.5rem }`; `p { margin: 0 }`; headings have size/weight (h1 `1.05rem` … h4–h6 `0.875rem`, weight 600, `line-height: 1.3`) but **no margins of their own**; `li { margin: 0.125rem 0 }`; `hr { margin: 0.5rem 0 }`.
- The comment at `index.css:134-136` documents the tightness as intentional (messages shouldn't dwarf adjacent 12px tool-call rows) → changes must be modest, not a full "prose" treatment.
- **Shared class — blast radius**: `.agetor-md` also styles PlanDialog plan bodies (`PlanDialog.tsx:330`) and all GitHubDialog PR/issue markdown (`GitHubDialog.tsx:6115` etc.). Those surfaces get the same improvement; dense GitHub bodies are the reason to stay modest.
- **rem only**: commit `2a4f1a1` (#170) added an app-wide font-size control that scales `documentElement.style.fontSize`; `px` values would break scaling.
- Semantic color tokens only (repo convention); no color changes planned anyway.
- No Tailwind typography plugin (`tailwind.config.js:97` → `plugins: []`); do not add one.
- ThinkingBlock and RawText are plain `pre-wrap` text, not markdown — out of scope (see §8).
- Perf constraint from prior fleet work: component maps stay module consts; block components stay memo'd. A CSS-only change satisfies this trivially.

## 3. Approach & key decisions

**CSS-only change to `.agetor-md` in `src/mainview/index.css`** (single file), keeping the margin-top-only owl pattern so margin-collapsing never enters the picture:

```css
.agetor-md { line-height: 1.6; }                      /* was 1.55 */
.agetor-md > * + * { margin-top: 0.625rem; }          /* was 0.5rem — paragraph rhythm */
/* headings: clear space above (wins over the owl by specificity)… */
.agetor-md h1, … h6 { margin-top: 1.125rem; }
/* …snug space below (placed AFTER the heading rules so consecutive headings stay snug) */
.agetor-md h1 + *, … h6 + * { margin-top: 0.375rem; }
/* guard: first child never gets pushed down (heading-first messages) */
.agetor-md > :first-child { margin-top: 0; }
.agetor-md li { margin: 0.1875rem 0; }                /* was 0.125rem */
.agetor-md hr { margin: 0.75rem 0; }                  /* was 0.5rem */
/* optional, small: h1 1.125rem / h2 1.0625rem / h3 1rem for a touch more hierarchy */
```

Alternatives considered:
- *Tailwind `@tailwindcss/typography` (`prose`)* — rejected: heavyweight, fights the intentional density, new plugin dependency.
- *Per-element overrides in the MD component maps* — rejected: wrong layer (styling is CSS-driven by design; maps exist only for `a`/`code`/`pre` behavior), and would triple-maintain across USER/ASSISTANT/GH maps.
- *Scoping changes to RunPanel only via a modifier class* — rejected: PlanDialog and GitHubDialog benefit equally from the fix; a modest global improvement beats a fork of the type ramp. Revisit only if GitHub bodies look too airy (see risk in §7).

Decisions rest on Phase 1 code reading (file:line verified); no spikes needed — pure CSS with well-understood cascade behavior (specificity: `.agetor-md h1` (0,1,1) beats `.agetor-md > * + *` (0,1,0); `.agetor-md > :first-child` (0,2,0) beats the heading rule).

## 4. Work breakdown — implementation

| ID | Goal | Files owned | Deps | Acceptance |
| --- | --- | --- | --- | --- |
| I1 | Apply the `.agetor-md` spacing/typography changes from §3 | `src/mainview/index.css` | — | Rules match §3 semantics; rem-only; comment at 134-136 updated to describe the new rhythm; `bun run typecheck` green; `bunx vite build` green |

Single wave, single task — nothing to partition.

## 5. Work breakdown — tests

| ID | Goal | Files owned | Covers | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Playwright spec asserting the reading rhythm on a rendered assistant message | `e2e/markdown-readability.spec.ts` | I1 | Renders a message containing `## heading` + two paragraphs + a list via the existing per-worker-backend fixtures (`e2e/fixtures.ts`, follow `quote.spec.ts` patterns); asserts computed styles **structurally** (heading margin-top > paragraph gap > 0; first child margin-top = 0) rather than exact px, so the spec survives future tuning and the font-size control |

**E2e applies**: the change is user-visible rendering in the webview; the repo has a parallel-safe Playwright harness (`playwright.config.ts`, worker-scoped isolated Bun backends per `docs/plans/e2e-per-worker-backends.md`). Run recipe: `bunx playwright test` (harness auto-manages the shared Vite server + per-worker backends). Unit tests don't apply — no logic changed; no unit test renders RunPanel.

## 6. Execution waves

1. Wave 1: I1 (implementation, sonnet)
2. Review (opus) on the diff vs base
3. Wave 2: T1 (tests creation, sonnet)
4. Test run: `bun test` + `bun run typecheck` + `bunx playwright test` (haiku runner)
5. Fixes if needed (sonnet), re-run to green

## 7. Blast radius & risks

- `.agetor-md` is shared: RunPanel messages, PlanDialog, GitHubDialog PR/issue bodies all shift. Mitigation: modest deltas (+0.125rem paragraph gap, headings +~0.6rem above). Rollback = revert one CSS block.
- Consecutive headings (`h2` directly followed by `h3`) get the snug 0.375rem gap by source order — accepted (a heading directly under its parent heading *should* bind tightly).
- Headings nested inside blockquotes/list items get `margin-top: 1.125rem` without the owl context — rare in agent output; accepted.
- The rAF-batched stream and memo'd blocks are untouched — no perf risk.

## 8. Open questions / assumptions (autonomous mode log)

- **A1**: "Titles" = markdown headings inside message bodies (not the panel section headers, which were just fixed in #164). Confidence: high, from the wording "titles in the messages".
- **A2**: The shared `.agetor-md` surfaces (PlanDialog, GitHubDialog) should receive the same improvement rather than be shielded with a scoped class. If GitHub PR bodies feel too loose afterwards, add a density modifier class there in a follow-up.
- **A3**: ThinkingBlock rendering literal `#`/`-` (it's plain text, not markdown) is a separate feature, out of scope here.
- **A4**: Exact values (0.625/1.125/0.375 rem) are my design call within the "modest" constraint; they're one-line tunables.
- Gates bypassed: Phase 2 grill and Phase 3 approval were self-resolved because the session runs unattended (agetor-orchestrated).

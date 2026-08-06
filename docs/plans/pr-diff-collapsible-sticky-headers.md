# Plan — Collapsible PR diff files + sticky per-file headers

| Field | Value |
| --- | --- |
| Date | 2026-07-14 |
| Source | /implement task (agetor run): "make the diff files in the Pull Request page in the Git integration collapsable/expandable; make them also having a fixed header, that is fixed until we're reading the file, similar to GitHub" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/pull-request-diff-files-expandable |
| Base SHA | 3f4b057e826383869fff20bf118f7c33b0072d0f (tree clean) |
| Mode | **Autonomous** — grill gate and plan-approval gate bypassed; every assumption is logged in §8 |

## 1. Objective & success criteria

On the PR detail subpage of the Git integration modal (`GitHubDialog`), each file in the "Diff" section:

1. Can be collapsed/expanded by clicking its header row (chevron indicates state). Default: expanded.
2. Has a header that sticks to the top of the diff scroll container while that file's hunks are scrolled, and is pushed away by the next file's header — GitHub's "Files changed" behavior.
3. Works identically for GitHub, GitLab, and Bitbucket PRs (single shared component — automatic).
4. `bun run typecheck` and `bun test` stay green.

## 2. Context & constraints (Phase 1 findings)

- All rendering lives in `src/mainview/components/kanban/GitHubDialog.tsx`:
  - `PullDiff` renders the list: scroll container at `:7675` — `max-h-[55vh] overflow-y-auto rounded-md border border-border/60`, mapping `diff.files` → `DiffFileBlock`.
  - `DiffFileBlock` at `:8481-8522`: outer `div.border-b`, header row `div.flex items-center gap-2 bg-muted/40 px-2 py-1.5` (status icon, path, +adds/−dels), then `DiffBody` (or binary/truncated notices).
- **Nearest scrolling ancestor for `sticky` is the `:7675` container**, not the outer modal body (`:3125`). `top-0` therefore pins to the diff box, which is the desired GitHub-like behavior. `position: sticky` inside each per-file block gives the "pinned until the file ends, then pushed out by the next header" behavior natively — no JS scroll tracking.
- No sticky element exists inside the diff containers today. Codebase sticky convention: `sticky top-0 z-10` (`RunPanel.tsx:2484`), which pairs a translucent bg with `backdrop-blur-md` to stop content bleed-through.
- House collapse style: hand-rolled `useState<boolean>` + full-width `<button>` with `ChevronDown`/`ChevronRight` (`size-3.5`) and `aria-expanded` — see `PullCommits` (`GitHubDialog.tsx:7324-7350`). No Collapsible/Accordion primitive exists; don't add one.
- Data shape: `DiffFile` (`src/shared/types.ts:957-977`). No backend change needed.
- Tests: no React DOM test harness exists; mainview tests are pure-logic `.ts` modules only. Test command `bun test`.

## 3. Approach & key decisions

- **Per-file local state** in `DiffFileBlock`: `const [open, setOpen] = useState(true)`. No lifted `Set<string>` (no such pattern exists in this file; nothing else needs the state). State resets on remount/refresh — acceptable.
- **Header becomes a `<button type="button">`** (full-width, keeps current layout classes) so the whole row toggles, matching `PullCommits`. Add a leading `ChevronDown`/`ChevronRight` before the status icon; keep icon/path/counters unchanged; add `aria-expanded={open}`.
- **Sticky**: header gets `sticky top-0 z-10`. To avoid diff text bleeding through the current translucent `bg-muted/40`, wrap so the sticky element is opaque: sticky wrapper carries `bg-background`, inner row keeps `bg-muted/40 px-2 py-1.5` — pixel-identical at rest, opaque when overlapping. (Alternative considered: `bg-card/50 backdrop-blur-md` à la RunPanel — rejected: blurred code lines under a thin header look noisy; the two-layer solid approach is deterministic.)
- **Collapsed** = body (`DiffBody` / binary notice / truncated notice) not rendered; the `border-b` file separator stays so collapsed files read as compact rows.
- Binary and truncated files are collapsible too (uniform behavior).
- Out of scope (non-goals): expand-all/collapse-all toolbar button, "viewed" checkboxes, persisting collapse state, virtualization, backend changes.

## 4. Work breakdown — implementation tasks

| ID | Goal | Files owned | Deps | Acceptance |
| --- | --- | --- | --- | --- |
| I1 | Add collapse/expand + sticky header to `DiffFileBlock` (and nothing else) | `src/mainview/components/kanban/GitHubDialog.tsx` | — | §1 criteria 1–2; typecheck green; visual style matches §2 tokens |

Single task — the change is confined to one component in one file; fan-out would only create collision risk.

## 5. Work breakdown — test tasks

None created. Rationale (logged decision): the change is a boolean `useState` toggle plus CSS classes; the repo has no DOM/component test harness, and extracting a `lib/` module to unit-test a boolean flip would be an artificial harness, contrary to the codebase's "extract *real* logic" pattern (e.g. `github-dialog-view.ts`). Phase 7 still runs the full existing suite + typecheck to catch regressions.

## 6. Execution waves

- Wave 1: I1 (single agent, `implementation` runner = sonnet).
- Then: code review (opus) → run `bun run typecheck` + `bun test` (haiku) → fixes if needed.

## 7. Blast radius & risks

- `DiffFileBlock` is used only by `PullDiff` in this modal; all three providers share it — one change covers all, and no other surface renders this component.
- Sticky + `z-10`: no competing positioned elements inside the `:7675` container; `overflow-y-auto` + `rounded-md` on the container clips corners, so no corner artifacts.
- Turning the header `div` into a `<button>`: default button styles (text-align, font) must be neutralized (`text-left`/`w-full`); nested content is spans/icons only — valid HTML.
- Rename keys (`oldPath -> path`) unchanged; no key churn.

## 8. Open questions / assumptions (autonomous mode)

1. Default state **expanded** (GitHub's default). 
2. Sticky is scoped to the inner `max-h-[55vh]` diff container (the modal has nested scroll areas; GitHub pins to the page — here the diff box is the analogue).
3. Whole header row is the click target (house style), no separate tiny chevron button.
4. No expand/collapse-all control, no persistence of collapse state across refreshes.
5. No new tests (see §5); suite + typecheck must stay green.

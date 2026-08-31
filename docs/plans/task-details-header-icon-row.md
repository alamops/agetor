# Plan — Task-details header: icon-only button row, title/subtitle below

| Field | Value |
| --- | --- |
| Date | 2026-08-31 |
| Source | /implement conversation + screenshot `screenshot-2026-08-31_19-51-34-b3d12184.png` |
| Config | AGENTS_CONFIG.yml (balanced) |
| Flags | none |
| Gates | grilled + approved by owner |
| Branch | feature/better-task-details-header-ui (pre-existing, clean) |
| Base SHA | 9b23119179bac6150dc05ae4f388f303d842341f |

## 1. Objective & success criteria

Restructure the RunPanel ("Task details") header so that:
- **Row 1** contains only buttons, all **icon-only** (no visible text labels), **right-aligned in today's order**.
- **Row 2** is the task title; **Row 3** is the subtitle (`agent · column · branch · base`), both full-width below the buttons.
- Every icon-only button carries `title` + `aria-label` (the app's established convention — GitHubDialog/DiffDialog pattern), fixing the header Close button which today has neither.
- No behavior change: same handlers, same render conditions, same search bar / Cmd+F / Escape-layering wiring.

## 2. Context & constraints (Phase 1 findings)

- Header: `src/mainview/components/kanban/RunPanel.tsx:2560-2709`. Container `flex items-start justify-between gap-2 border-b border-border/60 p-3`; left block `min-w-0 flex-1` (title `truncate text-sm font-semibold`, subtitle `truncate text-xs text-muted-foreground` with `font-mono` branch + `opacity-70` base spans); right block `flex items-center gap-2`.
- Buttons in order (conditions preserved verbatim): **View PR** (`GitPullRequest`, outline/sm, Button-or-ExternalLink depending on `parsePullNumber`), **View issue** (`CircleDot`, outline/sm, `data-testid="view-issue"` on both branches), **PR re-check** (`RefreshCw`, ghost/icon, already icon-only), **Diff** (`GitCompare`, outline/sm), **Open** (`FolderOpen`, outline/sm, dynamic path `title`), **Stop** (`Square`, destructive/sm), **Archive** (`Archive`, outline/sm) / **Unarchive** (`ArchiveRestore`, outline/sm), **Search** (`Search`, ghost/icon, `title` only), **Close** (`X`, ghost/icon, no title/aria-label).
- `Button` (`ui/button.tsx`) has `size="icon"` (`h-9 w-9`). Icon-only convention elsewhere: `title` + `aria-label` together; no tooltip primitive.
- Max realistic simultaneous buttons ≈ 9 → ~388px at h-9 w-9 + gap-2, fits the 520px panel; add `flex-wrap` as safety.
- **Tests:** no e2e/unit selector targets header buttons by visible label; `view-issue` testid and the backdrop's `aria-label="Close task panel"` (RunPanel.tsx:335 — a different element) are the only header-adjacent selectors. Label removal breaks nothing.
- Sibling convention: GitHubDialog detail header uses `mt-0.5` title→subtitle spacing.
- Known repo traps honored: no undefined Tailwind tokens; no `position:fixed` descendants (transform ancestor); search bar rows below keep `border-b border-border/60`.

## 3. Approach & key decisions

- **Single-file JSX restructure** — header becomes a stacked block: buttons row (`flex flex-wrap items-center justify-end gap-2`), then title (`mt-2 truncate text-sm font-semibold`), then subtitle (`mt-0.5 truncate text-xs text-muted-foreground`, content unchanged). `min-w-0 flex-1` left-block wrapper goes away (truncate works on full-width block divs).
- **Icon-only conversion**: drop label text + `mr-1` from icons; normalize icons to `size-4`; switch labeled buttons from `size="sm"` to `size="icon"`. **Keep each button's variant** (outline / ghost / destructive) so Stop stays visually destructive and action-vs-utility distinction survives (owner chose "all icon-only" incl. Stop).
- **Accessibility**: static `aria-label` on every button ("View PR", "View issue", "Re-check PR status", "View diff", "Open working folder", "Stop", "Archive", "Unarchive", "Search messages", "Close task details"); keep existing dynamic `title`s (Open's path, Archive's mode, PR re-check error) and add static `title`s where missing. `ExternalLink` fallback branches of View PR / View issue get the identical treatment.
- Decision rests on owner answers (icon scope, right-aligned) + Phase 1 evidence (no label-based selectors; convention anchors).

## 4. Work breakdown — implementation tasks

- **T1** — Restructure RunPanel header per §3. Owns `src/mainview/components/kanban/RunPanel.tsx` (header block only, ~lines 2560–2709). Acceptance: buttons-only right-aligned first row, all icon-only with title+aria-label, title/subtitle rows below, all render conditions/handlers/testids unchanged, typecheck green.

## 5. Work breakdown — test tasks

- **T2** — New `e2e/run-panel-header.spec.ts` (disjoint file): opens a task panel (reuse `e2e/fixtures.ts`/`helpers.ts` idioms), asserts (a) icon-only buttons expose accessible names (`getByRole("button", { name: "View diff" })` etc. visible, no visible "Diff"/"Open" text), (b) title + subtitle render below and show task title/agent, (c) Close via its new aria-label closes the panel. E2e applies (user-visible flow, Playwright harness exists; recipe: `bun node_modules/@playwright/test/cli.js test e2e/run-panel-header.spec.ts`, one Playwright run at a time). Unit layer: none — no DOM unit harness for RunPanel exists.

## 6. Execution waves

- Wave 1: T1 (1 sonnet agent) → typecheck checkpoint → commit.
- Review (opus) on the diff.
- Wave 2: T2 (1 sonnet agent) → commit.
- Test run (haiku): `bun run typecheck`, `bun test`, targeted `e2e/run-panel-header.spec.ts`.

## 7. Blast radius & risks

- Pure layout; no server/API/data change. Risks: (a) losing a render condition or handler in the JSX move — mitigated by verbatim-condition instruction + opus review; (b) discoverability drop from removing labels — mitigated by titles (hover) + aria-labels; (c) e2e flake — targeted spec, retry-once rule; (d) subagent tabs/archived states share this header — conditions preserved verbatim so unaffected.

## 8. Open questions / assumptions

- Owner answered: all buttons icon-only (incl. Stop); row right-aligned in current order.
- Assumption (low risk): keeping per-button variants (outline/ghost/destructive) rather than flattening to all-ghost; matches the "least surprise" reading of the screenshot. Reversible in one line per button.

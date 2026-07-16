# Plan — Branch-name template tags (`<slug>`, `<project_name>`, …)

| Field | Value |
| --- | --- |
| Date | 2026-07-12 |
| Source | /implement request + screenshot (Branch name field showing `feature/gtifkf`) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/branch-nomenclature-field-update (pre-existing agetor worktree branch) |
| Base SHA | 17beecdc47aa9a2773f02f470e319ff4dc0b13e7 |
| Mode | **Autonomous** — grill + plan-approval gates bypassed; assumptions logged in §8 |

## 1. Objective & success criteria

Replace the New Task sidebar's eagerly-resolved branch default (which shows a
gibberish token like `feature/gtifkf` while the title is empty) with a
**template pattern** containing dynamic tags, and document those tags in a
helper message under the field.

Done means:
- With no manual edit, the Branch name field shows the project's pattern with
  tags visible, e.g. `feature/<slug>` — never a random token.
- A muted helper line under the field lists the supported tags and says they
  are replaced at task creation; a live preview shows the resolved name.
- Tags typed by the user anywhere in the field (`<slug>`, `<project_name>`,
  `<type>`, `<date>`, `<timestamp>`, `<token>`) are substituted server-side at
  create time; uniqueness (-2/-3 suffixing) still applies afterwards.
- A tag-free override still passes through verbatim (back-compat).
- `bun run typecheck` green; `bun test` green.

## 2. Context & constraints (grounded)

- `src/shared/types.ts:236-318` — `BranchNamingRule`/`BranchNamingConfig`,
  `DEFAULT_BRANCH_CONFIG` (task→`feature/`, bug→`fix/`, spike→`spike/`,
  `includeSlug: true`), `slugifyBranch`, `buildBranchName(config, type, title,
  {token})`. All pure, shared by both processes.
- `src/mainview/components/kanban/NewTaskForm.tsx:111-148, 602-628` — field
  auto-tracks `computedBranch` until `branchDirty`; token comes from
  `newBranchToken()` (`Math.random`), which is what surfaces as `gtifkf`.
  Existing "Reset to pattern" affordance already uses the word *pattern*.
- `src/bun/orchestrator.ts:1648-1668` — `createTask` treats a non-empty
  `input.branch` as an override: validate → `ensureUniqueBranch`. No-override
  path composes via `buildBranchName` with a token derived from the task id.
- `validateBranchName` (`types.ts:326`) does **not** forbid `<`/`>` — git
  ref-legal — so templates in the field are not rejected by validation today.
- Prior decision entry (#90 design) — uniqueness is two-layer
  (`ensureUniqueBranch` at create + `isBranchNameTakenError` at start);
  sidebar field is the source of truth for `createTask.input.branch`.
  Nothing in this change may touch the start-time recovery path.
- No DB/schema change: config stays `{ rules, includeSlug }`; templates live
  in the field value only.

## 3. Approach & key decisions

- **Shared renderer** `renderBranchTemplate(template, ctx)` in
  `src/shared/types.ts`, ctx = `{ title, projectName, taskType, token, now }`.
  Deterministic (no `Date.now()` inside — `now` injected) so client preview
  and server resolution agree and tests are stable.
  - `<slug>` → `slugifyBranch(title) || token` (never empty — this kills the
    `feature/` dangling-slash edge on symbol-only titles).
  - `<project_name>` → `slugifyBranch(basename(workdir))`, fallback `project`.
  - `<type>` → task type id (`task` | `bug` | `spike`).
  - `<date>` → `YYYY-MM-DD`; `<timestamp>` → `YYYYMMDD-HHmmss` (local time).
  - `<token>` → caller-supplied short unique token.
  - Unknown `<…>` sequences pass through literally (git-legal; documented).
- **Pattern builder** `branchPattern(config, taskType)` →
  `${prefix}<slug>` when `includeSlug`, else `${prefix}<token>`. Single
  source for "what the undirty field shows" and the server's no-override
  default (`createTask` renders the same pattern → behavior identical to the
  old `buildBranchName` path).
- **Form UX**: undirty field value = `branchPattern(...)` (stable — no more
  rewriting the field as the title is typed). Below the field: live resolved
  preview (`→ feature/my-task`) when the value contains tags, plus a helper
  line enumerating the tags. Validation gates submit on the **resolved**
  name. `newBranchToken` stays as the preview/validation token seed.
- **Server**: in `createTask`, when the override contains tags, render it
  with the real task id token + creation time before validate +
  `ensureUniqueBranch`. Tag-free overrides keep today's verbatim path.
- Rejected: storing a full template string in `BranchNamingConfig` (schema
  migration + settings-dialog redesign for no user-visible ask); resolving
  tags client-side at submit (server must be authoritative for direct API
  callers and for `<timestamp>` at true creation time).

## 4. Work breakdown — implementation

| ID | Goal | Owns (disjoint per wave) | Depends on |
| --- | --- | --- | --- |
| W1-A | Shared: `BRANCH_TEMPLATE_TAGS` metadata, `renderBranchTemplate`, `branchPattern`; unit tests | `src/shared/types.ts`, `src/shared/branch.test.ts` | — |
| W2-A | Server: render template in `createTask` override + default paths; tests | `src/bun/orchestrator.ts`, `src/bun/branch-nomenclature.test.ts` | W1-A |
| W2-B | Webview: pattern-in-field, helper tags line, live resolved preview, resolved-value validation | `src/mainview/components/kanban/NewTaskForm.tsx` | W1-A |

## 5. Work breakdown — tests

Folded into W1-A (renderer semantics) and W2-A (createTask resolution,
uniqueness after resolution, back-compat verbatim path). No webview test
harness exists for `NewTaskForm` — UI covered by typecheck + manual preview
logic living in the shared, tested renderer.

## 6. Execution waves

Wave 1: W1-A alone (defines the shared API). Barrier. Wave 2: W2-A ∥ W2-B
(file-disjoint). Then review (opus) → full `bun test` + `bun run typecheck`
(haiku) → fixes if needed.

## 7. Blast radius & risks

- `buildBranchName` keeps its signature (used by `validateBranchConfig`
  sample composition) — no callers break.
- `commitPushPrompt`/`branchCommitType` operate on the *pinned resolved*
  branch — unaffected.
- Start-time `prepareWorkdir` uniqueness recovery untouched.
- Old clients / direct API callers sending literal branch names: unchanged
  behavior (no tags → verbatim).
- A stored pattern is never persisted — `task.branch` is always the resolved,
  unique name, so CLI/TUI/RunPanel surfaces see real branches only.

## 8. Open questions / assumptions (autonomous mode)

1. Tag set chosen: `<slug>`, `<project_name>`, `<type>`, `<date>`,
   `<timestamp>`, `<token>` — user said "etc.", this covers the named three.
2. `<project_name>` = slugified basename of the task's workdir (projects
   table has no display-name column worth plumbing for this).
3. Field shows the *pattern* (stable) rather than live-rewriting to the
   resolved name; resolved name appears as a preview line. Matches the
   screenshot intent ("feature/<auto-slugify>" visible in the field).
4. Timestamp format `YYYYMMDD-HHmmss` local time; date `YYYY-MM-DD`.
5. Unknown `<…>` tags pass through literally rather than erroring.
6. No settings-dialog/schema changes; per-project prefixes still come from
   the existing BranchNamingDialog.

# Plan — Branch-naming rules: recognize template tags typed into the per-type field

| Field | Value |
| --- | --- |
| Date | 2026-07-14 |
| Source | /implement — bug report + screenshot (Branch naming dialog shows `feature/<slug><slug>` / `feature/<slug>add-login-page`) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/bug-on-pattern-tags |
| Base SHA | dfb16bb7cfe107633aa905d48a04655675854a91 |
| Mode | **Autonomous** — grill + plan-approval gates bypassed; assumptions logged in §8 |

## 1. Objective & success criteria

Typing a template tag (e.g. `<slug>`) into a per-type field in the Branch naming
dialog must be recognized, not doubled or left literal:

- Field `feature/<slug>` → pattern `feature/<slug>` (no second `<slug>` appended),
  e.g. line `feature/add-login-page` (tag substituted).
- Field `fix/` (plain prefix, no body tag) → pattern `fix/<slug>` exactly as today.
- Server-side branch creation, New Task form live field, dialog pattern line, and
  dialog example all agree, because they all resolve through the same path.
- `bun run typecheck` green; `bun test` green.

## 2. Context & constraints (grounded findings)

- `branchPattern` — `src/shared/types.ts:421` — returns
  `${rule.prefix}${includeSlug ? "<slug>" : "<token>"}` unconditionally.
  A prefix that already contains a body tag gets a second one appended.
- `renderBranchTemplate` — `src/shared/types.ts:400` — substitutes **all**
  occurrences of every known tag; the doubled pattern renders a doubled slug.
- `buildBranchName` — `src/shared/types.ts:308` — legacy composer:
  `prefix + (slugified title | token)`, **never** substitutes tags in the
  prefix. Production callers: `validateBranchConfig` (`types.ts:475`) and the
  dialog's example line (`BranchNamingDialog.tsx:120`). This is the second,
  divergent composer that produced the literal `<slug>` in the screenshot.
- The authoritative resolution path is the orchestrator's
  (`src/bun/orchestrator.ts:1712`): `renderBranchTemplate(branchPattern(config, taskType), ctx)`.
- The dialog's footer explicitly invites tags: "Tags are replaced when the task
  is created: `<slug>` … `<token>`" — so tag input into the field is a supported
  intent, not misuse.
- The New Task form (`NewTaskForm.tsx:144`) and `branch-field.ts` consume
  `branchPattern` + `renderBranchTemplate` only — they inherit the fix for free.
- `validateBranchName` allows `<`/`>` in ref names, so nothing rejects a
  literal tag — the bug ships silently into real branch names.

## 3. Approach & key decisions

**Make the per-type value a template when it carries a body tag; otherwise keep
prefix semantics.** Alternatives considered:

- *(rejected)* Treat any known tag as "full template": a value like
  `archive/<date>-` would then lose its body entirely and produce
  non-unique, dangling names.
- *(rejected)* Keep `buildBranchName` and teach it tags: its signature has no
  `projectName`/`now`, so it structurally cannot resolve `<project_name>`,
  `<date>`, `<timestamp>` — the drift between two composers is the root of
  this bug; kill the second composer instead.

Decisions:

- **D1** — `branchPattern` appends the body tag (`<slug>`/`<token>` per
  `includeSlug`) **only when the rule value contains neither `<slug>` nor
  `<token>`**. A value carrying a body tag is used verbatim. Other tags
  (`<date>`, `<type>`, `<project_name>`, `<timestamp>`) do *not* suppress the
  append — they aren't uniqueness carriers.
- **D2** — an explicit `<slug>` typed by the user wins over `includeSlug: false`
  (explicit beats global toggle).
- **D3** — delete `buildBranchName`; migrate its two callers to the
  orchestrator's path `renderBranchTemplate(branchPattern(config, type), ctx)`
  so there is exactly one composer.

## 4. Work breakdown — implementation tasks

**T1 — shared helpers + dialog** (owns `src/shared/types.ts`,
`src/mainview/components/settings/BranchNamingDialog.tsx`):
- `branchPattern`: implement D1/D2; update doc comment.
- Delete `buildBranchName` (D3).
- `validateBranchConfig`: build the per-type sample via
  `renderBranchTemplate(branchPattern(config, t.id), { title: "example task", projectName: "project", taskType: t.id, token: "abc123" })`.
- `BranchNamingDialog.tsx`: compute `example` via the same path with
  `EXAMPLE_TITLE`, `projectName: projectName || basename(projectPath)`,
  `taskType: t.id`, `token: "a1b2c3"`. Drop the `buildBranchName` import.
- Acceptance: §1 scenarios; typecheck green.

## 5. Work breakdown — test tasks

**T2 — tests** (owns `src/shared/branch.test.ts`):
- Replace the `buildBranchName` describe with equivalent coverage through
  `renderBranchTemplate(branchPattern(...))`.
- New `branchPattern` cases: body-tag value used verbatim (`feature/<slug>` →
  `feature/<slug>`; `wip/<token>` → `wip/<token>`); explicit `<slug>` kept when
  `includeSlug: false`; non-body tag still gets append (`archive/<date>-` →
  `archive/<date>-<slug>`); plain prefixes unchanged (`fix/` → `fix/<slug>`).
- New `validateBranchConfig` cases: tag-containing value validates its
  *rendered* form (`feature/<slug>` ok; `feat ure/<slug>` rejected).

## 6. Execution waves

- **Wave 1 (parallel, file-disjoint):** T1 (impl, sonnet) ∥ T2 (tests, sonnet) —
  both briefs pin the exact D1–D3 semantics, so tests need not wait for code.
- **Barrier**, then review (opus) on `git diff dfb16bb..HEAD` + worktree.
- Then test run (haiku): `bun run typecheck && bun test`.
- Fixes (sonnet) if red; re-run.

## 7. Blast radius & risks

- `branchPattern` callers: orchestrator (server branch creation), NewTaskForm
  (live field), dialog pattern line — all *want* the new semantics; plain-prefix
  configs (all existing DBs) hit the unchanged append path, so no behavior change
  for untouched configs.
- `buildBranchName` deletion: no production callers remain after T1; tests
  updated in T2. It is exported from shared/types.ts — grep confirms no other
  imports.
- `validateBranchConfig` is also called by the server persist route
  (`server.ts:360`) — semantics only tighten (validates the rendered name).
- `<date>`/`<timestamp>` render non-deterministically in validation samples —
  harmless: their formatted output is always git-legal.

## 8. Open questions / assumptions (autonomous mode)

- **A1** (= D1) Only body tags (`<slug>`/`<token>`) suppress the automatic
  append; `<date>`-style prefixes still get a body. Rationale: uniqueness.
- **A2** (= D2) Explicit `<slug>` beats `includeSlug: false`.
- **A3** (= D3) `buildBranchName` is deleted rather than patched, since a
  tag-blind second composer is the root cause and its signature can't carry
  full template context.

# Plan — Full GitHub Integration (remaining gap list)

| Field | Value |
| --- | --- |
| Date | 2026-07-08 |
| Source | `/implement the whole list, not letting any items out` (conversation) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | `agetor/c417fa218b9d-full-git-integration` (existing feature branch) |
| Base SHA | `f2c35f2` |
| Mode | **Autonomous** — plan self-approved; execution runs group-by-group without inter-group pauses (both gates bypassed per user's "autonomous to the end"). |

## 1. Objective & success criteria

Deliver **every** remaining GitHub-integration feature enumerated in the gap list — nothing dropped — on top of the shipped batches #1–#10. Each feature follows the established contract: backend function(s) returning `{ok:true,…}|{ok:false,error}`, a thin token-gated server route, an `api.ts` client method, shared wire types, UI wiring in `GitHubDialog.tsx` with per-item state maps + seq guards, pure helpers extracted + unit-tested via `__githubInternals`, and (new this program) **network-level tests via a fetch-mock harness**.

**Done** = all 23 features implemented; every group typecheck-clean, `bun test` green, `vite build` clean; each group passed an opus code-review with must-fixes folded in; all committed to the branch.

User decisions (grill, 2026-07-08):
- Heavy surfaces (Projects v2, Discussions, Actions, Notifications) → **full CRUD**.
- Cadence → **autonomous to the end** (no pause between groups).
- Verify → **fetch-mock harness first**, network tests per feature, opus review per group.

## 2. Context & constraints

- Central files touched by **every** feature (the collision surface): `src/shared/types.ts`, `src/bun/github.ts` (`fetchGitHub`, `repoForDir`, `githubToken`, `apiError`, `pageLinks`, `repoSlug`, `__githubInternals`), `src/bun/server.ts` (`authed(...)` routes, object-style `routes`), `src/mainview/lib/api.ts`, `src/mainview/components/kanban/GitHubDialog.tsx`.
- GraphQL path already exists (`fetchGitHub` used for draft toggle + review threads) — reuse for auto-merge, linked issues, pin, sub-issues, Projects, Discussions.
- Established patterns to mirror: `listGitHubLabels`/`LabelManager` (list+CRUD+manager UI), `getGitHubViewer` (identity), optimistic `upsertListItem`/reconcile, `actionSource` feedback routing, request-seq refs for stale async, Search-API single-page rate-limit awareness.
- Known gotcha captured: milestone `due_on` → noon UTC. GraphQL error mapping via `graphqlErrorMessage`.
- Test convention: pure helpers via `__githubInternals` + `github.test.ts`; UI pure helpers under `src/mainview/lib/*` with `.test.ts`. **New:** `fetchGitHub` network tests via a global-`fetch` mock harness.

## 3. Approach & key decisions

- **Sequential delivery groups, not parallel fan-out.** All features share the 5 central files, so same-tree parallelism would collide on every file. Each group is one wave = one implementation agent end-to-end + one opus review + tests + one commit. The one exception that *can* run parallel is the **fetch-mock harness** (new test-only files), so it goes first as a foundation and unblocks network tests for all groups.
- **Delegate implementation per group** to a `general-purpose` sonnet agent with a brief that names the exact exemplar functions/components to mirror; orchestrator reviews (opus), runs tests, and commits.
- **GraphQL for** auto-merge, linked issues, pin/unpin, sub-issues, Projects v2, Discussions (these have no/!partial REST). REST for the rest.
- Heavy surfaces get their own manager panels mirroring `LabelManager`/`MilestoneManager`.

## 4. Work breakdown — features (F1–F23) → groups (G0–G12)

- **G0 — Foundation:** F23 fetch-mock harness (global-`fetch` stub + request/response map; retrofit a few existing network fns as proof).
- **G1 — Triage completion:** F1 assignees picker (`GET /repos/:o/:r/assignees`), F2 triage pickers (labels checkboxes + milestone dropdown + assignees dropdown wired into the editor).
- **G2 — Reactions:** F3 reactions on issues/PRs/comments (`GET/POST/DELETE …/reactions`, `Accept: squirrel-girl`).
- **G3 — PR depth I:** F4 auto-merge (GraphQL enable/disable), F5 commits list (`GET /pulls/:n/commits`), F6 linked issues (GraphQL `closingIssuesReferences`).
- **G4 — PR depth II:** F7 suggested changes (```suggestion block + apply), F8 team review requests.
- **G5 — Issue depth:** F9 lock/unlock, F10 pin/unpin (GraphQL), F11 sub-issues (GraphQL), F12 transfer issue.
- **G6 — Cross-cutting correctness:** F13 push-permission gating (`GET /repos/:o/:r` → `permissions.push`), F16 pagination/sort (load-more + sort), F17 rate-limit surfacing.
- **G7 — Notifications (CRUD):** F14 inbox (`GET /notifications`), mark-read, subscribe/unsubscribe threads.
- **G8 — Multi-repo:** F15 span several project repos in one view.
- **G9 — Releases & statuses:** F18 releases/tags (list+create), F19 commit statuses list.
- **G10 — Actions (CRUD):** F20 workflow runs list, re-run, cancel, dispatch with inputs.
- **G11 — Projects v2 (CRUD):** F21 boards, items, fields (GraphQL).
- **G12 — Discussions (CRUD):** F22 list/view/create/answer/comment (GraphQL).

Each feature owns additive regions of the 5 central files (+ any new `src/mainview/lib/*` helper files). Within a group the implementation agent owns all listed files exclusively; groups never overlap in time.

## 5. Work breakdown — tests

- G0 delivers the harness. Every later group adds: (a) pure-helper unit tests via `__githubInternals`, (b) network tests for each new `github.ts` function via the harness (URL, method, body, error mapping), (c) UI pure-helper tests where logic is extracted.

## 6. Execution waves

Strictly sequential: **G0 → G1 → G2 → … → G12.** Each group: implement (1 agent) → opus review → fold must-fixes → tests (create + run) → typecheck + `bun test` + `vite build` green → commit. No two groups run concurrently.

## 7. Blast radius & risks

- Shared-file additive edits: each commit re-verifies the whole suite so a later group can't silently break an earlier one.
- GraphQL features depend on token scopes (Projects/Discussions need `read:project`, `write:discussion`); surface friendly errors when the token lacks scope rather than crashing.
- Push-permission gating (G6) retroactively changes control visibility across G1–G5 UI — sequenced after them deliberately so it gates the complete control set at once.
- Notifications/Projects/Discussions are large; risk is scope creep — hold to the CRUD set defined above.

## 8. Open questions / assumptions (autonomous-mode log)

Gates bypassed under autonomous mode; assumptions recorded here for audit:
- **A1:** "Full CRUD" on Projects v2 = create/edit/move items + set field values on an existing project; **not** creating new Projects or custom-field schema editing (org-admin surface, out of a per-repo dialog's scope).
- **A2:** Discussions CRUD = create/comment/answer/delete-own; category management is out of scope (repo-settings surface).
- **A3:** Actions "dispatch with inputs" = `workflow_dispatch` events on workflows that declare inputs; parses `inputs` from the workflow file best-effort.
- **A4:** Multi-repo = the dialog can switch/aggregate across the user's already-registered agetor projects that have GitHub remotes; not arbitrary repo search.
- **A5:** Sub-issues uses the current GitHub sub-issues GraphQL API; if unavailable on the token/plan, degrades to a friendly error.
- **A6:** Each group commits to the existing feature branch (no per-group branches); autonomous, so no push until the user asks (consistent with prior batches where I committed+pushed — I'll push at natural checkpoints).

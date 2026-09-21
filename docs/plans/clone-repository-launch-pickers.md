# Plan — Clone repository: launch pickers + provider-generic naming

| Field | Value |
| --- | --- |
| Date | 2026-09-21 |
| Source | Task prompt: agent/harness/model/effort selection in the "Checkout from GitHub" modal + provider-generic rename |
| Config | AGENTS_CONFIG.yml (balanced, v1) |
| Flags | none |
| Gates | grilled + approved by owner; re-scoped by owner after a peer-overlap check (see §8) |
| Branch | feature/add-profile-and-harnesses-selection-to-g |
| Base SHA | 11c954f5e1d10734fee5b5dc38951781dd49d0fe |

## 1. Objective & success criteria

1. The clone modal lets the user pick an **Agent (profile)** or a manual **Harness / Mode / Model / Effort** (plus cursor's fast/max-mode) for the explainer task that writes `ELI5.md`, using the same shared pickers as the New Task panel and the two launch dialogs.
2. The projects-picker entry and the modal are renamed **"Clone repository"** (owner's pick) — copy, toast and button follow ("Clone" / "Cloning…" / "Cloned <name>").
3. ~~Multi-provider parsing~~ — **moved out of this run by the owner** (2026-09-21): the sibling task on `feature/git-checkout-modal-support-all-git-provi` owns the provider-generic parser, token auth and provider selector. Until it merges, the renamed modal still accepts GitHub only.

Done means: typecheck green, unit + endpoint tests green, a Playwright spec proves the picked model / profile lands on the created task.

## 2. Context & constraints

- `src/mainview/components/kanban/CloneProjectDialog.tsx` — the modal. Sends `api.cloneProject(url, dest, eli5)`; carries its own regex mirror of the server parser (`repoNameFrom`) only to preview the default destination.
- `src/mainview/components/kanban/ProjectPicker.tsx:127-134` — the "Checkout from GitHub…" footer button; the dialog is a sibling of `SearchSelect` on purpose (the footer unmounts with the popover).
- `src/bun/server.ts:737-797` — `POST /projects/clone`: `parseGitHubRepo` → `cloneRepo` → `projects.upsert` → `createTask({title, prompt, workdir, isolation:"none"})` → `startTask`. No harness fields, so the task always runs on the built-in `claude-code` default.
- `src/bun/clone.ts` — `parseGitHubRepo` (GitHub-only, deliberately: ambient git credentials must not go to an arbitrary host), `cloneRepo`, `defaultCloneDest`, ELI5 prompt/title. The parser and prompt builders are pure; only `cloneRepo`/`defaultCloneDest` need node.
- `src/mainview/components/kanban/TaskLaunchPickers.tsx` — `useTaskLaunch(open)` + `<TaskLaunchPickers launch>`; consumers gate submit on `launch.effectiveStatus?.available`, send `agentProfileId` only when set (never `null`), pre-check `promptByteOverage(launch.effectiveKind, composeLaunchPrompt(launch.selectedProfile, prompt))`, call `launch.rememberPicks()` on success. Reference consumer: `ResolveConflictsDialog.tsx`.
- `createTask` (`orchestrator.ts:5294`) already resolves `agentProfileId` (unknown id → `{error}`), a bound profile overrides the six launch fields, unknown harness → `{error}`, and defaults model/effort by kind.
- `GitProvider` already exists in `src/shared/types.ts:4024`; cloud host ↔ provider mapping mirrors `git-provider.ts:providerForHost`.
- Tests: `src/bun/clone.test.ts` (parser + cloneRepo), `src/bun/clone-endpoint.test.ts` (route, `AGETOR_CLONE_SOURCE_OVERRIDE` seam, fake claude driver; one test asserts a gitlab URL is *rejected* — becomes untrue). e2e fixture `startBackend` takes `extraEnv`, so the clone seam is reachable from Playwright.
- No CLI/TUI surface calls `/projects/clone` (grep: only the webview).

## 3. Approach & key decisions

- **D1 (re-scoped) — shared pure module `src/shared/clone-eli5.ts`** holding only `ELI5_FILENAME`, `eli5TaskTitle`, `buildEli5Prompt`, so the webview can run the gemini overage pre-check against the real prompt. They move out of `src/bun/clone.ts` (tail hunk only — the parser, which the sibling task rewrites, is not touched). `parseGitHubRepo`, the dialog's `repoNameFrom` mirror, the placeholder and the "not a GitHub repo" error copy all stay as they are: the sibling task owns them.
- **D2 — DROPPED from this run (owner, see §8). Original text kept for the record:** parser rules. Result `{ provider, host, owner, repo, cloneUrl }`, `cloneUrl` always canonical `https://<host>/<owner>/<repo>.git`. Accepted per host: `https?://(www.)host/…`, `git@host:…`, `ssh://git@host/…`. `owner/repo` shorthand stays GitHub. GitHub + Bitbucket: first two path segments (deep links like `/tree/main`, `/src/main` are cut). GitLab: everything before a `/-/` marker, ≥ 2 segments, `owner` = all but the last (so `group/sub/project` → owner `group/sub`). Every segment passes the existing charset rule, never starts with `-`, never `.`/`..`; `git clone --` stays. Any other host → `null`.
- **D3 — route validates the launch selection BEFORE cloning.** A bad profile id or harness id 400s with nothing on disk, instead of cloning and then reporting `eli5Error`. Wire shape (all optional, additive): `agent, mode, model, effort, fast, maxMode, agentProfileId`. Type errors → 400. Only checked/used when `eli5 !== false`. A profile id wins (the six manual fields are then not forwarded), matching `createTask`. Response shape unchanged.
- **D4 — dialog UX (owner's pick).** Pickers render under the "Explain this repo" switch only while it is on. Clone button gating: URL parses, not busy, and — only while the switch is on — harness data loaded, `effectiveStatus.available`, no prompt overage. Turning the switch off always leaves a plain clone possible, even if harness loading failed. Panel grows to `max-w-lg` with a scrolling body (`max-h-[85vh]`), same skeleton as `ResolveConflictsDialog`.
- **D5 — `api.cloneProject` takes one options object** (single caller), replacing the positional `(url, dest, eli5)`.
- **D6 — docs.** CLAUDE.md gets one orchestration-flow item for the clone flow (none exists today).

## 4. Work breakdown — implementation tasks

**T1 — shared ELI5 module + server route + client API** (owns: `src/shared/clone-eli5.ts` new, `src/bun/clone.ts`, `src/bun/server.ts` clone route + import only, `src/mainview/lib/api.ts` `cloneProject` only, `src/bun/clone.test.ts`, `src/bun/clone-endpoint.test.ts` — existing tests kept compiling/true, not extended). Acceptance: `bun run typecheck` green apart from the dialog's call site (T2 owns it); D1–D3, D5 implemented; existing tests updated for the moved ELI5 imports only.

**T2 — dialog + picker entry** (owns: `src/mainview/components/kanban/CloneProjectDialog.tsx`, `src/mainview/components/kanban/ProjectPicker.tsx`). Acceptance: D4; rename copy; test ids `project-clone-open`, `clone-project-dialog`, `clone-url`, `clone-dest`, `clone-eli5-switch`, `clone-launch`, `clone-submit`; `rememberPicks()` after a started task; Enter in either input respects the same gate as the button.

**T3 — CLAUDE.md item** (orchestrator, inline, after review).

## 5. Work breakdown — test tasks

- **TT1 unit** — ELI5 prompt/title tests follow the code to `src/shared/clone-eli5.test.ts`; `src/bun/clone.test.ts` keeps the parser + `cloneRepo`/`defaultCloneDest` tests unchanged.
- **TT2 endpoint** — `src/bun/clone-endpoint.test.ts`: manual `model`/`effort`/`mode` land on the task; `agentProfileId` binds and overrides manual fields; unknown profile → 400 **and no clone dir**; unknown harness → 400 and no clone dir; wrong-typed field → 400; `eli5:false` ignores launch fields.
- **TT3 e2e — applies** (user-visible flow UI→API→git→task). `e2e/clone-project.spec.ts` (new): backend with `extraEnv.AGETOR_CLONE_SOURCE_OVERRIDE` at a local fixture repo; open picker → "Clone repository…" → title check; pickers hidden with the switch off; `owner/repo` URL + manual model pick → task row carries that model; profile pick → task carries `agentProfileId`. Run recipe: `bun node_modules/@playwright/test/cli.js test e2e/clone-project.spec.ts` (one Playwright run at a time).

## 6. Execution waves

- Wave 1: T1 ‖ T2 (disjoint files; T2 codes against the D5 contract stated in its brief). Barrier: typecheck green, commit.
- Review (opus) → fixes if any.
- Wave 2: TT1+TT2 (one agent) ‖ TT3 (one agent). Barrier: commit.
- Test run (haiku): typecheck, the three unit files, the e2e spec. Fix loop ≤ 3 rounds.
- T3 docs, final commit.

## 7. Blast radius & risks

- Merge-conflict forecast with the sibling task: `server.ts` clone route, `api.ts` `cloneProject`, the dialog and the picker label. Mitigation: both sides use the same options-object shape and the same strings (sent to the peer).
- `api.cloneProject` signature: single caller (the dialog).
- `useTaskLaunch(open)` fires its harness/prefs fetches on open even if the switch gets turned off — a handful of cheap GETs, same as the other dialogs.
- Rollback: revert the branch; no migration, no persisted shape change.

## 8. Open questions / assumptions

Owner answers (grill, 2026-09-21): providers = cloud hosts only; name = "Clone repository"; pickers shown only while the explainer switch is on.

**Re-scope (owner, 2026-09-21, after plan approval):** a fleet peer announced — and `git worktree list` confirmed — a sibling agetor task generalizing the clone flow to all providers. Asked how to split, the owner chose *drop the parser from this run*. This run keeps: rename, launch pickers, pre-clone validation of the selection, `api.cloneProject` options object.

Assumptions: the Mode picker stays visible (it is part of the shared block; the explainer needs a writing mode, and every kind's default is one). `owner/repo` shorthand keeps meaning GitHub. Default destination for a nested GitLab project is `~/<last segment>`.

## 9. Completeness ledger

| Candidate remainder | Disposition |
| --- | --- |
| Client regex mirror of the parser (`repoNameFrom`) | owner-deferred — sibling task `feature/git-checkout-modal-support-all-git-provi` (owner, overlap question, 2026-09-21) |
| Multi-provider parsing, placeholder and "not a GitHub repo" error copy | owner-deferred — same sibling task, same decision |
| Comments saying "Checkout from GitHub" in `server.ts` route + dialog doc comment | in this run — T1/T2 |
| Toast + button copy ("Checked out", "Checkout") | in this run — T2 |
| Launch selection failing only after a successful clone | in this run — T1 (D3 pre-validation) |
| Gemini argv-cap pre-check with profile preamble | in this run — T2 |
| CLAUDE.md has no item for the clone flow | in this run — T3 |
| Self-hosted GitLab / GHES hosts | out of scope — owner chose cloud hosts only; needs a per-host trust decision |
| CLI `agetor` clone command | out of scope — no CLI surface exists for this flow today; a different ticket |
| Letting the user edit the explainer prompt | out of scope — not asked |

## 10. Review outcome (2026-09-21)

Opus review using the `code-review` skill: no must-fix, 4 should-fix, 6 nits — all ten applied in the follow-up commit. Swept in: `retry: false` on `api.cloneProject`; Clone gated on `loggedIn !== false`; launch block frozen while busy; a "no enabled harness" hint; the selected profile's own harness validated before cloning; `eli5` read once (`runEli5`); selected profile cleared on each open; last "Checkout-from-GitHub" comment renamed; overage + toast copy; `role="status"`/`role="alert"` on the async regions; CLAUDE.md "fifth" → "fourth".

Not covered by an automated test (no seam, both unreachable through the UI today): a profile whose harness row is gone (`harnesses.delete` refuses while a profile references it) and the logged-out gate (needs a harness stub that reports `auth: "missing"`).

Final test run: `bun test src/shared/clone-eli5.test.ts src/bun/clone.test.ts src/bun/clone-endpoint.test.ts` → 32 pass; `bun node_modules/@playwright/test/cli.js test e2e/clone-project.spec.ts e2e/agent-profiles-dialogs.spec.ts` → 8 pass; `bun run typecheck` green.

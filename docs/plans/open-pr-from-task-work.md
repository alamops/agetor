# Plan — Open PR from task work (post commit & push)

| Field | Value |
| --- | --- |
| Date | 2026-07-28 |
| Source | /implement conversation (owner-answered decision pass) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/open-pr-from-work-on-agetor |
| Base SHA | ce9177b34816982f2aeebbba15fefb8dde8bd827 |

## 1. Objective & success criteria

After the agent finishes a Commit & Push turn, the task panel offers an **"Open PR"** button —
only when the task's branch exists on the remote and is synced with local HEAD — which opens
the existing GitHubDialog New-PR composer **prefilled** with the PR title/description the agent
printed (per the `commitPushPrompt` contract). On successful creation the PR URL is persisted
on the task and the button becomes a durable **"View PR"** link.

Success =
- Button appears only when `upstream exists && ahead == 0` for the task's checkout dir (git-state-driven, never run-status-driven — repo convention).
- Clicking it opens GitHubDialog on the task's project, pulls tab, composer open, head = task branch, base = provider default, title/body prefilled from the parsed agent reply (when parseable; composer still opens with defaults when not).
- Creating the PR stores `tasks.pr_url`; the RunPanel then shows "View PR" instead, surviving app restarts.
- Works for GitHub/GitLab/Bitbucket via the `gitHost` facade (no provider gating in the UI beyond what the facade reports).
- `bun run typecheck` green, full `bun test` green.

## 2. Context & constraints (Phase 1 findings)

- **Agent output contract** (`commitPushPrompt`, `src/shared/types.ts:1902-1920`, pinned by `src/shared/branch.test.ts:190-233`): after pushing — plain-text PR-open link on its own line, then `PR title:` + ``` fence (one line), then `PR description:` + ```` 4-backtick fence (markdown). No other sentinel exists; the parser must tolerate model variance and **must CR-normalize (`\r\n?` → `\n`) at entry** — raw run_event data can carry bare `\r` newlines (tmux paste-buffer artifact; same reason `normalizeForKey` exists in `event-dedup.ts`).
- **Idiomatic parser template**: `src/mainview/lib/command-message.ts` — pure, DOM-free, regex-based, unit-tested; consumed upstream of ReactMarkdown.
- **Event stream**: RunPanel buffers all task events (`RunPanel.tsx:405-528`) into `events: RunEvent[]`; assistant text is `stream === "assistant"`. Events are replayed on reconnect, so scanning the array on each change re-derives state after reload.
- **Git status**: `GET /tasks/:id/git-status` (`server.ts:3296-3318`) returns `{hasChanges, ahead, ignored}` via `hasUncommittedChanges` + `getAheadCount(dir, baseRef)`; RunPanel polls it every 5s (`RunPanel.tsx:1021-1029`). Convention (fleet knowledge): commit/PR surfaces gate on git state only.
- **Missing primitive**: nothing answers "branch exists on remote && synced". `git push` updates the local remote-tracking ref, so a local check (`@{u}` exists, `ahead == 0`) is accurate immediately after the agent pushes — no network needed. Decision: local check (owner-approved).
- **PR creation**: `POST /github/pull-create` → `gitHost.pullCreate` (`server.ts:1586-1622`, facade `git-host.ts:83-111`) — provider-dispatched; `GET /github/pull-defaults` → `{repo, head, base}` where base = remote default branch. Client wrappers `api.createGitHubPull` (`api.ts:766-778`), `api.getGitHubPullDefaults` (`api.ts:542-545`).
- **Composer**: `GitHubDialog.tsx` — `pullComposerOpen` boolean (`:632`), state `newPullTitle/Body/Head/Base/...` (`:633-642`), defaults effect seeds head/base **only when empty** (`:1846-1860`), `createPull()` (`:2597-2626`). No prefill props today; App singleton at `App.tsx:754-759` with `initialProjectPath`.
- **Task schema**: no PR fields; latest migration `029_task_draft.sql`. PATCH allow-list is title/prompt/agent/workdir/column only — `prUrl` must stay server-managed (set via the pull-create route, not PATCH).

## 3. Approach & key decisions

1. **Sync gate = local tracking-ref check** added to the existing `/tasks/:id/git-status` payload (no new poll, no network). `remoteSynced := upstream exists && ahead(@{u}..HEAD) == 0`. `behind > 0` does not block (remote having extra commits doesn't invalidate opening a PR); noted as accepted edge.
2. **Reuse GitHubDialog composer** (owner's pick over a standalone dialog): add an optional prefill prop consumed once on open — switches the dialog to the task's project + pulls tab, opens the composer, seeds title/body/head. Base is left empty so the existing defaults effect fills it.
3. **Persist `tasks.pr_url`** via migration 030. Set server-side inside the pull-create route when an optional `taskId` accompanies the request and creation succeeds — atomic with creation, keeps the field out of the PATCH allow-list.
4. **Prefill source**: a new pure parser scans assistant events (latest match wins) for the title/description fences; the plain-text PR link is not needed for the composer but is parsed as a fallback signal. Prefill is best-effort: no parse ⇒ composer opens with empty title/body (defaults effect still fills head/base).
5. **Provider-agnostic**: everything routes through `gitHost`; no `provider === "github"` gating in the new UI. The button label stays "Open PR" (matching existing composer terminology helpers if present).
6. **Duplicate-PR edge**: a `branchSource === "existing"` task (PR-conflict resolution) may already have a PR — creation would fail with the provider's "PR already exists" error, surfaced by the composer's existing error state. Accepted for v1; `prUrl` tasks show "View PR" and never re-offer "Open PR".

## 4. Work breakdown — implementation tasks

**T1 — Backend: sync state + pr_url persistence** (wave 1)
Owns: `src/bun/worktree.ts`, `src/bun/server.ts`, `src/bun/db.ts`, `src/bun/migrations/030_task_pr_url.sql` (new), `src/bun/migrations/index.ts`, `src/shared/types.ts`.
- `worktree.ts`: new export `remoteSyncState(dir): { hasUpstream: boolean; ahead: number | null; behind: number | null }` using `git rev-parse --abbrev-ref @{u}` + `git rev-list --left-right --count @{u}...HEAD` (mirror `getAheadCount`'s spawn style + error tolerance; non-repo/no-upstream ⇒ `{hasUpstream:false, ahead:null, behind:null}`).
- `server.ts` git-status route: add `remoteSynced: boolean` (and `hasUpstream: boolean`) to the response, computed from `remoteSyncState` on the same dir the route already uses. Extend the corresponding shared type.
- Migration `030_task_pr_url.sql`: `ALTER TABLE tasks ADD COLUMN pr_url TEXT;` + register in `migrations/index.ts` (append, never reorder). `db.ts`: map `pr_url` ⇔ `Task.prUrl` on read/insert/update (follow the existing nullable-column pattern); do NOT add to the PATCH allow-list.
- `server.ts` pull-create route: accept optional `taskId` in the body; on `ok:true` result with a task match, persist the created PR's URL to `tasks.pr_url` (derive URL from the facade's returned item; verify field name in `normalizeItem`). Never fail the request over a persistence miss.
- `src/shared/types.ts`: `Task.prUrl: string | null`, git-status type fields. Do not touch `commitPushPrompt`.
Acceptance: typecheck green; git-status returns the new fields; creating a PR with `taskId` sets `pr_url`.

**T2 — Pure parser: PR proposal from assistant events** (wave 1)
Owns: `src/mainview/lib/pr-proposal.ts` (new file only).
- `parsePrProposal(text): { title: string; description: string; link: string | null } | null` — CR-normalize first; find `PR title:` label (case-insensitive, tolerate bold/trailing text) followed by a ``` fence (take first line of content); find `PR description:` followed by a 4-backtick fence (tolerate 3-backtick fallback when unambiguous); link = nearest preceding plain-text http(s) URL line (null if absent). Return null unless both title and description parse.
- `latestPrProposal(events: RunEvent[]): PrProposal | null` — scan `stream === "assistant"` events from newest to oldest, first parseable wins.
- Pure, DOM-free, no imports from components; mirror `command-message.ts` style. Import `RunEvent` from `@/…shared/types` the same way other lib files do.
Acceptance: typecheck green; functions exported and total (never throw on garbage input).

**T3 — UI wiring: RunPanel button + GitHubDialog prefill + App plumbing** (wave 2, after T1+T2)
Owns: `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/components/kanban/GitHubDialog.tsx`, `src/mainview/App.tsx`, `src/mainview/lib/api.ts`.
- `api.ts`: extend the git-status wrapper's type; add `taskId?` to `createGitHubPull` input.
- `GitHubDialog.tsx`: new optional prop `pullPrefill?: { projectPath: string; head: string; title: string; body: string; taskId: string } | null`. On open with a prefill: select that project, switch to pulls kind, `pullComposerOpen = true`, seed `newPullHead/Title/Body` (leave base to the defaults effect), remember `taskId`; consume once (don't re-clobber on later renders); `createPull()` passes the taskId through.
- `App.tsx`: state to open the dialog with a prefill payload from RunPanel (callback prop threaded to RunPanel alongside existing props); clear on dialog close.
- `RunPanel.tsx`: derive `proposal = latestPrProposal(events)` (memoized); next to the Commit & push chip render — when `task.prUrl` → a "View PR" link chip (anchor, opens externally like other GFM links); else when `gitStatus.remoteSynced` → an "Open PR" chip that calls the App callback with `{projectPath: task.workdir, head: task.branch, title: proposal?.title ?? "", body: proposal?.description ?? "", taskId: task.id}`. Hide on background-agent tabs / archived read-only mode, matching the Commit & push chip's placement conventions. Update the Commit & push tooltip only if it references the reply's purpose inaccurately.
- Keep gating pure where practical: add `shouldOfferOpenPr(...)` beside `shouldOfferCommitPush` in `src/mainview/lib/commit-push.ts`? — NO: that file is not owned by T3's wave-siblings (none), so allowed; put it there for symmetry.
Acceptance: typecheck green; button renders under the right conditions; dialog opens prefilled; created PR flips the chip to View PR (after poll refresh).

## 5. Work breakdown — test tasks

**TT1 — Bun-side tests** (covers T1): owns `src/bun/worktree.test.ts` additions, plus the server/db test file that covers git-status & pull-create persistence (follow `git-host.test.ts` + `github-test-util.ts` mock conventions; also cover: migration 030 applies, `db` round-trips `prUrl`, pull-create without `taskId` unchanged). Cases: no remote ⇒ `hasUpstream:false`; pushed & synced ⇒ `remoteSynced:true`; local commit after push ⇒ `ahead>0`, `remoteSynced:false`.

**TT2 — Webview lib tests** (covers T2 + gating): owns `src/mainview/lib/pr-proposal.test.ts` (new) and additions to the test file of wherever `shouldOfferOpenPr` lands. Cases: canonical contract parse; CR-only newlines; 3-backtick description fallback; nested ``` inside 4-backtick description; missing title ⇒ null; multiple proposals ⇒ latest wins; garbage ⇒ null; gating truth table (prUrl set, not synced, synced+proposal, synced+no proposal).

## 6. Execution waves

- **Wave 1** (parallel): T1 (backend), T2 (parser). Disjoint files. Barrier.
- **Wave 2**: T3 (UI wiring). Depends on T1's types + T2's exports.
- **Phase 6 wave** (parallel): TT1, TT2. Disjoint files.

## 7. Blast radius & risks

- `git-status` response shape grows — additive; existing consumers (RunPanel chip, CLI/TUI if any) unaffected.
- `pull-create` body grows optionally — additive; GitHubDialog's existing manual composer path unchanged when no prefill/taskId.
- Migration 030 is additive (`ALTER TABLE ADD COLUMN`), applied to dev DB (`~/.agetor-dev`) on next dev run — never edit applied migrations.
- GitHubDialog is large and stateful; prefill must not fight the defaults effect (seed-only-when-empty behavior is the seam) or the reset-on-close paths (`:908-918`, `:2615-2619`).
- Parser is best-effort by design; a non-conforming agent reply degrades to an unprefilled composer, never a broken button.
- `branchSource === "existing"` tasks may hit "PR already exists" on create — surfaced by existing composer error handling (accepted v1).

## 8. Open questions / assumptions

- Assumption: `behind > 0` does not hide the button (remote strictly ahead still allows a PR).
- Assumption: PR URL field on the facade's created item is present for all providers; if a provider omits it, `pr_url` stays null and the button simply reappears (harmless).
- CLI/TUI surfaces are out of scope for v1 (webview only); `commitPushPrompt` untouched.

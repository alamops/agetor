# Plan — Bitbucket integration: PRs not loading (alias-host credential UX)

| Field | Value |
| --- | --- |
| Date | 2026-08-05 |
| Source | /implement task: "BitBucket Git integration not loading PRs — 'You may not have access to this repository…'; perhaps custom git host domains (bitbucket-agetor.com)" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/bitbucket-git-integration-not-loading-pr |
| Base SHA | 1ac4dc62273745a11dae88a7d11c36828301b15e |
| Mode | Autonomous — Phase 2 grill and Phase 3 approval gates bypassed; assumptions logged in §8 |

## 1. Objective & success criteria

A user whose Bitbucket repo is reached through an ssh host alias (e.g.
`git@bitbucket-agetor.com:workspace/repo.git`) can discover, store, and use a
Bitbucket credential so PR list / detail / diff / comments / mergeability all
work; and when auth is missing or wrong, the error shown names the exact host
and the exact Settings section (with Bitbucket's `email:api_token` format)
instead of Bitbucket's bare "You may not have access…".

Success = typecheck green, full `bun test` green, new alias-host regression
tests for Bitbucket pass, all Settings-section references point at a section
that actually exists.

## 2. Context & constraints (grounded findings)

- **Parsing/canonicalization is NOT the bug.** `canonicalGitHost`
  (src/bun/github.ts:568) maps any host containing "bitbucket" → bitbucket.org;
  `parseGitRemote` (github.ts:582) preserves `rawHost`; `providerRepoForDir`
  (src/bun/git-provider.ts:56) threads it as `remoteHost`; `bitbucketCreds`
  (git-provider.ts:131) resolves `tokenForHost(remoteHost, "bitbucket.org")`
  from the shared `<dataDir>/github-tokens.json` store, then
  `BITBUCKET_TOKEN`/`BITBUCKET_EMAIL` env. Unit-tested (git-provider.test.ts:218-280).
- **Verified locally:** the user's `~/.agetor/github-tokens.json` holds only
  GitHub alias hosts — no Bitbucket entry under any host — and no
  `BITBUCKET_TOKEN` env. So `bitbucketCreds` → null → `authHeader(null)` → `{}`
  (src/bun/bitbucket.ts:169-176) → **unauthenticated request** → Bitbucket
  answers its 404-shaped "You may not have access to this repository or it no
  longer exists in this workspace…" for the private repo. Passed through
  verbatim (bitbucket.ts:221-231 → git-host.ts:192 → server.ts:678 →
  mainview api.ts:1258) — exactly the reported symptom.
- **The gap is the credential UX half, never built for non-GitHub providers**
  (confirmed by history: PR #104 scoped tokens GitHub-only; PR #107 widened the
  *plumbing* to Bitbucket/GitLab but promised only "Settings hint text updated",
  which never landed):
  1. `remoteHostsForDirs` (github.ts:840) uses `repoForDir` →
     `parseGitHubRemote`, which hard-rejects non-github hosts (github.ts:597) —
     Bitbucket/GitLab alias hosts never appear in Settings' detected-hosts list.
  2. The only credential UI is `GitHubTokensSection.tsx` — branded "GitHub
     tokens", GitHub-only copy, `ghp_…` placeholder; nothing signals it serves
     Bitbucket/GitLab or documents Bitbucket's `email:api_token` Basic format.
  3. Error hints are inconsistent/wrong: bitbucket.ts:228 (401 only) points at
     "Settings → API tokens" (doesn't exist); gitlab.ts authHint points at
     "Settings → GitLab tokens" (doesn't exist); Bitbucket 403/404 gets **no
     hint at all**, unlike GitHub's `privateRepoHint` (github.ts:1291).
- All ~18 Bitbucket API call sites share `bitbucketCreds` — the whole adapter
  fails identically ("perhaps not working for other features" confirmed).
- Constraints: keep `github-tokens.json` filename and `/github/tokens` routes
  (back-compat with stored tokens); never return raw tokens to the webview;
  test fixtures must use synthetic alias hosts (e.g. `bitbucket-work.com`),
  never real ones; `git-provider.ts` imports `github.ts`, so github.ts must not
  import from git-provider.ts (no circular import) — the generalized
  `remoteHostsForDirs` must detect "supported provider host" using
  `parseGitRemote`'s canonical host ∈ {github.com, gitlab.com, bitbucket.org}
  inline.

## 3. Approach & key decisions

- **Unify the Settings section as "Git host tokens"** (rename of the existing
  GitHub section, not a new section) — one store, one UI, provider-aware copy.
  Alternatives: per-provider sections (more surface, same store — rejected);
  leaving the GitHub name and only fixing hints (still misleading for
  Bitbucket-only users — rejected).
- **Generalize host discovery** in `remoteHostsForDirs` to collect the rawHost
  of any supported provider remote (github/gitlab/bitbucket), implemented
  inline in github.ts to avoid a circular import. Server route unchanged.
- **Error-hint parity for Bitbucket**: enrich 401/403/404 at the
  `apiErrorMessage` choke point with repo/host context (mirror gitlab.ts's
  `errorFrom(res, body, repo, hadCreds)` shape), naming the alias host, the
  "Git host tokens" section, and the `email:api_token` format. Bitbucket hides
  private repos behind 404 (and sometimes 403) — enrich both, plus 401.
- **Point gitlab.ts / github.ts hints at the renamed section** ("Git host
  tokens") so every hint references a section that exists.
- Decisions rest on code-reading + the verified-empty token store; no spikes
  needed (behavior of Bitbucket's API confirmed by the user's own error text,
  which is Bitbucket's documented no-access/nonexistent body).

## 4. Work breakdown — implementation tasks

**Wave 1** (parallel, file-disjoint):

- **T1 (bun side)** — files owned: `src/bun/github.ts`, `src/bun/bitbucket.ts`,
  `src/bun/gitlab.ts`, plus updating any *existing* assertions those wording
  changes break in `src/bun/*.test.ts`.
  - Generalize `remoteHostsForDirs` to all supported providers (keep name,
    location, signature; update doc comment).
  - bitbucket.ts: add repo/hadCreds-aware access hint for 401/403/404 at the
    error-message choke point; wording: repo not found / no access on
    Bitbucket → "add a credential for <remoteHost> in Settings → Git host
    tokens (Bitbucket Basic auth: email:api_token)"; hadCreds variant → "the
    configured credential cannot access it…". Thread `repo` + whether creds
    were present into that choke point (mirror gitlab's errorFrom pattern).
  - github.ts `privateRepoHint` + gitlab.ts `authHint`: section name → "Git
    host tokens".
  - Acceptance: typecheck green; existing bun tests updated & green.
- **T2 (mainview side)** — files owned:
  `src/mainview/components/settings/GitHubTokensSection.tsx`,
  `src/mainview/components/settings/GitHubSetupDialog.tsx`,
  `src/mainview/components/SettingsDialog.tsx` (only if it renders the section
  title), `src/mainview/lib/api.ts` (doc comments only).
  - Rename section label to "Git host tokens"; provider-generic copy: aliases
    for any git host (git@github-work.com / git@bitbucket-work.com …);
    defaults github.com / gitlab.com / bitbucket.org; Bitbucket credential
    format `email:api_token` stated inline; token placeholder no longer
    GitHub-only (`ghp_… / email:api_token`).
  - Setup guide dialog: add concise Bitbucket (Atlassian API token +
    email:api_token) and GitLab (PAT) sections alongside the GitHub one.
  - Acceptance: typecheck green; no route/store changes.

## 5. Work breakdown — test tasks

**Wave 2** (after Wave 1; one agent — small, related surface):

- **T3** — files owned: `src/bun/bitbucket-network.test.ts`,
  `src/bun/bitbucket.test.ts`, `src/bun/github.test.ts`,
  `src/bun/git-host.test.ts` (extend only).
  - Bitbucket alias-host regression tests using
    `makeBitbucketRepo(owner, name, "bitbucket-work.com")`: (a) stored
    alias-host credential → request carries the right auth header; (b) no
    credential → request unauthenticated and 404 body ("You may not have
    access…") surfaces *enriched* with host + "Git host tokens" +
    email:api_token; (c) hadCreds variant wording; (d) 401/403 enrichment.
  - `remoteHostsForDirs` returns bitbucket/gitlab alias hosts alongside github
    ones (temp git repos with synthetic alias remotes, per git-host.test.ts
    conventions).
  - E2e: **not applicable here** — the fix is bun-side wiring + Settings copy;
    the repo's Playwright e2e suite is being built on a different branch
    (feature/implement-e2e-tests) and isn't on main yet. Network-level tests
    via the existing mockGitHubFetch harness are the right layer.
- **Run recipe** (Phase 7): `export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"`,
  then `bun run typecheck` and `bun test` from the worktree root. Known
  env-only failures without tmux/bun on PATH (daemon-*, claude-followup-restart).

## 6. Execution waves

1. Wave 1: T1 ∥ T2 (disjoint: src/bun vs src/mainview) → typecheck + commit.
2. Phase 5 review (opus) of the full diff vs base.
3. Wave 2: T3 (tests) → commit.
4. Phase 7 run (haiku): typecheck + full bun test → Phase 8 fixes if needed.

## 7. Blast radius & risks

- `remoteHostsForDirs` feeds only the Settings detected-hosts datalist +
  "no token yet" rows (server.ts:2494,2506) — new bitbucket/gitlab hosts
  appearing there is the intended behavior; no auth-resolution path consumes it.
- Hint-wording changes can break existing test assertions (github.test.ts
  asserts "Settings → GitHub tokens" strings; bitbucket tests may assert the
  401 hint) — T1 owns updating them.
- UI rename is copy-only; routes/api shapes untouched, so no api.ts type churn.
- The store file stays `github-tokens.json` — slightly misleading name now
  serving three providers; renaming it would need a migration for zero user
  value. Accepted.
- Peers on feature/implement-e2e-tests don't touch these files (verified via
  fleet list_agents).

## 8. Open questions / assumptions (autonomous mode)

- A1: Section renamed to **"Git host tokens"** without owner sign-off (best
  generic name; matches "git host" vocabulary already used by git-host.ts).
- A2: Store filename + `/github/tokens` route names kept for back-compat.
- A3: The user still must create their Atlassian API token themselves; the fix
  makes the need discoverable and the format explicit. If their repo *also*
  lacks access server-side, the enriched message still guides correctly.
- A4: Bitbucket app-password retirement (2026-06-09) makes stale app passwords
  another possible cause for *some* users; the enriched error + setup-guide
  copy (which documents the current API-token flow) covers that path too.
- A5: GitLab gets discovery + UI copy + hint-name fixes but no new
  gitlab-specific tests this branch (its enrichment already exists and is
  tested; scope is Bitbucket).

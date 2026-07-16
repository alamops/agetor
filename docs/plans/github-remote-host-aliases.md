# Plan — Resolve custom git-host aliases in GitHub remote detection

| Field | Value |
| --- | --- |
| Date | 2026-07-13 |
| Source | /implement — "all projects show `project does not have a GitHub remote`" |
| Config | AGENTS_CONFIG.yml (collapsed: single-file fix, phases run inline) |
| Branch | fix/git-integration-error-no-project |
| Base SHA | 5ec712a |
| Mode | Autonomous — grill + plan-approval gates bypassed; assumptions logged in §8 |

## 1. Objective & success criteria

`GET /github/items?path=…` (and every other `repoForDir`-backed GitHub route) must
recognize remotes that use custom SSH host aliases for per-identity keys, e.g.
`git@github-alamops.com:alamops/agetor.git`, and resolve them to the canonical
`github.com` `owner/repo`. Success: the GitHub panel loads PRs/issues for the
user's projects instead of "project does not have a GitHub remote".

## 2. Context & constraints

- `parseGitHubRemote` (`src/bun/github.ts:558`) only matches literal `github.com`
  in https and ssh forms. `repoForDir` (`github.ts:787`) walks `git remote
  get-url` output through it; a null parse → the error on every route.
- The user's `~/.ssh/config` defines per-identity aliases (`github-alamops.com`
  and several other `github-*`/`bitbucket-*` hosts), so **every** project
  remote uses a non-literal host → all projects fail.
- The GitHub API integration is GitHub-only; gitlab/bitbucket appear only as a
  negative test case. No other module parses remote URLs.

## 3. Approach & key decisions

Split parsing into a generic `parseGitRemote` (host + owner + name across https,
`ssh://`, and scp-like syntaxes) plus a `canonicalGitHost` step that maps any
host **containing** `github` → `github.com`, `gitlab` → `gitlab.com`,
`bitbucket` → `bitbucket.org` (per the user's explicit instruction).
`parseGitHubRemote` then accepts only canonical-host `github.com`. A
gitlab/bitbucket remote still returns null for the GitHub API (correct — the
API can't serve it), but the canonicalization is provider-generic so future
gitlab/bitbucket integrations reuse it.

Alternative considered: reading `HostName` out of `~/.ssh/config` — more exact
(would handle GHE aliases) but heavier (fs + Include resolution) and not what
the user asked for.

## 4. Work breakdown — implementation

- T1 — `src/bun/github.ts`: add `canonicalGitHost` + `parseGitRemote`, rewrite
  `parseGitHubRemote` on top; export both via `__githubInternals`.

## 5. Work breakdown — tests

- T2 — `src/bun/github.test.ts`: alias ssh remotes (with and without `user@`),
  `ssh://` alias form, gitlab/bitbucket alias canonicalization, gitlab remote
  still null for GitHub, existing cases unchanged.

## 6. Execution waves

Single wave, inline (one file + its test — no fan-out).

## 7. Blast radius & risks

Every GitHub route funnels through `repoForDir` → behavior only *widens* (null →
match); no existing match can regress since literal `github.com` contains
`github`. Known tradeoff: a GitHub Enterprise host (`github.mycompany.com`)
would now canonicalize to `github.com` and hit the wrong API — accepted per the
user's explicit "if it has github, resolve to github.com".

## 8. Open questions / assumptions

- Assumed substring heuristic over `~/.ssh/config` `HostName` lookup (user's
  explicit instruction; GHE misresolution accepted).
- Assumed gitlab/bitbucket "the same" means canonicalization support in the
  shared parser, not a full gitlab/bitbucket API integration (none exists).

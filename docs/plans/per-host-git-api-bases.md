# Plan — Per-host git-provider API bases (self-hosted GitLab; explicit Bitbucket Server rejection)

| Field | Value |
| --- | --- |
| Date | 2026-08-12 |
| Source | /implement follow-up: "self-hosted GitLab/Bitbucket API base URLs are hard-coded — can we improve it?" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/load-binary-files-on-diff-modal-and-git |
| Base SHA | af9cd5a |
| Mode | Autonomous — assumptions in §8 |

## 1. Objective & success criteria
- A self-hosted GitLab remote (hostname containing "gitlab", e.g. gitlab.mycompany.com) gets ALL
  ~25 gitlab.ts API calls routed to `https://<real-host>/api/v4`, plus host-correct synthesized
  web URLs. gitlab.com behavior byte-identical. The documented ssh-alias multi-identity setup
  (alias → HostName gitlab.com) keeps hitting gitlab.com — no regression.
- A Bitbucket Server/DC remote (hostname containing "bitbucket", not resolving to bitbucket.org)
  gets a clear, actionable error from every adapter entry point instead of silent wrong calls to
  api.bitbucket.org. bitbucket.org (incl. aliases resolving to it) unchanged.
- Typecheck + full unit + e2e green.

## 2. Context (investigated, file:line anchors)
- Detection: canonicalGitHost (github.ts:570) substring-collapses any *gitlab*/*bitbucket* host
  to the cloud literal; providerForHost (git-provider.ts:45) maps only the three cloud literals;
  providerRepoForDir (git-provider.ts:65) returns { host: canonical, remoteHost: raw }.
  remoteHost is the ONLY field carrying the real hostname.
- gitlab.ts: `GITLAB_API_BASE = "https://gitlab.com/api/v4"` (:52), ~25 template sites (list in
  investigation brief); repo.host never read; remoteHost used for tokens (gitlabToken) + cache
  keys. Two web-URL literals: noteHtmlUrl (:264), synthesized webUrl (:503).
- bitbucket.ts: `BITBUCKET_API_BASE = "https://api.bitbucket.org"` (:69); resolveUrl (:114) is
  the near-single choke point; BITBUCKET_API_ORIGIN (:118) feeds sanitizeNextUrl's same-origin
  check (keep constant — cloud-only). webUrl literal (:640).
- github.ts: equally hard-coded (~60+ sites, GraphQL differs on GHE) — separate effort.
- Token store (github-tokens.json) is already keyed by raw remoteHost with cloud fallback
  (tokenForHost, github-tokens.ts:159) — identity routing needs NO change.
- THE ambiguity: remoteHost can be an ~/.ssh/config alias whose HostName is gitlab.com
  (multi-identity, docs/plans/github-remote-host-aliases.md) OR a real self-hosted domain.
  Verbatim use as API host regresses the alias case (https://gitlab-work/api/v4 → DNS failure).
- Tests: gitlab-network.test.ts matchers are path-substring based (host change safe);
  bitbucket-network.test.ts has a few absolute api.bitbucket.org pagination assertions (fine —
  cloud stays pinned). sampleAliasRepo exists in gitlab-test-util.ts.

## 3. Approach & key decisions
1. **`ssh -G <host>` resolves the ambiguity** (git-provider.ts): it prints the ssh-config-resolved
   `hostname` for aliases and echoes the input for non-aliases; handles Include/Match; no network.
   New `export function apiHostForRemote(remoteHost: string): string` — spawn `ssh -G`, parse
   `^hostname <value>$`, cache in a module Map (no TTL; ssh config is session-stable), fall back
   to the input on any failure/timeout. Binary overridable via `AGETOR_SSH_BIN` (house env-override
   pattern) so tests can stub resolution. — decision
2. **gitlabApiBase(repo) = `https://${apiHostForRemote(repo.remoteHost)}/api/v4`** replacing every
   GITLAB_API_BASE use; same derived host for the two synthesized web-URL literals. gitlab.com
   round-trips identically. — decision
3. **Bitbucket stays cloud-only**: `bitbucketServerGuard(repo)` — when
   `apiHostForRemote(repo.remoteHost) !== "bitbucket.org"`, every exported adapter function
   returns its error shape with: "Bitbucket Server / Data Center is not supported — only
   Bitbucket Cloud (bitbucket.org). This repo's remote points at <host>." Applied at the top of
   each exported entry (they all have `repo`); BITBUCKET_API_BASE/ORIGIN stay constants. — decision
4. **Detection heuristic unchanged** (hostname must contain "gitlab"/"bitbucket" substring to
   classify) — a Settings-backed host→provider mapping is a separate feature. — assumption
5. **GitHub Enterprise out of scope** — recorded follow-up. — decision

## 4. Work breakdown
Contract (wave-1 compiles together): `apiHostForRemote(remoteHost: string): string` exported from
src/bun/git-provider.ts, sync, never throws.

| ID | Goal | Owns | Deps |
| --- | --- | --- | --- |
| H1 | apiHostForRemote via `ssh -G` (cache, AGETOR_SSH_BIN override, failure fallback) + unit tests | src/bun/git-provider.ts, src/bun/git-provider.test.ts | — |
| H2 | gitlabApiBase(repo) replacing all GITLAB_API_BASE sites + 2 web-URL literals + doc comments; network tests for a self-hosted host (assert absolute URL prefix) and an alias host (stubbed ssh → gitlab.com) | src/bun/gitlab.ts, src/bun/gitlab-network.test.ts, src/bun/gitlab-test-util.ts (if a helper is needed) | contract |
| H3 | bitbucketServerGuard on every exported adapter entry + tests (server host rejected with the exact message + zero fetch calls; bitbucket.org + alias-to-cloud unaffected) | src/bun/bitbucket.ts, src/bun/bitbucket-network.test.ts | contract |

Waves: H1+H2+H3 together (file-disjoint; H2/H3 code against H1's contract). Then review (opus) →
fixes → full run. Tests are folded into each implementation task (small, module-scoped) instead of
a separate wave — logged deviation from the default pipeline.

## 7. Blast radius & risks
- ssh -G spawn cost: once per unique host per process (cached); mirrors existing glab/gh shellouts.
- A user whose ssh alias hostname ≠ what they want as API host (exotic) falls back cleanly: alias
  resolves → that host is used; failure → raw host. Worst case equals today's behavior for cloud.
- sanitizeNextUrl same-origin check untouched (cloud-only Bitbucket).
- GitHubDialog's credential hint already advertises self-hosted GitLab — now true.
- Not touched (follow-ups): GITLAB_TOKENS_URL settings deep-link (cosmetic), GitHub Enterprise,
  Settings-backed host→provider mapping for hosts without the substring, custom API path prefixes
  (assume standard /api/v4).

## 8. Open questions / assumptions (autonomous mode)
1. Standard `/api/v4` path prefix assumed for self-hosted GitLab (no custom-prefix field). — assumption
2. Hostname-substring provider detection retained; `git.mycompany.com` still unsupported. — assumption
3. ssh -G resolution treated as authoritative when it succeeds. — decision
4. GitHub Enterprise: follow-up, not this pass. — decision

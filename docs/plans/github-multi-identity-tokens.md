# Plan — GitHub multi-identity tokens (fix "Not Found" on alias-host origins)

| Field | Value |
| --- | --- |
| Date | 2026-07-14 |
| Source | /implement — "projects that have @github-<something>.com in their origin are showing as `not found`" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/git-integration-not-found |
| Base SHA | 7e798f51ef788e5cd69fc25ddcc7d144584be3a9 |

## 1. Objective & success criteria

Projects whose `origin` uses an ssh host alias (`git@github-<identity>.com:owner/repo.git`) must work
in the GitHub integration even when the repo is private and belongs to a different GitHub identity.

Success:
- A user can store one PAT per ssh host alias in Settings; the GitHub dialog then lists
  issues/PRs/etc. for private repos reached through that alias.
- Repos on plain `github.com` keep working exactly as before (env token / `gh auth token`).
- When no usable token exists for a private repo, the UI shows an actionable message pointing at
  Settings instead of GitHub's bare `Not Found`.

## 2. Context & constraints (Phase 1 findings)

- **Parsing is not the bug.** PR #101 (`7e798f5`) already resolves alias hosts:
  `parseGitRemote` (`src/bun/github.ts:573`) + `canonicalGitHost` (`:562`) map
  `github-work.com` → `github.com`. Verified empirically against every alias shape.
- **The "not found" is GitHub's 404 body**, surfaced verbatim by `apiError()`
  (`src/bun/github.ts:1245`). GitHub answers 404 (not 403) for private repos the caller cannot see.
- **All API calls are unauthenticated on the affected machine**: `githubToken()`
  (`src/bun/github.ts:824`) only checks `GITHUB_TOKEN`/`GH_TOKEN` env and `gh auth token`;
  neither exists. Verified live: the public repo → HTTP 200 (works), a private alias-host repo → 404.
- **Multiple identities are structural**: the user has 3+ GitHub identities via ssh aliases —
  one token can never cover all of them. Tokens must be routed **per remote host alias**
  (owner decision, Phase 2).
- The raw (pre-canonicalization) host is currently discarded at `parseGitRemote` (`:582`) and
  `GitHubRepo` (`src/shared/types.ts`) carries no host — it must be preserved and threaded.
- `githubToken()` has **76 call sites**, all with `repo` (from `repoForDir(input.dir)`) in scope,
  and no resolution choke point. Making the new `host` parameter **required** turns every missed
  site into a compile error.
- Token store template: `src/bun/core-creds.ts` — lazy `resolveDataDir()` (`:48`), atomic
  tmp+rename write with `mode: 0o600` plus best-effort `chmodSync` (`:62-72`), validating reader,
  **no `db.ts` import**.
- Settings precedent: generic preferences flow (`SettingsDialog.tsx` → `api.ts:938` →
  `server.ts:2397` routes). Sub-dialog precedent: `BranchNamingDialog.tsx`.
- Test harness: `github-test-util.ts` `makeGitHubRepo` (github.com https only — needs an
  alias-remote variant) + `mockGitHubFetch`; network tests assert the `authorization` header;
  `github.test.ts` tests pure helpers via `__githubInternals`.

## 3. Approach & key decisions

Owner decisions (Phase 2, 2026-07-14):
1. **Auth source**: agetor-managed PATs with env/`gh` fallback (no hard dependency on `gh`).
2. **Routing**: tokens keyed by **ssh host alias** (deterministic; the alias *is* the identity).
3. **Storage**: JSON file in dataDir, `0600`, core-creds pattern. Never returned raw to the webview.
4. **Error UX**: enrich 404s with an actionable message + Settings pointer.

**Token resolution order** for a repo whose origin host (raw, lowercased) is `H`:
1. stored token for `H` (exact match),
2. stored token for `github.com` (acts as the default entry),
3. `GITHUB_TOKEN` / `GH_TOKEN` env,
4. `gh auth token`.

Alternatives considered: try-each-token with per-owner caching (rejected by owner — prefers
deterministic mapping); gh multi-account enumeration (rejected — requires gh installed and logged
into every identity); macOS Keychain storage (rejected — macOS-only, finicky from a background Bun
process, harder to test).

## 4. Work breakdown — implementation tasks

### Wave 1

**T1 — token store module.** Owns: `src/bun/github-tokens.ts` (new).
Mirror `core-creds.ts` exactly (lazy dataDir, atomic tmp+rename `0o600` write, best-effort chmod,
validating reader, no db import). File: `<dataDir>/github-tokens.json`, shape
`{ "tokens": [{ "host": "github-x.com", "token": "ghp_…", "label": "optional" }] }`.
Exports:
- `type GitHubTokenEntry = { host: string; token: string; label: string | null }`
- `listGitHubTokens(): GitHubTokenEntry[]` (hosts lowercased on read)
- `setGitHubToken(host: string, token: string, label?: string | null): void` (upsert by host)
- `deleteGitHubToken(host: string): boolean`
- `tokenForHost(host: string | null): string | null` — implements steps 1–2 of the resolution
  order only (exact host, then `github.com`); env/gh fallback stays in `github.ts`.
Acceptance: pure module, no imports from `db.ts`/`github.ts`; malformed/missing file → `[]`.

### Wave 2 (parallel, file-disjoint)

**T2 — backend threading + routes.** Owns: `src/bun/github.ts`, `src/shared/types.ts`,
`src/bun/server.ts`.
- `parseGitRemote` returns `{ host, rawHost, owner, name }` (`rawHost` = lowercased `m[1]`,
  pre-canonicalization).
- `GitHubRepo` (shared/types.ts) gains `remoteHost?: string | null` (optional — UI consumers of
  `GitHubRepo` keep compiling). `parseGitHubRemote` and `repoForDir` populate it.
- `githubToken(host: string | null)` — **required parameter**: resolution order §3 (calls
  `tokenForHost(host)` first, then env, then gh). Update all 76 call sites to
  `githubToken(repo.remoteHost ?? null)` (compiler enforces completeness). The few pre-`repoForDir`
  or repo-less contexts, if any surface, pass `null`.
- Error enrichment: helper `privateRepoHint(status: number, message: string, repo: GitHubRepo,
  hadToken: boolean): string` — when `status === 404`, returns
  `"<owner>/<name> was not found on GitHub — if the repo is private, add a token for
  <remoteHost> in Settings → GitHub tokens"` (mention which source authenticated the request when
  one existed). Apply it in the primary user-facing lookups: `listGitHubItems`,
  the aggregate list path, `getGitHubViewer`, and repo-permissions. Export via `__githubInternals`.
- New exported helper `remoteHostsForDirs(dirs: string[]): Promise<string[]>` — distinct raw
  GitHub hosts across project dirs (drives Settings suggestions).
- Routes (object-style, token-gated like all others):
  - `GET /github/tokens` → `{ tokens: [{ host, label, tokenPreview }], detectedHosts: string[] }`
    where `tokenPreview` = `"…" + last 4 chars`; `detectedHosts` = `remoteHostsForDirs(all
    registered project paths)`. **Never returns the raw token.**
  - `PUT /github/tokens` body `{ host, token, label? }` — validates non-empty host/token, host
    lowercased, 400 on bad body.
  - `DELETE /github/tokens/:host` — 404 if absent.
- Add `canonicalGitHost`/`parseGitRemote` internals exports already exist; add `privateRepoHint`.
Acceptance: `bun run typecheck` green; no call site left calling arg-less `githubToken`.

**T3 — Settings UI.** Owns: `src/mainview/lib/api.ts`,
`src/mainview/components/settings/GitHubTokensSection.tsx` (new),
`src/mainview/components/settings/SettingsDialog.tsx`.
- `api.ts`: `listGitHubTokens()`, `setGitHubToken({host, token, label?})`,
  `deleteGitHubToken(host)` matching the wire contract above (define the wire types locally in
  api.ts, matching T2's route payloads exactly as written in this plan).
- `GitHubTokensSection`: rendered inside SettingsDialog as a new "GitHub tokens" section following
  the dialog's existing section idiom. Lists stored tokens (host, label, `tokenPreview`, delete
  button); add-form with host input (datalist fed by `detectedHosts`, so the user's real alias
  hosts are one click away), token input (`type="password"`), optional label. Saving refreshes the
  list; token input is cleared after save and never re-populated.
- Copy under the section title: one line explaining ssh-alias identities ("Repos reached through an
  ssh host alias (git@github-work.com:…) authenticate with the token stored for that alias;
  github.com is the default").
Acceptance: section renders in SettingsDialog, add/delete round-trips against the routes, no raw
token ever displayed after save.

## 5. Work breakdown — test tasks

**T5 — store + pure-helper tests.** Owns: `src/bun/github-tokens.test.ts` (new),
`src/bun/github.test.ts`.
- Store: round-trip, upsert-by-host, delete, host lowercasing, malformed file → `[]`, file mode
  0600 (skip mode assert if platform-flaky), `tokenForHost` exact-alias > github.com-default > null.
  Uses `AGETOR_DATA_DIR` mkdtemp per existing convention.
- Pure helpers via `__githubInternals`: `parseGitRemote` now yields `rawHost` (alias preserved,
  canonical host unchanged); `privateRepoHint` wording for 404 with/without token; non-404 passthrough.

**T6 — network/integration tests.** Owns: `src/bun/github-network.test.ts`,
`src/bun/github-test-util.ts`.
- `makeGitHubRepo` variant (new option or sibling helper) whose origin is
  `git@github-testalias.com:owner/name.git`.
- With a stored token for `github-testalias.com` (write via `setGitHubToken` under the test's
  `AGETOR_DATA_DIR`): request carries `Bearer <alias-token>` even when `GITHUB_TOKEN` is also set
  (alias beats env). With only env set and no stored entry: env token used (regression).
  With nothing: 404 response surfaces the enriched settings-pointer message.

## 6. Execution waves

- Wave 1: T1 (alone — T2 imports its exports).
- Wave 2: T2 ∥ T3 (file-disjoint; wire contract pinned in §4). Typecheck at wave end.
- Phase 5: code review (opus) of `git diff 7e798f5...HEAD`.
- Phase 6: T5 ∥ T6 (file-disjoint).
- Phase 7: `bun run typecheck` + `bun test` (haiku, background).
- Phase 8: fixes if needed, re-run to green.

## 7. Blast radius & risks

- `githubToken` signature change touches all 76 GitHub API functions — mitigated by the required
  parameter (compile-time completeness) and by regression tests keeping env-token behavior.
- `GitHubRepo` type widening is optional-field only; webview consumers unaffected.
- The token file contains secrets: 0600, never logged, never sent to the webview raw, and excluded
  from any knowledge-base capture (fleet rule). It lives in dataDir — dev (`~/.agetor-dev`) and
  prod (`~/.agetor`) stores are naturally separate.
- `gh`-based flow and `GITHUB_TOKEN` users: unchanged behavior when no stored tokens exist
  (resolution steps 3–4 preserved).
- Bitbucket-alias projects: out of scope — integration is GitHub-only today (non-goal).

## 8. Open questions / assumptions

- Assumption: keying strictly by host alias means a repo reached via a *new* alias needs a new
  Settings entry; `detectedHosts` in the Settings UI keeps that discoverable.
- Assumption: no "verify token" button in v1 (can be added later as `POST /github/tokens/verify`
  → `GET /user`); kept out to limit scope.
- Assumption: token file is intentionally plain JSON (not Keychain) per owner decision; acceptable
  because agents already run unsandboxed with user privileges (see CLAUDE.md security note).

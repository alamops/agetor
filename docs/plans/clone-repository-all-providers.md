# Plan — Clone repository: all supported git providers

| Field | Value |
| --- | --- |
| Date | 2026-09-21 |
| Source | Task: "Make the `Checkout from GitHub` actually support all already supported git providers in Agetor, not just GitHub" |
| Config | AGENTS_CONFIG.yml (balanced, v1 schema) — host `claude_code` |
| Flags | none |
| Gates | grilled by owner (two passes, answers in §8) + plan approval by owner |
| Branch | `feature/git-checkout-modal-support-all-git-provi`, **stacked on** `feature/add-profile-and-harnesses-selection-to-g` (owner decision — see §2 "Peer overlap") |
| Base SHA | `1bef09d` (merge of the peer branch @ `2b67dfb` onto the plan commit; pre-merge main base `11c954f`) — review diffs against `1bef09d` |

## 1. Objective & success criteria

The "Checkout from GitHub" flow (`POST /projects/clone` + `CloneProjectDialog`, shipped in #235) accepts
GitHub only. Make it accept every provider Agetor's Git integration already supports — GitHub, GitLab
(cloud **and** self-hosted), Bitbucket Cloud — with the same host rules the integration uses, and rename
it to the provider-neutral **"Clone repository"**.

Done means:

1. Pasting any of `https://…`, `git@host:…`, `ssh://…` for GitHub / GitLab / Bitbucket Cloud, a
   provider-named ssh alias (`git@gitlab-work:group/app.git`), or a self-hosted GitLab URL clones and
   registers the project. Bare `owner/repo` shorthand resolves against the provider picked in the dialog
   (default GitHub); GitLab shorthand accepts nested groups.
2. Transport is **preserved**: https input → canonical https clone URL; ssh/scp input → canonical SSH URL
   (alias host, user and port kept), so `origin` ends up on the transport the user chose.
3. Bitbucket Server / Data Center and unrelated hosts are rejected up front with a message listing what is
   supported.
4. A private **https** clone works with the tokens already stored in Settings → Git host tokens: the clone
   is tried anonymously first and retried once with the host-scoped token only when that fails. The token
   never reaches argv, `.git/config`, a plain-http origin, or a redirect target.
5. SSH clones cannot hang on a tty prompt (BatchMode, unless the user configured ssh themselves).
6. New CLI surface: `agetor clone <url>`.
7. `bun run typecheck` green; unit + endpoint + CLI tests green; a new Playwright spec covers the dialog.

## 2. Context & constraints (Phase 1 findings)

- **GitHub-only surface is small.** `parseGitHubRepo` (`src/bun/clone.ts:49`) is the only GitHub-specific
  logic; `cloneRepo`, `defaultCloneDest`, the ELI5 helpers and the route plumbing are provider-agnostic
  already. Literals: route error `server.ts:757`, dialog title/placeholder/regex
  `CloneProjectDialog.tsx:20-25,92,117`, menu item `ProjectPicker.tsx:133`. Callers: `server.ts:34,754-772`,
  `api.ts:555`, `CloneProjectDialog.tsx:60`. **No CLI caller, no e2e spec, no docs/README mention.**
- **Tests pinned to the old contract:** `clone.test.ts:67-72` ("rejects non-GitHub hosts" — asserts
  gitlab/bitbucket → null) and `clone-endpoint.test.ts:68-75` (error contains "GitHub"). Both invert.
- **Host rules of the Git integration** (what "mirror exactly" means):
  - Provider = substring match on the raw host (`canonicalGitHost`, `github.ts:582`): contains
    `github` / `gitlab` / `bitbucket`. Anything else → unsupported (`providerForHost`, `git-provider.ts:207`).
  - Raw host is identity (token-store key); `apiHostForRemote` (`git-provider.ts:132`) resolves an
    `~/.ssh/config` alias to its real `HostName` via `ssh -G` (cached, sync, never throws).
  - GitLab: self-hosted is first-class (`gitlabApiBase`, `gitlab.ts:84`); `gitlabToken`
    (`git-provider.ts:381`) already scopes self-hosted hosts to an **exact** store entry — no gitlab.com
    fallback, no env, no glab-cloud — precisely to stop a gitlab.com token reaching a look-alike host.
  - Bitbucket: `bitbucketServerError` (`bitbucket.ts:125`, module-private) rejects a resolved dotted host
    ≠ `bitbucket.org`, fails open on `bitbucket.org` and on dotless (unresolved alias) hosts.
  - GitHub: no host guard at all — any github-named host is treated as github.com identity; GHES is not
    supported by the API layer but is never rejected either.
- **Spike (measured, Apple Git 2.54.0, 2026-09-21 — scratchpad `spikes/git-env-auth/`):**
  `GIT_CONFIG_COUNT/KEY_n/VALUE_n` with key `http.<origin>/.extraheader` = `Authorization: Basic …`
  (a) reaches the server on the GET and both POSTs, (b) is never written to `.git/config` and origin stays
  credential-free, (c) is **not** sent to a non-matching origin, (d) composes with a pre-existing
  `GIT_CONFIG_COUNT` when appended at the next index, (e) is invisible to `ps`. **Leak found:** under git's
  default `http.followRedirects=initial`, a 301 from the scoped host makes the follow-up
  `POST /git-upload-pack` requests carry the header to the *new* host. With `http.followRedirects=false`
  the clone fails instead (`The requested URL returned error: 301`) and the target sees zero requests.
  Unauthenticated failure text under `GIT_TERMINAL_PROMPT=0 LC_ALL=C`:
  `fatal: could not read Username for '<origin>': terminal prompts disabled`. Min git for env config: 2.31.
- **Credential shapes for git smart-HTTP (provider docs, checked 2026-09-21):** GitHub
  `x-access-token:<token>` (username ignored for PATs/`gho_`; `Bearer` is rejected by git transport);
  GitLab `oauth2:<token>` (any username for PATs, `oauth2` required for OAuth/glab tokens); Bitbucket API
  token `x-bitbucket-api-token-auth:<token>` (the account **email is not documented** for git, only for
  REST); Bitbucket access token `x-token-auth:<token>`. Not verified live against real private repos — no
  credentials were used in the spike (see §8).
- **Runnability:** `bun run typecheck`; `bun test <file>`; e2e via
  `bun node_modules/@playwright/test/cli.js test e2e/<spec>` (one Playwright run at a time). The e2e
  backend is a per-worker `bun src/bun/headless.ts` child whose env is fixed at spawn
  (`e2e/fixtures.ts:290-361`), so `AGETOR_CLONE_SOURCE_OVERRIDE` can only be set worker-wide.
- **Peer overlap:** session `warm-sea-299c` (branch `feature/add-profile-and-harnesses-selection-to-g`)
  added harness/profile pickers to this same modal's ELI5 step and landed the provider-neutral rename
  (title "Clone repository", menu "Clone repository…", button "Clone", toast "Cloned <name>"), the
  `api.cloneProject` options object (`retry: false`), test ids (`project-clone-open`,
  `clone-project-dialog`, `clone-url`, `clone-dest`, `clone-eli5-switch`, `clone-launch`, `clone-submit`),
  `validateCloneLaunch` in the route, the ELI5 helpers' move to `src/shared/clone-eli5.ts`, an e2e spec
  (`e2e/clone-project.spec.ts`, using the existing `test.use({ backendEnv })` + `freshBackend` seam for
  `AGETOR_CLONE_SOURCE_OVERRIDE`) and CLAUDE.md item 18. **Post-approval amendment (owner decision):** this
  branch is stacked on that one (merged at `1bef09d`), so the parts of D7/D9/T3/T5/T6 that duplicated it
  are already done — what remains is listed in the amended tasks below. The ELI5/launch block in the
  dialog and the `validateCloneLaunch`/`createTask` code in the route stay untouched.

## 3. Approach & key decisions

**D1 — One shared, pure parser (`src/shared/clone-input.ts`).** The dialog needs provider detection (to
lock the picker) and the repo name (dest placeholder); the server needs the full parse. Today the dialog
carries a hand-rolled regex "mirror" of the server parser — exactly the drift the repo's shared-module
convention (`at-refs.ts`, `issue-task.ts`) exists to prevent. Provider classification by host substring is
already done inline in `src/shared/issue-task.ts`, so no `src/bun` import is needed. *(reasoning)*

**D2 — Host resolution stays server-side (`src/bun/clone.ts` → `resolveCloneRepo`).** `ssh -G` can't run in
the webview. The shared parser is syntactic; `resolveCloneRepo` layers the integration's host rules on top:

| Provider | ssh/scp input | https input |
| --- | --- | --- |
| GitHub | any github-named host, preserved as pasted (integration has no guard; an unresolved alias fails at ssh, not here) | `github.com`/`www.` → `https://github.com/…`; other github-named host: resolves (ssh -G) to github.com → rewritten to github.com; otherwise **rejected** (GHES https is "any other host"; dotless alias can't work over https → hint to paste the SSH URL) |
| GitLab | any gitlab-named host, preserved | cloud → `https://gitlab.com/…`; self-hosted → scheme + host + port preserved |
| Bitbucket | `bitbucketServerError` rule (now exported) | same rule, then `https://bitbucket.org/…`; dotless alias over https rejected with the SSH hint |

http→https is forced for the three clouds (today's GitHub behavior); a self-hosted GitLab keeps `http://`
if that is what was pasted, but then gets **no** token. *(reasoning, mirrors measured integration code)*

**D3 — Path rules per provider.** GitHub/Bitbucket: exactly owner + repo, deep links cut after two
segments (today's behavior). GitLab: nested groups kept; deep links cut at `/-/` and at GitLab's reserved
project names `tree|blob|raw|commits|blame|wikis` (index ≥ 2 — these can never be project names). Segment
charset `[A-Za-z0-9_.-]`, never `.`/`..`, never a leading `-`, `.git` suffix stripped; GitHub owner keeps
its stricter regex; host `[a-z0-9.-]` no leading `-`; ssh user `[A-Za-z0-9_][A-Za-z0-9._-]*`; port 1–5
digits. `git clone --` stays as the argv backstop. Default dest = `~/<last path segment>`.

**D4 — Token auth: anonymous first, token on failure (owner decision).** `cloneRepo` runs today's clone
unchanged; if it fails (and didn't time out) and an auth resolver yields a header, it retries once with
`GIT_CONFIG_*` env: `http.<origin>/.extraheader` + `http.followRedirects=false`, appended after any
existing `GIT_CONFIG_COUNT`. `resolveCloneRepo` only hands out an `authOrigin` for **https** URLs; the
token itself comes from the integration's own resolvers (`githubToken` / `gitlabToken` / `bitbucketCreds`)
keyed by the raw host, so GitLab's exact-host scoping applies verbatim. Rejected alternative: always send
the token — leaks a credential into every public clone and breaks renamed repos (301). *(spike evidence)*

**D5 — SSH can't hang.** `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` is set only when neither
`GIT_SSH_COMMAND` (env) nor `core.sshCommand` (git config) exists. Failure lines are mapped to actionable
copy: `Host key verification failed` → "run `ssh -T <user>@<host>` once in a terminal to trust the host";
`Permission denied (publickey)` → key/agent hint; the unauthenticated https line → "add a token for
<host> in Settings → Git host tokens, or paste the SSH URL"; a 301 on the token attempt → "repository
moved — paste its current URL". `LC_ALL=C` so the matches are locale-proof. *(owner decision)*

**D6 — Route contract.** `POST /projects/clone` body
`{ url, provider?: "github"|"gitlab"|"bitbucket", dest?, eli5? }` → `{ project, provider, eli5TaskId, eli5Error }`.
`provider` only matters for shorthand; a full URL's detected provider wins. 400: missing url, unknown
provider value, unparseable/unsupported input (resolver's message), relative dest. 502: clone failure.
Additive — an old client omitting `provider` keeps GitHub shorthand.

**D7 — Dialog.** Native `Select` (existing primitive, no popover/Escape coupling) labelled "Provider"
above "Repository"; when `detectCloneProvider(url)` is non-null the select shows it and is disabled with a
"Detected from URL" hint; placeholder text follows the selected provider. Title "Clone repository", menu
item "Clone repository…", primary button "Clone" / "Cloning…", toast "Cloned <name>". Test ids added
(there are none today): `project-clone-open`, `clone-provider`, `clone-url`, `clone-dest`, `clone-eli5`,
`clone-submit`, `clone-error`. `api.cloneProject` becomes an options object `{ url, provider, dest, eli5 }`.

**D8 — CLI.** `agetor clone <url> [--provider github|gitlab|bitbucket] [--dest <path>] [--no-eli5]`,
`--json` prints the route's response. `--dest` is `path.resolve`d client-side. The request uses a 15-minute
timeout (the default one-shot timeout would abort a legitimate long clone). Registered in `index.ts` help,
`usage.ts`, README's command list.

**D9 — e2e seam.** `e2e/fixtures.ts` creates a tiny git repo at `<dataDir>/clone-source`, sets
`AGETOR_CLONE_SOURCE_OVERRIDE` to it for the worker, and exposes `backend.cloneSourceDir`. Safe
worker-wide: nothing else in e2e clones.

## 4. Work breakdown — implementation tasks

**T1 — shared parser.** Owns `src/shared/clone-input.ts` (new). Exports: `CLONE_PROVIDERS`,
`isGitProvider`, `CLONE_CLOUD_HOST`, `type CloneInputForm = "shorthand"|"https"|"scp"|"ssh-url"`,
`interface ParsedCloneInput { provider; form; transport: "https"|"ssh"; scheme: "https"|"http"|null; rawHost: string|null; port: string|null; user: string|null; segments: string[]; fullPath: string; repo: string }`,
`parseCloneInput(input, shorthandProvider?) → { ok: true; value } | { ok: false; error }`,
`detectCloneProvider(input) → GitProvider|null` (null for shorthand/unparseable),
`CLONE_SUPPORTED_HINT`. Zero runtime imports beyond `./types.ts` types. Acceptance: D3 rules; typecheck.

**T2 — server clone core + route.** Owns `src/bun/clone.ts`, `src/bun/server.ts` (the `/projects/clone`
handler + its import line only), `src/bun/bitbucket.ts` (add `export` to `bitbucketServerError`, nothing
else). Deletes `parseGitHubRepo`/`ParsedRepo`. Adds `resolveCloneRepo`, `cloneAuthHeader`,
`cloneAuthEnv` (pure, exported for tests), `explainCloneFailure` (pure), extends `cloneRepo` with
`{ timeoutMs?, auth?: () => Promise<{ origin; header } | null> }`. Depends on T1. Acceptance: D2, D4, D5, D6;
ELI5 block untouched.

**T3 — webview.** Owns `src/mainview/components/kanban/CloneProjectDialog.tsx`,
`src/mainview/components/kanban/ProjectPicker.tsx` (label + test id only), `src/mainview/lib/api.ts`
(`cloneProject` only). Depends on T1. Acceptance: D7; ELI5 switch block untouched.

**T4 — CLI.** Owns `src/cli/commands/clone.ts` (new), `src/cli/api-client.ts` (`cloneProject` method),
`src/cli/index.ts` (help line + dispatch), `src/cli/usage.ts` (entry), `README.md` (one command line).
Depends on the D6 contract only. Acceptance: D8.

**T5 — e2e seam.** ~~Owns `e2e/fixtures.ts`.~~ **Dropped after stacking:** `e2e/fixtures.ts` already
exposes `backendEnv`/`freshBackend`, which the peer's spec uses to set `AGETOR_CLONE_SOURCE_OVERRIDE`
per file. No fixture change needed.

**T6 — docs.** Owns `CLAUDE.md` — **extends the existing item 18** (added by the peer branch) with the
provider parsing/host rules, the token/redirect rule, the ssh BatchMode rule, the CLI command and the test
seams — written last so it describes what actually landed.

**Amendments to T3 after stacking:** title/menu/button/toast strings, the options-object `cloneProject`
and most test ids already exist. T3 now = add `provider` to `api.cloneProject`'s input + response type;
replace `repoNameFrom` with the shared parser; add the Provider select (`clone-provider`), per-provider
placeholder, `data-testid="clone-error"` on the error paragraph. `ProjectPicker.tsx` needs no change.

## 5. Work breakdown — test tasks

- **TT1 (unit, covers T1):** `src/shared/clone-input.test.ts` (new) — every form × provider, nested groups,
  deep-link cuts, shorthand × provider, aliases, ports/users, rejections (unsupported host, traversal,
  leading dash, garbage), `detectCloneProvider`.
- **TT2 (unit + integration, covers T2):** rewrite `src/bun/clone.test.ts` — `resolveCloneRepo` host table
  (with an `AGETOR_SSH_BIN` stub for alias resolution, `__clearApiHostCacheForTest`), `cloneAuthEnv`
  index-append, `explainCloneFailure`, `cloneAuthHeader` shapes against a temp token store; `cloneRepo`
  existing cases + **auth-retry integration** against a local Bun server proxying `git http-backend`
  (401 without header → succeeds on retry, `.git/config` clean, anonymous-success never calls the resolver)
  + **redirect non-leak** (token attempt against a 301 server fails, target receives nothing).
- **TT3 (endpoint, covers T2 route):** update `src/bun/clone-endpoint.test.ts` — gitlab/bitbucket URLs now
  clone; unsupported host 400 with the supported-hosts hint; Bitbucket Server 400; bad `provider` 400;
  `provider` + shorthand; response carries `provider`; nested GitLab registers the last segment as name.
- **TT4 (CLI, covers T4):** `src/cli/clone.test.ts` (new), mocking idiom of `files.test.ts` — flags → client
  call, `--json`, usage error without a url, bad `--provider`.
- **TT5 (e2e, covers T3 and the assembled flow):** `e2e/clone-providers.spec.ts` (new — separate from the
  peer's `e2e/clone-project.spec.ts`, which keeps passing unchanged since GitHub shorthand is still the
  default; same `test.use({ backendEnv: { AGETOR_CLONE_SOURCE_OVERRIDE } })` seam). **E2E applies** —
  user-visible flow crossing webview → API → git → DB. Flows: open from the project picker; pasting a
  GitLab nested URL locks the provider select to GitLab and previews `~/project`; shorthand + Bitbucket
  selection; successful clone into a temp dest registers the project (ELI5 off); an unsupported host shows
  the inline error and keeps the dialog open. Run recipe: `bun node_modules/@playwright/test/cli.js test
  e2e/clone-providers.spec.ts e2e/clone-project.spec.ts` — the harness boots Vite + a headless backend itself; no credentials needed.

## 6. Execution waves

- **Wave 1:** T1. *(barrier: exports exist + typecheck)*
- **Wave 2:** T2 ∥ T3 ∥ T4 — file sets are disjoint (checked: `server.ts`/`clone.ts`/`bitbucket.ts` ·
  dialog/`api.ts` · `src/cli/*` + README). *(barrier: typecheck, commit)*
- **Review (Phase 5)**, then **Wave 3 (tests):** TT1 ∥ TT2 ∥ TT3 ∥ TT4 ∥ TT5 — disjoint test files.
- **Run → fix loop**, then **T6 docs** last.

## 7. Blast radius & risks

- **Behavior change for existing GitHub users:** an SSH-form GitHub input used to be rewritten to https and
  now clones over SSH (owner decision). Someone without an ssh key who pasted `git@github.com:…` for a
  public repo will now get a publickey failure — mitigated by the D5 hint naming the https alternative.
- **Credential handling** is the sensitive part: origin-scoped header, https-only, exact-host scoping for
  self-hosted GitLab inherited from `gitlabToken`, `followRedirects=false`, env not argv, never persisted.
  The redirect non-leak and `.git/config` cleanliness are pinned by integration tests (TT2).
- `githubToken` can shell out to `gh auth token` and `gitlabToken` to `glab` — both already bounded (5 s)
  and only reached on the retry path.
- `apiHostForRemote` is a sync `ssh -G` (≤750 ms, cached) — one call per clone request, on a route that
  already takes seconds.
- Route change is additive; no DB migration; no persisted data shape changes. Rollback = revert the branch.
- Merge conflict with the peer branch is expected in `CloneProjectDialog.tsx` (title string + a new row);
  kept mechanical by not touching the ELI5 block.

## 8. Open questions / assumptions

Owner answers (grill pass 1, relayed by the owner; pass 2 asked in this session):

| Question | Answer |
| --- | --- |
| Transport for SSH-form input | Preserve what was pasted |
| `owner/repo` shorthand with three providers | Provider picker in the dialog |
| Accepted hosts | Mirror the Git integration exactly |
| Stored tokens for private https clones | Sweep it in |
| When to send the token | Anonymous first, token on failure |
| Feature name | "Clone repository" |
| SSH prompt hangs | BatchMode unless the user configured ssh |
| CLI surface | Add `agetor clone <url>` |

Assumptions proceeding on:

- **Unverified live:** the three providers' Basic-credential shapes come from their current docs, and the
  mechanism is spike-proven against a local server, but no real private repo was cloned (no credentials
  were used). Bitbucket: a stored `email:api_token` credential is sent as
  `x-bitbucket-api-token-auth:<api_token>` because the email is documented for REST only.
- GHES over SSH is indistinguishable from a dotted ssh alias and is accepted (the integration doesn't
  reject it either); GHES over https is rejected.
- A self-hosted GitLab served under a relative URL root (`https://host/gitlab/group/project`) parses as a
  nested path and clones correctly; the token origin scope is host-level, which still matches.

## 9. Completeness ledger

| Candidate remainder | Disposition |
| --- | --- |
| Every caller of `parseGitHubRepo` / `ParsedRepo` (server.ts only) migrated; old export deleted | in this run — T2 |
| Dialog's duplicated client-side regex removed in favor of the shared parser | in this run — T3 |
| "Checkout from GitHub" / "not a GitHub repo" literals (dialog, picker, route, comments) | in this run — T2, T3 |
| `api.cloneProject` signature + its one caller | in this run — T3 |
| Tests asserting the GitHub-only contract rewritten, not just extended | in this run — TT2, TT3 |
| Reachable failure states: unsupported host, Bitbucket Server, dotless-alias-over-https, auth failure with/without token, moved repo on token attempt, ssh host-key / publickey, timeout | in this run — T2 (`explainCloneFailure`), TT2 |
| Test ids for the new controls (`clone-provider`, `clone-error`) | in this run — T3 |
| e2e coverage of the provider flows (the peer's spec covers only the launch pickers, GitHub shorthand) | in this run — TT5 |
| Peer spec's header comment calling multi-provider parsing "out of scope" / naming `parseGitHubRepo` — untrue once this lands | in this run — TT5 (comment-only edit to `e2e/clone-project.spec.ts`) |
| CLI parity | in this run — T4, TT4 (owner swept it in) |
| README command list + CLAUDE.md feature documentation | in this run — T4, T6 |
| Stale `git-provider.ts:203-206` comment calling self-hosted GitLab "out of scope" | out of scope — pre-existing doc drift in a file this change doesn't otherwise touch; different ticket |
| GitHub Enterprise Server API support | out of scope — the Git integration doesn't support GHES; a provider feature, not clone parity |
| Bitbucket Server clones | out of scope — owner chose to mirror the integration's rejection |
| TUI dashboard entry point for cloning | out of scope — the TUI has no project-management surface at all (projects are CLI-subcommand only) |
| Progress streaming for long clones | out of scope — pre-existing UX of #235, unrelated to provider parity |

## Addendum A (2026-09-21) — clone progress streaming + cancel, and the stale `providerForHost` comment

Owner asked to sweep in two items §9 had ruled out of scope. Grilled (this session): progress rides
**`/app/events`** (no new SSE connection from the webview — WKWebView's ~6/host cap; the CLI uses the
existing `streamSse`), and the dialog gets a **Cancel** button while cloning.

**Design.**
- `POST /projects/clone` accepts an optional client-minted `cloneId` (UUID, validated case-insensitively against the 8-4-4-4-12 hex shape;
  the server mints one when absent and echoes it in the response). While `git clone --progress` runs,
  the server broadcasts `AppEvent { type: "clone_progress", cloneId, phase, percent, line, ts }` —
  parsed from git's `\r`-separated stderr progress records (`Cloning into`, `remote: Enumerating/Counting/
  Compressing objects`, `Receiving objects: NN% (a/b)`, `Resolving deltas: NN% (a/b)`, `Updating files: NN%`)
  by a pure exported `parseCloneProgress(record)`; forwarding is bounded — ≤ 1 event/100 ms per phase, phase
  changes and 100 % pass the timer but never as consecutive duplicates, and a hard per-clone event budget caps
  what a hostile remote's `remote:` lines can broadcast (review finding: the unbounded fast path let a remote
  push 20k events). A final `phase: "done" | "failed" | "cancelled"` event closes it.
  Progress text is sanitized by the same control-char strip as error stderr and never carries a token.
- The progress reader replaces `readBoundedCloneStderr`: it splits on `\r`/`\n` incrementally, feeds
  records to the parser, and still accumulates the bounded stderr the failure copy needs (a record that
  parses as progress is NOT part of the error text — git's progress lines would otherwise crowd the
  16 KB tail out).
- **Cancel**: `DELETE /projects/clone/:cloneId` (authed) → an in-memory registry `activeClones`
  (`cloneId → { kill() }`) kills the running git process; `cloneRepo` reports `{ ok: false, cancelled: true }`
  (no token retry, no error copy), the route answers the held POST with 409 `{ error: "clone cancelled",
  cancelled: true }` and removes a destination git created (an existing empty dir stays), registers nothing.
  Unknown/finished id → 404. Registry entries are removed on settle; the second attempt re-registers
  under the same id.
- Dialog: while `busy`, the Clone button is replaced by a progress row (phase label + `<progress>` bar,
  `clone-progress`/`clone-progress-bar` test ids, `aria-live="polite"` on the phase text) and the Cancel
  button becomes active (`clone-cancel`) → `api.cancelClone(cloneId)`; the POST's cancelled result closes
  the dialog with an info toast. Progress reaches the dialog through App.tsx's single `subscribeAppEvents`
  handler forwarding `clone_progress` into a tiny module store `src/mainview/lib/clone-progress.ts`
  (`subscribeCloneProgress(cloneId, cb)`), so the dialog never opens its own EventSource.
- CLI: `agetor clone` mints the id, opens `streamSse("/app/events")` for the clone's duration, redraws one
  stderr status line (`\r`-overwritten when stderr is a TTY, one line per phase change otherwise), and
  cancels on SIGINT (DELETE, then exits 130). `--json` prints no progress.
- `git-provider.ts` `providerForHost` doc comment: self-hosted GitLab is supported (via `gitlabApiBase`);
  only Bitbucket Server / unrelated hosts are out.

**Tasks.** P1 `src/bun/clone.ts` (+ `clone.test.ts`) — parser, streaming reader, registry, cancel, `--progress`,
`onProgress` option; P2 `src/shared/types.ts` (`clone_progress` AppEvent + `CloneProgressPhase`) and
`src/bun/server.ts` (body `cloneId`, broadcast, DELETE route, response `cloneId`) (+ `clone-endpoint.test.ts`);
P3 `src/mainview` (store, App.tsx forwarding, dialog UI, `api.cloneProject`/`cancelClone`); P4 `src/cli`
(`api-client.cloneProject` id + `cancelClone`, `commands/clone.ts` progress + SIGINT) (+ `clone.test.ts`);
P5 `git-provider.ts` comment; docs: CLAUDE.md item 18. Waves: P1 → (P2) → (P3 ∥ P4 ∥ P5). e2e: extend
`e2e/clone-providers.spec.ts` with a progress-bar-visible + cancel flow using a slow fixture (a large
synthetic repo, or `AGETOR_FAKE_CLONE_DELAY_MS` test seam if a real slow clone is impractical).

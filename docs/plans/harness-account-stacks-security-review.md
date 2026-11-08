# Security review — harness-stack mirror and session transfer

| Field | Value |
| --- | --- |
| Date | 2026-11-08 (re-verified after the source-parent, async-copy, plugin-payload, shape-based credential-strip, user-memory-file, plugin-registry-identity and payload-cap fixes) |
| Scope | `harness-mirror.ts`, `harness-file-transfer.ts`, `harness-session-transfer.ts`, the create/update/swap call sites, `harness_session_handoffs` cleanup |
| Verdict | **Approved with one recorded deviation** (Codex MCP OAuth tokens are not copied). The Claude plugin payload is now mirrored, with `.git` excluded at every depth and registry paths rewritten to the destination account. |
| Owner decision | Full mirror (hooks/permissions included) is the default; per-stack `safe` mode is the opt-out. Confirmed by the grilled plan, not changed by this review. |

## Trust boundary

A harness home is agent-writable: an agent can plant a symlink, a FIFO, a
device node, a huge file, or a transcript from another account. The mirror and
transfer therefore treat **every source path as untrusted**, not just paths
that came from a request.

## Copied paths (allowlist)

Claude Code (`CLAUDE_CONFIG_DIR`, i.e. `harness.home ?? ~/.claude`):

- `settings.json` (merged), `.claude.json` (only `mcpServers` and
  `enabledPlugins`, merged)
- `CLAUDE.md` (user-level memory), `output-styles/`
- `skills/`, `commands/`, `agents/`
- `plugins/cache/` (the installed plugin payload), `plugins/marketplaces/`,
  `plugins/data/`
- `plugins/installed_plugins.json`, `plugins/known_marketplaces.json` — merged
  with every absolute path under the primary's config root rewritten to the
  destination root, so the backup loads its own payload copy. Install records
  merge by install identity — scope plus `projectPath` (primary wins), not by
  a plain array union (which installed one plugin twice at `user` scope) or by
  scope alone (which dropped a plugin's other project installs and the
  backup's own project records).

Codex (`CODEX_HOME` = `<home>/.codex` or `~/.codex`):

- `config.toml` (section-preserving merge; `Bun.TOML.parse` validates the
  result; invalid output is discarded)
- `AGENTS.md` (user-level instructions), `prompts/`, `skills/`, `plugins/`
  including the installed payload cache

Why these are safe: they are the CLI's own user-level configuration and
authored content. None carries a login, a session, or machine state that
another account would misread. The plugin payload is authored plugin content,
not a credential store; `.git` (where a marketplace clone keeps its remote URL
and any embedded token) is never copied, and Codex's transient install staging
is excluded.

## Never copied

`.credentials.json`, legacy `.claude/` credential state, `auth.json`,
`history.jsonl`, `projects/`, `sessions/`, `shell-snapshots/`, `sessions/`,
`todos/`, `statsig/`, `stats-cache.json`, `daemon/`, `session-env/`,
`paste-cache/`, `backups/`, `jobs/`, `plugins/store/`, plugin catalog caches,
Codex `state_*.sqlite`, `thread_history_*.sqlite`, `logs_*.sqlite`,
`queue_*.sqlite`, `goals_*.sqlite`, `memories_*.sqlite`, `app-server-*`,
`mcp-oauth-locks/`, and the primary's `[projects.*]` trust entries.

`.git` is also never copied, at any depth of any mirrored tree: a marketplace
clone's `.git/config` can contain the remote URL with an embedded access token,
and that token must not become the backup account's. `.gitignore` /
`.gitattributes` are ordinary files and stay copyable.

`assertNotCredentialPath` refuses any of these even if a future allowlist entry
would match, and `isNeverCopyPath` is the shared predicate the walker and the
refusal use (`isNeverCopySegment` is the `.git` segment rule).

## Controls

- **No-follow reads**: the copy path and the merge readers open with
  `O_NOFOLLOW | O_NONBLOCK` and require a regular file, so a FIFO cannot block
  the core. The merge readers cap the read at 8 MB; there is no `lstat` →
  `readFileSync` window.
- **Source parents**: `isPlainAncestorPathUnder` walks every component
  **between** the trusted account root and the leaf and refuses a symlink,
  non-directory or unreadable ancestor. A leaf-only `lstat` follows parents, so
  `~/.claude/plugins` → outside would otherwise hand back the target's
  regular file as if it were the account's own. Applied to every mirror
  `copy`/`merge` source and to the Claude transcript/sidecar and Codex rollout
  paths; the leaf still needs `isPlainDir` / `isRegularFileNoFollow`.
- **Directory walks**: `lstat` each entry; symlinks, FIFOs and devices are
  skipped with a warning; destination copies are additive (a backup's own
  files survive) and every destination component below the account root is
  checked with `ensurePlainDirUnder`, so a planted symlink cannot redirect a
  mirror write.
- **Atomic writes**: sibling temp file → fsync → rename; 0600 files, 0700 dirs;
  a target symlink is replaced, never followed.
- **Caps**: 64 MB and 5,000 entries per user-config tree; plugin payload trees
  (`plugins/cache/`, `plugins/marketplaces/`, Codex `plugins/`) get a bounded
  512 MB / 25,000-entry budget so a normal marketplace install is not
  truncated. Oversized files/trees are skipped, never block a swap. A cap hit
  is reported by `copyTreeCooperative` (`truncated`), and a plugin payload that
  was only partly copied leaves the account's plugin registry untouched with a
  warning — a rewritten `installPath` must never point at a file that does not
  exist.
- **Cooperative**: the walk yields every ~20 ms / 32 files, every read/write is
  asynchronous and chunked (1 MiB), so the shared Bun main thread (all tasks)
  is not frozen by one large file.
- **Login separation**: provider *and cloud* credential env keys are stripped
  from the primary's merged `settings.json` by **shape, not by an enumerated
  vendor list**: any `_`-separated `TOKEN`/`SECRET`/`PASSWORD`/`KEY`/
  `CREDENTIAL`/`AUTHORIZATION` segment (`OPENROUTER_API_KEY`, `GITHUB_TOKEN`,
  `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_SECRET_ACCESS_KEY`,
  `AZURE_OPENAI_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`) plus the
  vendor-prefix markers for names whose credential shape is not a whole
  segment (`ANTHROPIC_CUSTOM_HEADERS`). Login-selecting cloud settings
  (`AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, `AWS_ROLE_ARN`, the AWS config/
  credentials file pointers) are stripped too: they name the identity Bedrock
  would assume even though no secret crosses. Non-credential settings such as
  `*_BASE_URL`, `*_MODEL`, `*_MAX_TOKENS`, `AWS_REGION` and project ids still
  mirror; login-selecting `settings.json` keys (`apiKeyHelper`,
  `forceLoginOrgUUID`, `awsCredentialExport`, `awsAuthRefresh`) are never
  imported from the primary either; a backup's own values survive; the process
  env is not modified (a creation warning names the first kind-relevant
  credential it sees, cloud keys included).
- **Login evidence fails open**: an account is only skipped when its config
  root has no `.credentials.json`, no credential in its own env map /
  `settings.json` `env` / the inherited process env, no `apiKeyHelper`-style
  login, and no Bedrock/Vertex/custom-provider selector in any of those scopes.
  A settings-file key, a process-level cloud selector, or a present-but-
  uninspectable `settings.json`/Codex `config.toml` therefore never reads as
  "not logged in".
- **Cleanup**: only a path recorded in `harness_session_handoffs.copied_paths_json`
  and below the destination account's config root is removed, and only when it
  is a regular file or a plain directory and **every component below the root
  is a real, non-symlink path**. A symlinked parent directory cannot redirect a
  recorded copy path outside the account. Delete removes immediately; archive
  keeps them for the retention sweep.

## Risks accepted

- **Hooks/permissions in full mode** execute the primary's hooks on every
  backup. The owner chose this; `safe` mode skips them and never rewrites an
  existing backup's values. This review records the risk rather than reversing
  the decision.
- **A mid-turn resume may repeat a tool whose result was lost.** Owner-accepted;
  the continuation prompt forbids repeating completed steps, and Agetor never
  retries a tool result itself.
- **Process provider keys leak to every harness** (pre-existing). v1 warns at
  stack creation and strips them from the mirrored file, not the process.

## Deviation — Codex MCP OAuth

The Codex binary's `mcp_oauth_credentials_store` defaults to `auto`, with
`file | keyring | auto | ephemeral` modes and a `mcp-oauth-locks/` dir. There is
no stable standalone filename exposed for the file store. Copying an unnameable
credential store would violate the never-copy-credentials rule, so the mirror
copies only the MCP **definitions** and the swap warns that sign-in may need
repeating on the backup. The owner should ratify this narrow deviation for
Codex (plan §8, unratified item 2).

## Testing evidence

- `harness-mirror.test.ts`: credentials/session DBs never copied; the primary's
  auth key stripped while the backup's own survives; login-selecting settings
  keys never imported; safe mode; leaf symlink refusal; a symlinked intermediate
  source folder (`plugins/` → outside) refused without reading the target's
  file or tree; a planted token in `plugins/marketplaces/<name>/.git/config`
  never reaches the backup; the plugin payload is copied and the registries'
  absolute paths are rewritten to the destination; a shared plugin keeps one
  record per install identity (scope + `projectPath`), preserving both
  accounts' project installs; an incomplete payload copy leaves the registry
  untouched; `CLAUDE.md`/`output-styles/`/`AGENTS.md` are mirrored; Codex
  `[projects.*]` not inherited; TOML parses; Codex MCP sign-in warning;
  cleanup refuses a path behind a symlinked parent and prunes the empty
  sidecar directories it created.
- `harness-stacks.test.ts`: process-level Bedrock/Vertex/gateway selectors fail
  login evidence open for Claude and Codex, a present-but-uninspectable Codex
  `config.toml` fails open instead of reading as logged out, and a symlinked
  `.credentials.json`/`auth.json` counts as login evidence rather than a
  logout.
- `harness-failover.test.ts`: a retry timer that fires while another start
  holds the task's claim persists a short backoff and re-arms instead of being
  consumed, so a failed prepare cannot strand the countdown with no timer.
- `harness-session-transfer.test.ts`: transcript + sidecars, 0600, handoff,
  cleanup, `no-session`, leaf symlink → `unsafe-source`, a symlinked `projects/`
  parent → `unsafe-source` with nothing copied.
- `harness-file-transfer`: atomic write, symlink refusal, path/credential
  refusal, symlinked-parent cleanup refusal, and the cooperative tree copy's
  entry budget charging each entry once.

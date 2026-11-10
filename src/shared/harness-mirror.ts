/**
 * The harness-mirror allowlist metadata (docs/architecture/harness-stacks.md,
 * plan D12/T02). Pure: no filesystem access. The engine in
 * `src/bun/harness-mirror.ts` consumes exactly these lists, so the set of
 * paths a stack can copy is reviewable in one place and the "never copy a
 * credential" rule is a data property, not a convention scattered through
 * code.
 *
 * Rules:
 * - `copy` is an explicit enumerated allowlist. No globs — a glob like
 *   `plugins/*` would sweep a marketplace cache that contains a token.
 * - `merge` entries are JSON/TOML files whose declared keys are deep-merged
 *   with the primary winning; they are copied through a merge, never raw.
 * - `never` is defense in depth: the engine never walks these, and
 *   `assertNotCredentialPath` refuses one if a caller asks.
 * - `.git` is never copied anywhere in a mirrored tree. A marketplace clone
 *   keeps its remote URL (and any token embedded in it) in `.git/config`; the
 *   payload files are enough for the backup to load the plugin, and a token
 *   must never cross accounts. This is a segment rule, not an allowlist entry,
 *   because a clone may sit at any depth (`plugins/marketplaces/<name>/.git`).
 * - The primary's harness-auth and cloud credential env keys, and the env keys
 *   that select a provider/login (`CLAUDE_CODE_USE_BEDROCK`,
 *   `ANTHROPIC_BASE_URL`, …), are never imported while merging
 *   `settings.json`; a backup's own value is kept. Codex's login-bearing
 *   `config.toml` keys and `[model_providers.*]` tables follow the same rule,
 *   as do the login-bearing and login-selecting `settings.json` keys.
 */
import type { HarnessStackKind } from "./types.ts";

export interface HarnessMirrorSpec {
  /** Directories/files copied verbatim from the primary (regular files only,
   *  no symlinks, cooperative, size-capped). */
  copy: string[];
  /** Copy entries whose TOP-LEVEL symlinked children are re-created on the
   *  backup as an absolute symlink to the link's resolved target (a skill
   *  kept as `skills/x -> ../../.agents/skills/x`). The target's bytes are
   *  never read, the target is resolved without `realpath` (no stat inside
   *  it), and a target inside a credential/never-copy path or a macOS
   *  TCC-protected home folder is refused.
   *  Nested symlinks are still skipped. */
  linkTopLevel: string[];
  /** Files merged with the primary's values winning. */
  merge: string[];
  /** Never read or copied, even if an allowlist entry would match. */
  never: string[];
}

/** Env names that carry a harness login. A stack mirrors config, never login:
 *  the primary's key must not become the backup's session.
 *
 *  The explicit list covers spellings the two shape rules below cannot
 *  express: provider keys whose name has no credential segment (the vendor
 *  prefix rule covers the built-ins) and, more importantly, *login-selecting*
 *  cloud settings. `AWS_ROLE_ARN`/`AWS_PROFILE`/`AWS_DEFAULT_PROFILE` name the
 *  identity Bedrock will assume and the shared-config files name its credential
 *  store; inheriting the primary's would make the backup run as the primary
 *  even though no secret crossed (review R15-S1).
 */
export const HARNESS_AUTH_ENV_KEYS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "CURSOR_API_KEY",
  // Login-selecting cloud settings (not secrets themselves).
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_ROLE_ARN",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AZURE_FEDERATED_TOKEN_FILE",
];

/**
 * Env names that SELECT a provider or login without being a secret: turning on
 * Bedrock/Vertex/Foundry, or pointing the CLI at another endpoint, makes the
 * account authenticate somewhere else. The primary's value must not become the
 * backup's (it would run the backup against the primary's provider), so the
 * mirror never imports these; the backup's own value survives. The same names
 * make login evidence uninspectable in `src/bun/harness-stacks.ts`
 * (`UNINSPECTABLE_LOGIN_ENV_KEYS`); this list covers that selector set plus
 * the other provider switches Claude Code 2.1.319 reads. Keyed by kind so a
 * caller can ask for one kind's selectors; the mirror strips every kind's
 * (a Codex selector in a Claude `settings.json` is inert but never useful).
 */
export const LOGIN_SELECTOR_ENV_KEYS: Readonly<Record<HarnessStackKind, readonly string[]>> = {
  "claude-code": [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_USE_GATEWAY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_SKIP_VERTEX_AUTH",
    "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
    "CLAUDE_CODE_SKIP_MANTLE_AUTH",
    "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
    "CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_FOUNDRY_RESOURCE",
    "ANTHROPIC_AWS_BASE_URL",
    "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
  ],
  codex: ["OPENAI_BASE_URL", "CODEX_BASE_URL", "OPENAI_API_BASE"],
};

/** True for an env name that selects a provider/login for any stack kind. */
export function isLoginSelectorEnvKey(key: string): boolean {
  return LOGIN_SELECTOR_ENV_KEYS["claude-code"].includes(key) || LOGIN_SELECTOR_ENV_KEYS.codex.includes(key);
}

/** The env keys the mirror never imports from the primary's `settings.json`:
 *  anything secret-shaped ({@link isCredentialShapedEnvKey}, logins included)
 *  and provider/login selectors ({@link isLoginSelectorEnvKey}). A backup's
 *  own value always survives. */
export function isMirrorNeverImportedEnvKey(key: string): boolean {
  return isCredentialShapedEnvKey(key) || isLoginSelectorEnvKey(key) || isLoginSelectorEnvKey(key.toUpperCase());
}

/** True for a URL-shaped value with userinfo (`scheme://user[:pass]@host`). */
export function urlHasUserinfo(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s]*@/.test(value.trim());
}

/**
 * Entry-level form of {@link isMirrorNeverImportedEnvKey}: also refuses ANY
 * variable whose value is a URL carrying userinfo (`HTTPS_PROXY`,
 * `DATABASE_URL=postgres://u:pw@db`, …), which is a credential whatever the
 * name looks like.
 */
export function isMirrorNeverImportedEnvEntry(key: string, value: unknown): boolean {
  return isMirrorNeverImportedEnvKey(key) || urlHasUserinfo(value);
}

/** True when any string anywhere inside `value` is a URL with userinfo. */
export function containsUrlUserinfo(value: unknown): boolean {
  if (typeof value === "string") return urlHasUserinfo(value);
  if (Array.isArray(value)) return value.some(containsUrlUserinfo);
  if (typeof value === "object" && value !== null) return Object.values(value).some(containsUrlUserinfo);
  return false;
}

/** Env var names (any case) that make a spawned command run something: a shell
 *  prefix, a startup script, a loader hook, or a helper/command by suffix. Safe
 *  mode never imports them from the primary; the backup's own value survives. */
const COMMAND_RUNNING_ENV_KEYS: readonly string[] = [
  "CLAUDE_CODE_SHELL_PREFIX",
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "NODE_PATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "BROWSER",
  "ZDOTDIR",
  "PERL5LIB",
  "RUBYLIB",
  "PERL5OPT",
  "RUBYOPT",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "EDITOR",
  "VISUAL",
  "PAGER",
];

/** True for an env var that runs a command (see {@link COMMAND_RUNNING_ENV_KEYS}),
 *  including `DYLD_*` and any name ending `_HELPER` or `_COMMAND`. */
export function isCommandRunningEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return COMMAND_RUNNING_ENV_KEYS.includes(upper)
    || upper.startsWith("DYLD_")
    || upper.endsWith("_HELPER")
    || upper.endsWith("_COMMAND");
}

/** Prefixes owned by a model provider (or the cloud that fronts one). A
 *  credential can name the cloud without the provider, e.g.
 *  `AWS_SECRET_ACCESS_KEY` for Bedrock or `AZURE_OPENAI_API_KEY` for the
 *  Azure-hosted OpenAI endpoints. */
const VENDOR_KEY_PREFIXES: readonly string[] = [
  "ANTHROPIC",
  "OPENAI",
  "AZURE_OPENAI",
  "AZURE",
  "CLAUDE",
  "CODEX",
  "GEMINI",
  "GOOGLE",
  "VERTEX_AI",
  "CURSOR",
  "AWS",
  "BEDROCK",
];

/** Credential-shaped segments anywhere after the vendor prefix. Deliberately
 *  matched as substrings: `ACCESS_KEY` must catch `ACCESS_KEY_ID`, and
 *  `BEARER_TOKEN` must catch `BEARER_TOKEN_BEDROCK`. Bare `TOKEN` is absent so
 *  a limit setting such as `MAX_TOKENS` is not treated as a credential. */
const CREDENTIAL_MARKERS: readonly string[] = [
  "API_KEY",
  "AUTH_TOKEN",
  "OAUTH_TOKEN",
  "ACCESS_TOKEN",
  "ACCESS_KEY",
  "SECRET_KEY",
  "SECRET_ACCESS_KEY",
  "SESSION_TOKEN",
  "BEARER_TOKEN",
  "AD_TOKEN",
  "CLIENT_SECRET",
  "PRIVATE_KEY",
  "CREDENTIALS",
  "CUSTOM_HEADERS",
  "AUTHORIZATION",
];

/** Whole `_`-separated name segments that make an env var a credential
 *  regardless of its vendor prefix: `OPENROUTER_API_KEY`, `GITHUB_TOKEN`,
 *  `AWS_WEB_IDENTITY_TOKEN_FILE` and `SOME_VENDOR_SECRET` all name a secret
 *  without using a prefix the enumerated list knows. Matching whole segments
 *  (not substrings) keeps settings such as `MAX_TOKENS`, `TOKENIZER`,
 *  `KEYCHAIN_PATH` and `MONKEY` out — `TOKENS` is deliberately absent. */
const CREDENTIAL_SEGMENTS: readonly string[] = [
  "TOKEN",
  "SECRET",
  "SECRETS",
  "PASSWORD",
  "PASSWD",
  "KEY",
  "CREDENTIAL",
  "CREDENTIALS",
  "AUTHORIZATION",
];

/**
 * The `CLAUDE_CODE_*` variables that really log the Claude Code CLI in
 * (checked against the 2.1.319 binary's strings): the OAuth token and its
 * file-descriptor/refresh forms, the API-key file descriptor, the gateway
 * token, and the remote-session access tokens. Every other credential-shaped
 * `CLAUDE_CODE_*` name is the CLI's own runtime/session plumbing or a
 * non-login integration secret — `CLAUDE_CODE_MESSAGING_TOKEN` (set in every
 * process a Claude Code session spawns, so in Agetor itself when it is started
 * from one), `CLAUDE_CODE_MCP_SERVE_AUTH_TOKEN`, `CLAUDE_CODE_MEMORY_API_TOKEN`,
 * `CLAUDE_CODE_ARTIFACTS_API_TOKEN`, `CLAUDE_CODE_CLIENT_KEY` (mTLS),
 * `CLAUDE_CODE_IDLE_TOKEN_THRESHOLD`, … — and is not a login. The
 * `CLAUDE_CODE_` namespace is therefore an allowlist: a new runtime variable
 * there can never make every account read as logged in.
 */
export const CLAUDE_CODE_LOGIN_ENV_KEYS: readonly string[] = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_GATEWAY_TOKEN",
  "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_SESSIONS_OAUTH_TOKEN",
];

/**
 * True for an env name SHAPED like a secret (explicit list, the vendor-prefix
 * + credential-marker rule, and the provider-agnostic credential-segment
 * rule), whether or not it is a harness login. The mirror strips every such
 * key from the primary's `settings.json` env — a secret has no business
 * crossing accounts even when it is not a login. Use
 * {@link isHarnessAuthEnvKey} to ask "does this log the harness in?".
 */
export function isCredentialShapedEnvKey(key: string): boolean {
  // Case-insensitive: `github_token` is as much a secret as `GITHUB_TOKEN`.
  const upper = key.toUpperCase();
  if (HARNESS_AUTH_ENV_KEYS.includes(upper)) return true;
  if (upper.split("_").some((segment) => MIRROR_EXTRA_CREDENTIAL_SEGMENTS.includes(segment))) return true;
  return isLoginShapedEnvKey(upper);
}

/** Whole-segment credential names the MIRROR strips on top of
 *  {@link CREDENTIAL_SEGMENTS}: `SERPAPI_APIKEY`, `DB_PASS`, `GH_PAT`,
 *  `NPM_AUTH`, `OTEL_EXPORTER_OTLP_HEADERS`, cookies and session blobs. Only a
 *  whole `_`-separated segment matches, so `PATH` never matches `PAT`. They are
 *  deliberately NOT part of login evidence ({@link isHarnessAuthEnvKey}):
 *  `TERM_SESSION_ID` in the process env is not a harness login. */
const MIRROR_EXTRA_CREDENTIAL_SEGMENTS: readonly string[] = [
  "APIKEY",
  "PASS",
  "PASSWD",
  "PAT",
  "AUTH",
  "HEADERS",
  "COOKIE",
  "COOKIES",
  "SESSION",
  "DSN",
  "WEBHOOK",
  "CONNECTION",
  "PASSPHRASE",
];

/** The original (case-sensitive-era) credential shape rule: explicit list,
 *  credential segment, then vendor prefix + marker. Login evidence keeps using
 *  exactly this. */
function isLoginShapedEnvKey(key: string): boolean {
  if (HARNESS_AUTH_ENV_KEYS.includes(key)) return true;
  // Shape first: a credential segment is a credential under any vendor.
  const segments = key.split("_");
  if (segments.some((segment) => CREDENTIAL_SEGMENTS.includes(segment))) return true;
  // Then the vendor-prefix + marker rule for names whose credential shape is
  // not a whole segment (e.g. `ANTHROPIC_CUSTOM_HEADERS`).
  const prefix = VENDOR_KEY_PREFIXES.find((p) => key.startsWith(`${p}_`));
  if (!prefix) return false;
  const rest = key.slice(prefix.length + 1);
  return CREDENTIAL_MARKERS.some((marker) => rest.includes(marker));
}

/** True for an env name that carries provider auth or cloud credentials: a
 *  credential-shaped key ({@link isCredentialShapedEnvKey}) — except in the
 *  `CLAUDE_CODE_` namespace, where only {@link CLAUDE_CODE_LOGIN_ENV_KEYS}
 *  count (Claude Code's own session variables such as
 *  `CLAUDE_CODE_MESSAGING_TOKEN` are not a login). The rule is deliberately
 *  broad elsewhere: a backup inheriting `AWS_SECRET_ACCESS_KEY` runs as the
 *  primary exactly as it would with `ANTHROPIC_API_KEY`, and
 *  `OPENROUTER_API_KEY`/`GITHUB_TOKEN` are no different just because their
 *  vendor is not enumerated. Non-credential settings (`*_BASE_URL`, `*_MODEL`,
 *  `*_REGION`, project ids) are not matched. Case-sensitive by POSIX
 *  convention. Login evidence and the process-provider-key warning
 *  (`src/bun/harness-stacks.ts`) use this. */
export function isHarnessAuthEnvKey(key: string): boolean {
  if (key.startsWith("CLAUDE_CODE_")) return CLAUDE_CODE_LOGIN_ENV_KEYS.includes(key);
  return isLoginShapedEnvKey(key);
}

/**
 * The Claude `settings.json` keys whose value is a command the CLI runs —
 * exactly Claude Code 2.1.319's own list of command settings: the
 * credential/login helpers (`apiKeyHelper`, `awsAuthRefresh`,
 * `awsCredentialExport`, `gcpAuthRefresh`, `proxyAuthHelper`), the telemetry
 * header helper (`otelHeadersHelper`), the UI commands (`statusLine`,
 * `subagentStatusLine`, `fileSuggestion`), the process wrapper every tool
 * command runs under (`processWrapper`) and the policy helpers
 * (`policyHelpers`). The login helpers are never imported in either mode
 * ({@link MIRROR_NEVER_IMPORTED_SETTINGS_KEYS}); safe mode skips all of them.
 */
export const COMMAND_RUNNING_SETTINGS_KEYS: readonly string[] = [
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "fileSuggestion",
  "gcpAuthRefresh",
  "otelHeadersHelper",
  "policyHelpers",
  "processWrapper",
  "proxyAuthHelper",
  "statusLine",
  "subagentStatusLine",
];

/**
 * Safe mode skips everything in the primary's config that runs a command or
 * grants one: settings hooks, permissions and every command setting
 * ({@link COMMAND_RUNNING_SETTINGS_KEYS}: status lines, file suggestion,
 * process wrapper, policy and credential helpers) in Claude `settings.json`,
 * and Codex's top-level `notify` (plus its `hooks` and `permissions` tables).
 * Plugins and MCP servers are still mirrored — they are the tools the feature
 * promises. Executing the primary's commands on every backup is the risk the
 * security review calls out, and the per-stack `safe` mode is the opt-out. The
 * backup's own value of an excluded key always survives.
 */
export const SAFE_MODE_EXCLUDED_SETTINGS_KEYS: readonly string[] = [
  "hooks",
  "permissions",
  ...COMMAND_RUNNING_SETTINGS_KEYS,
];

/** Codex `config.toml` keys/tables skipped in safe mode (see
 *  {@link SAFE_MODE_EXCLUDED_SETTINGS_KEYS}). Matched on the first key
 *  segment, so `[hooks.x]` and a dotted `hooks.x = …` are both skipped. */
export const SAFE_MODE_EXCLUDED_CODEX_KEYS: readonly string[] = ["hooks", "permissions", "notify"];

/**
 * Claude `settings.json` keys the primary REPLACES outright in full mode
 * instead of deep-merging. An array union kept every hook the backup ever
 * received (an edited hook then ran twice) and kept a revoked
 * `permissions.allow` entry forever; these two objects are the primary's
 * policy, so the backup gets exactly the primary's copy. When the primary has
 * no such key the backup's own value is left alone. Safe mode skips them.
 */
export const FULL_MODE_REPLACED_SETTINGS_KEYS: readonly string[] = ["hooks", "permissions"];

/**
 * Codex `config.toml` top-level keys that select or carry a login: which
 * provider the CLI talks to (`model_provider`, `model_providers` and every
 * `[model_providers.*]` table — those hold `experimental_bearer_token`,
 * `http_headers`, `env_http_headers`, `requires_openai_auth`), how it logs in
 * (`forced_login_method`, `forced_chatgpt_workspace_id`,
 * `preferred_auth_method`), where the login is stored
 * (`cli_auth_credentials_store`, `mcp_oauth_credentials_store`), the auth
 * endpoints (`chatgpt_base_url`, `openai_base_url`) and the MCP enterprise auth
 * switch (`mcp_enterprise_managed_auth`). Names checked against the Codex
 * 0.166 `ConfigToml` field list. The primary's values are never imported; the
 * backup's own keys and tables are kept verbatim.
 */
export const CODEX_LOGIN_BEARING_CONFIG_KEYS: readonly string[] = [
  "model_provider",
  "model_providers",
  "forced_login_method",
  "forced_chatgpt_workspace_id",
  "preferred_auth_method",
  "cli_auth_credentials_store",
  "mcp_oauth_credentials_store",
  "mcp_enterprise_managed_auth",
  "chatgpt_base_url",
  "openai_base_url",
];

/**
 * True for a Codex config key path (table header or dotted assignment key,
 * already split into unquoted segments) that carries or selects a login:
 * a login-bearing top-level key or anything below one, and the same keys
 * inside a `[profiles.<name>]` table (a profile can set `model_provider`).
 */
export function isCodexLoginBearingKeyPath(segments: readonly string[]): boolean {
  if (segments.length === 0) return false;
  if (CODEX_LOGIN_BEARING_CONFIG_KEYS.includes(segments[0]!)) return true;
  return segments[0] === "profiles"
    && segments.length >= 3
    && CODEX_LOGIN_BEARING_CONFIG_KEYS.includes(segments[2]!);
}

/**
 * True for a Codex config key path (already split into unquoted segments) that
 * holds a secret the mirror must not import although it is not a login: a
 * credential-shaped variable in `shell_environment_policy.set` (`set.GH_TOKEN`)
 * or anything named `headers` under `otel` (OTLP exporters carry auth headers).
 * The backup's own value of such a key survives. A path that STOPS at
 * `shell_environment_policy.set` (an inline `set = {…}`) is not matched here:
 * the engine filters that table's members one by one.
 */
export function isCodexSecretKeyPath(segments: readonly string[]): boolean {
  if (segments.length === 0) return false;
  if (segments[0] === "otel") return segments.slice(1).some((s) => s.toLowerCase() === "headers");
  if (segments[0] === "shell_environment_policy" && segments[1] === "set" && segments.length >= 3) {
    return isMirrorNeverImportedEnvKey(segments[2]!);
  }
  return false;
}

/**
 * Claude `settings.json` keys that carry a login rather than describe
 * configuration: `apiKeyHelper` hands the CLI a credential-producing command,
 * `forceLoginOrgUUID` pins the account's organization, and the AWS/GCP helpers
 * export or refresh cloud credentials (Claude Code 2.1.319). Copying the
 * primary's value would make the backup run as the primary (or overwrite the
 * backup's own login), which breaks the "each account keeps its own login"
 * invariant. The backup's own value always survives; only the primary's is
 * dropped. Login evidence (`src/bun/harness-stacks.ts`) also reads a set key
 * from this list as "this account logs in through a helper", so only keys that
 * really produce or pin a login belong here; the login-SELECTING keys that are
 * no login by themselves are in {@link LOGIN_SELECTING_SETTINGS_KEYS}.
 */
export const LOGIN_BEARING_SETTINGS_KEYS: readonly string[] = [
  "apiKeyHelper",
  "forceLoginOrgUUID",
  "awsCredentialExport",
  "awsAuthRefresh",
  "gcpAuthRefresh",
];

/**
 * Claude `settings.json` keys that pick HOW an account authenticates without
 * being a login themselves, so the mirror never imports them but login
 * evidence ignores them:
 * - `forceLoginMethod` (`claudeai` / `console`) decides which login the CLI
 *   accepts; the primary's would lock the backup out of its own.
 * - `proxyAuthHelper` is a command whose output is the proxy's
 *   authentication (a credential for the network path, not the account), so
 *   it is credential-producing and command-running: never imported in either
 *   mode, and listed among the safe-mode command settings too.
 */
export const LOGIN_SELECTING_SETTINGS_KEYS: readonly string[] = [
  "forceLoginMethod",
  "proxyAuthHelper",
];

/** True when a Claude `settings.json` key carries a login (login evidence). */
export function isLoginBearingSettingsKey(key: string): boolean {
  return LOGIN_BEARING_SETTINGS_KEYS.includes(key);
}

/** Every Claude `settings.json` key the mirror never imports from the primary,
 *  in either mode: the login-bearing and the login-selecting keys. */
export const MIRROR_NEVER_IMPORTED_SETTINGS_KEYS: readonly string[] = [
  ...LOGIN_BEARING_SETTINGS_KEYS,
  ...LOGIN_SELECTING_SETTINGS_KEYS,
];

/** True when the mirror must keep the backup's own value of a Claude
 *  `settings.json` key and never import the primary's. */
export function isMirrorNeverImportedSettingsKey(key: string): boolean {
  return MIRROR_NEVER_IMPORTED_SETTINGS_KEYS.includes(key);
}

/**
 * Home-relative folders macOS gates per app through TCC (privacy prompts /
 * Full Disk Access): the user's Desktop, Documents and Downloads, iCloud Drive
 * (`Library/Mobile Documents`), the media libraries, Mail, Messages, Safari
 * data and other apps' sandbox containers. When the core touches a path under
 * one of them in its own process, macOS answers with Agetor's grants (or
 * prompts in Agetor's name), which is what the CLI path gate prevents
 * (docs/architecture/security.md, D24). The list is deliberately the
 * well-known set rather than every protected location: it is used to REFUSE
 * a config root or symlink target that resolves into one of these folders
 * after it was saved somewhere else (docs/architecture/harness-stacks.md), so
 * a missing entry only narrows that refusal.
 */
export const MACOS_TCC_PROTECTED_HOME_FOLDERS: readonly string[] = [
  "Desktop",
  "Documents",
  "Downloads",
  "Library/Mobile Documents",
  "Pictures",
  "Movies",
  "Music",
  "Library/Mail",
  "Library/Messages",
  "Library/Safari",
  "Library/Containers",
  "Library/Group Containers",
];

/** `p` without trailing slashes and with repeated slashes collapsed. */
function trimSlashes(p: string): string {
  const collapsed = p.replace(/\/+/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

/**
 * The {@link MACOS_TCC_PROTECTED_HOME_FOLDERS} entry (e.g. `"Documents"`)
 * whose folder `<home>/<entry>` the absolute, normalized path `p` is equal to
 * or inside, or null. Every candidate home in `homes` is
 * tried (the caller passes the home as spelled and its realpath). Compared
 * case-insensitively: the default macOS volume is case-insensitive, so
 * `~/documents` is `~/Documents`. Pure string work — nothing is stat'ed.
 */
export function tccProtectedFolderOf(p: string, homes: readonly string[]): string | null {
  const target = trimSlashes(p);
  const lowered = target.toLowerCase();
  for (const home of homes) {
    if (!home) continue;
    const base = trimSlashes(home);
    for (const entry of MACOS_TCC_PROTECTED_HOME_FOLDERS) {
      const folder = `${base === "/" ? "" : base}/${entry}`;
      const f = folder.toLowerCase();
      if (lowered === f || lowered.startsWith(`${f}/`)) return entry;
    }
  }
  return null;
}

export const MIRROR_SPECS: Record<HarnessStackKind, HarnessMirrorSpec> = {
  "claude-code": {
    // Skills/commands/agents are often kept as symlinks into a shared folder
    // (`skills/x -> ../../.agents/skills/x`); the backup gets the same link.
    linkTopLevel: ["skills", "commands", "agents"],
    copy: [
      // User-level memory and output styles are part of the account's config,
      // not machine state: a backup that lacks them behaves differently from
      // the primary even though its MCP servers and skills match (review M2,
      // grill 18's "mirror the whole user-level config").
      "CLAUDE.md",
      "output-styles",
      "skills",
      "commands",
      "agents",
      // The installed plugin payload. Without it a backup's registry points at
      // plugins it cannot load (and, worse, at the primary's cache). `.git`
      // inside it is excluded by `isNeverCopyPath`, so a marketplace clone's
      // remote/token never crosses accounts.
      "plugins/cache",
      "plugins/marketplaces",
      "plugins/data",
    ],
    // The two registries hold absolute paths into the source account's plugin
    // directories; they are merged with every such path rewritten to the
    // destination root, never copied raw.
    merge: [
      "settings.json",
      ".claude.json",
      "plugins/installed_plugins.json",
      "plugins/known_marketplaces.json",
    ],
    never: [
      ".credentials.json",
      ".claude",
      "projects",
      "history.jsonl",
      "file-history",
      "shell-snapshots",
      "sessions",
      "todos",
      "statsig",
      "stats-cache.json",
      "daemon",
      "session-env",
      "paste-cache",
      "backups",
      "jobs",
      "plugins/store",
      "plugins/plugin-catalog-cache.json",
      "plugins/plugin-directory-cache-v2.json",
    ],
  },
  codex: {
    // `AGENTS.md` is Codex's user-level instruction file (the counterpart of
    // Claude's `CLAUDE.md`); without it a backup loses the user's standing
    // instructions on failover (review M2).
    copy: ["AGENTS.md", "prompts", "skills", "plugins"],
    linkTopLevel: ["skills", "prompts"],
    merge: ["config.toml"],
    never: [
      "auth.json",
      "history.jsonl",
      "sessions",
      "log",
      "tmp",
      "shell_snapshots",
      "models_cache.json",
      "mcp-oauth-locks",
      // The allowlist copies `plugins/` whole, including the installed payload
      // cache, so a backup can load its plugins. Repository metadata is
      // excluded by the `.git` segment rule; a half-written install staging
      // directory and the derived catalog/store caches are excluded here.
      "plugins/.remote-plugin-install-staging",
      "plugins/store",
      "plugins/plugin-catalog-cache.json",
      "plugins/plugin-directory-cache-v2.json",
    ],
  },
};

/**
 * Per-tree copy budget, keyed by the root-relative allowlist entry. The generic
 * 64 MB / 5,000-entry cap fits user-authored `skills/`/`commands/`, but an
 * installed plugin payload is a whole marketplace tree (many plugins, versions
 * and vendor files) and would be truncated at that size — while the merged
 * registry would still rewrite every `installPath` to the destination, pointing
 * the CLI at files that were never copied (review S3). Payload trees therefore
 * get their own larger, still bounded budget; when even that is exceeded the
 * engine leaves the plugin registry untouched and warns instead of publishing a
 * broken path (see `harness-mirror.ts`).
 */
export const MIRROR_PAYLOAD_LIMITS: Partial<Record<string, { maxBytes: number; maxEntries: number }>> = {
  "plugins/cache": { maxBytes: 512 * 1024 * 1024, maxEntries: 25_000 },
  "plugins/marketplaces": { maxBytes: 512 * 1024 * 1024, maxEntries: 25_000 },
  // Codex mirrors `plugins/` whole (definitions, data and the installed cache).
  plugins: { maxBytes: 512 * 1024 * 1024, maxEntries: 25_000 },
};

/** True for a path segment that must never be mirrored: a git repository's
 *  `.git` directory (or a submodule's `.git` gitlink file) can carry the
 *  marketplace's remote URL, including an embedded access token. Checked as a
 *  segment so a clone at any depth is covered. `.gitignore`/`.gitattributes`
 *  are ordinary plugin files and stay copyable. */
export function isNeverCopySegment(segment: string): boolean {
  return segment === ".git";
}

/**
 * Codex DB files are matched by prefix rather than enumerated: `state_*.sqlite`
 * and friends are per-CLI-version and a new suffix must never become copyable
 * by default. Checked by both the walker and `assertNotCredentialPath`.
 */
export function isCodexNeverCopyName(name: string): boolean {
  return (
    /^state_.*\.sqlite$/.test(name) ||
    /^thread_history_.*\.sqlite$/.test(name) ||
    /^logs_.*\.sqlite$/.test(name) ||
    /^queue_.*\.sqlite$/.test(name) ||
    /^goals_.*\.sqlite$/.test(name) ||
    /^memories_.*\.sqlite$/.test(name) ||
    /^app-server-/.test(name)
  );
}

/** True when a relative path is a known never-copy path for the kind. */
export function isNeverCopyPath(kind: HarnessStackKind, rel: string): boolean {
  const normalized = rel.replace(/^\.\//, "").replace(/\/+$/, "");
  const segments = normalized.split("/");
  if (segments.some((segment) => isNeverCopySegment(segment))) return true;
  const spec = MIRROR_SPECS[kind];
  if (spec.never.some((p) => normalized === p || normalized.startsWith(`${p}/`))) return true;
  if (kind === "codex") {
    return segments.some((segment) => isCodexNeverCopyName(segment));
  }
  return false;
}

/**
 * True when `rel` (relative to the account's config root, `/`-separated) is a
 * path the mirror's `copy` allowlist can have written: a listed entry or
 * something below one, and not a never-copy path. Provenance rows live in
 * SQLite, which an agent can write, so a removal or restore of a recorded file
 * must pass this shape check besides the usual path checks.
 */
export function isMirrorCopyShape(kind: HarnessStackKind, rel: string): boolean {
  if (rel.length === 0 || rel.startsWith("/") || rel.includes("\0") || rel.includes("\\")) return false;
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return false;
  if (isNeverCopyPath(kind, rel)) return false;
  return MIRROR_SPECS[kind].copy.some((entry) => rel === entry || rel.startsWith(`${entry}/`));
}

/** The per-session sidecar folders Claude Code keeps next to a transcript
 *  (`projects/<encoded cwd>/<session>/<sidecar>/…`). `file-history/<session>/`
 *  (the `/rewind` checkpoints) sits beside `projects/`, not under it, and is
 *  handled separately by the handoff shapes. */
export const CLAUDE_SESSION_SIDECAR_DIRS: readonly string[] = ["subagents", "tool-results", "mcp-tasks"];

/** A single path segment Agetor may treat as a session or project name: no
 *  separators, not `.`/`..`, no NUL. */
export function isSafePathSegment(segment: string): boolean {
  return segment.length > 0
    && segment !== "."
    && segment !== ".."
    && !segment.includes("/")
    && !segment.includes("\\")
    && !segment.includes("\0");
}

/**
 * True when `rel` (relative to an account's config root, `/`-separated) has
 * the shape a session handoff writes for the recorded `sessionId` — the only
 * shapes cleanup may unlink:
 * - claude-code: `projects/<enc>/<sid>.jsonl`, a file below
 *   `projects/<enc>/<sid>/{subagents,tool-results,mcp-tasks}/`, or a file
 *   below `file-history/<sid>/`;
 * - codex: `sessions/YYYY/MM/DD/rollout-*-<sid>.jsonl` (Codex embeds the
 *   thread id as the file name's suffix).
 * Handoff rows live in SQLite, which an agent can write; a recorded path of
 * any other shape, or one naming a different session, is never touched,
 * whatever the row says.
 */
export function isHandoffCopyShape(kind: HarnessStackKind, rel: string, sessionId: string): boolean {
  if (!isSafePathSegment(sessionId)) return false;
  const parts = rel.split("/");
  if (parts.some((p) => !isSafePathSegment(p))) return false;
  if (kind === "claude-code") {
    if (parts[0] === "file-history") return parts.length >= 3 && parts[1] === sessionId;
    if (parts[0] !== "projects" || parts.length < 3) return false;
    if (parts.length === 3) return parts[2] === `${sessionId}.jsonl`;
    return parts.length >= 5 && parts[2] === sessionId && CLAUDE_SESSION_SIDECAR_DIRS.includes(parts[3]!);
  }
  return parts.length === 5
    && parts[0] === "sessions"
    && /^\d{4}$/.test(parts[1]!)
    && /^\d{2}$/.test(parts[2]!)
    && /^\d{2}$/.test(parts[3]!)
    && parts[4]!.startsWith("rollout-")
    && parts[4]!.endsWith(`-${sessionId}.jsonl`);
}

/**
 * True when `rel` names a DIRECTORY inside a handoff shape for `sessionId`
 * that cleanup may prune once it is empty: for claude-code the session folder
 * `projects/<enc>/<sid>` and its sidecar folders, and `file-history/<sid>` and
 * anything below it; for codex the date folders `sessions/YYYY[/MM[/DD]]`.
 * Never `projects/<enc>`, `projects`, `file-history` or `sessions` themselves —
 * those belong to the account.
 */
export function isHandoffPrunableDir(kind: HarnessStackKind, rel: string, sessionId: string): boolean {
  if (!isSafePathSegment(sessionId)) return false;
  const parts = rel.split("/");
  if (parts.some((p) => !isSafePathSegment(p))) return false;
  if (kind === "claude-code") {
    if (parts[0] === "file-history") return parts.length >= 2 && parts[1] === sessionId;
    if (parts[0] !== "projects" || parts.length < 3 || parts[2] !== sessionId) return false;
    return parts.length === 3 || CLAUDE_SESSION_SIDECAR_DIRS.includes(parts[3]!);
  }
  if (parts[0] !== "sessions" || parts.length < 2 || parts.length > 4) return false;
  return /^\d{4}$/.test(parts[1]!)
    && (parts.length < 3 || /^\d{2}$/.test(parts[2]!))
    && (parts.length < 4 || /^\d{2}$/.test(parts[3]!));
}

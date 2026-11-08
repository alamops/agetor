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
 * - The primary's harness-auth and cloud credential env keys are stripped
 *   while merging `settings.json`; a backup's own key is kept.
 */
import type { HarnessStackKind } from "./types.ts";

export interface HarnessMirrorSpec {
  /** Directories/files copied verbatim from the primary (regular files only,
   *  no symlinks, cooperative, size-capped). */
  copy: string[];
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

/** True for an env name that carries provider auth or cloud credentials
 *  (explicit list, the vendor-prefix + credential-marker rule, and the
 *  provider-agnostic credential-segment rule). The rule is deliberately broad:
 *  a backup inheriting `AWS_SECRET_ACCESS_KEY` runs as the primary exactly as
 *  it would with `ANTHROPIC_API_KEY`, and `OPENROUTER_API_KEY`/`GITHUB_TOKEN`
 *  are no different just because their vendor is not enumerated. Non-credential
 *  settings (`*_BASE_URL`, `*_MODEL`, `*_REGION`, project ids) are not
 *  matched. Case-sensitive by POSIX convention. */
export function isHarnessAuthEnvKey(key: string): boolean {
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

/** Safe mode deliberately excludes user-level hooks and permission rules:
 *  executing the primary's hooks on every backup is the risk the security
 *  review calls out, and the per-stack `safe` mode is the opt-out. */
export const SAFE_MODE_EXCLUDED_KEYS: readonly string[] = ["hooks", "permissions"];

/**
 * Claude `settings.json` keys that select a login rather than describe
 * configuration: `apiKeyHelper` hands the CLI a credential-producing command,
 * `forceLoginOrgUUID` pins the account's organization, and the AWS helpers
 * export/refresh credentials. Copying the primary's value would make the
 * backup run as the primary (or overwrite the backup's own login), which
 * breaks the "each account keeps its own login" invariant. The backup's own
 * value always survives; only the primary's is dropped.
 */
export const LOGIN_BEARING_SETTINGS_KEYS: readonly string[] = [
  "apiKeyHelper",
  "forceLoginOrgUUID",
  "awsCredentialExport",
  "awsAuthRefresh",
];

/** True when a Claude `settings.json` key carries or selects a login. */
export function isLoginBearingSettingsKey(key: string): boolean {
  return LOGIN_BEARING_SETTINGS_KEYS.includes(key);
}

export const MIRROR_SPECS: Record<HarnessStackKind, HarnessMirrorSpec> = {
  "claude-code": {
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

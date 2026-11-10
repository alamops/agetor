/**
 * Harness account stacks: the store, validation, effective-home resolution,
 * login evidence and the account-global cooldown
 * (docs/architecture/harness-stacks.md, plan T03).
 *
 * A stack is an ordered membership on `harnesses` rows of one kind. The
 * store never touches the runtime: the orchestrator/failover modules read
 * these helpers, and the API/CLI/Settings call the CRUD functions. Keeping
 * the fs/probe surface here (rather than in a route) is what lets the CLI and
 * the webview share one validation story.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  HARNESS_STACK_KINDS,
  type Harness,
  type HarnessLimitReason,
  type HarnessLimitSignal,
  type HarnessLimitState,
  type HarnessMirrorMode,
  type HarnessStack,
  type HarnessStackInput,
  type HarnessStackKind,
  type HarnessStackMember,
  type HarnessStackWarning,
  type Task,
} from "../shared/types.ts";
import { isHarnessAuthEnvKey, isLoginBearingSettingsKey } from "../shared/harness-mirror.ts";
import { resolveBin } from "./agents.ts";
import { childEnv, coreSpawn } from "./core-spawn.ts";
import {
  claudeConfigDirEnvFor,
  claudeConfigDirFor,
  codexHomeFor,
  type HarnessRootSource,
} from "./harness-config-root.ts";
import { getDiscoveredModels, getHarnessDiscoveredModels } from "./agent-discovery.ts";
import { readAccountFileText } from "./no-follow.ts";
import { db, harnesses, tasks } from "./db.ts";

/** Fallback cooldown for a rate limit when the provider gave no reset time. */
export const HARNESS_RATE_LIMIT_COOLDOWN_MS = 60_000;
/** Fallback cooldown for a quota/credits signal with no reset time. */
export const HARNESS_QUOTA_COOLDOWN_MS = 10 * 60_000;

const MAX_MEMBERS = 10;

type StackRow = {
  id: string;
  label: string;
  kind: string;
  mirror_mode: string;
  created_at: number;
  updated_at: number;
};
type MemberRow = { stack_id: string; harness_id: string; position: number };
type LimitRow = {
  harness_id: string;
  model: string;
  reason: string;
  source: string;
  message: string | null;
  exhausted_until_ms: number;
  updated_at: number;
};

function resolveHarness(id: string): Harness | null {
  return harnesses.getByIdOrKind(id);
}

/**
 * The sub-fields of a harness that determine its on-disk config root. `env`
 * is optional so a caller may pass a `{ home }`-only fixture.
 */
export type HarnessHomeSource = HarnessRootSource;

// One resolver per kind, shared with the spawn (`harnessEnv`), capability
// discovery and the usage tracker: harness-config-root.ts. Re-exported here
// for the mirror and transcript-transfer importers.
export { claudeConfigDirFor, claudeJsonDirFor, codexHomeFor } from "./harness-config-root.ts";

/** The per-kind config root a mirror/session copy reads and writes. */
export function effectiveHome(harness: Pick<Harness, "kind" | "home" | "env">): string {
  return harness.kind === "claude-code" ? claudeConfigDirFor(harness) : codexHomeFor(harness);
}

/** Resolve `~` and make the path absolute without requiring it to exist. */
export function expandHomePath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/** A comparable home: realpath when it exists, else the expanded path. */
function comparableHome(p: string): string {
  const expanded = expandHomePath(p);
  try {
    return realpathSync(expanded);
  } catch {
    return path.resolve(expanded);
  }
}

function isV1Kind(kind: string): kind is HarnessStackKind {
  return (HARNESS_STACK_KINDS as readonly string[]).includes(kind);
}

/**
 * Env prefixes whose credentials a given harness kind can actually use. A
 * stray `GITHUB_TOKEN` in Agetor's process env must not make every Claude
 * account look logged in, and a Bedrock `AWS_*` key must.
 */
const KIND_AUTH_ENV_PREFIXES: Record<HarnessStackKind, readonly string[]> = {
  "claude-code": ["ANTHROPIC", "CLAUDE"],
  codex: ["OPENAI", "CODEX", "AZURE", "AWS", "BEDROCK"],
};

/** Env settings that select a login we cannot verify from a file: a cloud
 *  (Bedrock/Vertex/Foundry), a gateway, or a custom provider. Their presence
 *  means "unknown", never "logged out". Kind-scoped so a process-level
 *  `OPENAI_BASE_URL` cannot suppress Claude's evidence (or the reverse). */
const UNINSPECTABLE_LOGIN_ENV_KEYS: Record<HarnessStackKind, readonly string[]> = {
  "claude-code": [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
  ],
  codex: ["OPENAI_BASE_URL", "CODEX_BASE_URL", "OPENAI_API_BASE"],
};

/** Cloud-provider credential prefixes. They are Claude login evidence only
 *  when a provider selector (`CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` /
 *  `_FOUNDRY`) is truthy in the same scope, and then the evidence is
 *  "unknown", never "logged in": an `AWS_*` key left over from the user's
 *  other tooling says nothing about Claude (finding 10). */
const CLAUDE_CLOUD_AUTH_PREFIXES: readonly string[] = ["AWS", "BEDROCK", "AZURE", "VERTEX", "GOOGLE_APPLICATION"];
const CLAUDE_PROVIDER_SELECTORS: readonly string[] = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

const MAX_LOGIN_EVIDENCE_BYTES = 1024 * 1024;

function truthyEnvValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  return value !== undefined && value !== null && value !== false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasKindAuthKey(env: Record<string, unknown>, kind: HarnessStackKind): boolean {
  const prefixes = KIND_AUTH_ENV_PREFIXES[kind];
  return Object.entries(env).some(
    ([key, value]) =>
      truthyEnvValue(value)
      && isHarnessAuthEnvKey(key)
      && prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}_`)),
  );
}

/** The first cloud credential key of `env` when a Claude provider selector is
 *  truthy in the same `env`; null otherwise (selector absent: the key is
 *  ignored). */
function claudeCloudKeyUnderSelector(env: Record<string, unknown>): string | null {
  if (!CLAUDE_PROVIDER_SELECTORS.some((key) => truthyEnvValue(env[key]))) return null;
  const keys = Object.keys(env)
    .filter(
      (key) =>
        truthyEnvValue(env[key])
        && isHarnessAuthEnvKey(key)
        && CLAUDE_CLOUD_AUTH_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix}_`)),
    )
    .sort();
  return keys[0] ?? null;
}

function hasUninspectableLogin(env: Record<string, unknown>, kind: HarnessStackKind): boolean {
  return UNINSPECTABLE_LOGIN_ENV_KEYS[kind].some((key) => truthyEnvValue(env[key]));
}

/** True when *anything* exists at `p` (a regular file, a symlink, a FIFO…).
 *  Used to tell "the file is absent" from "the file is present but Agetor
 *  cannot inspect it": the latter must fail open, never read as logged out. */
function pathExistsNoFollow(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Read a small config file through the same no-follow/non-blocking rule the
 *  rest of the account-file readers use (`readAccountFileText`): an agent can
 *  rewrite `settings.json`/`config.toml`, so a planted symlink or FIFO must not
 *  be read under Agetor's identity or block the core. */
function readTextFile(p: string, maxBytes = MAX_LOGIN_EVIDENCE_BYTES): string | null {
  try {
    return readAccountFileText(p, maxBytes);
  } catch {
    return null;
  }
}

function readJsonObject(p: string): Record<string, unknown> | null {
  const text = readTextFile(p);
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** Outcome of an existence-only keychain lookup: found, not found, or
 *  unknown (any error, a timeout, a locked keychain). A probe may answer
 *  synchronously (test fixtures) or with a promise (the real `security`
 *  lookup, which never runs on the main thread's critical path). */
export type KeychainProbe = (service: string) => boolean | null | Promise<boolean | null>;

/** Runs `argv` and reports how it ended: its exit code, or null when it was
 *  killed (the timeout) or could not start. The real one is `coreSpawn`. */
export type SecurityRunner = (argv: string[], timeoutMs: number) => Promise<number | null>;

const KEYCHAIN_PROBE_TIMEOUT_MS = 2_000;
const KEYCHAIN_PROBE_CACHE_MS = 60_000;
/** `security` exits 44 (errSecItemNotFound) when no item has the service. */
const SECURITY_ITEM_NOT_FOUND = 44;
const SECURITY_BIN = "/usr/bin/security";

/** The real runner: `coreSpawn` (disclaimed, scrubbed env), all output
 *  discarded, killed after `timeoutMs`. Never throws. Exported for its own
 *  test only (it runs any argv; production passes it nothing but
 *  `/usr/bin/security`). */
export async function runSecurity(argv: string[], timeoutMs: number): Promise<number | null> {
  let proc: ReturnType<typeof coreSpawn>;
  try {
    proc = coreSpawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: childEnv() });
  } catch {
    return null;
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch { /* already gone */ }
  }, timeoutMs);
  try {
    const code = await proc.exited;
    if (timedOut || proc.signalCode) return null;
    return typeof code === "number" ? code : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the macOS keychain whether a generic-password item with this service
 * exists. Existence only: no `-w`/`-g`, so the secret is never read (and no
 * keychain ACL prompt can appear), and all output is discarded. The absolute
 * `/usr/bin/security` keeps a binary an agent planted on PATH out of it.
 * Exit 0 = found, 44 (errSecItemNotFound) = not found, anything else
 * (a locked keychain, a timeout, a spawn failure) = unknown.
 */
export async function securityItemExists(
  service: string,
  run: SecurityRunner = runSecurity,
): Promise<boolean | null> {
  try {
    const code = await run([SECURITY_BIN, "find-generic-password", "-s", service], KEYCHAIN_PROBE_TIMEOUT_MS);
    if (code === 0) return true;
    if (code === SECURITY_ITEM_NOT_FOUND) return false;
    return null;
  } catch {
    return null;
  }
}

let loginEvidencePlatform: NodeJS.Platform | null = null;
let securityRunner: SecurityRunner | null = null;

/** Under `bun test` the real keychain is never consulted: a test that does
 *  not inject a probe (or a runner) sees "no item", which keeps a
 *  credential-less fixture account logged out exactly as on Linux. An
 *  injected runner exercises the real argv and exit-code mapping. */
function defaultKeychainProbe(service: string): boolean | null | Promise<boolean | null> {
  if (securityRunner) return securityItemExists(service, securityRunner);
  if (process.env.NODE_ENV === "test") return false;
  return securityItemExists(service);
}

let keychainProbe: KeychainProbe = defaultKeychainProbe;
const keychainProbeCache = new Map<string, { value: boolean | null; at: number }>();
/** One lookup in flight per service (single-flight). */
const keychainProbeInFlight = new Map<string, Promise<void>>();
/** Bumped by the test seam so a lookup started under an old seam can never
 *  write into the fresh cache. */
let keychainProbeGeneration = 0;

/** Test seam: pin the platform, the keychain probe and/or the `security`
 *  runner (null restores the defaults). Always clears the probe cache and
 *  forgets in-flight lookups. */
export function setLoginEvidenceDepsForTests(
  deps: { platform?: NodeJS.Platform; keychainProbe?: KeychainProbe; securityRunner?: SecurityRunner } | null,
): void {
  loginEvidencePlatform = deps?.platform ?? null;
  keychainProbe = deps?.keychainProbe ?? defaultKeychainProbe;
  securityRunner = deps?.securityRunner ?? null;
  keychainProbeCache.clear();
  keychainProbeInFlight.clear();
  keychainProbeGeneration++;
}

/** Test seam: resolves once every keychain lookup in flight has landed in
 *  the cache. */
export async function settleKeychainProbesForTests(): Promise<void> {
  while (keychainProbeInFlight.size > 0) {
    await Promise.all([...keychainProbeInFlight.values()]);
  }
}

/** Start a background lookup for `service` unless one is already running. */
function refreshKeychainProbe(service: string, result: Promise<boolean | null>): void {
  const generation = keychainProbeGeneration;
  const flight = result
    .catch(() => null)
    .then((value) => {
      if (generation !== keychainProbeGeneration) return;
      keychainProbeCache.set(service, { value, at: Date.now() });
    })
    .finally(() => {
      if (keychainProbeInFlight.get(service) === flight) keychainProbeInFlight.delete(service);
    });
  keychainProbeInFlight.set(service, flight);
}

/**
 * The keychain answer for `service` without ever blocking the caller: a fresh
 * cached answer is returned as is. Otherwise a lookup is started in the
 * background (one per service at a time) and the caller gets the stale
 * cached answer, or null (unknown, which never skips an account) when there
 * is none. A probe that answers synchronously (a test fixture) is cached and
 * returned at once.
 */
function cachedKeychainProbe(service: string, now = Date.now()): boolean | null {
  const hit = keychainProbeCache.get(service);
  if (hit && now - hit.at < KEYCHAIN_PROBE_CACHE_MS) return hit.value;
  if (keychainProbeInFlight.has(service)) return hit?.value ?? null;
  let answer: boolean | null | Promise<boolean | null>;
  try {
    answer = keychainProbe(service);
  } catch {
    answer = null;
  }
  if (answer instanceof Promise) {
    refreshKeychainProbe(service, answer);
    return hit?.value ?? null;
  }
  keychainProbeCache.set(service, { value: answer, at: now });
  return answer;
}

/**
 * The macOS keychain service Claude Code stores a `CLAUDE_CONFIG_DIR`
 * account's OAuth login under: `Claude Code-credentials-<first 8 hex of
 * sha256(dir)>`, hashing the env value exactly as the CLI receives it (NFC,
 * no resolve, a trailing slash changes it; verified against claude 2.1.319).
 * A `CLAUDE_SECURESTORAGE_CONFIG_DIR` the spawn sees replaces the hashed dir;
 * set but empty, it selects the unsuffixed default item, which cannot be
 * attributed to this account, so the result is null (unknown).
 */
export function claudeKeychainServiceFor(harness: HarnessRootSource, configDir: string): string | null {
  const secure = harness.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const source = secure !== undefined ? secure : configDir;
  if (!source) return null;
  const hash = createHash("sha256").update(source.normalize("NFC")).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

/** Login evidence for a member: `true`/`false` when the kind has a check,
 *  `null` when it can't be known (the built-in Claude keychain item, a failed
 *  keychain lookup, a Codex keyring login, or a Bedrock/Vertex/custom-provider
 *  setup whose credential source is not a file under the account's config
 *  root). Only an explicit `false` skips a member.
 *
 *  On macOS a pinned Claude config dir with no `.credentials.json` is decided
 *  by an existence-only keychain lookup (`claudeKeychainEvidence`); the CLI
 *  keeps such a login there and writes no file. The lookup is an async
 *  `security` spawn that never blocks this call: the answer is read from a
 *  per-service cache (fresh for a minute), and a miss or a stale entry starts
 *  one background refresh per service and returns the stale answer, or null
 *  (unknown, which never skips an account) until the first lookup lands. Its
 *  readers are the stack list/create/update warnings (`GET /harnesses`) and
 *  the failover planner's member check.
 *
 *  The account's own `settings.json` `env` block, its `harness.env` map and
 *  Agetor's process env are login sources exactly like `.credentials.json`: a
 *  stack used to refuse such an account as "not logged in" (review R15-M1),
 *  which blocked both a manual Run and failover for a supported configuration.
 *  Cloud/custom-provider accounts fail open for the same reason, including
 *  when the selector is process-level and inherited by every spawn (M1). */
export function loginEvidence(harness: Harness): boolean | null {
  const harnessEnv = (harness.env ?? {}) as Record<string, unknown>;
  // Agetor's own process environment is inherited by every spawn and cannot be
  // overridden by `harnessEnv` for these selectors, so a process-level
  // Bedrock/Vertex/Foundry/gateway/custom-endpoint setting makes the account's
  // login unverifiable exactly like one in `settings.json`/`harness.env`
  // (review M1). Ignoring it read a working cloud account as logged out.
  const processEnv = process.env as Record<string, unknown>;
  if (harness.kind === "claude-code") {
    // With no `CLAUDE_CONFIG_DIR` (the built-in account, or an env-map `HOME`
    // alone) the login is the unsuffixed keychain item shared with the user's
    // own claude, so it cannot be attributed: unknown. A home, an env
    // `CLAUDE_CONFIG_DIR`, or a process-level one (which the built-in
    // inherits) pins the config root the CLI reads (see `claudeConfigDirFor`).
    const configDir = claudeConfigDirEnvFor(harness);
    if (!configDir) return null;
    // Presence, not regular-file-ness: a user may legitimately symlink the
    // credential file (a shared keychain file, a dotfiles manager). Counting
    // only a regular file read a working account as logged out and skipped it
    // (R17-S2); the file is never opened here, so a symlink/FIFO is harmless.
    if (pathExistsNoFollow(path.join(configDir, ".credentials.json"))) return true;
    // The harness's own env map is layered onto every spawn, and Agetor's
    // process env is inherited by every account (the stack warning calls that
    // out), so either is real login evidence.
    if (hasKindAuthKey(harnessEnv, "claude-code")) return true;
    if (hasKindAuthKey(processEnv, "claude-code")) return true;
    // A cloud key under a selector in the same scope is a login the file check
    // cannot verify: unknown. Without a selector it is ignored.
    if (claudeCloudKeyUnderSelector(harnessEnv) || claudeCloudKeyUnderSelector(processEnv)) return null;
    const settingsPath = path.join(configDir, "settings.json");
    const settings = readJsonObject(settingsPath);
    if (settings) {
      const settingsEnv = isPlainObject(settings.env) ? settings.env : {};
      if (hasKindAuthKey(settingsEnv, "claude-code")) return true;
      if (claudeCloudKeyUnderSelector(settingsEnv)) return null;
      // `apiKeyHelper` / `forceLoginOrgUUID` / `awsCredentialExport` /
      // `awsAuthRefresh` / `gcpAuthRefresh` produce or select a credential at
      // run time — a login the file check cannot see.
      if (isLoginBearingSettingsKeyIn(settings)) return true;
      if (hasUninspectableLogin({ ...settingsEnv, ...harnessEnv, ...processEnv }, "claude-code")) return null;
    } else if (pathExistsNoFollow(settingsPath)) {
      // Present but unreadable/not a JSON object (a symlink, FIFO, oversized
      // or malformed file): cannot decide, so never report a working account
      // as logged out.
      return null;
    } else if (hasUninspectableLogin({ ...harnessEnv, ...processEnv }, "claude-code")) {
      return null;
    }
    return claudeKeychainEvidence(harness, configDir);
  }
  if (harness.kind === "codex") {
    const configPath = path.join(codexHomeFor(harness), "config.toml");
    // Same rule as Claude's credential file (R17-S2): an existing symlinked
    // `auth.json` is real login evidence, never "logged out".
    if (pathExistsNoFollow(path.join(codexHomeFor(harness), "auth.json"))) return true;
    if (hasKindAuthKey(harnessEnv, "codex")) return true;
    if (hasKindAuthKey(processEnv, "codex")) return true;
    const config = readTextFile(configPath);
    if (config !== null) {
      try {
        const parsed = Bun.TOML.parse(config) as Record<string, unknown>;
        // A custom `model_provider` (or any `[model_providers.*]` table) may
        // authenticate through its own env key, helper or cloud login; there
        // is no auth file to inspect, so fail open.
        if (parsed.model_provider !== undefined || isPlainObject(parsed.model_providers)) return null;
        // `keyring` keeps the login in the OS keychain instead of `auth.json`,
        // and `auto` does whenever a keychain is available. Its item is keyed
        // by an account Agetor cannot attribute reliably, so the login is
        // unknown, never "logged out" (review S19).
        const store = parsed.cli_auth_credentials_store;
        if (store === "keyring" || store === "auto") return null;
      } catch {
        // An unparseable config is not proof of a missing login.
        return null;
      }
    } else if (pathExistsNoFollow(configPath)) {
      // Present but unreadable/oversized (or a symlink/FIFO the no-follow
      // reader refuses): a `config.toml` that might select a provider must not
      // read as logged out (review nit).
      return null;
    }
    // A process-level selector (`OPENAI_BASE_URL`, ...) applies to every Codex
    // spawn just like one in `config.toml` does (review M1).
    if (hasUninspectableLogin({ ...harnessEnv, ...processEnv }, "codex")) return null;
    return false;
  }
  return null;
}

/**
 * The last word on a pinned Claude config dir with no file/env/settings
 * login: on macOS, Claude Code keeps a `CLAUDE_CONFIG_DIR` account's OAuth
 * login in the keychain and writes no `.credentials.json` at all (review B1),
 * so the item's existence decides. Elsewhere the credential file is the
 * login, and its absence means logged out.
 */
function claudeKeychainEvidence(harness: Harness, configDir: string): boolean | null {
  const platform = loginEvidencePlatform ?? process.platform;
  if (platform !== "darwin") return false;
  const service = claudeKeychainServiceFor(harness, configDir);
  if (!service) return null;
  return cachedKeychainProbe(service);
}

function isLoginBearingSettingsKeyIn(settings: Record<string, unknown>): boolean {
  return Object.keys(settings).some((key) => isLoginBearingSettingsKey(key) && truthyEnvValue(settings[key]));
}

function isInstalled(harness: Harness): boolean {
  const bin = resolveBin(harness);
  if (path.isAbsolute(bin)) return existsSync(bin);
  return Bun.which(bin, { PATH: process.env.PATH }) !== null;
}

/** Exported for the failover planner (cheap cached-install check). */
export function memberInstalled(harness: Harness): boolean {
  return isInstalled(harness);
}

/** The process-level credentials a stack of this kind inherits on every spawn.
 *  `harnessEnv` only overrides the home/config-dir vars, so an
 *  `AWS_SECRET_ACCESS_KEY` (Bedrock) or `AZURE_OPENAI_API_KEY` in Agetor's own
 *  environment makes every account the same login just as `ANTHROPIC_API_KEY`
 *  does — warning on five enumerated names missed it (review R15-S2). Uses the
 *  same kind-scoped prefixes as login evidence, so a stray `GITHUB_TOKEN` does
 *  not warn about a provider the kind never reads. */
function processProviderKeyFor(kind: HarnessStackKind): string | null {
  if (kind === "claude-code") {
    const direct = directProviderKey(kind);
    if (direct) return direct;
    return claudeCloudKeyUnderSelector(process.env as Record<string, unknown>);
  }
  return directProviderKey(kind);
}

function directProviderKey(kind: HarnessStackKind): string | null {
  const prefixes = KIND_AUTH_ENV_PREFIXES[kind];
  const keys = Object.keys(process.env)
    .filter(
      (key) =>
        truthyEnvValue(process.env[key])
        && isHarnessAuthEnvKey(key)
        && prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}_`)),
    )
    .sort();
  return keys[0] ?? null;
}

/** Per-harness catalog kinds (mirrors `modelsForHarness` in
 *  model-discovery.ts); every other kind, Claude included, has one kind-level
 *  catalog, so the per-harness list is always empty for it. */
const PER_HARNESS_CATALOG_KINDS: ReadonlySet<string> = new Set(["fx", "codex", "opencode"]);

function modelCatalogFor(harness: Harness): string[] {
  const models = PER_HARNESS_CATALOG_KINDS.has(harness.kind)
    ? getHarnessDiscoveredModels(harness.id)
    : getDiscoveredModels(harness.kind);
  return models.map((m) => m.id);
}

function stackRows(): StackRow[] {
  return db.query<StackRow, []>(`SELECT * FROM harness_stacks ORDER BY created_at ASC`).all();
}

function memberRows(stackId?: string): MemberRow[] {
  return stackId
    ? db
        .query<MemberRow, [string]>(
          `SELECT * FROM harness_stack_members WHERE stack_id = ? ORDER BY position ASC`,
        )
        .all(stackId)
    : db.query<MemberRow, []>(`SELECT * FROM harness_stack_members ORDER BY stack_id ASC, position ASC`).all();
}

/**
 * Map a stored membership row to its API shape. `position` is the caller's
 * contiguous rank, NOT the stored `harness_stack_members.position`: deleting
 * an account used to drop its row through a foreign-key cascade and leave a
 * gap in the stored ranks (`0, 2`; `harnesses.delete` now deletes and
 * renumbers explicitly, migration 085), which used to surface as an impossible "3/2" in the swap divider
 * and the card badge (review R13-M1). Deriving it from the surviving order
 * keeps every reader correct even against a database written before the
 * renumber-on-delete fix.
 */
function toMember(row: MemberRow, position: number): HarnessStackMember | null {
  const harness = resolveHarness(row.harness_id);
  if (!harness) return null;
  if (!isV1Kind(harness.kind)) return null;
  return {
    harnessId: harness.id,
    position,
    label: harness.label,
    kind: harness.kind,
    enabled: harness.enabled,
  };
}

function stackWarnings(members: HarnessStackMember[], mirrorMode: HarnessMirrorMode, kind: HarnessStackKind): HarnessStackWarning[] {
  const warnings: HarnessStackWarning[] = [];
  if (members.length < 2) {
    warnings.push({ code: "too-few-members", message: "A stack needs at least two accounts to fail over." });
  }
  if (members.length > MAX_MEMBERS) {
    warnings.push({ code: "too-many-members", message: `More than ${MAX_MEMBERS} accounts makes the train hard to reason about.` });
  }
  const processKey = processProviderKeyFor(kind);
  if (processKey) {
    warnings.push({
      code: "process-provider-key",
      message: `Agetor's own environment carries ${processKey}; every account inherits it, so a swap may not change the effective login.`,
    });
  }
  if (mirrorMode === "full") {
    warnings.push({
      code: "full-mirror-hooks",
      message: "Full mirror copies settings hooks, permissions, status line and helper commands (Codex: notify) onto every backup.",
    });
  }
  for (const member of members) {
    if (!member.enabled) {
      warnings.push({ code: "member-disabled", harnessId: member.harnessId, message: `${member.label} is disabled.` });
      continue;
    }
    const harness = resolveHarness(member.harnessId);
    if (!harness) continue;
    if (!isInstalled(harness)) {
      warnings.push({ code: "member-not-installed", harnessId: member.harnessId, message: `${member.label}'s CLI is not installed.` });
    }
    if (loginEvidence(harness) === false) {
      warnings.push({ code: "member-logged-out", harnessId: member.harnessId, message: `${member.label} is not logged in.` });
    }
    if (modelCatalogFor(harness).length === 0) {
      warnings.push({ code: "member-model-catalog-empty", harnessId: member.harnessId, message: `${member.label}'s model catalog is empty or not discovered yet.` });
    }
  }
  return warnings;
}

/**
 * Map a stored stack to its API shape. `warnings` (install probe, login
 * evidence with its keychain lookup, the model catalog) are computed only when
 * asked for: by `list()`, `get(id, { warnings: true })` and the create/update
 * results. The runtime readers (`get`, `getByMember`, `resolveForTask`, used
 * on every swap, retry, start and send) get `warnings: []` and stay a plain
 * database read (review C6).
 */
function toStack(row: StackRow, opts: { warnings?: boolean } = {}): HarnessStack {
  const kind = isV1Kind(row.kind) ? row.kind : "claude-code";
  const mirrorMode: HarnessMirrorMode = row.mirror_mode === "safe" ? "safe" : "full";
  // Re-rank from the surviving order: dropping an unresolvable row (or a gap
  // a pre-085 cascade delete left in the stored rank) must not shift
  // the displayed position away from the array index every consumer
  // (`pickNextMember`, the notice, the badge) reads.
  const members: HarnessStackMember[] = [];
  for (const membership of memberRows(row.id)) {
    const member = toMember(membership, members.length);
    if (member) members.push(member);
  }
  return {
    id: row.id,
    label: row.label,
    kind,
    mirrorMode,
    members,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    warnings: opts.warnings ? stackWarnings(members, mirrorMode, kind) : [],
  };
}

function normalizeLabel(raw: unknown): string {
  if (typeof raw !== "string") throw new StackInputError("label is required");
  const label = raw.trim();
  if (!label) throw new StackInputError("label is required");
  if (label.length > 80) throw new StackInputError("label is too long (max 80)");
  return label;
}

/** A hard input error carrying user-facing blockers. */
/** An edit carried an `expectedUpdatedAt` that no longer matches the stored
 *  stack (another client saved first). `current` is the stored stack; the
 *  field is not called `stack` because `Error.stack` is a string. */
export class StackChangedError extends Error {
  readonly current: HarnessStack;
  constructor(current: HarnessStack) {
    super("the stack changed since it was loaded");
    this.name = "StackChangedError";
    this.current = current;
  }
}

export class StackInputError extends Error {
  readonly blockers: HarnessStackWarning[];
  constructor(message: string, blockers: HarnessStackWarning[] = [{ code: "invalid", message }]) {
    super(message);
    this.name = "StackInputError";
    this.blockers = blockers;
  }
}

export interface StackValidation {
  blockers: HarnessStackWarning[];
  warnings: HarnessStackWarning[];
  /** Resolved ordered harness rows, when the draft has no blocker. */
  harnesses: Harness[];
}

/**
 * Validate a create/edit draft. Blockers prevent a save; warnings are shown
 * and saved. `stackId` is the stack being edited, so its own members aren't
 * treated as a second membership.
 */
export function validateInput(input: HarnessStackInput, stackId?: string): StackValidation {
  const blockers: HarnessStackWarning[] = [];
  if (!isV1Kind(input.kind)) {
    return {
      blockers: [{ code: "unsupported-kind", message: `Stacks support ${HARNESS_STACK_KINDS.join(" and ")} only.` }],
      warnings: [],
      harnesses: [],
    };
  }
  if (!Array.isArray(input.members)) {
    return { blockers: [{ code: "invalid-members", message: "members must be an array of harness ids" }], warnings: [], harnesses: [] };
  }
  const ids = input.members;
  if (ids.length === 0) {
    blockers.push({ code: "no-members", message: "Add at least one account." });
  }
  if (new Set(ids).size !== ids.length) {
    blockers.push({ code: "duplicate-member", message: "An account can appear only once in a stack." });
  }
  const rows: Harness[] = [];
  const homes = new Map<string, string>();
  for (const id of ids) {
    if (typeof id !== "string" || !id) {
      blockers.push({ code: "invalid-member", message: "member ids must be non-empty strings" });
      continue;
    }
    const harness = resolveHarness(id);
    if (!harness) {
      blockers.push({ code: "unknown-harness", harnessId: id, message: `unknown account "${id}"` });
      continue;
    }
    const harnessKind = harness.kind;
    if (harnessKind !== "claude-code" && harnessKind !== "codex") {
      blockers.push({ code: "unsupported-kind", harnessId: id, message: `${harness.label} is a ${harness.kind} account; stacks support ${HARNESS_STACK_KINDS.join(" and ")} only.` });
      continue;
    }
    if (harness.kind !== input.kind) {
      blockers.push({ code: "mixed-kinds", harnessId: id, message: `${harness.label} is a ${harness.kind} account; this stack is ${input.kind}.` });
    }
    const home = comparableHome(effectiveHome(harness));
    const clash = homes.get(home);
    if (clash) {
      blockers.push({ code: "same-home", harnessId: id, message: `${harness.label} and ${clash} share the same config directory.` });
    } else {
      homes.set(home, harness.label);
    }
    const existing = db
      .query<{ stack_id: string }, [string]>(
        `SELECT stack_id FROM harness_stack_members WHERE harness_id = ?`,
      )
      .get(id);
    if (existing && existing.stack_id !== stackId) {
      blockers.push({ code: "already-in-stack", harnessId: id, message: `${harness.label} is already in another stack.` });
    }
    rows.push(harness);
  }
  const mirrorMode: HarnessMirrorMode = input.mirrorMode === "safe" ? "safe" : "full";
  const members: HarnessStackMember[] = rows.map((h, i) => ({
    harnessId: h.id,
    position: i,
    label: h.label,
    kind: h.kind === "claude-code" ? "claude-code" : "codex",
    enabled: h.enabled,
  }));
  const warnings = stackWarnings(members, mirrorMode, input.kind);
  return { blockers, warnings, harnesses: rows };
}

function memberIdsOf(stackId: string): string[] {
  return memberRows(stackId).map((m) => m.harness_id);
}

export const harnessStacks = {
  /** Every stack, with its warnings (the Settings/CLI listing). */
  list(): HarnessStack[] {
    return stackRows().map((row) => toStack(row, { warnings: true }));
  },
  /** One stack. `warnings` stays `[]` unless `{ warnings: true }` is passed:
   *  the runtime reads this on every swap and must not probe accounts. */
  get(id: string, opts: { warnings?: boolean } = {}): HarnessStack | null {
    const row = db.query<StackRow, [string]>(`SELECT * FROM harness_stacks WHERE id = ?`).get(id);
    return row ? toStack(row, opts) : null;
  },
  /** The stack an account belongs to, or null. */
  getByMember(harnessId: string): HarnessStack | null {
    const row = db
      .query<{ stack_id: string }, [string]>(
        `SELECT stack_id FROM harness_stack_members WHERE harness_id = ?`,
      )
      .get(harnessId);
    return row ? this.get(row.stack_id) : null;
  },
  /** Create a stack and its ordered memberships in one transaction. The
   *  result carries the draft's warnings. */
  create(input: HarnessStackInput): HarnessStack {
    const label = normalizeLabel(input.label);
    const validation = validateInput({ ...input, label });
    if (validation.blockers.length > 0) throw new StackInputError(validation.blockers[0]!.message, validation.blockers);
    const id = randomUUID();
    const now = Date.now();
    db.transaction(() => {
      db.run(
        `INSERT INTO harness_stacks (id, label, kind, mirror_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, label, input.kind, input.mirrorMode === "safe" ? "safe" : "full", now, now],
      );
      input.members.forEach((harnessId, position) => {
        db.run(
          `INSERT INTO harness_stack_members (stack_id, harness_id, position) VALUES (?, ?, ?)`,
          [id, harnessId, position],
        );
      });
    })();
    return { ...(this.get(id) as HarnessStack), warnings: validation.warnings };
  },
  /**
   * Edit a stack. The result carries the edited stack's warnings. `members` defines the FULL ordered list; omit it to keep
   * membership and order. Reorders are applied inside one transaction so
   * `UNIQUE(stack_id, position)` never sees a transient duplicate.
   */
  update(id: string, patch: Partial<HarnessStackInput>): HarnessStack {
    const current = this.get(id);
    if (!current) throw new StackInputError(`stack not found: ${id}`);
    // Fast path so a stale draft reports the conflict, not a validation error
    // about its own stale content; the authoritative check is in the
    // transaction below.
    if (patch.expectedUpdatedAt !== undefined && patch.expectedUpdatedAt !== current.updatedAt) {
      throw new StackChangedError(current);
    }
    const label = patch.label === undefined ? current.label : normalizeLabel(patch.label);
    const members = patch.members ?? memberIdsOf(id);
    const kind = patch.kind ?? current.kind;
    const mirrorMode = patch.mirrorMode ?? current.mirrorMode;
    const validation = validateInput({ label, kind, members, mirrorMode }, id);
    if (validation.blockers.length > 0) throw new StackInputError(validation.blockers[0]!.message, validation.blockers);
    const now = Date.now();
    db.transaction(() => {
      const stored = db
        .query<{ updated_at: number }, [string]>(`SELECT updated_at FROM harness_stacks WHERE id = ?`)
        .get(id);
      if (!stored) throw new StackInputError(`stack not found: ${id}`);
      if (patch.expectedUpdatedAt !== undefined && stored.updated_at !== patch.expectedUpdatedAt) {
        throw new StackChangedError(this.get(id) as HarnessStack);
      }
      // Strictly increasing, so two edits inside one millisecond still differ
      // and the second editor's `expectedUpdatedAt` conflicts.
      const stamp = Math.max(now, stored.updated_at + 1);
      db.run(
        `UPDATE harness_stacks SET label = ?, kind = ?, mirror_mode = ?, updated_at = ? WHERE id = ?`,
        [label, kind, mirrorMode === "safe" ? "safe" : "full", stamp, id],
      );
      db.run(`DELETE FROM harness_stack_members WHERE stack_id = ?`, [id]);
      members.forEach((harnessId, position) => {
        db.run(
          `INSERT INTO harness_stack_members (stack_id, harness_id, position) VALUES (?, ?, ?)`,
          [id, harnessId, position],
        );
      });
    })();
    return { ...(this.get(id) as HarnessStack), warnings: validation.warnings };
  },
  /**
   * Would saving `candidate` as harness `harnessId`'s home/env make it share a
   * config root with another member of its stack (or leave the stack's kind)?
   * Returns a user-facing error, or null when the edit is fine or the harness
   * is in no stack. `PATCH /harnesses/:id` calls it before saving a stack
   * member, since the same-root check at stack save cannot see a later edit
   * (review S5). Roots compare by realpath, falling back to `path.resolve`.
   */
  validateMemberRoot(
    harnessId: string,
    candidate: { kind: string; home: string | null; env?: Record<string, string> | null },
  ): string | null {
    const stack = this.getByMember(harnessId);
    if (!stack) return null;
    const self = resolveHarness(harnessId);
    const selfLabel = self?.label ?? harnessId;
    if (candidate.kind !== stack.kind) {
      return `${selfLabel} is in the ${stack.kind} stack "${stack.label}"; remove it from the stack before changing its kind.`;
    }
    const root = comparableHome(effectiveHome({
      kind: candidate.kind as Harness["kind"],
      home: candidate.home,
      env: candidate.env ?? {},
    }));
    for (const member of stack.members) {
      if (member.harnessId === harnessId || member.harnessId === self?.id) continue;
      const other = resolveHarness(member.harnessId);
      if (!other) continue;
      if (comparableHome(effectiveHome(other)) === root) {
        return `${selfLabel} would share its config directory with ${other.label} in the stack "${stack.label}"; every account in a stack needs its own.`;
      }
    }
    return null;
  },
  /** Delete a stack; its task failover state becomes inert. Cooldowns and
   *  copied session files stay account-scoped. */
  delete(id: string): void {
    const current = this.get(id);
    if (!current) return;
    db.transaction(() => {
      db.run(`DELETE FROM harness_stacks WHERE id = ?`, [id]);
      clearTaskStateForStack(id);
    })();
  },
  /** The stack a task belongs to. The CURRENT account's membership wins: an
   *  account edited into another stack must fail over (and run) inside that
   *  new train, not the recorded `harnessState.stackId`, or the next swap
   *  would transfer the conversation into the train the account left. The
   *  recorded stack is a fallback for an account removed from every stack
   *  mid-flight, so the task still resolves until the next move. */
  resolveForTask(task: Pick<Task, "id" | "agent" | "harnessState">): {
    stack: HarnessStack;
    current: string;
    position: number;
    orphaned: boolean;
  } | null {
    const memberStack = this.getByMember(task.agent);
    const stateStack = memberStack
      ? null
      : task.harnessState?.stackId
        ? this.get(task.harnessState.stackId)
        : null;
    const stack = memberStack ?? stateStack;
    if (!stack) return null;
    const index = stack.members.findIndex((m) => m.harnessId === task.agent);
    return {
      stack,
      current: task.agent,
      position: index < 0 ? 0 : index,
      orphaned: index < 0,
    };
  },
  /** Write (or replace) a cooldown row, keyed by (account, `signal.model ??
   *  ''`): an empty model is the whole account. A provider-reported reset is
   *  authoritative even when it is earlier than the stored one. A fallback
   *  (no reset time in the signal) must never SHORTEN a later provider reset
   *  that is still active on the same row — an API-error/rate-limit fallback
   *  arriving after a quota signal would otherwise unblock the account too
   *  early. Writes are also the safe place to sweep expired rows. */
  setLimitState(harnessId: string, signal: HarnessLimitSignal, now = Date.now()): HarnessLimitState {
    this.pruneExpired(now);
    const model = signal.model ? signal.model : "";
    const fallback = signal.reason === "rate_limit" ? HARNESS_RATE_LIMIT_COOLDOWN_MS : HARNESS_QUOTA_COOLDOWN_MS;
    const nextUntil = signal.resetAtMs ?? now + fallback;
    const existing = db
      .query<LimitRow, [string, string]>(`SELECT * FROM harness_limit_state WHERE harness_id = ? AND model = ?`)
      .get(harnessId, model);
    const exhaustedUntilMs = signal.resetAtMs === null
      && existing !== null
      && existing.exhausted_until_ms > nextUntil
      ? existing.exhausted_until_ms
      : nextUntil;
    db.run(
      `INSERT INTO harness_limit_state
         (harness_id, model, reason, source, message, exhausted_until_ms, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(harness_id, model) DO UPDATE SET
         reason = excluded.reason,
         source = excluded.source,
         message = excluded.message,
         exhausted_until_ms = excluded.exhausted_until_ms,
         updated_at = excluded.updated_at`,
      [harnessId, model, signal.reason, signal.source, signal.message || null, exhaustedUntilMs, now],
    );
    return {
      harnessId,
      reason: signal.reason,
      source: signal.source,
      message: signal.message || null,
      exhaustedUntilMs,
      updatedAt: now,
      model: model || null,
    };
  },
  /** The effective ACTIVE cooldown for a task on `opts.model`: the
   *  account-wide row and (when a model is given) that model's row, whichever
   *  expires later. Without `opts.model` only the account-wide row counts.
   *  Expired rows are ignored (`opts.now`, default the clock). Read-only. */
  getLimitState(harnessId: string, opts: { model?: string | null; now?: number } = {}): HarnessLimitState | null {
    const now = opts.now ?? Date.now();
    const model = opts.model ? opts.model : "";
    const rows = model
      ? db
          .query<LimitRow, [string, string]>(
            `SELECT * FROM harness_limit_state WHERE harness_id = ? AND model IN ('', ?)`,
          )
          .all(harnessId, model)
      : db
          .query<LimitRow, [string]>(`SELECT * FROM harness_limit_state WHERE harness_id = ? AND model = ''`)
          .all(harnessId);
    let best: LimitRow | null = null;
    for (const row of rows) {
      if (row.exhausted_until_ms <= now) continue;
      if (best === null || row.exhausted_until_ms > best.exhausted_until_ms) best = row;
    }
    return best ? toLimitState(best) : null;
  },
  /** Every ACTIVE row, account-wide and per-model, soonest reset first.
   *  `model` is null for an account-wide row. */
  listLimitStates(now = Date.now()): HarnessLimitState[] {
    // Read-only: a GET/poll must not DELETE. Expired rows are filtered out of
    // the payload; `pruneExpired` runs on boot and on every write.
    return db
      .query<LimitRow, []>(`SELECT * FROM harness_limit_state ORDER BY exhausted_until_ms ASC, harness_id ASC, model ASC`)
      .all()
      .map(toLimitState)
      .filter((state) => state.exhaustedUntilMs > now);
  },
  /** Clear cooldown rows of one account.
   *  - no opts: every row (the explicit "Clear cooldown" action);
   *  - `startedAtMs`: only rows written at or before it (a turn that started
   *    before the limit was recorded must not erase that limit), limited to
   *    the account-wide row and `opts.model`'s row;
   *  - `model` alone: that model's row only. */
  clearLimitState(harnessId: string, opts: { startedAtMs?: number; model?: string | null } = {}): void {
    const model = opts.model ? opts.model : "";
    if (opts.startedAtMs !== undefined) {
      db.run(
        `DELETE FROM harness_limit_state WHERE harness_id = ? AND updated_at <= ? AND model IN ('', ?)`,
        [harnessId, opts.startedAtMs, model],
      );
      return;
    }
    if (opts.model !== undefined) {
      db.run(`DELETE FROM harness_limit_state WHERE harness_id = ? AND model = ?`, [harnessId, model]);
      return;
    }
    db.run(`DELETE FROM harness_limit_state WHERE harness_id = ?`, [harnessId]);
  },
  pruneExpired(now = Date.now()): void {
    db.run(`DELETE FROM harness_limit_state WHERE exhausted_until_ms <= ?`, [now]);
  },
  isCooling(harnessId: string, now = Date.now(), model?: string | null): HarnessLimitState | null {
    return this.getLimitState(harnessId, { model, now });
  },
};

function toLimitState(row: LimitRow): HarnessLimitState {
  const reason: HarnessLimitReason =
    row.reason === "rate_limit" || row.reason === "insufficient_credits" ? row.reason : "quota";
  const source = row.source === "claude-pane" || row.source === "codex-error" ? row.source : "claude-api-error";
  return {
    harnessId: row.harness_id,
    reason,
    source,
    message: row.message,
    exhaustedUntilMs: row.exhausted_until_ms,
    updatedAt: row.updated_at,
    model: row.model ? row.model : null,
  };
}

/** Clear every task's harness state that names `stackId`, without bumping
 *  `updated_at` (see `tasks.setHarnessState`). */
export function clearTaskStateForStack(stackId: string): number {
  const rows = db
    .query<{ id: string }, []>(
      `SELECT id FROM tasks WHERE harness_state IS NOT NULL`,
    )
    .all();
  let cleared = 0;
  for (const row of rows) {
    const state = tasks.get(row.id)?.harnessState;
    if (state?.stackId !== stackId) continue;
    tasks.setHarnessState(row.id, null);
    cleared++;
  }
  return cleared;
}

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
import { randomUUID } from "node:crypto";
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
import { claudeConfigDirOverrideFor, codexHomeOverrideFor, resolveBin } from "./agents.ts";
import { getHarnessDiscoveredModels } from "./agent-discovery.ts";
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
export interface HarnessHomeSource {
  home: string | null;
  env?: Record<string, string> | null;
}

/**
 * The Claude config root for a harness (`CLAUDE_CONFIG_DIR` equivalent).
 *
 * The harness's own env map is authoritative when it pins
 * `CLAUDE_CONFIG_DIR`: `harnessEnv` (agents.ts) layers that map over the
 * home-derived value, so the CLI really reads there. Ignoring it here made the
 * mirror and the transcript transfer target the home-derived directory while
 * claude wrote to the env-pinned one (a swap then blocked on `no-session`).
 *
 * A home-less built-in inherits Agetor's own process env (`harnessEnv` writes
 * nothing for it), so a process-level `CLAUDE_CONFIG_DIR` is the account's
 * real root too. Resolve it here or mirror/transfer would read and write
 * `~/.claude` while the CLI uses the override (review R-S2).
 */
export function claudeConfigDirFor(harness: HarnessHomeSource): string {
  const pinned = claudeConfigDirOverrideFor(harness);
  if (pinned) return pinned;
  const fromProcess = process.env.CLAUDE_CONFIG_DIR;
  if (fromProcess && fromProcess.trim() !== "") return fromProcess;
  return path.join(homedir(), ".claude");
}

/**
 * The Codex state root for a harness (`CODEX_HOME`). Same precedence as
 * {@link claudeConfigDirFor}: the env map's own `CODEX_HOME` wins over the
 * home-derived `<home>/.codex`, and a home-less built-in falls back to the
 * process-level `CODEX_HOME` before `~/.codex` (review R-S2).
 */
export function codexHomeFor(harness: HarnessHomeSource): string {
  const pinned = codexHomeOverrideFor(harness);
  if (pinned) return pinned;
  const fromProcess = process.env.CODEX_HOME;
  if (fromProcess && fromProcess.trim() !== "") return fromProcess;
  return path.join(homedir(), ".codex");
}

/** The directory holding Claude's `.claude.json` blob. It lives directly in
 *  the account's config root when the harness pins one (`home`, an env
 *  `CLAUDE_CONFIG_DIR`, or the process-level override the built-in inherits);
 *  a built-in account keeps it in the real home, NOT in `~/.claude`. */
export function claudeJsonDirFor(harness: HarnessHomeSource): string {
  return claudeConfigDirOverrideFor(harness)
    ?? (process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim() !== ""
      ? process.env.CLAUDE_CONFIG_DIR
      : null)
    ?? homedir();
}

/** The per-kind config root a mirror/session copy reads and writes. */
export function effectiveHome(harness: Harness): string {
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
  "claude-code": ["ANTHROPIC", "CLAUDE", "AWS", "BEDROCK", "AZURE", "VERTEX_AI", "GOOGLE_APPLICATION"],
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

/** Login evidence for a member: `true`/`false` when the kind has a check,
 *  `null` when it can't be known cheaply (the built-in Claude keychain, or a
 *  Bedrock/Vertex/custom-provider setup whose credential source is not a file
 *  under the account's config root). Only an explicit `false` skips a member.
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
    // The built-in account uses the macOS keychain, so there is no file to
    // inspect. A home, an env `CLAUDE_CONFIG_DIR`, or a process-level
    // `CLAUDE_CONFIG_DIR` (which the built-in inherits) pins a file-based
    // config root — the same one the CLI reads (see `claudeConfigDirFor`).
    const configDir = claudeConfigDirOverrideFor(harness)
      ?? (process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim() !== ""
        ? process.env.CLAUDE_CONFIG_DIR
        : null);
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
    const settingsPath = path.join(configDir, "settings.json");
    const settings = readJsonObject(settingsPath);
    if (settings) {
      const settingsEnv = isPlainObject(settings.env) ? settings.env : {};
      if (hasKindAuthKey(settingsEnv, "claude-code")) return true;
      // `apiKeyHelper` / `awsCredentialExport` / `awsAuthRefresh` produce or
      // select a credential at run time — a login the file check cannot see.
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
    return false;
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

function modelCatalogFor(harness: Harness): string[] {
  return getHarnessDiscoveredModels(harness.id).map((m) => m.id);
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
 * an account cascades its row away and leaves a gap in the stored ranks
 * (`0, 2`), which used to surface as an impossible "3/2" in the swap divider
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
      message: "Full mirror copies user-level hooks and permissions onto every backup; use Safe mirror to skip them.",
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

function toStack(row: StackRow): HarnessStack {
  const kind = isV1Kind(row.kind) ? row.kind : "claude-code";
  const mirrorMode: HarnessMirrorMode = row.mirror_mode === "safe" ? "safe" : "full";
  // Re-rank from the surviving order: dropping an unresolvable row (or a
  // cascade-deleted account leaving a gap in the stored rank) must not shift
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
    warnings: stackWarnings(members, mirrorMode, kind),
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
  list(): HarnessStack[] {
    return stackRows().map(toStack);
  },
  get(id: string): HarnessStack | null {
    const row = db.query<StackRow, [string]>(`SELECT * FROM harness_stacks WHERE id = ?`).get(id);
    return row ? toStack(row) : null;
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
  /** Create a stack and its ordered memberships in one transaction. */
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
    return this.get(id) as HarnessStack;
  },
  /**
   * Edit a stack. `members` defines the FULL ordered list; omit it to keep
   * membership and order. Reorders are applied inside one transaction so
   * `UNIQUE(stack_id, position)` never sees a transient duplicate.
   */
  update(id: string, patch: Partial<HarnessStackInput>): HarnessStack {
    const current = this.get(id);
    if (!current) throw new StackInputError(`stack not found: ${id}`);
    const label = patch.label === undefined ? current.label : normalizeLabel(patch.label);
    const members = patch.members ?? memberIdsOf(id);
    const kind = patch.kind ?? current.kind;
    const mirrorMode = patch.mirrorMode ?? current.mirrorMode;
    const validation = validateInput({ label, kind, members, mirrorMode }, id);
    if (validation.blockers.length > 0) throw new StackInputError(validation.blockers[0]!.message, validation.blockers);
    const now = Date.now();
    db.transaction(() => {
      db.run(
        `UPDATE harness_stacks SET label = ?, kind = ?, mirror_mode = ?, updated_at = ? WHERE id = ?`,
        [label, kind, mirrorMode === "safe" ? "safe" : "full", now, id],
      );
      db.run(`DELETE FROM harness_stack_members WHERE stack_id = ?`, [id]);
      members.forEach((harnessId, position) => {
        db.run(
          `INSERT INTO harness_stack_members (stack_id, harness_id, position) VALUES (?, ?, ?)`,
          [id, harnessId, position],
        );
      });
    })();
    return this.get(id) as HarnessStack;
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
  /** Write (or replace) the account cooldown. A provider-reported reset is
   *  authoritative even when it is earlier than the stored one. A fallback
   *  (no reset time in the signal) must never SHORTEN a later provider reset
   *  that is still active — an API-error/rate-limit fallback arriving after a
   *  quota signal would otherwise unblock the account too early (review
   *  should-fix). Writes are also the safe place to sweep expired rows. */
  setLimitState(harnessId: string, signal: HarnessLimitSignal, now = Date.now()): HarnessLimitState {
    this.pruneExpired(now);
    const fallback = signal.reason === "rate_limit" ? HARNESS_RATE_LIMIT_COOLDOWN_MS : HARNESS_QUOTA_COOLDOWN_MS;
    const nextUntil = signal.resetAtMs ?? now + fallback;
    const existing = this.getLimitState(harnessId);
    const exhaustedUntilMs = signal.resetAtMs === null
      && existing !== null
      && existing.exhaustedUntilMs > nextUntil
      ? existing.exhaustedUntilMs
      : nextUntil;
    db.run(
      `INSERT INTO harness_limit_state
         (harness_id, reason, source, message, exhausted_until_ms, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(harness_id) DO UPDATE SET
         reason = excluded.reason,
         source = excluded.source,
         message = excluded.message,
         exhausted_until_ms = excluded.exhausted_until_ms,
         updated_at = excluded.updated_at`,
      [harnessId, signal.reason, signal.source, signal.message || null, exhaustedUntilMs, now],
    );
    return {
      harnessId,
      reason: signal.reason,
      source: signal.source,
      message: signal.message || null,
      exhaustedUntilMs,
      updatedAt: now,
    };
  },
  getLimitState(harnessId: string): HarnessLimitState | null {
    const row = db
      .query<LimitRow, [string]>(`SELECT * FROM harness_limit_state WHERE harness_id = ?`)
      .get(harnessId);
    return row ? toLimitState(row) : null;
  },
  listLimitStates(now = Date.now()): HarnessLimitState[] {
    // Read-only: a GET/poll must not DELETE. Expired rows are filtered out of
    // the payload; `pruneExpired` runs on boot and on every write below.
    return db
      .query<LimitRow, []>(`SELECT * FROM harness_limit_state ORDER BY exhausted_until_ms ASC`)
      .all()
      .map(toLimitState)
      .filter((state) => state.exhaustedUntilMs > now);
  },
  clearLimitState(harnessId: string): void {
    db.run(`DELETE FROM harness_limit_state WHERE harness_id = ?`, [harnessId]);
  },
  pruneExpired(now = Date.now()): void {
    db.run(`DELETE FROM harness_limit_state WHERE exhausted_until_ms <= ?`, [now]);
  },
  isCooling(harnessId: string, now = Date.now()): HarnessLimitState | null {
    const state = this.getLimitState(harnessId);
    return state && state.exhaustedUntilMs > now ? state : null;
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

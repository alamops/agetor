/**
 * The harness mirror (docs/architecture/harness-stacks.md, plan T04/D12).
 *
 * A stack mirrors user-level config from the primary (position 0) onto its
 * backups so a failover keeps the same skills, commands, MCP servers, plugins
 * and settings. Each account keeps its own login: harness credential files are
 * never copied, and the primary's provider env keys are stripped from a merged
 * `settings.json` while a backup's own key survives.
 *
 * Failures are warnings, never blocks: a task must still be able to fail over
 * when a mirror cannot read one directory.
 */
import { closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import path from "node:path";
import { openReadNoFollow } from "./no-follow.ts";
import {
  MIRROR_PAYLOAD_LIMITS,
  MIRROR_SPECS,
  SAFE_MODE_EXCLUDED_KEYS,
  isHarnessAuthEnvKey,
  isLoginBearingSettingsKey,
  isNeverCopyPath,
  type HarnessMirrorSpec,
} from "../shared/harness-mirror.ts";
import type { Harness, HarnessStack, HarnessStackKind } from "../shared/types.ts";
import {
  assertNotCredentialPath,
  atomicWriteFile,
  copyRegularFile,
  copyTreeCooperative,
  isPlainAncestorPathUnder,
  isPlainDir,
  isRegularFileNoFollow,
} from "./harness-file-transfer.ts";
import { claudeConfigDirFor, claudeJsonDirFor, codexHomeFor } from "./harness-stacks.ts";
import { harnesses } from "./db.ts";

export interface MirrorResult {
  copied: string[];
  warnings: string[];
}

export interface MirrorOptions {
  /** Swap: mirror only this destination account. */
  targetHarnessId?: string;
  /** Per-allowlist-entry copy budget override, used by tests to exercise the
   *  truncation/registry interaction without planting 25,000 files. Any tree
   *  without an entry keeps the defaults (`MIRROR_PAYLOAD_LIMITS`, then the
   *  generic transfer caps). */
  copyLimits?: Partial<Record<string, { maxBytes?: number; maxEntries?: number }>>;
}

/** The config root the kind's user-level files live under. */
function mirrorRootFor(harness: Harness): string {
  return harness.kind === "claude-code" ? claudeConfigDirFor(harness) : codexHomeFor(harness);
}

type TextRead =
  | { ok: true; text: string }
  /** The file genuinely does not exist (the only case a merge may treat as
   *  empty). */
  | { ok: false; missing: true }
  /** Present but unsafe/unreadable/oversized. A merge must leave it alone —
   *  treating this as `{}` would overwrite the user's real file with only the
   *  keys the primary supplies. */
  | { ok: false; missing: false; reason: string };

/**
 * Read a regular file without following a final-component symlink and without
 * reading more than `maxBytes`. The open itself enforces the type and the cap
 * (`O_NOFOLLOW`, `fstat` size), so there is no lstat→readFileSync window in
 * which an agent could swap in a symlink to a TCC-protected file or a huge
 * FIFO.
 */
function readTextIfRegular(p: string, maxBytes: number): TextRead {
  let fd: number;
  try {
    fd = openReadNoFollow(p, { maxBytes });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { ok: false, missing: true };
    return { ok: false, missing: false, reason: `${code ?? "read error"}: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    // Cap the read even if the file grows after the open; `readFileSync`
    // would follow it to EOF and defeat `maxBytes`.
    const size = Math.min(fstatSync(fd).size, maxBytes);
    const buf = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, read);
      if (n <= 0) break;
      read += n;
    }
    return { ok: true, text: buf.subarray(0, read).toString("utf8") };
  } catch (err) {
    return { ok: false, missing: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    closeSync(fd);
  }
}

/**
 * Mirror the stack's primary onto its backups. The primary is position 0 by
 * definition (the editor labels it "Primary"); a `targetHarnessId` mirrors only
 * that destination account (the swap path).
 */
export async function mirrorStack(
  stack: HarnessStack,
  opts: MirrorOptions,
): Promise<MirrorResult> {
  const copied: string[] = [];
  const warnings: string[] = [];
  const primaryMember = stack.members[0];
  if (!primaryMember) return { copied, warnings: ["stack has no primary account to mirror from"] };
  const primary = harnesses.getByIdOrKind(primaryMember.harnessId);
  if (!primary) return { copied, warnings: [`primary account ${primaryMember.harnessId} no longer exists`] };
  const kind = primary.kind;
  if (kind !== "claude-code" && kind !== "codex") {
    return { copied, warnings: [`${kind} accounts do not support mirroring in this version`] };
  }
  const spec = MIRROR_SPECS[kind];
  const targets = stack.members
    .filter((m) => m.harnessId !== primary.id)
    .filter((m) => opts.targetHarnessId === undefined || m.harnessId === opts.targetHarnessId);

  for (const member of targets) {
    const target = harnesses.getByIdOrKind(member.harnessId);
    if (!target) {
      warnings.push(`${member.label}: account no longer exists`);
      continue;
    }
    if (target.id === primary.id) continue;
    try {
      const one = await mirrorOne(primary, target, kind, spec, stack.mirrorMode === "safe", opts.copyLimits);
      copied.push(...one.copied.map((p) => `${target.id}:${p}`));
      warnings.push(...one.warnings.map((w) => `${target.label}: ${w}`));
    } catch (err) {
      warnings.push(`${target.label}: mirror failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { copied, warnings };
}

/** Mirror `targetHarnessId` from the stack's primary, if both exist. */
export async function mirrorForSwap(
  stack: HarnessStack,
  targetHarnessId: string,
): Promise<MirrorResult> {
  return mirrorStack(stack, { targetHarnessId });
}

async function mirrorOne(
  primary: Harness,
  target: Harness,
  kind: HarnessStackKind,
  spec: HarnessMirrorSpec,
  safe: boolean,
  copyLimits: MirrorOptions["copyLimits"],
): Promise<MirrorResult> {
  const copied: string[] = [];
  const warnings: string[] = [];
  const fromRoot = mirrorRootFor(primary);
  const toRoot = mirrorRootFor(target);
  if (path.resolve(fromRoot) === path.resolve(toRoot)) {
    return { copied, warnings: ["source and destination share a config directory"] };
  }

  // 1. Copy the allowlisted dirs/files verbatim FIRST, so the registry merge
  //    below can tell whether the payload it points at was copied completely.
  //    An incomplete payload plus a rewritten registry is worse than no
  //    registry: the CLI would resolve plugins to files that do not exist.
  const incompletePayloads = new Set<string>();
  for (const rel of spec.copy) {
    try {
      assertNotCredentialPath(rel, kind);
      if (safe && SAFE_MODE_EXCLUDED_KEYS.some((k) => rel === k || rel.startsWith(`${k}/`))) {
        warnings.push(`${rel}: not copied in safe mode`);
        continue;
      }
      const from = path.join(fromRoot, rel);
      const to = path.join(toRoot, rel);
      // A leaf `lstat` follows every parent, so a linked intermediate folder
      // (`plugins/` → outside the account) would hand back the target's
      // regular file. Refuse it before any stat/read.
      if (!isPlainAncestorPathUnder(fromRoot, from)) {
        warnings.push(`${rel}: symlinked parent directory refused`);
        incompletePayloads.add(rel);
        continue;
      }
      let st;
      try {
        st = lstatSync(from);
      } catch {
        continue; // not present on the primary
      }
      if (st.isSymbolicLink()) {
        warnings.push(`${rel}: symlink refused`);
        incompletePayloads.add(rel);
        continue;
      }
      if (st.isDirectory()) {
        if (!isPlainDir(from)) {
          warnings.push(`${rel}: not a plain directory`);
          incompletePayloads.add(rel);
          continue;
        }
        const result = await copyTreeCooperative(from, to, {
          // Plugin payload trees get their own (still bounded) budget; see
          // `MIRROR_PAYLOAD_LIMITS`.
          ...MIRROR_PAYLOAD_LIMITS[rel],
          ...copyLimits?.[rel],
          root: toRoot,
          skip: (child) => {
            // `child` is relative to `from` (e.g. "plugins"), but the
            // allowlist's never-copy entries are root-relative
            // ("plugins/store"). Check the full path or a nested store would
            // slip through.
            const rootRel = `${rel}/${child}`;
            try {
              assertNotCredentialPath(rootRel, kind);
            } catch {
              return true;
            }
            return safe
              && SAFE_MODE_EXCLUDED_KEYS.some((k) => rootRel === k || rootRel.startsWith(`${k}/`));
          },
        });
        copied.push(...result.copied.map((c) => `${rel}/${c}`));
        if (result.truncated) {
          incompletePayloads.add(rel);
          warnings.push(`${rel}: copy hit its size/entry budget — the copy on this account is incomplete`);
        }
        if (result.skipped.length > 0) {
          // Not silent: a never-copy cache, a symlink, a vanished entry or a
          // size/entry cap is exactly what a user needs to know did not move
          // (review nit).
          warnings.push(
            `${rel}: skipped ${result.skipped.length} entr${result.skipped.length === 1 ? "y" : "ies"}`
            + " (symlink, never-copy cache, vanished entry, or size/entry cap)",
          );
        }
      } else if (st.isFile()) {
        if (!isRegularFileNoFollow(from)) {
          warnings.push(`${rel}: not a regular file`);
          incompletePayloads.add(rel);
          continue;
        }
        await copyRegularFile(from, to, { root: toRoot });
        copied.push(rel);
      } else {
        warnings.push(`${rel}: not a regular file or directory`);
        incompletePayloads.add(rel);
      }
    } catch (err) {
      warnings.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
      incompletePayloads.add(rel);
    }
  }

  // 2. Merge the declared JSON/TOML files.
  for (const rel of spec.merge) {
    try {
      assertNotCredentialPath(rel, kind);
      // `.claude.json` does not live in `~/.claude`: it sits directly in the
      // account's pinned config root (`home` or env CLAUDE_CONFIG_DIR), and in
      // the real home for the built-in account. `mergeClaudeJson` resolves and
      // validates its own parent.
      if (rel !== ".claude.json" && !isPlainAncestorPathUnder(fromRoot, path.join(fromRoot, rel))) {
        warnings.push(`${rel}: symlinked parent directory refused`);
        continue;
      }
      if (rel === "settings.json") {
        const result = await mergeClaudeSettings(fromRoot, toRoot, safe);
        copied.push(...result.copied);
        warnings.push(...result.warnings);
      } else if (rel === ".claude.json") {
        const result = await mergeClaudeJson(primary, target);
        copied.push(...result.copied);
        warnings.push(...result.warnings);
      } else if (rel === "plugins/installed_plugins.json" || rel === "plugins/known_marketplaces.json") {
        const payload = rel === "plugins/installed_plugins.json" ? "plugins/cache" : "plugins/marketplaces";
        if (incompletePayloads.has(payload)) {
          warnings.push(
            `${rel}: the ${payload} copy was incomplete — this account's registry was left untouched so it cannot point at missing files`,
          );
          continue;
        }
        const result = await mergePluginRegistry(fromRoot, toRoot, rel);
        copied.push(...result.copied);
        warnings.push(...result.warnings);
      } else if (rel === "config.toml") {
        const result = await mergeCodexConfig(fromRoot, toRoot, safe);
        copied.push(...result.copied);
        warnings.push(...result.warnings);
      }
    } catch (err) {
      warnings.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { copied, warnings };
}

const MAX_MIRROR_FILE_BYTES = 8 * 1024 * 1024;

/** Deep-merge `backup` under `primary`: primary scalars win, arrays union
 *  (primary first, deduped), objects recurse, backup-only keys survive. */
export function deepMerge(primary: unknown, backup: unknown): unknown {
  if (Array.isArray(primary) && Array.isArray(backup)) {
    const out: unknown[] = [];
    const seen = new Set<string>();
    for (const item of [...primary, ...backup]) {
      const key = typeof item === "object" ? JSON.stringify(item) : `${typeof item}:${String(item)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }
  if (isPlainObject(primary) && isPlainObject(backup)) {
    const out: Record<string, unknown> = { ...backup };
    for (const [key, value] of Object.entries(primary)) {
      out[key] = key in backup ? deepMerge(value, backup[key]) : value;
    }
    return out;
  }
  return primary === undefined ? backup : primary;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Merge Claude's `settings.json`, stripping the primary's provider login
 *  keys while keeping a backup's own. `safe` mode drops hooks/permissions
 *  from the primary and preserves whatever the backup already has. */
async function mergeClaudeSettings(
  fromRoot: string,
  toRoot: string,
  safe: boolean,
): Promise<MirrorResult> {
  const warnings: string[] = [];
  const fromPath = path.join(fromRoot, "settings.json");
  const toPath = path.join(toRoot, "settings.json");
  const primaryRead = readTextIfRegular(fromPath, MAX_MIRROR_FILE_BYTES);
  if (!primaryRead.ok) {
    if (primaryRead.missing) return { copied: [], warnings: [] };
    return { copied: [], warnings: [`settings.json: primary file could not be read safely — left alone (${primaryRead.reason})`] };
  }
  const backupRead = readTextIfRegular(toPath, MAX_MIRROR_FILE_BYTES);
  if (!backupRead.ok && !backupRead.missing) {
    return { copied: [], warnings: [`settings.json: backup file could not be read safely — left alone (${backupRead.reason})`] };
  }
  const primary = parseJsonObject(primaryRead.text);
  const backup = parseJsonObject(backupRead.ok ? backupRead.text : "{}");
  if (!primary) return { copied: [], warnings: ["settings.json: primary file is not a JSON object — left alone"] };
  if (!backup) return { copied: [], warnings: ["settings.json: backup file is not a JSON object — left alone"] };

  const filtered: Record<string, unknown> = { ...primary };
  if (safe) for (const key of SAFE_MODE_EXCLUDED_KEYS) delete filtered[key];
  // Login-selecting keys never cross accounts. Deleting them from the primary
  // side before the merge leaves the backup's own value intact (when it has
  // one) and leaves the key absent otherwise.
  let strippedSettings = 0;
  for (const key of Object.keys(filtered)) {
    if (!isLoginBearingSettingsKey(key)) continue;
    delete filtered[key];
    strippedSettings++;
  }
  const merged = deepMerge(filtered, backup) as Record<string, unknown>;

  // Provider login keys are account-scoped. Start from the backup's own env,
  // then overwrite every non-auth key from the primary's (auth keys stripped).
  const primaryEnv = isPlainObject(filtered.env) ? filtered.env : {};
  const backupEnv = isPlainObject(backup.env) ? backup.env : {};
  const env: Record<string, unknown> = { ...backupEnv };
  let stripped = 0;
  for (const [key, value] of Object.entries(primaryEnv)) {
    if (isHarnessAuthEnvKey(key)) {
      stripped++;
      continue;
    }
    env[key] = value;
  }
  if (Object.keys(env).length > 0) merged.env = env;
  else delete merged.env;
  if (stripped > 0) {
    warnings.push(`settings.json: stripped ${stripped} provider credential key${stripped === 1 ? "" : "s"} from the primary`);
  }
  if (strippedSettings > 0) {
    warnings.push(
      `settings.json: kept this account's own login settings; did not copy ${strippedSettings} login key${strippedSettings === 1 ? "" : "s"} from the primary`,
    );
  }

  await atomicWriteFile(toPath, `${JSON.stringify(merged, null, 2)}\n`, { root: toRoot });
  return { copied: ["settings.json"], warnings };
}

/**
 * Merge only the two user-level keys of Claude's `.claude.json` blob
 * (`mcpServers`, `enabledPlugins`). The blob also holds session/project state
 * and an account id; copying the whole thing would be both noisy and
 * credential-adjacent.
 */
async function mergeClaudeJson(
  primary: Harness,
  target: Harness,
): Promise<MirrorResult> {
  const warnings: string[] = [];
  const fromBase = claudeJsonDirFor(primary);
  const fromPath = path.join(fromBase, ".claude.json");
  const toBase = claudeJsonDirFor(target);
  const toPath = path.join(toBase, ".claude.json");
  if (path.resolve(fromPath) === path.resolve(toPath)) return { copied: [], warnings: [] };
  if (!isPlainAncestorPathUnder(fromBase, fromPath)) {
    return { copied: [], warnings: [".claude.json: symlinked parent directory refused — left alone"] };
  }
  const primaryRead = readTextIfRegular(fromPath, MAX_MIRROR_FILE_BYTES);
  if (!primaryRead.ok) {
    if (primaryRead.missing) return { copied: [], warnings: [] };
    return { copied: [], warnings: [`.claude.json: primary file could not be read safely — left alone (${primaryRead.reason})`] };
  }
  const backupRead = readTextIfRegular(toPath, MAX_MIRROR_FILE_BYTES);
  if (!backupRead.ok && !backupRead.missing) {
    return { copied: [], warnings: [`.claude.json: backup file could not be read safely — left alone (${backupRead.reason})`] };
  }
  const primaryJson = parseJsonObject(primaryRead.text);
  const backupJson = parseJsonObject(backupRead.ok ? backupRead.text : "{}");
  if (!primaryJson) return { copied: [], warnings: [".claude.json: primary file is not a JSON object — left alone"] };
  if (!backupJson) return { copied: [], warnings: [".claude.json: backup file is not a JSON object — left alone"] };

  const merged: Record<string, unknown> = { ...backupJson };
  const mcp = primaryJson.mcpServers;
  if (isPlainObject(mcp)) merged.mcpServers = deepMerge(mcp, isPlainObject(backupJson.mcpServers) ? backupJson.mcpServers : {});
  const plugins = primaryJson.enabledPlugins;
  if (isPlainObject(plugins)) {
    merged.enabledPlugins = deepMerge(plugins, isPlainObject(backupJson.enabledPlugins) ? backupJson.enabledPlugins : {});
  }
  // This merge copies only `mcpServers`/`enabledPlugins`; it never imports the
  // primary's hooks or permissions, so safe mode must not delete the backup's
  // own copy of those keys from the rest of its blob.
  await atomicWriteFile(toPath, `${JSON.stringify(merged, null, 2)}\n`, {
    root: toBase,
  });
  return { copied: [".claude.json"], warnings };
}

/**
 * Merge a Claude plugin registry (`plugins/installed_plugins.json` or
 * `plugins/known_marketplaces.json`) with every absolute path that points into
 * the primary's config root rewritten to the destination root.
 *
 * The payload itself is copied by the `plugins/cache`/`plugins/marketplaces`
 * allowlist entries, so the backup can load its own copy instead of silently
 * reading the primary's (and breaking when the primary's home is removed). The
 * merge is additive: a backup-only plugin/marketplace entry survives, while
 * the primary wins on a shared key. `installed_plugins.json` arrays are merged
 * by install identity — scope plus `projectPath` (review S1, R17-M1) — and the
 * caller has already refused to write this registry when the payload copy was
 * incomplete (review S3).
 */
async function mergePluginRegistry(
  fromRoot: string,
  toRoot: string,
  rel: string,
): Promise<MirrorResult> {
  const warnings: string[] = [];
  const fromPath = path.join(fromRoot, rel);
  const toPath = path.join(toRoot, rel);
  const primaryRead = readTextIfRegular(fromPath, MAX_MIRROR_FILE_BYTES);
  if (!primaryRead.ok) {
    if (primaryRead.missing) return { copied: [], warnings: [] };
    return {
      copied: [],
      warnings: [`${rel}: primary file could not be read safely — left alone (${primaryRead.reason})`],
    };
  }
  const backupRead = readTextIfRegular(toPath, MAX_MIRROR_FILE_BYTES);
  if (!backupRead.ok && !backupRead.missing) {
    return {
      copied: [],
      warnings: [`${rel}: backup file could not be read safely — left alone (${backupRead.reason})`],
    };
  }
  const primaryJson = parseJsonObject(primaryRead.text);
  const backupJson = parseJsonObject(backupRead.ok ? backupRead.text : "{}");
  if (!primaryJson) return { copied: [], warnings: [`${rel}: primary file is not a JSON object — left alone`] };
  if (!backupJson) return { copied: [], warnings: [`${rel}: backup file is not a JSON object — left alone`] };

  const rewritten = rewritePathPrefixes(primaryJson, path.resolve(fromRoot), path.resolve(toRoot)) as Record<string, unknown>;
  // `installed_plugins.json` maps a plugin to an ARRAY of per-scope install
  // records. A generic array union kept the primary's AND the backup's `user`
  // record, so the CLI saw the same plugin installed twice at user scope
  // (review S1). Merge those arrays by install identity instead; every other
  // registry (and key) keeps the deep-merge rule.
  const merged = rel === "plugins/installed_plugins.json"
    ? mergeInstalledPluginsJson(rewritten, backupJson)
    : (deepMerge(rewritten, backupJson) as Record<string, unknown>);
  await atomicWriteFile(toPath, `${JSON.stringify(merged, null, 2)}\n`, { root: toRoot });
  return { copied: [rel], warnings };
}

/**
 * Merge two `installed_plugins.json` documents. The top level is
 * `{ version, plugins: { "plugin@marketplace": InstallRecord[] } }`; a plugin
 * normally has one record per install scope (`user`, `project`, `local`) and
 * a `project`/`local` record also names the `projectPath` it was installed
 * for — so one plugin can hold several project records at once.
 *
 * The primary wins on an install identity it defines, the backup keeps the
 * identities the primary does not. A record without a `scope` (an older or
 * unexpected shape) falls back to full-record identity so it is still deduped
 * rather than duplicated. Exported for the merge unit tests.
 */
export function mergeInstalledPluginsJson(
  primary: Record<string, unknown>,
  backup: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...backup };
  for (const [key, value] of Object.entries(primary)) {
    const existing = merged[key];
    if (key === "plugins" && isPlainObject(value) && isPlainObject(existing)) {
      const plugins: Record<string, unknown> = { ...existing };
      for (const [pluginKey, pluginValue] of Object.entries(value)) {
        const backupValue = plugins[pluginKey];
        plugins[pluginKey] = Array.isArray(pluginValue) && Array.isArray(backupValue)
          ? mergeInstallRecords(pluginValue, backupValue)
          : pluginValue;
      }
      merged[key] = plugins;
    } else if (Array.isArray(value) && Array.isArray(existing)) {
      merged[key] = mergeInstallRecords(value, existing);
    } else if (isPlainObject(value) && isPlainObject(existing)) {
      merged[key] = deepMerge(value, existing);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/** Primary-first union of install records keyed by install identity —
 *  `scope` plus `projectPath` when present (full-record identity when the
 *  scope is missing).
 *
 *  Keying by scope alone collapsed a plugin's several `project` records (real
 *  registries carry one per `projectPath`) AND dropped the backup's own
 *  project records whenever both accounts had the plugin (R17-M1). The
 *  `projectPath` is the identity of a project-scope install, so it must be
 *  part of the key; a `user` record has no `projectPath` and therefore still
 *  dedupes to one. */
export function mergeInstallRecords(primary: unknown[], backup: unknown[]): unknown[] {
  const keyOf = (record: unknown): string => {
    if (isPlainObject(record) && typeof record.scope === "string") {
      const projectPath = typeof record.projectPath === "string" ? record.projectPath : "";
      return `scope:${record.scope}\u0000project:${projectPath}`;
    }
    try {
      return `record:${JSON.stringify(record)}`;
    } catch {
      return `record:${String(record)}`;
    }
  };
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const record of [...primary, ...backup]) {
    const key = keyOf(record);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}

/** Deep-copy `value`, replacing the `from` path prefix on every string. Used
 *  only for the plugin registries, whose `installPath`/`installLocation`
 *  values are absolute paths into the source account. A string outside the
 *  prefix is left byte-identical. */
export function rewritePathPrefixes(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") {
    if (value === from) return to;
    if (value.startsWith(`${from}${path.sep}`)) return `${to}${value.slice(from.length)}`;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => rewritePathPrefixes(item, from, to));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = rewritePathPrefixes(item, from, to);
    }
    return out;
  }
  return value;
}

/**
 * Section-preserving merge of Codex's `config.toml`. There is no TOML writer
 * dependency (plan §2.3), so this works on text blocks: every primary block
 * except `[projects.*]` replaces the backup block with the same header, new
 * primary blocks are appended, and backup-only blocks are kept. `[projects.*]`
 * trust entries are never inherited — directory trust is per-account and
 * security-sensitive. The result is validated by `Bun.TOML.parse`; invalid
 * output is discarded and the backup file left untouched.
 */
async function mergeCodexConfig(fromRoot: string, toRoot: string, safe: boolean): Promise<MirrorResult> {
  const warnings: string[] = [];
  const fromPath = path.join(fromRoot, "config.toml");
  const toPath = path.join(toRoot, "config.toml");
  const primaryRead = readTextIfRegular(fromPath, MAX_MIRROR_FILE_BYTES);
  if (!primaryRead.ok) {
    if (primaryRead.missing) return { copied: [], warnings: [] };
    return { copied: [], warnings: [`config.toml: primary file could not be read safely — left alone (${primaryRead.reason})`] };
  }
  const backupRead = readTextIfRegular(toPath, MAX_MIRROR_FILE_BYTES);
  if (!backupRead.ok && !backupRead.missing) {
    return { copied: [], warnings: [`config.toml: backup file could not be read safely — left alone (${backupRead.reason})`] };
  }
  const primaryBlocks = splitTomlBlocks(primaryRead.text);
  const backupBlocks = splitTomlBlocks(backupRead.ok ? backupRead.text : "");
  // Codex MCP OAuth tokens live in a store Agetor never copies (security
  // review deviation). The definitions do move, but a backup that has never
  // signed in to that server must do so once; warn instead of pretending the
  // mirror made it work.
  const primaryMcpSections = primaryBlocks.filter(
    (b) => b.header === "mcp_servers" || b.header.startsWith("mcp_servers."),
  ).length;
  const backupHeaders = new Map(backupBlocks.map((b) => [b.header, b.text] as const));
  // Only headers the primary actually writes may replace a backup section.
  // A primary section removed by safe mode must NOT make the backup's own
  // same-named section disappear.
  const keptPrimaryHeaders = new Set<string>();
  const out: string[] = [];
  let skippedProjects = 0;

  // Top-level scalars are their own merge: the primary's replace by key,
  // while a backup-only key (a model override, notify list, custom setting)
  // survives. The old whole-block replacement silently dropped every
  // backup-only top-level key.
  const primaryTopAssignments = splitTopLevelAssignments(
    primaryBlocks.filter((b) => b.header === "").map((b) => b.text).join("\n"),
  ).assignments;
  const keptPrimaryTop = safe
    ? primaryTopAssignments.filter((a) => !SAFE_MODE_EXCLUDED_KEYS.includes(a.key))
    : primaryTopAssignments;
  const primaryTopKeys = new Set(keptPrimaryTop.map((a) => a.key));
  const topParts = keptPrimaryTop.map((a) => a.text.trimEnd());
  const backupTopText = backupBlocks.filter((b) => b.header === "").map((b) => b.text).join("\n");
  for (const assignment of splitTopLevelAssignments(backupTopText).assignments) {
    if (primaryTopKeys.has(assignment.key)) continue;
    topParts.push(assignment.text.trimEnd());
  }
  if (topParts.some((t) => t.trim().length > 0)) {
    out.push(topParts.join("\n"));
  } else if (!primaryTopAssignments.length && backupTopText.trim()) {
    // Primary has no top-level keys; keep the backup's block (comments incl.).
    out.push(backupTopText.trimEnd());
  }

  for (const block of primaryBlocks) {
    if (block.header === "") continue;
    if (block.header.startsWith("projects.") || block.header === "projects") {
      skippedProjects++;
      continue;
    }
    if (safe && SAFE_MODE_EXCLUDED_KEYS.some((k) => block.header === k || block.header.startsWith(`${k}.`))) continue;
    out.push(block.text.trimEnd());
    keptPrimaryHeaders.add(block.header);
  }
  for (const block of backupBlocks) {
    if (block.header === "") continue;
    if (block.header.startsWith("projects.") || block.header === "projects") {
      // Keep the backup's own trust entries verbatim. A primary `[projects.*]`
      // block was never written above, so the same header on both sides still
      // means only the backup's entry survives.
      const keep = backupHeaders.get(block.header);
      if (keep) out.push(keep.trimEnd());
      continue;
    }
    if (keptPrimaryHeaders.has(block.header)) continue;
    out.push(block.text.trimEnd());
  }
  const merged = `${out.filter(Boolean).join("\n\n")}\n`;
  try {
    Bun.TOML.parse(merged);
  } catch (err) {
    return {
      copied: [],
      warnings: [`config.toml: merge produced invalid TOML — backup left untouched (${err instanceof Error ? err.message : String(err)})`],
    };
  }
  if (skippedProjects > 0) {
    warnings.push("config.toml: did not copy the primary's [projects.*] trust entries");
  }
  if (primaryMcpSections > 0) {
    warnings.push("config.toml: MCP sign-in may need repeating on this account — OAuth tokens are not copied");
  }
  await atomicWriteFile(toPath, merged, { root: toRoot });
  return { copied: ["config.toml"], warnings };
}

interface TomlBlock {
  header: string;
  text: string;
}

/** Split TOML text into a leading top-level block plus one block per table
 *  header (`[a.b]` or `[[a.b]]`). Comments and blank lines stay with the block
 *  they precede. */
export function splitTomlBlocks(text: string): TomlBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: TomlBlock[] = [];
  let current: { header: string; lines: string[] } = { header: "", lines: [] };
  for (const line of lines) {
    const m = /^\s*(\[\[?)([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
    if (m) {
      if (current.lines.length > 0) blocks.push({ header: current.header, text: current.lines.join("\n") });
      current = { header: m[2]!.trim(), lines: [line] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.length > 0) blocks.push({ header: current.header, text: current.lines.join("\n") });
  return blocks;
}

export interface TomlAssignment {
  /** Normalized key (`a.b`, no whitespace) for matching across files. */
  key: string;
  /** The full assignment text, including leading comments and any multiline
   *  value continuation. */
  text: string;
}

const TOML_KEY = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'))*`;
const TOML_ASSIGN_RE = new RegExp(String.raw`^\s*(${TOML_KEY})\s*=`);

/**
 * Split the top-level (pre-table) portion of a TOML document into
 * key assignments. Only used for the Codex `config.toml` merge, where the
 * primary's top-level scalars replace the backup's by key while backup-only
 * keys are appended. Multiline arrays/strings and comments are kept with the
 * assignment they belong to; the merged output is validated by
 * `Bun.TOML.parse` before it is written, so a parse-shape we get wrong leaves
 * the backup untouched rather than corrupting it.
 */
export function splitTopLevelAssignments(text: string): { assignments: TomlAssignment[] } {
  const assignments: TomlAssignment[] = [];
  const lines = text.split(/\r?\n/);
  let current: { key: string; lines: string[] } | null = null;
  let pending: string[] = [];
  let depth = 0;
  let multiline: '"""' | "'''" | null = null;

  const scan = (line: string, start: number) => {
    let i = start;
    while (i < line.length) {
      if (multiline) {
        const close = line.indexOf(multiline, i);
        if (close < 0) return;
        i = close + 3;
        multiline = null;
        continue;
      }
      const ch = line[i]!;
      if (ch === "#") return;
      if (ch === '"' || ch === "'") {
        const triple = line.slice(i, i + 3);
        if (triple === '"""' || triple === "'''") {
          const close = line.indexOf(triple, i + 3);
          if (close < 0) {
            multiline = triple;
            return;
          }
          i = close + 3;
          continue;
        }
        const quote = ch;
        i++;
        while (i < line.length) {
          if (quote === '"' && line[i] === "\\") {
            i += 2;
            continue;
          }
          if (line[i] === quote) {
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
      i++;
    }
  };

  const finish = () => {
    if (!current) return;
    assignments.push({ key: current.key, text: current.lines.join("\n") });
    current = null;
  };

  for (const line of lines) {
    if (!current) {
      if (/^\s*(?:#.*)?$/.test(line)) {
        pending.push(line);
        continue;
      }
      const match = TOML_ASSIGN_RE.exec(line);
      if (!match) {
        pending.push(line);
        continue;
      }
      current = { key: match[1]!.replace(/\s+/g, ""), lines: [...pending, line] };
      pending = [];
      depth = 0;
      multiline = null;
      scan(line, match[0].length);
      if (depth === 0 && multiline === null) finish();
      continue;
    }
    current.lines.push(line);
    scan(line, 0);
    if (depth === 0 && multiline === null) finish();
  }
  finish();
  if (pending.length > 0 && assignments.length > 0) {
    assignments[assignments.length - 1]!.text += `\n${pending.join("\n")}`;
  }
  return { assignments };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** Re-exported so the security review's paths list has one source. */
export { MIRROR_SPECS, isNeverCopyPath };

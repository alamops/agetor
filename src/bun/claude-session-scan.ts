/**
 * Discover Claude Code transcripts that were started outside Agetor.
 * Disk scan plus liveness. The list path never spawns `claude`; a fresh
 * probe is `refreshClaudeSessionLiveness` (Re-check and import commit).
 * Tests inject `listLive` / `readRegistry` and never hit the default lister.
 */
import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import path from "node:path";
import { effectiveClaudeConfigDir } from "./harness-discovery.ts";
import {
  createClaudeSessionMetaReader,
  claudeProjectDirUnresolved,
  type ClaudeSessionMeta,
} from "../shared/claude-session-meta.ts";

export interface ClaudeSessionCandidate {
  sessionId: string;
  configDir: string;
  cwd: string;
  title: string;
  gitBranch: string | null;
  liveBranch: string | null;
  branchMismatch: boolean;
  model: string | null;
  lastActivity: number;
  messageCount: number;
  liveness: "live" | "idle" | "unknown";
  liveHint: string | null;
  importable: boolean;
  blockedReason: "long-path" | "live" | "no-harness" | null;
  harnessId: string | null;
}

/** Extra fields the commit path needs. Not part of the list DTO. */
export interface ClaudeSessionRecord extends ClaudeSessionCandidate {
  jsonlPath: string;
  permissionMode: string | null;
  firstHumanPrompt: string | null;
  continuedIn: string | null;
}

export interface ListedClaudeAgent {
  sessionId: string;
  kind: string | null;
}

export interface ClaudeRegistryRecord {
  sessionId: string;
  pid: number | null;
  procStart: string | null;
  kind: string | null;
  tmux: string | null;
}

export interface ClaudeHarnessRef {
  id: string;
  kind: string;
  home: string | null;
}

export interface ScanClaudeSessionsOptions {
  homeDir: string;
  env?: Record<string, string | undefined>;
  ownedSessionIds?: ReadonlySet<string>;
  /** Absolute `worktrees/` directories. A cwd under any of them is hidden. */
  worktreeRoots?: readonly string[];
  harnesses?: readonly ClaudeHarnessRef[];
  /** Defaults to `encodeProjectPath`. Tests inject this so they stay green
   *  whether or not the over-200 hash has been derived. */
  encodePath?: (cwd: string) => string;
  /** When set, this is the liveness source (tests, or a caller that already
   *  probed). When omitted, the module cache is used and a dir with no cache
   *  entry stays `liveness: "unknown"`. Never spawns `claude`. */
  listLive?: (configDir: string) => ListedClaudeAgent[] | Promise<ListedClaudeAgent[]>;
  readRegistry?: (configDir: string) => ClaudeRegistryRecord[] | Promise<ClaudeRegistryRecord[]>;
  /** Injectable pid check. Default is `process.kill(pid, 0)`. */
  pidAlive?: (pid: number) => boolean;
  /** Injectable UTC `ps -o lstart=` comparison. Default shells out. */
  procStartMatches?: (pid: number, procStart: string) => boolean | Promise<boolean>;
}

const SLICE_MS = 20;

interface LiveInfo {
  kind: string | null;
  background: boolean;
}

interface CacheEntry {
  byId: Map<string, LiveInfo>;
}

const livenessCache = new Map<string, CacheEntry>();

function envOf(opts: { env?: Record<string, string | undefined> }): Record<string, string | undefined> {
  return opts.env ?? process.env;
}

function safeRealpath(p: string): string {
  try { return realpathSync(p); } catch { return path.resolve(p); }
}

export function isAgetorOwnedTmux(tmux: string | null | undefined): boolean {
  if (!tmux) return false;
  // `sessionNameFor` is `agetor-` + the first 12 chars of a uuid, which is
  // `8 hex + hyphen + 3 hex` (`agetor-07b34738-b02`). Also accept 12
  // contiguous hex digits.
  return /^agetor-(?:[0-9a-f]{12}|[0-9a-f]{8}-[0-9a-f]{3})(?![0-9a-f])/i.test(tmux);
}

function isBackgroundKind(kind: string | null | undefined): boolean {
  if (!kind) return false;
  const k = kind.toLowerCase();
  return k === "background" || k === "bg" || k === "daemon";
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

function epochSecondsUtc(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)\s*$/i.test(trimmed);
  const ms = Date.parse(hasZone ? trimmed : `${trimmed} GMT`);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

/** `LC_ALL=C TZ=UTC ps -o lstart=` for `pid`, or null when ps fails. */
export async function utcProcStart(pid: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = (await new Response(proc.stdout).text()).trim();
    const code = await proc.exited;
    if (code !== 0 || !text) return null;
    return text;
  } catch {
    return null;
  }
}

async function defaultProcStartMatches(pid: number, procStart: string): Promise<boolean> {
  const live = await utcProcStart(pid);
  if (!live) return false;
  if (live.trim() === procStart.trim()) return true;
  const a = epochSecondsUtc(live);
  const b = epochSecondsUtc(procStart);
  return a !== null && b !== null && a === b;
}

function underRoot(cwd: string, root: string): boolean {
  const c = path.resolve(cwd);
  const r = path.resolve(root);
  return c === r || c.startsWith(r + path.sep);
}

function isTempAgetorCwd(cwd: string): boolean {
  const temp = path.resolve(tmpdir());
  const resolved = path.resolve(cwd);
  if (resolved !== temp && !resolved.startsWith(temp + path.sep)) return false;
  const parts = resolved.split(path.sep);
  if (parts.some((seg) => seg.toLowerCase().includes("agetor"))) return true;
  return resolved.includes(`${path.sep}worktrees${path.sep}`);
}

/** `~/.agetor` and `~/.agetor-*` data dirs that contain `agetor.sqlite`. */
export function discoverAgetorWorktreeRoots(homeDir: string): string[] {
  const roots: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(homeDir);
  } catch {
    return roots;
  }
  for (const name of entries) {
    if (name !== ".agetor" && !name.startsWith(".agetor-")) continue;
    const dir = path.join(homeDir, name);
    if (!existsSync(path.join(dir, "agetor.sqlite"))) continue;
    roots.push(path.join(dir, "worktrees"));
  }
  return roots;
}

export function claudeConfigDirsToScan(opts: ScanClaudeSessionsOptions): string[] {
  const discovery = { homeDir: opts.homeDir, env: envOf(opts) };
  const found: string[] = [];
  for (const harness of opts.harnesses ?? []) {
    if (harness.kind !== "claude-code") continue;
    found.push(effectiveClaudeConfigDir(harness.home, discovery));
  }
  found.push(effectiveClaudeConfigDir(null, discovery));
  try {
    for (const entry of readdirSync(opts.homeDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(".claude")) {
        found.push(path.join(opts.homeDir, entry.name));
      }
    }
  } catch { /* unreadable home */ }
  const configDir = envOf(opts).CLAUDE_CONFIG_DIR;
  if (configDir) found.push(configDir);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of found) {
    if (!dir || !existsSync(dir)) continue;
    const real = safeRealpath(dir);
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(dir);
  }
  return out;
}

function harnessIdFor(configDir: string, harnesses: readonly ClaudeHarnessRef[], opts: ScanClaudeSessionsOptions): string | null {
  const real = safeRealpath(configDir);
  const discovery = { homeDir: opts.homeDir, env: envOf(opts) };
  for (const harness of harnesses) {
    if (harness.kind !== "claude-code") continue;
    const effective = effectiveClaudeConfigDir(harness.home, discovery);
    if (safeRealpath(effective) === real) return harness.id;
  }
  return null;
}

function parseAgentList(value: unknown): ListedClaudeAgent[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? (value as { agents?: unknown; sessions?: unknown }).agents
        ?? (value as { sessions?: unknown }).sessions
      : null;
  if (!Array.isArray(list)) return [];
  const out: ListedClaudeAgent[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const sessionId = rec.sessionId ?? rec.session_id ?? rec.id;
    if (typeof sessionId !== "string" || !sessionId) continue;
    const kind = typeof rec.kind === "string" ? rec.kind : typeof rec.type === "string" ? rec.type : null;
    out.push({ sessionId, kind });
  }
  return out;
}

function agentsFromStubFile(file: string, configDir: string): ListedClaudeAgent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const keyed = parsed as Record<string, unknown>;
    if (keyed[configDir]) return parseAgentList(keyed[configDir]);
    const real = safeRealpath(configDir);
    for (const [key, value] of Object.entries(keyed)) {
      if (key === "agents" || key === "sessions") continue;
      try {
        if (safeRealpath(key) === real) return parseAgentList(value);
      } catch { /* not a path */ }
    }
  }
  return parseAgentList(parsed);
}

async function spawnClaudeAgents(configDir: string, env: Record<string, string | undefined>): Promise<ListedClaudeAgent[] | null> {
  const bin = env.AGETOR_CLAUDE_BIN || "claude";
  try {
    const proc = Bun.spawn([bin, "agents", "--json"], {
      env: { ...process.env, ...env, CLAUDE_CONFIG_DIR: configDir },
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, 8_000);
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    if (code !== 0) return null;
    return parseAgentList(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Default lister. Honors `AGETOR_CLAUDE_AGENTS_JSON` (a file path) so e2e
 *  never spawns `claude`. A spawn failure returns null — the cache is left
 *  unknown. Not called by `scanClaudeSessions`. */
export async function defaultListLive(configDir: string, env?: Record<string, string | undefined>): Promise<ListedClaudeAgent[] | null> {
  const source = env ?? process.env;
  const stub = source.AGETOR_CLAUDE_AGENTS_JSON;
  if (stub) return agentsFromStubFile(stub, configDir);
  return spawnClaudeAgents(configDir, source);
}

export function readClaudeRegistry(configDir: string): ClaudeRegistryRecord[] {
  const dir = path.join(configDir, "sessions");
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ClaudeRegistryRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const rec = parsed as Record<string, unknown>;
    const sessionId = typeof rec.sessionId === "string" ? rec.sessionId : "";
    if (!sessionId) continue;
    const pid = typeof rec.pid === "number" && Number.isInteger(rec.pid) ? rec.pid : null;
    out.push({
      sessionId,
      pid,
      procStart: typeof rec.procStart === "string" ? rec.procStart : null,
      kind: typeof rec.kind === "string" ? rec.kind : null,
      tmux: typeof rec.tmux === "string" ? rec.tmux : null,
    });
  }
  return out;
}

export async function refreshClaudeSessionLiveness(
  configDirs: readonly string[],
  env?: Record<string, string | undefined>,
): Promise<void> {
  for (const dir of configDirs) {
    const listed = await defaultListLive(dir, env);
    if (listed === null) continue;
    const byId = new Map<string, LiveInfo>();
    for (const agent of listed) {
      byId.set(agent.sessionId, { kind: agent.kind, background: isBackgroundKind(agent.kind) });
    }
    livenessCache.set(safeRealpath(dir), { byId });
  }
}

/** Test seam. Production never needs to drop the cache. */
export function clearClaudeSessionLivenessCache(): void {
  livenessCache.clear();
}

async function metaFromFile(file: string): Promise<ClaudeSessionMeta> {
  const reader = createClaudeSessionMetaReader();
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) reader.push(line);
  return reader.finish();
}

async function gitHeadBranch(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = (await new Response(proc.stdout).text()).trim();
    const code = await proc.exited;
    if (code !== 0 || !text || text === "HEAD") return null;
    return text;
  } catch {
    return null;
  }
}

interface Collected {
  record: ClaudeSessionRecord;
  ownedTmux: boolean;
  continued: boolean;
  noUser: boolean;
}

async function registryLive(
  records: ClaudeRegistryRecord[],
  opts: ScanClaudeSessionsOptions,
): Promise<Map<string, LiveInfo>> {
  const alive = opts.pidAlive ?? pidAlive;
  const matches = opts.procStartMatches ?? defaultProcStartMatches;
  const out = new Map<string, LiveInfo>();
  for (const rec of records) {
    if (rec.pid === null || !rec.procStart) continue;
    if (!alive(rec.pid)) continue;
    if (!await matches(rec.pid, rec.procStart)) continue;
    out.set(rec.sessionId, { kind: rec.kind, background: isBackgroundKind(rec.kind) });
  }
  return out;
}

function applyLiveness(
  record: ClaudeSessionRecord,
  known: boolean,
  fromAgents: LiveInfo | undefined,
  fromRegistry: LiveInfo | undefined,
): void {
  const info = fromAgents ?? fromRegistry;
  if (info) {
    record.liveness = "live";
    record.liveHint = info.background
      ? `claude stop ${record.sessionId}`
      : "Close it in your terminal first";
  } else if (known) {
    record.liveness = "idle";
    record.liveHint = null;
  } else {
    record.liveness = "unknown";
    record.liveHint = null;
  }
  if (record.blockedReason === "long-path") {
    record.importable = false;
    return;
  }
  if (record.liveness === "live") record.blockedReason = "live";
  else if (!record.harnessId && record.blockedReason === null) record.blockedReason = "no-harness";
  record.importable = record.blockedReason === null && record.liveness === "idle";
}

async function collect(opts: ScanClaudeSessionsOptions): Promise<Collected[]> {
  const encode = opts.encodePath ?? (await import("./claude-tmux.ts")).encodeProjectPath;
  const harnesses = opts.harnesses ?? [];
  const branchCache = new Map<string, Promise<string | null>>();
  const out: Collected[] = [];
  let sliceStart = Date.now();

  for (const configDir of claudeConfigDirsToScan(opts)) {
    const projects = path.join(configDir, "projects");
    let projectDirs: string[] = [];
    try {
      projectDirs = readdirSync(projects);
    } catch {
      continue;
    }
    const harnessId = harnessIdFor(configDir, harnesses, opts);
    const registry = await (opts.readRegistry ?? readClaudeRegistry)(configDir);
    const ownedTmux = new Set(registry.filter((r) => isAgetorOwnedTmux(r.tmux)).map((r) => r.sessionId));
    const registryById = new Map(registry.map((r) => [r.sessionId, r]));

    let agentMap: Map<string, LiveInfo> | null = null;
    let known = false;
    if (opts.listLive) {
      known = true;
      agentMap = new Map();
      try {
        for (const agent of await opts.listLive(configDir)) {
          agentMap.set(agent.sessionId, { kind: agent.kind, background: isBackgroundKind(agent.kind) });
        }
      } catch {
        known = false;
        agentMap = null;
      }
    } else {
      const cached = livenessCache.get(safeRealpath(configDir));
      if (cached) {
        known = true;
        agentMap = cached.byId;
      }
    }
    const regLive = await registryLive(registry, opts);

    for (const dirName of projectDirs) {
      const dirPath = path.join(projects, dirName);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(dirPath); } catch { continue; }
      if (!st.isDirectory()) continue;
      let files: string[] = [];
      try { files = readdirSync(dirPath); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        if (Date.now() - sliceStart >= SLICE_MS) {
          await new Promise((r) => setImmediate(r));
          sliceStart = Date.now();
        }
        const jsonlPath = path.join(dirPath, file);
        const sessionId = file.slice(0, -".jsonl".length);
        let meta: ClaudeSessionMeta;
        let mtime = 0;
        try {
          meta = await metaFromFile(jsonlPath);
          mtime = statSync(jsonlPath).mtimeMs;
        } catch {
          continue;
        }
        if (!meta.cwd) continue;
        const unresolved = claudeProjectDirUnresolved(meta.cwd, dirName, encode);
        let liveBranch: string | null = null;
        if (!branchCache.has(meta.cwd)) branchCache.set(meta.cwd, gitHeadBranch(meta.cwd));
        liveBranch = await branchCache.get(meta.cwd)!;
        const gitBranch = meta.gitBranch;
        const branchMismatch = gitBranch !== null && liveBranch !== null && gitBranch !== liveBranch;
        const reg = registryById.get(sessionId);
        const background = isBackgroundKind(reg?.kind) || (agentMap?.get(sessionId)?.background ?? false);
        const record: ClaudeSessionRecord = {
          sessionId,
          configDir,
          cwd: meta.cwd,
          title: meta.title ?? "Untitled session",
          gitBranch,
          liveBranch,
          branchMismatch,
          model: meta.model,
          lastActivity: meta.lastTimestamp ?? mtime,
          messageCount: meta.messageCount,
          liveness: "unknown",
          liveHint: null,
          importable: false,
          blockedReason: unresolved ? "long-path" : null,
          harnessId,
          jsonlPath,
          permissionMode: meta.permissionMode,
          firstHumanPrompt: meta.firstHumanPrompt,
          continuedIn: meta.continuedIn,
        };
        const agentInfo = agentMap?.get(sessionId);
        const regInfo = regLive.get(sessionId);
        if (agentInfo && background && !agentInfo.background) {
          agentInfo.background = true;
        }
        applyLiveness(record, known, agentInfo, regInfo);
        if (background && record.liveness === "live") {
          record.liveHint = `claude stop ${sessionId}`;
        }
        out.push({
          record,
          ownedTmux: ownedTmux.has(sessionId),
          continued: meta.continuedIn !== null,
          noUser: !meta.hasUser,
        });
      }
    }
  }
  return out;
}

function shouldHide(item: Collected, opts: ScanClaudeSessionsOptions): boolean {
  const { record } = item;
  if (item.noUser) return true;
  if (opts.ownedSessionIds?.has(record.sessionId)) return true;
  if ((opts.worktreeRoots ?? []).some((root) => underRoot(record.cwd, root))) return true;
  if (item.ownedTmux) return true;
  if (item.continued) return true;
  if (isTempAgetorCwd(record.cwd)) return true;
  return false;
}

/** List candidates, newest first. Does not spawn `claude`. */
export async function scanClaudeSessions(opts: ScanClaudeSessionsOptions): Promise<ClaudeSessionCandidate[]> {
  const items = await collect(opts);
  const visible = items.filter((item) => !shouldHide(item, opts));
  visible.sort((a, b) => b.record.lastActivity - a.record.lastActivity || a.record.sessionId.localeCompare(b.record.sessionId));
  return visible.map((item) => toCandidate(item.record));
}

function toCandidate(record: ClaudeSessionRecord): ClaudeSessionCandidate {
  return {
    sessionId: record.sessionId,
    configDir: record.configDir,
    cwd: record.cwd,
    title: record.title,
    gitBranch: record.gitBranch,
    liveBranch: record.liveBranch,
    branchMismatch: record.branchMismatch,
    model: record.model,
    lastActivity: record.lastActivity,
    messageCount: record.messageCount,
    liveness: record.liveness,
    liveHint: record.liveHint,
    importable: record.importable,
    blockedReason: record.blockedReason,
    harnessId: record.harnessId,
  };
}

/** One session by id, including rows the list hides (owned, live, long-path).
 *  Returns null when the id is not on disk. */
export async function findClaudeSession(
  sessionId: string,
  opts: ScanClaudeSessionsOptions,
): Promise<ClaudeSessionRecord | null> {
  const items = await collect(opts);
  const matches = items.filter((item) => item.record.sessionId === sessionId);
  matches.sort((a, b) => b.record.lastActivity - a.record.lastActivity);
  return matches[0]?.record ?? null;
}

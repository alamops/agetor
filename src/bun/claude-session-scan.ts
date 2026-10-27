/**
 * Discover Claude Code transcripts that were started outside Agetor.
 * Disk scan plus liveness. The list path never spawns `claude`; a fresh
 * probe is `refreshClaudeSessionLiveness` (Re-check and import commit).
 * Tests inject `listLive` / `readRegistry` and never hit the default lister.
 *
 * A list reads as little as it can. A session Agetor already owns is skipped
 * by file name. A project folder whose name looks like an Agetor worktree or
 * temp dir is peeked for its cwd before any full parse. Parsed metadata is
 * cached per file until its size or mtime changes. `git` runs only for rows
 * that stay visible.
 */
import { closeSync, createReadStream, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import path from "node:path";
import { effectiveClaudeConfigDir } from "./harness-discovery.ts";
import { coreSpawn } from "./core-spawn.ts";
import {
  createClaudeSessionMetaReader,
  claudeProjectDirUnresolved,
  plainEncodedProjectPath,
  type ClaudeSessionMeta,
} from "../shared/claude-session-meta.ts";
import { openReadNoFollow, READ_NOFOLLOW, readTextNoFollow } from "./no-follow.ts";

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
  /** Precedence when several apply: `long-path`, `missing-folder`, `live`,
   *  `no-harness`. The first two do not change on a liveness re-check. */
  blockedReason: "long-path" | "missing-folder" | "live" | "no-harness" | null;
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
  /** The harness's own binary. The `claude agents --json` probe of its
   *  config dir runs this, same precedence as `resolveBin` in agents.ts. */
  bin?: string | null;
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
  /** When set, only JSONL files whose session id is in the set are parsed.
   *  A batch import looks each id up once instead of re-reading every transcript. */
  onlySessionIds?: ReadonlySet<string>;
  /** Test seam: fired once per transcript that is actually parsed. A cache
   *  hit, a skipped owned file, and a head peek are not parses. */
  onJsonlRead?: (jsonlPath: string) => void;
}

const SLICE_MS = 20;
/** Bytes read to find a hidden-looking transcript's launch cwd. */
const PEEK_BYTES = 64 * 1024;
const GIT_BRANCH_TIMEOUT_MS = 5_000;
const GIT_BRANCH_CONCURRENCY = 8;

interface LiveInfo {
  kind: string | null;
  background: boolean;
}

interface CacheEntry {
  byId: Map<string, LiveInfo>;
  /** When this probe finished, ms epoch. */
  at: number;
}

const livenessCache = new Map<string, CacheEntry>();

interface MetaCacheEntry {
  size: number;
  mtimeMs: number;
  /** Full parse, or null while only the head has been read. */
  meta: ClaudeSessionMeta | null;
  /** Launch cwd from a head peek. Undefined until peeked; null when the
   *  head held no complete line with a cwd. */
  headCwd?: string | null;
}

/** Parsed transcripts by absolute path. An entry is reused only while the
 *  file's size and mtime are unchanged. A full list drops paths it no
 *  longer saw. */
const metaCache = new Map<string, MetaCacheEntry>();

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
    const proc = coreSpawn(["ps", "-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      stdout: "pipe",
      stderr: "ignore",
    }) as Bun.Subprocess<"ignore", "pipe", "ignore">;
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
    parsed = JSON.parse(readTextNoFollow(file));
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

async function spawnClaudeAgents(
  configDir: string,
  env: Record<string, string | undefined>,
  harnessBin?: string | null,
): Promise<ListedClaudeAgent[] | null> {
  const bin = harnessBin
    || env.AGETOR_CLAUDE_BIN
    || Bun.which("claude", { PATH: env.PATH ?? process.env.PATH ?? "" })
    || "claude";
  try {
    // coreSpawn: the claude binary resolves from an agent-plantable PATH/config.
    const proc = coreSpawn([bin, "agents", "--json"], {
      env: { ...process.env, ...env, CLAUDE_CONFIG_DIR: configDir },
      stdout: "pipe",
      stderr: "ignore",
    }) as Bun.Subprocess<"ignore", "pipe", "ignore">;
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
 *  never spawns `claude`. A spawn failure returns null. `refreshClaudeSessionLiveness`
 *  drops that dir's cache entry so the next list stays `unknown` instead of
 *  a stale idle snapshot. Not called by `scanClaudeSessions`. `bin` is the
 *  owning harness's binary, when it has one. */
export async function defaultListLive(
  configDir: string,
  env?: Record<string, string | undefined>,
  bin?: string | null,
): Promise<ListedClaudeAgent[] | null> {
  const source = env ?? process.env;
  const stub = source.AGETOR_CLAUDE_AGENTS_JSON;
  if (stub) return agentsFromStubFile(stub, configDir);
  return spawnClaudeAgents(configDir, source, bin);
}

/** The `bin` of the claude-code harness whose config dir is `configDir`. */
function harnessBinFor(
  configDir: string,
  harnesses: readonly ClaudeHarnessRef[],
  discovery: { homeDir?: string; env?: Record<string, string | undefined> },
): string | null {
  const real = safeRealpath(configDir);
  for (const harness of harnesses) {
    if (harness.kind !== "claude-code" || !harness.bin) continue;
    const effective = effectiveClaudeConfigDir(harness.home, { homeDir: discovery.homeDir, env: discovery.env ?? process.env });
    if (safeRealpath(effective) === real) return harness.bin;
  }
  return null;
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
      parsed = JSON.parse(readTextNoFollow(path.join(dir, name)));
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

/** Probe each config dir with `claude agents --json`, using the matching
 *  harness's `bin` when it has one, and cache the answer. */
export async function refreshClaudeSessionLiveness(
  configDirs: readonly string[],
  env?: Record<string, string | undefined>,
  harnesses: readonly ClaudeHarnessRef[] = [],
  homeDir?: string,
): Promise<void> {
  for (const dir of configDirs) {
    const bin = harnessBinFor(dir, harnesses, { homeDir, env });
    const listed = await defaultListLive(dir, env, bin);
    const key = safeRealpath(dir);
    if (listed === null) {
      livenessCache.delete(key);
      continue;
    }
    const byId = new Map<string, LiveInfo>();
    for (const agent of listed) {
      byId.set(agent.sessionId, { kind: agent.kind, background: isBackgroundKind(agent.kind) });
    }
    livenessCache.set(key, { byId, at: Date.now() });
  }
}

/** When the oldest cached probe among `configDirs` ran, or null when any of
 *  them has none. A list serves this cache, so a caller can re-check when
 *  the answer is missing or old. */
export function claudeSessionLivenessCheckedAt(configDirs: readonly string[]): number | null {
  let oldest: number | null = null;
  for (const dir of configDirs) {
    const entry = livenessCache.get(safeRealpath(dir));
    if (!entry) return null;
    oldest = oldest === null ? entry.at : Math.min(oldest, entry.at);
  }
  return oldest;
}

/** Test seam. Production never needs to drop the cache. */
export function clearClaudeSessionLivenessCache(): void {
  livenessCache.clear();
}

/** Test seam: forget every parsed transcript. */
export function clearClaudeSessionMetaCache(): void {
  metaCache.clear();
}

/**
 * Stream a transcript into the shared meta reader, yielding at least every
 * {@link SLICE_MS} so one large JSONL does not hold the main thread. Same
 * fields as `readClaudeSessionMeta`, including the last `gitBranch`.
 */
export async function readClaudeSessionMetaFile(file: string): Promise<ClaudeSessionMeta> {
  const reader = createClaudeSessionMetaReader();
  // The fd is opened no-follow (a planted symlink throws ELOOP here); the
  // stream owns and closes it.
  const input = createReadStream("", { fd: openReadNoFollow(file) });
  const rl = createInterface({ input, crlfDelay: Infinity });
  let sliceStart = Date.now();
  try {
    for await (const line of rl) {
      reader.push(line);
      if (Date.now() - sliceStart >= SLICE_MS) {
        await new Promise((resolve) => setImmediate(resolve));
        sliceStart = Date.now();
      }
    }
  } finally {
    rl.close();
    input.destroy();
  }
  return reader.finish();
}

/** Launch cwd from the first complete lines of a transcript, or null when
 *  the head holds none. Synchronous: one bounded read. */
function peekFirstCwd(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, READ_NOFOLLOW);
    const buf = Buffer.alloc(PEEK_BYTES);
    const n = readSync(fd, buf, 0, PEEK_BYTES, 0);
    const lines = buf.subarray(0, n).toString("utf8").split("\n");
    // A full buffer can end mid-line. That piece is not parsed.
    if (n === PEEK_BYTES) lines.pop();
    const reader = createClaudeSessionMetaReader();
    for (const line of lines) {
      reader.push(line);
      const cwd = reader.finish().cwd;
      if (cwd) return cwd;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

async function gitHeadBranch(cwd: string): Promise<string | null> {
  try {
    // coreSpawn: the transcript's cwd is a repo whose git config an agent can
    // plant (`core.fsmonitor`); it must not run with Agetor's identity.
    const proc = coreSpawn(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      stdout: "pipe",
      stderr: "ignore",
    }) as Bun.Subprocess<"ignore", "pipe", "ignore">;
    // A folder on a slow or unmounted volume must not hold the list.
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, GIT_BRANCH_TIMEOUT_MS);
    try {
      const text = (await new Response(proc.stdout).text()).trim();
      const code = await proc.exited;
      if (code !== 0 || !text || text === "HEAD") return null;
      return text;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** Fill `liveBranch` / `branchMismatch`. One `git` per distinct cwd, a few
 *  at a time. A missing folder has no branch to read. */
async function fillLiveBranches(records: readonly ClaudeSessionRecord[]): Promise<void> {
  const byCwd = new Map<string, ClaudeSessionRecord[]>();
  for (const record of records) {
    if (record.blockedReason === "missing-folder") continue;
    const group = byCwd.get(record.cwd);
    if (group) group.push(record);
    else byCwd.set(record.cwd, [record]);
  }
  const cwds = [...byCwd.keys()];
  let next = 0;
  const worker = async () => {
    while (next < cwds.length) {
      const cwd = cwds[next++]!;
      const liveBranch = await gitHeadBranch(cwd);
      for (const record of byCwd.get(cwd)!) {
        record.liveBranch = liveBranch;
        record.branchMismatch = record.gitBranch !== null && liveBranch !== null && record.gitBranch !== liveBranch;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(GIT_BRANCH_CONCURRENCY, cwds.length) }, worker));
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
  // Facts about the folder, not the process. A re-check does not clear them.
  if (record.blockedReason === "long-path" || record.blockedReason === "missing-folder") {
    record.importable = false;
    return;
  }
  // A second stamp (the commit re-check, after the transcript read) must drop
  // a "live" reason from the probe that ran before that read.
  if (record.blockedReason === "live") record.blockedReason = null;
  if (record.liveness === "live") record.blockedReason = "live";
  else if (!record.harnessId && record.blockedReason === null) record.blockedReason = "no-harness";
  record.importable = record.blockedReason === null && record.liveness === "idle";
}

function stampLiveness(
  record: ClaudeSessionRecord,
  known: boolean,
  agentInfo: LiveInfo | undefined,
  regInfo: LiveInfo | undefined,
  registryKind: string | null | undefined,
): void {
  const background = isBackgroundKind(registryKind) || (agentInfo?.background ?? false);
  if (agentInfo && background && !agentInfo.background) agentInfo.background = true;
  applyLiveness(record, known, agentInfo, regInfo);
  if (background && record.liveness === "live") {
    record.liveHint = `claude stop ${record.sessionId}`;
  }
}

async function readAgentMap(
  configDir: string,
  opts: ScanClaudeSessionsOptions,
): Promise<{ known: boolean; agentMap: Map<string, LiveInfo> | null }> {
  if (opts.listLive) {
    const agentMap = new Map<string, LiveInfo>();
    try {
      for (const agent of await opts.listLive(configDir)) {
        agentMap.set(agent.sessionId, { kind: agent.kind, background: isBackgroundKind(agent.kind) });
      }
      return { known: true, agentMap };
    } catch {
      return { known: false, agentMap: null };
    }
  }
  const cached = livenessCache.get(safeRealpath(configDir));
  if (!cached) return { known: false, agentMap: null };
  return { known: true, agentMap: cached.byId };
}

/** Re-read liveness for records whose transcripts were already parsed.
 *  The list and the first pass of a commit snapshot agents and the registry
 *  before `readClaudeSessionMetaFile`. A session that starts during that
 *  read must be refused. Does not parse JSONL again. */
export async function recheckClaudeSessionLiveness(
  records: Iterable<ClaudeSessionRecord>,
  opts: ScanClaudeSessionsOptions,
): Promise<void> {
  const byDir = new Map<string, ClaudeSessionRecord[]>();
  for (const record of records) {
    const group = byDir.get(record.configDir);
    if (group) group.push(record);
    else byDir.set(record.configDir, [record]);
  }
  if (byDir.size === 0) return;
  if (!opts.listLive) {
    await refreshClaudeSessionLiveness([...byDir.keys()], opts.env, opts.harnesses, opts.homeDir);
  }
  for (const [configDir, group] of byDir) {
    const { known, agentMap } = await readAgentMap(configDir, opts);
    const registry = await (opts.readRegistry ?? readClaudeRegistry)(configDir);
    const regLive = await registryLive(registry, opts);
    const registryById = new Map(registry.map((r) => [r.sessionId, r]));
    for (const record of group) {
      const reg = registryById.get(record.sessionId);
      stampLiveness(record, known, agentMap?.get(record.sessionId), regLive.get(record.sessionId), reg?.kind);
    }
  }
}

/** Absolute cwd under an Agetor worktree root, or an Agetor temp dir. */
function cwdHidden(cwd: string, opts: ScanClaudeSessionsOptions): boolean {
  if ((opts.worktreeRoots ?? []).some((root) => underRoot(cwd, root))) return true;
  return isTempAgetorCwd(cwd);
}

/** Encoded project-dir prefixes of the hidden roots. Claude names a project
 *  dir by its cwd's plain encoding, so a dir under a hidden root starts with
 *  one of these. The encoding is lossy (`worktrees-x` shares the prefix), so
 *  a match only earns a head peek, never a skip on its own. */
function hiddenDirPrefixes(opts: ScanClaudeSessionsOptions): string[] {
  const roots = [...(opts.worktreeRoots ?? []), tmpdir()];
  const prefixes = new Set<string>();
  for (const root of roots) {
    for (const form of [path.resolve(root), safeRealpath(root)]) {
      prefixes.add(`${plainEncodedProjectPath(form)}-`);
    }
  }
  return [...prefixes];
}

/** Cached or freshly parsed meta for one transcript. `"hidden"` when a head
 *  peek already shows a hidden cwd (list mode only). Null when unreadable. */
async function loadMeta(
  jsonlPath: string,
  dirName: string,
  hidePrefixes: readonly string[],
  opts: ScanClaudeSessionsOptions,
): Promise<{ meta: ClaudeSessionMeta; mtime: number } | "hidden" | null> {
  let st: ReturnType<typeof statSync>;
  try { st = lstatSync(jsonlPath); } catch { return null; }
  // A planted symlink is never read (no-follow.ts); Claude writes regular files.
  if (!st.isFile()) return null;
  let entry = metaCache.get(jsonlPath);
  if (!entry || entry.size !== st.size || entry.mtimeMs !== st.mtimeMs) {
    entry = { size: st.size, mtimeMs: st.mtimeMs, meta: null };
    metaCache.set(jsonlPath, entry);
  }
  if (!entry.meta && hidePrefixes.some((prefix) => dirName.startsWith(prefix))) {
    if (entry.headCwd === undefined) entry.headCwd = peekFirstCwd(jsonlPath);
    if (entry.headCwd && cwdHidden(entry.headCwd, opts)) return "hidden";
  }
  if (!entry.meta) {
    opts.onJsonlRead?.(jsonlPath);
    try {
      entry.meta = await readClaudeSessionMetaFile(jsonlPath);
    } catch {
      metaCache.delete(jsonlPath);
      return null;
    }
  }
  return { meta: entry.meta, mtime: st.mtimeMs };
}

function folderExists(cwd: string): boolean {
  try {
    return statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

async function collect(opts: ScanClaudeSessionsOptions): Promise<Collected[]> {
  const encode = opts.encodePath ?? (await import("./claude-tmux.ts")).encodeProjectPath;
  const harnesses = opts.harnesses ?? [];
  // A full list may skip what it will hide anyway. A lookup by id must still
  // find owned and hidden sessions (the commit path refuses them by name).
  const listMode = !opts.onlySessionIds;
  const hidePrefixes = listMode ? hiddenDirPrefixes(opts) : [];
  const folders = new Map<string, boolean>();
  const visited = new Set<string>();
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

    const { known, agentMap } = await readAgentMap(configDir, opts);
    const regLive = await registryLive(registry, opts);

    for (const dirName of projectDirs) {
      const dirPath = path.join(projects, dirName);
      let st: ReturnType<typeof statSync>;
      // lstat: a project dir planted as a symlink into a protected folder is
      // skipped, never listed in-process (no-follow.ts).
      try { st = lstatSync(dirPath); } catch { continue; }
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
        if (opts.onlySessionIds && !opts.onlySessionIds.has(sessionId)) continue;
        if (listMode && opts.ownedSessionIds?.has(sessionId)) continue;
        visited.add(jsonlPath);
        const loaded = await loadMeta(jsonlPath, dirName, hidePrefixes, opts);
        if (loaded === null || loaded === "hidden") continue;
        const { meta, mtime } = loaded;
        if (!meta.cwd) continue;
        const unresolved = claudeProjectDirUnresolved(meta.cwd, dirName, encode);
        let folderOk = folders.get(meta.cwd);
        if (folderOk === undefined) {
          folderOk = folderExists(meta.cwd);
          folders.set(meta.cwd, folderOk);
        }
        const reg = registryById.get(sessionId);
        const record: ClaudeSessionRecord = {
          sessionId,
          configDir,
          cwd: meta.cwd,
          title: meta.title ?? "Untitled session",
          gitBranch: meta.gitBranch,
          liveBranch: null,
          branchMismatch: false,
          model: meta.model,
          lastActivity: meta.lastTimestamp ?? mtime,
          messageCount: meta.messageCount,
          liveness: "unknown",
          liveHint: null,
          importable: false,
          blockedReason: unresolved ? "long-path" : folderOk ? null : "missing-folder",
          harnessId,
          jsonlPath,
          permissionMode: meta.permissionMode,
          firstHumanPrompt: meta.firstHumanPrompt,
          continuedIn: meta.continuedIn,
        };
        stampLiveness(record, known, agentMap?.get(sessionId), regLive.get(sessionId), reg?.kind);
        out.push({
          record,
          ownedTmux: ownedTmux.has(sessionId),
          continued: meta.continuedIn !== null,
          noUser: !meta.hasUser,
        });
      }
    }
  }
  if (listMode) {
    for (const cached of metaCache.keys()) {
      if (!visited.has(cached)) metaCache.delete(cached);
    }
  }
  return out;
}

function shouldHide(item: Collected, opts: ScanClaudeSessionsOptions): boolean {
  const { record } = item;
  if (item.noUser) return true;
  if (opts.ownedSessionIds?.has(record.sessionId)) return true;
  if (cwdHidden(record.cwd, opts)) return true;
  if (item.ownedTmux) return true;
  if (item.continued) return true;
  return false;
}

/** List candidates, newest first. Does not spawn `claude`. */
export async function scanClaudeSessions(opts: ScanClaudeSessionsOptions): Promise<ClaudeSessionCandidate[]> {
  const items = await collect(opts);
  const visible = items.filter((item) => !shouldHide(item, opts));
  await fillLiveBranches(visible.map((item) => item.record));
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

/** Sessions by id, including rows the list hides (owned, live, long-path).
 *  One directory walk, and only the named JSONL files are parsed. */
export async function findClaudeSessions(
  sessionIds: ReadonlySet<string>,
  opts: ScanClaudeSessionsOptions,
): Promise<Map<string, ClaudeSessionRecord>> {
  const out = new Map<string, ClaudeSessionRecord>();
  if (sessionIds.size === 0) return out;
  const items = await collect({ ...opts, onlySessionIds: sessionIds });
  for (const item of items) {
    const prev = out.get(item.record.sessionId);
    if (!prev || item.record.lastActivity >= prev.lastActivity) out.set(item.record.sessionId, item.record);
  }
  await fillLiveBranches([...out.values()]);
  return out;
}

/** One session by id, including rows the list hides (owned, live, long-path).
 *  Returns null when the id is not on disk. */
export async function findClaudeSession(
  sessionId: string,
  opts: ScanClaudeSessionsOptions,
): Promise<ClaudeSessionRecord | null> {
  const found = await findClaudeSessions(new Set([sessionId]), opts);
  return found.get(sessionId) ?? null;
}

/**
 * The harness mirror (docs/architecture/harness-stacks.md, plan T04/D12).
 *
 * A stack mirrors user-level config from the primary (position 0) onto its
 * backups so a failover keeps the same skills, commands, MCP servers, plugins
 * and settings. Each account keeps its own login: harness credential files are
 * never copied, the primary's provider credential and provider-selector env
 * keys are never imported into a merged `settings.json`, and the primary's
 * Codex login/provider keys and `[model_providers.*]` tables are never
 * imported into `config.toml` — a backup's own values survive.
 *
 * Safe mode skips settings hooks, permissions and every command setting
 * (status lines, file suggestion, process wrapper, policy and credential
 * helpers; Codex: notify) and every env var that runs a command
 * (`NODE_OPTIONS`, `BASH_ENV`, `*_HELPER`, …); plugins and MCP servers are
 * still mirrored. Full mode copies them, and the primary's `hooks`/
 * `permissions` objects replace the backup's. Login and login-selecting
 * settings (`apiKeyHelper`, `forceLoginMethod`, the AWS/GCP/proxy auth
 * helpers, …) never cross in either mode.
 *
 * Every account root is resolved lexically before the mirror touches it, and a
 * root that now resolves into a macOS-protected home folder it was not saved
 * under is refused (contract CR4); symlinked skills are resolved the same way
 * and never into a protected folder.
 *
 * Recorded, reversible, previewable (plan D7-D11). Every phase first DECIDES
 * what it would do and then applies it through one effect layer
 * (`MirrorCtx.dry`): a dry run records the decisions into a `MirrorPlan` and
 * writes nothing, a real run performs them and records provenance
 * (`harness_mirror_provenance`) for every file, merged key and link it wrote.
 * Provenance rows are UNTRUSTED on use: every removal or restore re-checks the
 * path (below the root, no symlinked component, regular file, mirror-allowlist
 * shape) and the current hash. The rules:
 * - An item the mirror wrote that the primary no longer has is removed only
 *   while its current hash still equals the recorded one. An edited item is
 *   kept (warning, ownership dropped).
 * - An item that PREEXISTED on the backup (different content, no row) is never
 *   removed by propagation: ownership is dropped and the backup's value stays.
 *   A primary deletion must not resurrect the backup's old value.
 * - The first overwrite of a preexisted item saves the original under the data
 *   dir (`harness-mirror-backup.ts`), once; `restoreMirror` puts it back.
 * - An identical item the backup already had is not recorded (the mirror did
 *   not write it, so it never removes it).
 * - A primary that cannot be read (missing/unsafe file, truncated tree, refused
 *   symlink) never counts as a deletion.
 *
 * A mirror is idempotent and cheap to repeat: a copied file keeps the source's
 * mtime and an unchanged destination (same size + mtime, or the recorded source
 * size/mtime plus the recorded hash) is not rewritten, a merged file whose
 * result equals the backup's current text is not rewritten, and
 * `mirrorForSwap` is single-flight per destination account. Work on one
 * destination (mirror, preview, restore) is serialized, so a stack save and a
 * swap never write the same account at once.
 *
 * Failures are warnings, never blocks: a task must still be able to fail over
 * when a mirror cannot read one directory.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { openReadNoFollow, READ_NOFOLLOW } from "./no-follow.ts";
import {
  FULL_MODE_REPLACED_SETTINGS_KEYS,
  MIRROR_PAYLOAD_LIMITS,
  MIRROR_SPECS,
  SAFE_MODE_EXCLUDED_CODEX_KEYS,
  SAFE_MODE_EXCLUDED_SETTINGS_KEYS,
  isCodexLoginBearingKeyPath,
  isCodexSecretKeyPath,
  isCommandRunningEnvKey,
  isMirrorCopyShape,
  containsUrlUserinfo,
  isMirrorNeverImportedEnvEntry,
  isMirrorNeverImportedEnvKey,
  isMirrorNeverImportedSettingsKey,
  isNeverCopyPath,
  isNeverCopySegment,
  type HarnessMirrorSpec,
} from "../shared/harness-mirror.ts";
import type {
  Harness,
  HarnessMirrorMode,
  HarnessStack,
  HarnessStackKind,
  MirrorPlan,
  MirrorPreview,
  MirrorRestoreResult,
} from "../shared/types.ts";
import {
  assertNotCredentialPath,
  atomicWriteFile,
  canonicalRoot,
  copyRegularFileDetailed,
  destinationState,
  ensurePlainDirUnder,
  isPlainAncestorPathUnder,
  isPlainDir,
  isPlainPathUnder,
  isRegularFileNoFollow,
  resolvePathLexically,
  rootsRedirectRefusal,
  sameConfigRoot,
} from "./harness-file-transfer.ts";
import {
  backupFileOriginal,
  backupKeyOriginal,
  backupLinkOriginal,
  fileBackupRef,
  linkRef,
  readBackup,
  readBackupMode,
  readKeyBackup,
  removeBackupEntry,
  removeMirrorBackups,
} from "./harness-mirror-backup.ts";
import {
  isUnownedRow,
  mirrorProvenance,
  mirrorSources,
  UNOWNED_STAMP,
  type MirrorProvenanceRow,
} from "./harness-mirror-provenance.ts";
import { nonBlankRootValue, ROOT_ENV_KEYS } from "../shared/harness-config-root.ts";
import { claudeConfigDirFor, claudeJsonDirFor, codexHomeFor } from "./harness-stacks.ts";
import { dataDir, harnesses } from "./db.ts";

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

/** Where a provenance path is rooted: `.claude.json` sits in the account's
 *  pinned `.claude.json` directory, everything else under the config root. */
function baseForPath(harness: Harness, rel: string): string {
  return harness.kind === "claude-code" && rel === ".claude.json" ? claudeJsonDirFor(harness) : mirrorRootFor(harness);
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

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

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
  const targetIds = stack.members
    .filter((m) => m.harnessId !== primaryMember.harnessId)
    .filter((m) => opts.targetHarnessId === undefined || m.harnessId === opts.targetHarnessId)
    .map((m) => ({ id: m.harnessId, label: m.label }));
  const run = await runMirror({
    primaryId: primaryMember.harnessId,
    targets: targetIds,
    safe: stack.mirrorMode === "safe",
    stackId: stack.id,
    dry: false,
    copyLimits: opts.copyLimits,
  });
  if (run.fatal) return { copied, warnings: [run.fatal] };
  for (const one of run.results) {
    copied.push(...one.copied.map((p) => `${one.harnessId}:${p}`));
    warnings.push(...one.warnings.map((w) => `${one.label}: ${w}`));
  }
  return { copied, warnings };
}

/**
 * Dry run of {@link mirrorStack} for a draft stack (plan D10): the same code
 * path with the effect layer switched to "record into a plan", so the preview
 * is exactly what a real run would do. Nothing is written, no provenance row
 * is touched. `members` are harness ids, the first is the primary. Names only:
 * a plan never carries a value. `overwrites` is true when any plan backs up an
 * original or removes something.
 */
export async function previewMirror(
  draft: { kind: HarnessStackKind; members: string[]; mirrorMode: HarnessMirrorMode },
  opts: { stackId?: string } = {},
): Promise<MirrorPreview> {
  const [primaryId, ...rest] = draft.members;
  if (!primaryId) return { plans: [], overwrites: false };
  const run = await runMirror({
    primaryId,
    targets: rest.filter((id) => id !== primaryId).map((id) => ({ id, label: id })),
    safe: draft.mirrorMode === "safe",
    stackId: opts.stackId ?? null,
    dry: true,
    expectKind: draft.kind,
  });
  const plans = run.results.map((r) => r.plan);
  if (run.fatal) {
    plans.unshift({ ...emptyPlan(primaryId, primaryId), warnings: [run.fatal] });
  }
  const overwrites = plans.some(
    (p) => p.backups.length > 0 || p.files.remove.length > 0 || p.keys.some((k) => k.action === "remove"),
  );
  return { plans, overwrites };
}

interface MirrorRunInput {
  primaryId: string;
  targets: Array<{ id: string; label: string }>;
  safe: boolean;
  stackId: string | null;
  dry: boolean;
  copyLimits?: MirrorOptions["copyLimits"];
  expectKind?: HarnessStackKind;
}

interface OneResult extends MirrorResult {
  harnessId: string;
  label: string;
  plan: MirrorPlan;
}

async function runMirror(input: MirrorRunInput): Promise<{ results: OneResult[]; fatal: string | null }> {
  const results: OneResult[] = [];
  const primary = harnesses.getByIdOrKind(input.primaryId);
  if (!primary) return { results, fatal: `primary account ${input.primaryId} no longer exists` };
  const kind = primary.kind;
  if (kind !== "claude-code" && kind !== "codex") {
    return { results, fatal: `${kind} accounts do not support mirroring in this version` };
  }
  if (input.expectKind && input.expectKind !== kind) {
    return { results, fatal: `the primary account is a ${kind} account, not ${input.expectKind}` };
  }
  const spec = MIRROR_SPECS[kind];
  for (const member of input.targets) {
    const target = harnesses.getByIdOrKind(member.id);
    if (!target) {
      const plan = emptyPlan(member.id, member.label);
      plan.warnings.push("account no longer exists");
      results.push({ copied: [], warnings: plan.warnings, harnessId: member.id, label: member.label, plan });
      continue;
    }
    if (target.id === primary.id) continue;
    const label = target.label;
    try {
      const one = await serializeForDestination(target.id, () =>
        mirrorOne(primary, target, kind, spec, input.safe, input.copyLimits, input.dry, input.stackId));
      results.push({ ...one, harnessId: target.id, label });
    } catch (err) {
      const plan = emptyPlan(target.id, label);
      const message = `mirror failed — ${err instanceof Error ? err.message : String(err)}`;
      plan.warnings.push(message);
      results.push({ copied: [], warnings: [message], harnessId: target.id, label, plan });
    }
  }
  return { results, fatal: null };
}

function emptyPlan(harnessId: string, label: string): MirrorPlan {
  return { harnessId, label, files: { add: [], update: [], remove: [] }, keys: [], backups: [], kept: [], warnings: [] };
}

/** The tail of the work queued for each destination account. Every mirror
 *  write to one account runs after the previous one settled, so a stack save
 *  and a swap (or two swaps) never interleave writes into the same files. */
const destinationTails = new Map<string, Promise<void>>();

function serializeForDestination<T>(harnessId: string, work: () => Promise<T>): Promise<T> {
  const previous = destinationTails.get(harnessId) ?? Promise.resolve();
  const run = previous.then(work);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  destinationTails.set(harnessId, tail);
  void tail.then(() => {
    if (destinationTails.get(harnessId) === tail) destinationTails.delete(harnessId);
  });
  return run;
}

/** In-flight `mirrorForSwap` per destination account (contract C4). */
const swapMirrorsInFlight = new Map<string, Promise<MirrorResult>>();

/**
 * Mirror `targetHarnessId` from the stack's primary, if both exist.
 *
 * Single-flight per destination: every account move (automatic swap, retry,
 * manual move, boot switch) calls this, and N tasks failing over onto one
 * backup at once would otherwise copy the same tree N times concurrently. A
 * caller that arrives while a mirror into the same account is running gets
 * that same promise; a call after it settled runs a fresh mirror (which skips
 * every unchanged file, so it is cheap).
 */
export function mirrorForSwap(
  stack: HarnessStack,
  targetHarnessId: string,
): Promise<MirrorResult> {
  const existing = swapMirrorsInFlight.get(targetHarnessId);
  if (existing) return existing;
  const promise: Promise<MirrorResult> = mirrorStack(stack, { targetHarnessId }).finally(() => {
    if (swapMirrorsInFlight.get(targetHarnessId) === promise) swapMirrorsInFlight.delete(targetHarnessId);
  });
  swapMirrorsInFlight.set(targetHarnessId, promise);
  return promise;
}

export { removeMirrorBackups };

/**
 * Delete everything the mirror keeps for one account: its provenance rows and
 * its saved originals. Runs inside the account's mirror queue, so it waits for
 * a mirror or Restore already writing into the account and nothing is
 * recreated after it. Safe for an id that no longer exists; never throws.
 */
export function deleteMirrorStateForHarness(harnessId: string): Promise<void> {
  return serializeForDestination(harnessId, async () => {
    try {
      mirrorProvenance.deleteForHarness(harnessId);
      mirrorSources.deleteForHarness(harnessId);
    } catch (err) {
      console.warn(`[harness-mirror] could not drop provenance for a deleted account: ${err instanceof Error ? err.message : String(err)}`);
    }
    await removeMirrorBackups(harnessId);
  });
}

// ---------------------------------------------------------------------------
// The run context: decisions go in, effects come out
// ---------------------------------------------------------------------------

const YIELD_EVERY_MS = 20;

interface MirrorCtx {
  /** Dry run: record into `plan`, write nothing (files, backups, provenance). */
  dry: boolean;
  harnessId: string;
  stackId: string | null;
  kind: HarnessStackKind;
  safe: boolean;
  fromRoot: string;
  toRoot: string;
  guard: LinkGuard;
  /** The primary's config root is a plain directory, so a missing item there is
   *  a real deletion rather than an unreadable account. */
  propagate: boolean;
  rows: Map<string, MirrorProvenanceRow>;
  plan: MirrorPlan;
  copied: string[];
  warnings: string[];
  lastYield: number;
  /** The destination account was deleted while this run was in flight. */
  gone?: boolean;
}

const rowId = (p: string, key: string) => `${p}\u0000${key}`;

function getRow(ctx: MirrorCtx, p: string, key = ""): MirrorProvenanceRow | undefined {
  return ctx.rows.get(rowId(p, key));
}

/** True while the destination account still exists. A mirror in flight when
 *  the account is deleted must not recreate its provenance or backups; the
 *  first check that finds it gone says so once. */
function accountAlive(ctx: MirrorCtx): boolean {
  if (ctx.dry) return true;
  if (ctx.gone) return false;
  if (harnesses.getByIdOrKind(ctx.harnessId)) return true;
  ctx.gone = true;
  warn(ctx, "this account was deleted during the mirror — it stopped writing");
  return false;
}

function putRow(ctx: MirrorCtx, row: Omit<MirrorProvenanceRow, "harnessId" | "stackId" | "updatedAt">): void {
  if (ctx.dry) return;
  if (!accountAlive(ctx)) return;
  const full: MirrorProvenanceRow = { ...row, harnessId: ctx.harnessId, stackId: ctx.stackId, updatedAt: Date.now() };
  mirrorProvenance.upsert(full);
  ctx.rows.set(rowId(row.path, row.key), full);
}

/** End the mirror's ownership of an item. A row whose item was the account's
 *  own before the mirror (`preexisted`, with a saved original) is KEPT as an
 *  un-owned restore pointer: propagation and the mirror skip it, a later write
 *  re-adopts it with the original intact, and Restore still puts the original
 *  back. Any other row goes, with its saved original (so an orphaned backup can
 *  never shadow a later, different original). `purge` drops the row whatever
 *  it is (a row that is garbage: an invalid shape). */
async function dropRow(ctx: MirrorCtx, p: string, key = "", purge = false): Promise<void> {
  if (ctx.dry) return;
  const row = ctx.rows.get(rowId(p, key));
  if (row && !purge && row.preexisted && row.backupRef) {
    if (!isUnownedRow(row)) {
      putRow(ctx, {
        scope: row.scope, path: p, key, valueHash: row.valueHash,
        srcMtimeMs: UNOWNED_STAMP, srcSize: UNOWNED_STAMP, preexisted: true, backupRef: row.backupRef,
      });
    }
    return;
  }
  mirrorProvenance.remove(ctx.harnessId, p, key);
  ctx.rows.delete(rowId(p, key));
  if (row?.backupRef) await removeBackupEntry(ctx.harnessId, row.scope, p, key);
}

function warn(ctx: MirrorCtx, message: string): void {
  ctx.warnings.push(message);
  ctx.plan.warnings.push(message);
}

async function tick(ctx: MirrorCtx): Promise<void> {
  if (Date.now() - ctx.lastYield >= YIELD_EVERY_MS) {
    await Bun.sleep(0);
    ctx.lastYield = Date.now();
  }
}

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** Stable JSON: object keys sorted, so a value hashes the same wherever it
 *  came from. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const hashValue = (value: unknown): string => sha256(canonicalJson(value));

/** sha256 of a regular file, read without following a final symlink, in
 *  chunks with a yield, so a large skill asset cannot block the event loop. */
async function hashFile(p: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(p, READ_NOFOLLOW);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Error(`not a regular file: ${p}`);
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let pos = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, pos);
      if (bytesRead <= 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      pos += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function sameMtime(a: number, b: number): boolean {
  return Math.abs(a - b) < 1;
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  // `obj["__proto__"] = x` would set the prototype instead of a key.
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

const UNSAFE_KEYS = new Set(["__proto__"]);

// ---------------------------------------------------------------------------
// One destination account
// ---------------------------------------------------------------------------

/** Top-level files the user may keep as symlinks into a dotfiles repo (stow,
 *  chezmoi, home-manager). They are resolved lexically like `linkTopLevel`. */
const DOTFILE_ENTRIES: readonly string[] = ["CLAUDE.md", "AGENTS.md", "settings.json", "config.toml", ".claude.json"];

async function mirrorOne(
  primary: Harness,
  target: Harness,
  kind: HarnessStackKind,
  spec: HarnessMirrorSpec,
  safe: boolean,
  copyLimits: MirrorOptions["copyLimits"],
  dry: boolean,
  stackId: string | null,
): Promise<MirrorResult & { plan: MirrorPlan }> {
  const plan = emptyPlan(target.id, target.label);
  const fromRoot = mirrorRootFor(primary);
  const toRoot = mirrorRootFor(target);
  const refuse = (message: string) => {
    plan.warnings.push(message);
    return { copied: [], warnings: [message], plan };
  };
  // Contract CR4: a root gated when the account was saved may since have been
  // replaced by a symlink into a macOS-protected folder. Resolve every root
  // the mirror reads or writes lexically (no stat inside the target) before
  // anything else touches it, including the realpath below.
  const redirected = rootsRedirectRefusal([
    [fromRoot, "the primary's config directory"],
    [toRoot, "this account's config directory"],
    ...(kind === "claude-code"
      ? [
        [claudeJsonDirFor(primary), "the primary's .claude.json directory"] as const,
        [claudeJsonDirFor(target), "this account's .claude.json directory"] as const,
      ]
      : []),
  ]);
  if (redirected) return refuse(redirected);
  // realpath, not `path.resolve`: an account edited after the stack was saved
  // can alias another member's root through a symlink. Mirroring onto itself
  // would rewrite the primary's own files.
  if (sameConfigRoot(fromRoot, toRoot)) return refuse("source and destination share a config directory");
  // Roots a re-created symlink must never expose (see `linkTopLevelSymlinks`).
  const guard: LinkGuard = {
    kind,
    configRoots: [canonicalRoot(fromRoot), canonicalRoot(toRoot)],
    accountDirs: kind === "claude-code"
      ? [canonicalRoot(claudeJsonDirFor(primary)), canonicalRoot(claudeJsonDirFor(target))]
      : [],
  };
  // Deletion propagation trusts that the primary's folder is the one the last
  // run read. The same primary, with unchanged root settings, resolving to a
  // different folder means the core's environment changed, not the user's
  // files: copy as usual, but remove nothing (and keep the recorded folder).
  const source = primarySourceOf(primary, fromRoot);
  const recorded = mirrorSources.get(target.id);
  const rootMoved = recorded !== null
    && recorded.primaryId === primary.id
    && recorded.primaryConfig === source.primaryConfig
    && recorded.primaryRoot !== source.primaryRoot;
  const ctx: MirrorCtx = {
    dry,
    harnessId: target.id,
    stackId,
    kind,
    safe,
    fromRoot,
    toRoot,
    guard,
    propagate: isDirectory(fromRoot) && !rootMoved,
    rows: new Map(mirrorProvenance.list(target.id).map((r) => [rowId(r.path, r.key), r] as const)),
    plan,
    copied: [],
    warnings: [],
    lastYield: Date.now(),
  };
  if (rootMoved) {
    warn(
      ctx,
      `the primary account's config folder is now ${fromRoot}, but it was ${recorded.primaryRoot.split("\n")[0]} on the last mirror and the account's settings did not change (Agetor was probably started with a different ${kind === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"}): nothing is removed from this account until it resolves back, or give the primary account its own config folder`,
    );
  }

  // 1. Copy the allowlisted dirs/files verbatim FIRST, so the registry merge
  //    below can tell whether the payload it points at was copied completely.
  //    An incomplete payload plus a rewritten registry is worse than no
  //    registry: the CLI would resolve plugins to files that do not exist.
  const incompletePayloads = new Set<string>();
  for (const rel of spec.copy) {
    try {
      await copyEntry(ctx, spec, rel, copyLimits, incompletePayloads);
    } catch (err) {
      warn(ctx, `${rel}: ${err instanceof Error ? err.message : String(err)}`);
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
        warn(ctx, `${rel}: symlinked parent directory refused`);
        continue;
      }
      if (rel === "settings.json") {
        await mergeClaudeSettings(ctx);
      } else if (rel === ".claude.json") {
        await mergeClaudeJson(ctx, primary, target);
      } else if (rel === "plugins/installed_plugins.json" || rel === "plugins/known_marketplaces.json") {
        const payload = rel === "plugins/installed_plugins.json" ? "plugins/cache" : "plugins/marketplaces";
        if (incompletePayloads.has(payload)) {
          warn(
            ctx,
            `${rel}: the ${payload} copy was incomplete — this account's registry was left untouched so it cannot point at missing files`,
          );
          continue;
        }
        await mergePluginRegistry(ctx, rel);
      } else if (rel === "config.toml") {
        await mergeCodexConfig(ctx);
      }
    } catch (err) {
      warn(ctx, `${rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Record the folder this run read, except when it was the unexpected one:
  // the recorded folder stays the reference until the primary resolves back
  // or its own settings change.
  if (!dry && !rootMoved && accountAlive(ctx)) {
    mirrorSources.set({ harnessId: target.id, ...source, updatedAt: Date.now() });
  }

  return { copied: ctx.copied, warnings: ctx.warnings, plan };
}

/** The primary's resolved folder(s) and a fingerprint of the settings that
 *  choose them (see {@link mirrorOne}). */
function primarySourceOf(primary: Harness, fromRoot: string): { primaryId: string; primaryRoot: string; primaryConfig: string } {
  const roots = [path.resolve(fromRoot)];
  if (primary.kind === "claude-code") roots.push(path.resolve(claudeJsonDirFor(primary)));
  const env: Record<string, string> = {};
  for (const key of ROOT_ENV_KEYS) {
    const value = primary.env?.[key];
    if (nonBlankRootValue(value)) env[key] = value;
  }
  return {
    primaryId: primary.id,
    primaryRoot: roots.join("\n"),
    primaryConfig: JSON.stringify({ home: nonBlankRootValue(primary.home) ? primary.home : null, env }),
  };
}

function isDirectory(p: string): boolean {
  try {
    // The root is trusted (it may be a user symlink) and has already passed the
    // protected-folder redirect gate; this asks only whether it is a directory.
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * One allowlist entry: a directory tree, a single file, or a dotfile symlink.
 */
async function copyEntry(
  ctx: MirrorCtx,
  spec: HarnessMirrorSpec,
  rel: string,
  copyLimits: MirrorOptions["copyLimits"],
  incompletePayloads: Set<string>,
): Promise<void> {
  assertNotCredentialPath(rel, ctx.kind);
  const from = path.join(ctx.fromRoot, rel);
  // A leaf `lstat` follows every parent, so a linked intermediate folder
  // (`plugins/` → outside the account) would hand back the target's
  // regular file. Refuse it before any stat/read.
  if (!isPlainAncestorPathUnder(ctx.fromRoot, from)) {
    warn(ctx, `${rel}: symlinked parent directory refused`);
    incompletePayloads.add(rel);
    return;
  }
  let st = lstatOrNull(from);
  let src = from;
  if (!st) {
    // Not present on the primary: a deletion, but only for an account whose
    // root is a real directory (an unmounted account is not a deletion).
    if (ctx.propagate) await propagateRemovals(ctx, rel, { complete: true });
    return;
  }
  if (st.isSymbolicLink()) {
    if (!DOTFILE_ENTRIES.includes(rel)) {
      warn(ctx, `${rel}: symlink refused`);
      incompletePayloads.add(rel);
      return;
    }
    const resolved = resolveDotfile(ctx, from, rel);
    if (!resolved.ok) {
      warn(ctx, `${rel}: ${resolved.reason}`);
      incompletePayloads.add(rel);
      return;
    }
    src = resolved.path;
    st = lstatOrNull(src);
    if (!st) return;
  }
  const toRel = rel;
  if (st.isDirectory()) {
    if (!isPlainDir(src)) {
      warn(ctx, `${rel}: not a plain directory`);
      incompletePayloads.add(rel);
      return;
    }
    const limits = { ...MIRROR_PAYLOAD_LIMITS[rel], ...copyLimits?.[rel] };
    const tree = await planTree(ctx, src, rel, limits);
    const visited = new Set<string>();
    const reasons = new Map<string, number>();
    for (const file of tree.files) {
      const fileRel = `${toRel}/${file.child}`;
      visited.add(fileRel);
      const result = await mirrorFile(ctx, fileRel, file.abs, file.st);
      if (result.reason) reasons.set(result.reason, (reasons.get(result.reason) ?? 0) + 1);
      await tick(ctx);
    }
    for (const [reason, count] of reasons) {
      warn(ctx, `${rel}: ${reason}${count > 1 ? ` (${count} files)` : ""}`);
    }
    if (tree.truncated) {
      incompletePayloads.add(rel);
      warn(ctx, `${rel}: copy hit its size/entry budget — the copy on this account is incomplete`);
    }
    // Top-level symlinked skills/commands/agents are re-created as links
    // on the backup instead of being skipped (the walk never follows them).
    const linkedNames = new Set<string>();
    if (spec.linkTopLevel.includes(rel)) {
      const links = await linkTopLevelSymlinks(ctx, src, rel);
      for (const name of links.handled) linkedNames.add(name);
    }
    const skipped = tree.skipped.filter((entry) => !linkedNames.has(entry));
    if (skipped.length > 0) {
      // Not silent: a never-copy cache, a symlink, a vanished entry or a
      // size/entry cap is exactly what a user needs to know did not move
      // (review nit).
      warn(
        ctx,
        `${rel}: skipped ${skipped.length} entr${skipped.length === 1 ? "y" : "ies"}`
        + " (symlink, never-copy cache, vanished entry, or size/entry cap)",
      );
    }
    if (ctx.propagate && !tree.truncated) {
      await propagateRemovals(ctx, rel, {
        complete: true,
        visited,
        skippedPrefixes: tree.skipped.map((s) => `${toRel}/${s}`),
        handledLinks: linkedNames,
      });
    }
  } else if (st.isFile()) {
    if (!isRegularFileNoFollow(src)) {
      warn(ctx, `${rel}: not a regular file`);
      incompletePayloads.add(rel);
      return;
    }
    const result = await mirrorFile(ctx, rel, src, st);
    if (result.reason) warn(ctx, `${rel}: ${result.reason}`);
  } else {
    warn(ctx, `${rel}: not a regular file or directory`);
    incompletePayloads.add(rel);
  }
}

interface PlannedFile {
  /** Relative to the tree root. */
  child: string;
  abs: string;
  st: Stats;
}

/** The files a copy of `srcDir` would visit, with the same rules as
 *  `copyTreeCooperative` (no symlinks, never-copy segments, one slot per
 *  entry, byte budget) but without writing: the effect layer applies them. */
async function planTree(
  ctx: MirrorCtx,
  srcDir: string,
  entryRel: string,
  limits: { maxBytes?: number; maxEntries?: number },
): Promise<{ files: PlannedFile[]; skipped: string[]; truncated: boolean }> {
  const maxBytes = limits.maxBytes ?? 64 * 1024 * 1024;
  const maxEntries = limits.maxEntries ?? 5_000;
  const files: PlannedFile[] = [];
  const skipped: string[] = [];
  let truncated = false;
  let bytes = 0;
  let entries = 0;
  if (!isPlainDir(srcDir)) return { files, skipped, truncated };
  const walk = async (rel: string): Promise<void> => {
    if (rel && entries >= maxEntries) {
      truncated = true;
      skipped.push(rel);
      return;
    }
    if (rel) {
      entries++;
      await tick(ctx);
    }
    if (rel && rel.split(/[\\/]+/).some((segment) => isNeverCopySegment(segment))) {
      skipped.push(rel);
      return;
    }
    if (rel) {
      // `child` is relative to `srcDir`, but the allowlist's never-copy
      // entries are root-relative ("plugins/store"): check the full path or a
      // nested store would slip through.
      try {
        assertNotCredentialPath(`${entryRel}/${rel}`, ctx.kind);
      } catch {
        skipped.push(rel);
        return;
      }
    }
    const abs = path.join(srcDir, rel);
    const st = lstatOrNull(abs);
    if (!st) {
      skipped.push(rel);
      return;
    }
    if (st.isSymbolicLink()) {
      skipped.push(rel);
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) await walk(rel ? path.join(rel, name) : name);
      return;
    }
    if (!st.isFile()) {
      skipped.push(rel);
      return;
    }
    if (bytes + st.size > maxBytes) {
      truncated = true;
      skipped.push(rel);
      return;
    }
    bytes += st.size;
    files.push({ child: rel, abs, st });
  };
  await walk("");
  return { files, skipped, truncated };
}

/**
 * Decide and apply one file: add, update or leave it. See the module comment
 * for the provenance rules. `reason` is set when the file was skipped.
 */
async function mirrorFile(
  ctx: MirrorCtx,
  rel: string,
  from: string,
  srcSt: Stats,
): Promise<{ outcome: "add" | "update" | "unchanged" | "skipped"; reason?: string }> {
  const to = path.join(ctx.toRoot, rel);
  const state = destinationState(ctx.toRoot, to);
  if (state === "unsafe") {
    return { outcome: "skipped", reason: "destination path goes through a symlink or non-directory — skipped" };
  }
  const row = getRow(ctx, rel);
  let existing: Stats | null = null;
  if (state === "present") {
    existing = lstatOrNull(to);
    if (existing?.isSymbolicLink()) {
      return { outcome: "skipped", reason: "destination is a symlink — kept, not replaced by a regular file" };
    }
    if (existing && !existing.isFile()) return { outcome: "skipped", reason: "destination is not a regular file — kept" };
  }
  const write = async (preexisted: boolean, backupRef: string | null, planned: "add" | "update") => {
    (planned === "add" ? ctx.plan.files.add : ctx.plan.files.update).push(rel);
    ctx.copied.push(rel);
    if (ctx.dry) return;
    await copyRegularFileDetailed(from, to, { root: ctx.toRoot, skipUnchanged: true });
    putRow(ctx, {
      scope: "file",
      path: rel,
      key: "",
      valueHash: await hashFile(to),
      srcMtimeMs: srcSt.mtimeMs,
      srcSize: srcSt.size,
      preexisted,
      backupRef,
    });
  };
  if (!existing) {
    await write(false, null, "add");
    return { outcome: "add" };
  }
  const srcMatchesRow = (r: MirrorProvenanceRow) =>
    r.srcSize === srcSt.size && r.srcMtimeMs !== null && sameMtime(r.srcMtimeMs, srcSt.mtimeMs);
  // Cheap equality first: every mirror write keeps the source's mtime.
  if (existing.size === srcSt.size && sameMtime(existing.mtimeMs, srcSt.mtimeMs)) {
    // A row left half-written by a crash (intent row: no source stamp) is
    // refreshed so Restore can still tell edits from the mirror's own bytes.
    if (row && !ctx.dry && !srcMatchesRow(row)) {
      putRow(ctx, {
        scope: "file", path: rel, key: "", valueHash: await hashFile(to),
        srcMtimeMs: srcSt.mtimeMs, srcSize: srcSt.size, preexisted: row.preexisted, backupRef: row.backupRef,
      });
    }
    return { outcome: "unchanged" };
  }
  let destHash: string | null = null;
  let edited = false;
  if (row) {
    destHash = await hashFile(to);
    if (srcMatchesRow(row) && destHash === row.valueHash) return { outcome: "unchanged" };
    edited = destHash !== row.valueHash;
  }
  if (!row || edited) {
    destHash ??= await hashFile(to);
    // Identical bytes: nothing to write (and nothing to back up).
    if (destHash === (await hashFile(from))) {
      if (row && !ctx.dry) {
        putRow(ctx, {
          scope: "file", path: rel, key: "", valueHash: destHash,
          srcMtimeMs: srcSt.mtimeMs, srcSize: srcSt.size, preexisted: row.preexisted, backupRef: row.backupRef,
        });
      }
      return { outcome: "unchanged" };
    }
  }
  // No row: the backup's own file (preexisted). A row whose bytes changed: the
  // account's edit; the primary still wins, but the edit is saved as the
  // original first, so Restore and the preview both see it.
  const preexisted = row ? row.preexisted || edited : true;
  let backupRef = row?.backupRef ?? null;
  if (!row || edited || (preexisted && !backupRef)) {
    ctx.plan.backups.push(rel);
    if (!ctx.dry) {
      if (!accountAlive(ctx)) throw new Error("account deleted");
      backupRef = await backupFileOriginal(ctx.harnessId, rel, to, { force: true });
      // Record the intent before the write (no source stamp marks it pending):
      // a crash in between must not lose the link to the saved original.
      putRow(ctx, {
        scope: "file", path: rel, key: "", valueHash: destHash ?? (await hashFile(to)),
        srcMtimeMs: null, srcSize: null, preexisted: true, backupRef,
      });
    }
  }
  await write(preexisted, backupRef, "update");
  return { outcome: "update" };
}

// ---------------------------------------------------------------------------
// Deletion propagation (plan D8)
// ---------------------------------------------------------------------------

/**
 * Remove (or drop ownership of) every item the mirror wrote below `entry` that
 * the primary no longer has. `visited` is every file the primary still has;
 * with no `visited` the whole entry is gone from the primary. Rows are
 * untrusted: see {@link removeOwnedFile}.
 */
async function propagateRemovals(
  ctx: MirrorCtx,
  entry: string,
  opts: {
    complete: boolean;
    visited?: ReadonlySet<string>;
    skippedPrefixes?: readonly string[];
    handledLinks?: ReadonlySet<string>;
  },
): Promise<void> {
  if (!opts.complete) return;
  const rows = [...ctx.rows.values()].filter(
    (r) => (r.scope === "file" || r.scope === "link") && !isUnownedRow(r)
      && (r.path === entry || r.path.startsWith(`${entry}/`)),
  );
  for (const row of rows) {
    await tick(ctx);
    if (row.scope === "link") {
      const name = row.path.startsWith(`${entry}/`) ? row.path.slice(entry.length + 1) : "";
      if (name && !name.includes("/") && opts.handledLinks?.has(name)) continue;
      await removeOwnedLink(ctx, row);
      continue;
    }
    if (opts.visited?.has(row.path)) continue;
    if (opts.skippedPrefixes?.some((s) => row.path === s || row.path.startsWith(`${s}/`))) continue;
    // A name the primary still has as a symlink is a link row's business.
    if (opts.handledLinks && row.path.startsWith(`${entry}/`)) {
      const first = row.path.slice(entry.length + 1).split("/")[0] ?? "";
      if (opts.handledLinks.has(first)) continue;
    }
    await removeOwnedFile(ctx, row);
  }
}

/** Remove a file the mirror wrote, after every re-check a hostile row could
 *  need: allowlist shape, below the root, no symlinked component, a regular
 *  file, and a content hash that still equals the recorded one. */
async function removeOwnedFile(ctx: MirrorCtx, row: MirrorProvenanceRow): Promise<void> {
  const rel = row.path;
  const abs = path.join(ctx.toRoot, rel);
  if (!isMirrorCopyShape(ctx.kind, rel)) {
    await dropRow(ctx, rel, "", true);
    return;
  }
  if (!isPlainPathUnder(ctx.toRoot, abs)) {
    await dropRow(ctx, rel);
    return;
  }
  const st = lstatOrNull(abs);
  if (!st || !st.isFile()) {
    await dropRow(ctx, rel);
    return;
  }
  // A preexisted item was the backup's own before the mirror: ownership ends,
  // the file stays (a primary deletion must not resurrect or destroy it).
  if (row.preexisted) {
    await dropRow(ctx, rel);
    return;
  }
  let hash: string;
  try {
    hash = await hashFile(abs);
  } catch {
    await dropRow(ctx, rel);
    return;
  }
  if (hash !== row.valueHash) {
    ctx.plan.kept.push(rel);
    warn(ctx, `${rel}: edited on this account since the mirror wrote it — kept, no longer mirrored`);
    await dropRow(ctx, rel);
    return;
  }
  ctx.plan.files.remove.push(rel);
  if (!ctx.dry) {
    try {
      unlinkSync(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        warn(ctx, `${rel}: could not remove — ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    pruneEmptyMirrorDirs(ctx, path.dirname(abs));
  }
  await dropRow(ctx, rel);
}

/** Remove now-empty plain directories below a mirrored entry, from `start`
 *  upwards, never the entry's own top directory or the account root. */
function pruneEmptyMirrorDirs(ctx: MirrorCtx, start: string): void {
  let cur = path.resolve(start);
  const root = path.resolve(ctx.toRoot);
  for (;;) {
    const rel = path.relative(root, cur);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return;
    // Keep the allowlist entry's own directory (e.g. `skills/`).
    if (!rel.includes(path.sep)) return;
    const st = lstatOrNull(cur);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return;
    try {
      if (readdirSync(cur).length > 0) return;
      rmdirSync(cur);
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
}

async function removeOwnedLink(ctx: MirrorCtx, row: MirrorProvenanceRow): Promise<void> {
  const rel = row.path;
  const abs = path.join(ctx.toRoot, rel);
  if (!isMirrorCopyShape(ctx.kind, rel)) {
    await dropRow(ctx, rel, "", true);
    return;
  }
  if (destinationState(ctx.toRoot, abs) !== "present") {
    await dropRow(ctx, rel);
    return;
  }
  const st = lstatOrNull(abs);
  if (!st?.isSymbolicLink() || row.preexisted) {
    await dropRow(ctx, rel);
    return;
  }
  let current: string;
  try {
    current = readlinkSync(abs);
  } catch {
    await dropRow(ctx, rel);
    return;
  }
  if (current !== row.valueHash) {
    ctx.plan.kept.push(rel);
    warn(ctx, `${rel}: link changed on this account since the mirror wrote it — kept, no longer mirrored`);
    await dropRow(ctx, rel);
    return;
  }
  ctx.plan.files.remove.push(rel);
  if (!ctx.dry) {
    try {
      unlinkSync(abs);
    } catch {
      // Already gone.
    }
  }
  await dropRow(ctx, rel);
}

// ---------------------------------------------------------------------------
// Symlinks: top-level skills and dotfile-manager configs
// ---------------------------------------------------------------------------

interface LinkGuard {
  kind: HarnessStackKind;
  /** Canonical config roots of the source and destination accounts. A link
   *  target equal to/above one of them, or at/above/inside one of its
   *  never-copy paths, is refused. */
  configRoots: string[];
  /** Canonical folders that hold an account file outside its config root
   *  (Claude's `.claude.json` dir). A target equal to or above one is
   *  refused. */
  accountDirs: string[];
}

/** File names that are a login wherever they sit. */
const CREDENTIAL_BASENAMES = new Set([".credentials.json", "auth.json", ".claude.json"]);

/** Home-relative folders that hold secrets; a link into one is never followed. */
const SENSITIVE_HOME_SUBPATHS: readonly string[] = [
  ".ssh", ".aws", ".gnupg", ".config/gh", ".netrc", ".docker",
  ".git-credentials", ".npmrc", ".kube", ".config/gcloud", ".pypirc",
];

/** The extension a dotfile entry's resolved target must have. */
const DOTFILE_EXTENSIONS: Readonly<Record<string, string>> = {
  "CLAUDE.md": ".md",
  "AGENTS.md": ".md",
  "settings.json": ".json",
  ".claude.json": ".json",
  "config.toml": ".toml",
};

function isInsideOrEqual(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** True when a resolved symlink target would hand a backup the primary's (or
 *  its own) login or session data: the target is an account root or one of
 *  its ancestors, a never-copy path (or a folder containing one), a `.git`
 *  folder, a credential file by name, or secret-bearing home folder.
 *  `ownName` is the dotfile being resolved (`.claude.json` may link to a file
 *  of that name; every other credential basename may not). */
function isForbiddenLinkTarget(target: string, guard: LinkGuard, ownName?: string): boolean {
  if (target.split(path.sep).some((segment) => isNeverCopySegment(segment))) return true;
  const base = path.basename(target);
  if (CREDENTIAL_BASENAMES.has(base) && !(ownName !== undefined && base === ownName)) return true;
  for (const dir of [...guard.configRoots, ...guard.accountDirs]) {
    if (isInsideOrEqual(dir, target)) return true;
  }
  const never = MIRROR_SPECS[guard.kind].never;
  for (const root of guard.configRoots) {
    if (!isInsideOrEqual(target, root)) continue;
    const rel = path.relative(root, target).split(path.sep).join("/");
    if (isNeverCopyPath(guard.kind, rel)) return true;
    if (never.some((entry) => entry.startsWith(`${rel}/`))) return true;
  }
  // Agetor's own data dir holds the core's token file and the saved originals.
  // Both spellings: the data dir is core-trusted, so its realpath is safe to
  // take (macOS /var vs /private/var, a dotfile-linked ~/.agetor). The link
  // target is never realpathed.
  for (const data of dataDirCandidates()) {
    if (isInsideOrEqual(target, data) || isInsideOrEqual(data, target)) return true;
  }
  for (const home of homeCandidates()) {
    for (const sub of SENSITIVE_HOME_SUBPATHS) {
      if (isInsideOrEqual(target, path.join(home, sub))) return true;
    }
  }
  return false;
}

function dataDirCandidates(): string[] {
  const dirs = [path.resolve(dataDir)];
  try {
    const real = realpathSync(dataDir);
    if (real !== dirs[0]) dirs.push(real);
  } catch {
    // Not resolvable: only the spelled one applies.
  }
  return dirs;
}

function homeCandidates(): string[] {
  const homes = [homedir()];
  try {
    const real = realpathSync(homes[0]!);
    if (real !== homes[0]) homes.push(real);
  } catch {
    // No resolvable home: only the spelled one applies.
  }
  return homes;
}

/**
 * Resolve a symlinked top-level config file the way `linkTopLevel` resolves a
 * skill: lexically (`resolvePathLexically`, no stat inside a macOS-protected
 * folder), then refuse a dangling or looping target, one at or above either
 * account root, one under a protected home folder, a never-copy/credential
 * path, and the secret-bearing home folders. The accepted path has no symlink
 * component left, so the caller reads it with a no-follow final component.
 */
function resolveDotfile(ctx: MirrorCtx, linkPath: string, name: string): { ok: true; path: string } | { ok: false; reason: string } {
  const resolved = resolvePathLexically(linkPath);
  if (resolved.protectedFolder) {
    return { ok: false, reason: `symlink points into the macOS-protected folder ~/${resolved.protectedFolder} — skipped` };
  }
  if (resolved.error) return { ok: false, reason: `symlink target could not be resolved (${resolved.error}) — skipped` };
  if (resolved.missing) return { ok: false, reason: "symlink target is missing — skipped" };
  const base = path.basename(name);
  if (isForbiddenLinkTarget(resolved.path, ctx.guard, base)) {
    return { ok: false, reason: "symlink points at account login or session data — skipped" };
  }
  // Only a regular file of the entry's own type: a link must not turn
  // `CLAUDE.md` into some other file's contents.
  const expected = DOTFILE_EXTENSIONS[base];
  if (expected !== undefined && path.extname(resolved.path).toLowerCase() !== expected) {
    return { ok: false, reason: `symlink target is not a ${expected} file — skipped` };
  }
  const targetSt = lstatOrNull(resolved.path);
  if (!targetSt?.isFile()) return { ok: false, reason: "symlink target is not a regular file — skipped" };
  return { ok: true, path: resolved.path };
}

/**
 * Re-create the top-level symlinked entries of a mirrored folder (`skills/x ->
 * ../../.agents/skills/x`) on the backup as an ABSOLUTE symlink to the source
 * link's resolved target. Nothing is read through the link, and the target is
 * resolved LEXICALLY (`readlink` + `lstat` of each component,
 * {@link resolvePathLexically}) rather than with `realpath`: the link is
 * agent-plantable, and resolving `skills/x -> ~/Documents/notes` with
 * `realpath` would stat inside a macOS-protected folder in the core's own
 * process (review R-S5). A target that reaches a protected folder is refused
 * without anything below that folder being touched. A dangling link, a chain
 * that cannot be resolved, or a target inside a credential or never-copy path
 * (see {@link isForbiddenLinkTarget}) is skipped with a warning. The
 * destination entry is created when absent and replaced only when it is
 * itself a symlink (atomically, via a temp link + rename); a real file or
 * folder the backup has at that name is never replaced. A replaced link is
 * a preexisted item: its old target is saved first.
 */
async function linkTopLevelSymlinks(
  ctx: MirrorCtx,
  from: string,
  rel: string,
): Promise<{ handled: string[] }> {
  const handled: string[] = [];
  const to = path.join(ctx.toRoot, rel);
  let names: string[];
  try {
    names = readdirSync(from).sort();
  } catch {
    return { handled };
  }
  for (const name of names) {
    const src = path.join(from, name);
    const srcSt = lstatOrNull(src);
    if (!srcSt?.isSymbolicLink()) continue;
    handled.push(name);
    const relPath = `${rel}/${name}`;
    const resolved = resolvePathLexically(src);
    if (resolved.protectedFolder) {
      warn(ctx, `${relPath}: symlink points into the macOS-protected folder ~/${resolved.protectedFolder} — not linked`);
      continue;
    }
    if (resolved.error) {
      warn(ctx, `${relPath}: symlink target could not be resolved (${resolved.error}) — not linked`);
      continue;
    }
    if (resolved.missing) {
      warn(ctx, `${relPath}: symlink target is missing — not linked`);
      continue;
    }
    const target = resolved.path;
    if (isForbiddenLinkTarget(target, ctx.guard)) {
      warn(ctx, `${relPath}: symlink points at account login or session data — not linked`);
      continue;
    }
    const dest = path.join(to, name);
    try {
      if (destinationState(ctx.toRoot, to) === "unsafe") {
        warn(ctx, `${relPath}: destination folder goes through a symlink — not linked`);
        continue;
      }
      const existing = destinationState(ctx.toRoot, dest) === "present" ? lstatOrNull(dest) : null;
      const row = getRow(ctx, relPath);
      if (!existing) {
        ctx.plan.files.add.push(relPath);
        ctx.copied.push(relPath);
        if (!ctx.dry) {
          ensurePlainDirUnder(ctx.toRoot, to);
          symlinkSync(target, dest);
          putRow(ctx, { scope: "link", path: relPath, key: "", valueHash: target, srcMtimeMs: null, srcSize: null, preexisted: false, backupRef: null });
        }
        continue;
      }
      if (!existing.isSymbolicLink()) {
        warn(ctx, `${relPath}: kept this account's own copy — not replaced by the primary's link`);
        continue;
      }
      const current = readlinkSync(dest);
      if (current === target) {
        if (row && (row.valueHash !== target || isUnownedRow(row))) {
          putRow(ctx, { scope: "link", path: relPath, key: "", valueHash: target, srcMtimeMs: null, srcSize: null, preexisted: row.preexisted, backupRef: row.backupRef });
        }
        continue;
      }
      const edited = row !== undefined && row.valueHash !== current;
      const preexisted = row ? row.preexisted || edited : true;
      let backupRef = row?.backupRef ?? null;
      if (!row || edited || (preexisted && !backupRef)) {
        ctx.plan.backups.push(relPath);
        if (!ctx.dry) {
          if (!accountAlive(ctx)) throw new Error("account deleted");
          backupRef = await backupLinkOriginal(ctx.harnessId, relPath, current, { force: true });
          putRow(ctx, { scope: "link", path: relPath, key: "", valueHash: current, srcMtimeMs: null, srcSize: null, preexisted: true, backupRef });
        }
      }
      ctx.plan.files.update.push(relPath);
      ctx.copied.push(relPath);
      if (ctx.dry) continue;
      const tmp = path.join(to, `.agetor-tmp-${randomUUID()}`);
      symlinkSync(target, tmp);
      try {
        renameSync(tmp, dest);
      } catch (err) {
        try {
          unlinkSync(tmp);
        } catch {
          // Already gone.
        }
        throw err;
      }
      putRow(ctx, { scope: "link", path: relPath, key: "", valueHash: target, srcMtimeMs: null, srcSize: null, preexisted, backupRef });
    } catch (err) {
      warn(ctx, `${relPath}: could not link — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { handled };
}

// ---------------------------------------------------------------------------
// Merged files (JSON and TOML)
// ---------------------------------------------------------------------------

const MAX_MIRROR_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Deep-merge `backup` under `primary`: primary scalars win, objects recurse,
 * backup-only keys survive, and an ARRAY the primary defines replaces the
 * backup's whole value for that key (a union kept a server's old and new `args`
 * side by side and left a server in both `enabledMcpjsonServers` and
 * `disabledMcpjsonServers`).
 *
 * Per-key rules for every caller (see the callers' own comments):
 * - `settings.json`: this function, except that `env` entries, `mcpServers`
 *   and `enabledPlugins` entries are replaced whole per name, and (full mode)
 *   `hooks`/`permissions` replace outright;
 * - `.claude.json`: only per-name replacement of the three owned structures;
 * - plugin registries: this function for flat registries; install records by
 *   identity ({@link mergeInstallRecords}) for `installed_plugins.json`.
 */
export function deepMerge(primary: unknown, backup: unknown): unknown {
  if (Array.isArray(primary)) return primary;
  if (isPlainObject(primary) && isPlainObject(backup)) {
    const out: Record<string, unknown> = { ...backup };
    for (const [key, value] of Object.entries(primary)) {
      setOwn(out, key, Object.prototype.hasOwnProperty.call(backup, key) ? deepMerge(value, backup[key]) : value);
    }
    return out;
  }
  return primary === undefined ? backup : primary;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `{...backup, ...primary}` for the entries of a named structure
 *  (`mcpServers`, `enabledPlugins`, `env`): each entry is replaced whole. */
function replaceEntries(primary: unknown, backup: unknown): Record<string, unknown> {
  return { ...(isPlainObject(backup) ? backup : {}), ...(isPlainObject(primary) ? primary : {}) };
}

function ownProp(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function getAt(doc: Record<string, unknown>, segs: readonly string[]): { found: boolean; value?: unknown } {
  let cur: unknown = doc;
  for (const seg of segs) {
    if (!isPlainObject(cur) || !ownProp(cur, seg)) return { found: false };
    cur = cur[seg];
  }
  return { found: true, value: cur };
}

function setAt(doc: Record<string, unknown>, segs: readonly string[], value: unknown): void {
  let cur = doc;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    const next = ownProp(cur, seg) ? cur[seg] : undefined;
    if (isPlainObject(next)) {
      cur = next;
    } else {
      const created: Record<string, unknown> = {};
      setOwn(cur, seg, created);
      cur = created;
    }
  }
  setOwn(cur, segs[segs.length - 1]!, value);
}

function deleteAt(doc: Record<string, unknown>, segs: readonly string[]): void {
  const parent = segs.length === 1 ? { found: true, value: doc } : getAt(doc, segs.slice(0, -1));
  if (parent.found && isPlainObject(parent.value)) delete parent.value[segs[segs.length - 1]!];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface MergeTexts {
  primaryText: string;
  /** null when the destination file does not exist yet. */
  backupText: string | null;
  toPath: string;
  toBase: string;
}

/**
 * Read the two sides of a merged file safely. Returns null (after a warning
 * where the situation is worth one) when the merge must leave the file alone.
 * The DESTINATION is checked before it is read: `destinationState` walks it
 * one component at a time, so a symlinked parent never makes the core stat
 * inside a protected folder, and a destination that is itself a symlink (a
 * dotfile manager's link) is skipped, never replaced by a regular file. The
 * primary file may be a dotfile-manager symlink ({@link resolveDotfile}).
 */
async function loadMergeTexts(
  ctx: MirrorCtx,
  rel: string,
  fromPath: string,
  toBase: string,
  toPath: string,
  opts: { dotfile: boolean; emptyText: string; fromBase?: string },
): Promise<MergeTexts | null> {
  const fromBase = opts.fromBase ?? ctx.fromRoot;
  let primaryText: string;
  // The primary deleted the whole file: merge it as an empty document so the
  // keys this mirror wrote (and the account never edited) are removed, exactly
  // as deleting one key does. Only a real deletion counts — see
  // {@link primaryDeletionPropagates}.
  let deleted = false;
  const srcSt = lstatOrNull(fromPath);
  if (!srcSt) {
    if (!primaryDeletionPropagates(ctx, rel, fromBase, fromPath)) return null;
    // An editor that saves by renaming leaves the file absent for a moment:
    // look again before treating it as deleted. Back already → leave it for
    // the next run rather than merge a half-observed state.
    await Bun.sleep(PRIMARY_DELETION_RECHECK_MS);
    if (lstatOrNull(fromPath)) return null;
    primaryText = opts.emptyText;
    deleted = true;
  } else {
    let readPath = fromPath;
    if (srcSt.isSymbolicLink() && opts.dotfile) {
      const resolved = resolveDotfile(ctx, fromPath, path.basename(fromPath));
      if (!resolved.ok) {
        warn(ctx, `${rel}: primary file ${resolved.reason}`);
        return null;
      }
      readPath = resolved.path;
    }
    const primaryRead = readTextIfRegular(readPath, MAX_MIRROR_FILE_BYTES);
    if (primaryRead.ok) {
      primaryText = primaryRead.text;
    } else {
      // Gone between the lstat and the open (most likely mid-save) is left
      // for the next run, like an unreadable file.
      if (!primaryRead.missing) warn(ctx, `${rel}: primary file could not be read safely — left alone (${primaryRead.reason})`);
      return null;
    }
  }
  const state = destinationState(toBase, toPath);
  if (state === "unsafe") {
    warn(ctx, `${rel}: backup file path goes through a symlinked directory — left alone`);
    return null;
  }
  let backupText: string | null = null;
  if (state === "present") {
    const dstSt = lstatOrNull(toPath);
    if (dstSt?.isSymbolicLink()) {
      warn(ctx, `${rel}: backup file is a symlink (a dotfile manager's?) — skipped, not replaced by a regular file`);
      return null;
    }
    const backupRead = readTextIfRegular(toPath, MAX_MIRROR_FILE_BYTES);
    if (!backupRead.ok) {
      if (!backupRead.missing) {
        warn(ctx, `${rel}: backup file could not be read safely — left alone (${backupRead.reason})`);
        return null;
      }
    } else {
      backupText = backupRead.text;
    }
  }
  // Nothing to remove from a backup that has no such file, and an empty
  // primary must never create one.
  if (deleted && backupText === null) return null;
  return { primaryText, backupText, toPath, toBase };
}

/** How long a missing primary merged file must stay missing before it counts
 *  as deleted (see {@link loadMergeTexts}). */
const PRIMARY_DELETION_RECHECK_MS = 250;

/**
 * Whether a primary file that does not exist is a deletion to propagate to
 * the backup. All must hold: the primary's config root is a directory
 * (`ctx.propagate`; an unreadable or missing account is never a deletion), the
 * file's folder exists — `fromBase` (trusted like the root: it passed the
 * protected-folder gate) is a directory and every folder below it is a real,
 * non-symlink directory (a `.claude.json` beside a missing home, or a removed
 * `plugins/` folder, is not a deletion) — and the mirror still owns at least
 * one key in this file. A dangling dotfile link or an unreadable file never gets here:
 * those are left alone.
 */
function primaryDeletionPropagates(ctx: MirrorCtx, rel: string, fromBase: string, fromPath: string): boolean {
  if (!ctx.propagate || !isDirectory(fromBase)) return false;
  const base = path.resolve(fromBase);
  const relDir = path.relative(base, path.dirname(path.resolve(fromPath)));
  if (relDir.startsWith("..") || path.isAbsolute(relDir)) return false;
  let cur = base;
  for (const part of relDir.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    const st = lstatOrNull(cur);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
  }
  for (const row of ctx.rows.values()) {
    if (row.path === rel && row.scope === "key" && !isUnownedRow(row)) return true;
  }
  return false;
}

interface JsonEntry {
  /** Stable key path recorded in provenance (`env.FOO`, `mcpServers.x`). */
  key: string;
  /** The real object path, since a name may itself contain dots. */
  segs: string[];
}

interface JsonMerge {
  rel: string;
  texts: MergeTexts;
  /** The primary as read. */
  raw: Record<string, unknown>;
  /** The primary after the strippers: what may be imported. */
  filtered: Record<string, unknown>;
  backup: Record<string, unknown>;
  mergeDoc(filtered: Record<string, unknown>, backup: Record<string, unknown>): Record<string, unknown>;
  enumerate(doc: Record<string, unknown>): JsonEntry[];
  /** A recorded key the current policy no longer mirrors: ownership is dropped
   *  and nothing is deleted on the backup (plan D11). */
  excluded(key: string): boolean;
}

/** Keys the mirror owns in a JSON file, as (key path, object path). */
function enumerateNamed(doc: Record<string, unknown>, containers: readonly string[], whole: boolean): JsonEntry[] {
  const out: JsonEntry[] = [];
  for (const [k, v] of Object.entries(doc)) {
    if (containers.includes(k) && isPlainObject(v)) {
      for (const name of Object.keys(v)) out.push({ key: `${k}.${name}`, segs: [k, name] });
    } else if (whole) {
      out.push({ key: k, segs: [k] });
    }
  }
  return out;
}

/**
 * The merge itself, shared by every JSON file: compute the merged document and
 * the key operations, then hand them to {@link commitMerged}. Deletion
 * propagation (plan D8): a recorded key the primary no longer has is removed
 * from the backup only while the backup's value still hashes to the recorded
 * value and the key did not preexist; an edited one is kept and unowned.
 */
async function mergeJsonDoc(ctx: MirrorCtx, m: JsonMerge): Promise<void> {
  const { rel, texts } = m;
  const merged = cloneJson(m.mergeDoc(m.filtered, m.backup));
  const owned = m.enumerate(m.filtered);
  const ownedKeys = new Set(owned.map((e) => e.key));
  const upserts: KeyUpsert[] = [];
  const refresh: KeyRefresh[] = [];
  for (const entry of owned) {
    const next = getAt(merged, entry.segs);
    if (!next.found) continue;
    const old = getAt(m.backup, entry.segs);
    const nextHash = hashValue(next.value);
    if (old.found && canonicalJson(old.value) === canonicalJson(next.value)) {
      const row = getRow(ctx, rel, entry.key);
      if (row && (row.valueHash !== nextHash || isUnownedRow(row))) refresh.push({ key: entry.key, valueHash: nextHash });
      continue;
    }
    upserts.push({
      key: entry.key, valueHash: nextHash, hasOld: old.found, oldValue: old.value,
      oldHash: old.found ? hashValue(old.value) : undefined,
    });
  }
  const removals: string[] = [];
  const drops: string[] = [];
  const backupIndex = new Map(m.enumerate(m.backup).map((e) => [e.key, e] as const));
  const rawKeys = new Set(m.enumerate(m.raw).map((e) => e.key));
  if (ctx.propagate) {
    for (const row of [...ctx.rows.values()]) {
      if (row.path !== rel || row.scope !== "key" || ownedKeys.has(row.key) || isUnownedRow(row)) continue;
      await tick(ctx);
      if (m.excluded(row.key) || rawKeys.has(row.key)) {
        drops.push(row.key);
        continue;
      }
      const loc = backupIndex.get(row.key);
      const current = loc ? getAt(m.backup, loc.segs) : { found: false };
      if (!loc || !current.found || row.preexisted) {
        drops.push(row.key);
        continue;
      }
      if (hashValue(current.value) !== row.valueHash) {
        ctx.plan.kept.push(`${rel}:${row.key}`);
        warn(ctx, `${rel}: ${row.key} was edited on this account since the mirror wrote it — kept, no longer mirrored`);
        drops.push(row.key);
        continue;
      }
      removals.push(row.key);
      deleteAt(merged, loc.segs);
    }
  }
  await commitMerged(ctx, {
    rel,
    toBase: texts.toBase,
    toPath: texts.toPath,
    text: `${JSON.stringify(merged, null, 2)}\n`,
    backupText: texts.backupText,
    upserts,
    removals,
    drops,
    foreign: [],
    refresh,
  });
}

interface KeyUpsert {
  key: string;
  valueHash: string;
  /** The backup already has a (different) value for this key. */
  hasOld: boolean;
  /** Value to save as the original: any JSON value, or block text for TOML. */
  oldValue?: unknown;
  /** Hash of `oldValue` in the same canonical form rows use. */
  oldHash?: string;
}

/** A key whose value is already right but whose row is stale (a crash left
 *  the intent row, or it was never written): the row is refreshed. */
interface KeyRefresh {
  key: string;
  valueHash: string;
}

interface ForeignRemoval {
  key: string;
  oldValue: unknown;
  /** Save the original first (the mirror did not write it). */
  needsBackup: boolean;
}

interface MergedCommit {
  rel: string;
  toBase: string;
  toPath: string;
  text: string;
  backupText: string | null;
  upserts: KeyUpsert[];
  /** Keys removed from the merged document because the primary dropped them. */
  removals: string[];
  /** Rows to drop without touching the document. */
  drops: string[];
  /** Backup content the merge removes that the mirror never wrote (a stale
   *  Codex subtable); saved under keys/ first and kept as a `preexisted` row
   *  so Restore can put it back. */
  foreign: ForeignRemoval[];
  refresh: KeyRefresh[];
}

/**
 * The effect layer for a merged file: plan entries first (identical for a dry
 * run and a real one), then, unless `ctx.dry`, back up the originals, write the
 * file atomically and record provenance. A backup that cannot be written aborts
 * the write (the caller turns the throw into a warning), so an original is
 * never overwritten unsaved.
 */
async function commitMerged(ctx: MirrorCtx, c: MergedCommit): Promise<void> {
  const fileChanged = c.backupText !== c.text;
  const pending: Array<{ key: string; oldValue: unknown; oldHash: string | null }> = [];
  const preexistedOf = new Map<string, boolean>();
  for (const u of c.upserts) {
    const row = getRow(ctx, c.rel, u.key);
    // A value the account changed since the mirror wrote it is, from now on,
    // that account's original: the primary still wins, but reversibly.
    const edited = row !== undefined && u.hasOld && (row.valueHash === null || row.valueHash !== u.oldHash);
    const preexisted = row ? row.preexisted || edited : u.hasOld;
    preexistedOf.set(u.key, preexisted);
    ctx.plan.keys.push({ file: c.rel, key: u.key, action: u.hasOld ? "update" : "add" });
    const needsBackup = u.hasOld && (!row || edited || (preexisted && !row.backupRef));
    if (needsBackup) {
      ctx.plan.backups.push(`${c.rel}:${u.key}`);
      pending.push({ key: u.key, oldValue: u.oldValue, oldHash: u.oldHash ?? null });
    }
  }
  for (const key of c.removals) ctx.plan.keys.push({ file: c.rel, key, action: "remove" });
  for (const f of c.foreign) {
    ctx.plan.keys.push({ file: c.rel, key: f.key, action: "remove" });
    if (f.needsBackup) ctx.plan.backups.push(`${c.rel}:${f.key}`);
  }
  if (fileChanged) (c.backupText === null ? ctx.plan.files.add : ctx.plan.files.update).push(c.rel);
  if (ctx.dry) return;

  const savedRefs = new Map<string, string>();
  for (const item of pending) {
    // `force`: the entry may be an orphan of a dropped row; this value is the
    // original now.
    if (!accountAlive(ctx)) throw new Error("account deleted");
    const ref = await backupKeyOriginal(ctx.harnessId, c.rel, item.key, item.oldValue, { force: true });
    savedRefs.set(item.key, ref);
    // Record the intent before the write (crash safety, as for files).
    putRow(ctx, {
      scope: "key", path: c.rel, key: item.key, valueHash: item.oldHash,
      srcMtimeMs: null, srcSize: null, preexisted: true, backupRef: ref,
    });
  }
  for (const f of c.foreign) {
    if (!f.needsBackup) continue;
    if (!accountAlive(ctx)) throw new Error("account deleted");
    const ref = await backupKeyOriginal(ctx.harnessId, c.rel, f.key, f.oldValue, { force: true });
    savedRefs.set(f.key, ref);
    putRow(ctx, {
      scope: "key", path: c.rel, key: f.key, valueHash: null,
      srcMtimeMs: null, srcSize: null, preexisted: true, backupRef: ref,
    });
  }
  if (fileChanged) {
    await atomicWriteFile(c.toPath, c.text, { root: c.toBase });
    ctx.copied.push(c.rel);
  }
  for (const u of c.upserts) {
    const row = getRow(ctx, c.rel, u.key);
    putRow(ctx, {
      scope: "key", path: c.rel, key: u.key, valueHash: u.valueHash,
      srcMtimeMs: null, srcSize: null,
      preexisted: preexistedOf.get(u.key) ?? false,
      backupRef: savedRefs.get(u.key) ?? row?.backupRef ?? null,
    });
  }
  for (const r of c.refresh) {
    const row = getRow(ctx, c.rel, r.key);
    if (row) putRow(ctx, { ...row, valueHash: r.valueHash, srcMtimeMs: null, srcSize: null });
  }
  for (const key of [...c.removals, ...c.drops]) await dropRow(ctx, c.rel, key);
  // A stale subtable that was the mirror's own and unedited just goes away; one
  // that was not stays as a `preexisted` row until Restore.
  for (const f of c.foreign) if (!f.needsBackup) await dropRow(ctx, c.rel, f.key);
}

// ---- settings.json ---------------------------------------------------------

/** Merge Claude's `settings.json`, stripping the primary's provider
 *  credential and provider-selector env keys and login-bearing settings while
 *  keeping a backup's own. `safe` mode drops the primary's hooks, permissions,
 *  status line, helper commands and command-running env vars and preserves
 *  whatever the backup already has; full mode makes the primary's
 *  `hooks`/`permissions` replace the backup's (no array union — an edited hook
 *  would otherwise run twice and a revoked permission survive forever). Every
 *  other array the primary defines replaces the backup's value too, and
 *  `env`, `mcpServers` and `enabledPlugins` entries replace per name. */
async function mergeClaudeSettings(ctx: MirrorCtx): Promise<void> {
  const rel = "settings.json";
  const toPath = path.join(ctx.toRoot, rel);
  const texts = await loadMergeTexts(ctx, rel, path.join(ctx.fromRoot, rel), ctx.toRoot, toPath, { dotfile: true, emptyText: "{}" });
  if (!texts) return;
  const raw = parseJsonObject(texts.primaryText);
  const backup = parseJsonObject(texts.backupText ?? "{}");
  if (!raw) return void warn(ctx, "settings.json: primary file is not a JSON object — left alone");
  if (!backup) return void warn(ctx, "settings.json: backup file is not a JSON object — left alone");

  const safe = ctx.safe;
  const filtered: Record<string, unknown> = { ...raw };
  if (safe) for (const key of SAFE_MODE_EXCLUDED_SETTINGS_KEYS) delete filtered[key];
  // Login-selecting keys never cross accounts. Deleting them from the primary
  // side before the merge leaves the backup's own value intact (when it has
  // one) and leaves the key absent otherwise.
  let strippedSettings = 0;
  for (const key of Object.keys(filtered)) {
    if (!isMirrorNeverImportedSettingsKey(key)) continue;
    delete filtered[key];
    strippedSettings++;
  }
  // Provider login keys are account-scoped: every credential-shaped or
  // provider-selecting env entry stays out, and (safe mode) so does every env
  // var that runs a command. The backup's own value of each survives.
  let stripped = 0;
  let safeSkipped = 0;
  if (isPlainObject(filtered.env)) {
    const env: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(filtered.env)) {
      if (isMirrorNeverImportedEnvEntry(key, value)) {
        stripped++;
        continue;
      }
      if (safe && isCommandRunningEnvKey(key)) {
        safeSkipped++;
        continue;
      }
      setOwn(env, key, value);
    }
    if (Object.keys(env).length > 0) filtered.env = env;
    else delete filtered.env;
  }
  // Marketplace entries whose URL embeds credentials never cross.
  if (isPlainObject(filtered.extraKnownMarketplaces)) {
    const entries: Record<string, unknown> = {};
    let dropped = 0;
    for (const [name, value] of Object.entries(filtered.extraKnownMarketplaces)) {
      if (containsUrlUserinfo(value)) dropped++;
      else setOwn(entries, name, value);
    }
    if (dropped > 0) {
      filtered.extraKnownMarketplaces = entries;
      warn(ctx, `settings.json: did not copy ${dropped} marketplace entr${dropped === 1 ? "y" : "ies"} whose URL carries credentials`);
    }
  }
  if (stripped > 0) {
    warn(
      ctx,
      `settings.json: stripped ${stripped} provider credential or login-selector key${stripped === 1 ? "" : "s"} from the primary`,
    );
  }
  if (safeSkipped > 0) {
    warn(ctx, `settings.json: safe mode did not copy ${safeSkipped} env variable${safeSkipped === 1 ? "" : "s"} that run${safeSkipped === 1 ? "s" : ""} a command`);
  }
  if (strippedSettings > 0) {
    warn(
      ctx,
      `settings.json: kept this account's own login settings; did not copy ${strippedSettings} login key${strippedSettings === 1 ? "" : "s"} from the primary`,
    );
  }
  await mergeJsonDoc(ctx, {
    rel,
    texts,
    raw,
    filtered,
    backup,
    mergeDoc: (f, b) => {
      const merged = deepMerge(f, b) as Record<string, unknown>;
      for (const container of ["env", "mcpServers", "enabledPlugins"]) {
        if (isPlainObject(f[container])) setOwn(merged, container, replaceEntries(f[container], b[container]));
      }
      if (!safe) {
        for (const key of FULL_MODE_REPLACED_SETTINGS_KEYS) {
          if (ownProp(f, key)) setOwn(merged, key, f[key]);
        }
      }
      return merged;
    },
    enumerate: (doc) => enumerateNamed(doc, ["env", "mcpServers", "enabledPlugins"], true),
    excluded: (key) => {
      const top = key.split(".")[0]!;
      if (isMirrorNeverImportedSettingsKey(top)) return true;
      if (safe && SAFE_MODE_EXCLUDED_SETTINGS_KEYS.includes(top)) return true;
      if (key.startsWith("env.")) {
        const name = key.slice(4);
        return isMirrorNeverImportedEnvKey(name) || (safe && isCommandRunningEnvKey(name));
      }
      return false;
    },
  });
}

// ---- .claude.json ----------------------------------------------------------

/**
 * Merge only the user-level keys of Claude's `.claude.json` blob that carry
 * configuration: `mcpServers`, `enabledPlugins`, and the `mcpServers` of each
 * project path (`claude mcp add` defaults to project scope). The blob also
 * holds session/project state (trust dialogs, history, allowed tools) and an
 * account id; none of it is copied. Every server entry is replaced whole by
 * name — a union would leave the old and new `args` of a server side by side —
 * and backup-only entries survive.
 */
async function mergeClaudeJson(ctx: MirrorCtx, primary: Harness, target: Harness): Promise<void> {
  const rel = ".claude.json";
  const fromBase = claudeJsonDirFor(primary);
  const fromPath = path.join(fromBase, rel);
  const toBase = claudeJsonDirFor(target);
  const toPath = path.join(toBase, rel);
  // Compare the DIRECTORIES (already past the protected-folder gate), never the
  // leaf: `realpath` of a planted `.claude.json` symlink would stat inside the
  // folder it points at.
  if (sameConfigRoot(fromBase, toBase)) return;
  if (!isPlainAncestorPathUnder(fromBase, fromPath)) {
    return void warn(ctx, ".claude.json: symlinked parent directory refused — left alone");
  }
  const texts = await loadMergeTexts(ctx, rel, fromPath, toBase, toPath, { dotfile: true, emptyText: "{}", fromBase });
  if (!texts) return;
  const raw = parseJsonObject(texts.primaryText);
  const backup = parseJsonObject(texts.backupText ?? "{}");
  if (!raw) return void warn(ctx, ".claude.json: primary file is not a JSON object — left alone");
  if (!backup) return void warn(ctx, ".claude.json: backup file is not a JSON object — left alone");
  const filtered = claudeJsonOwned(raw);
  await mergeJsonDoc(ctx, {
    rel,
    texts,
    raw,
    filtered,
    backup,
    mergeDoc: (f, b) => {
      const merged: Record<string, unknown> = { ...b };
      for (const container of ["mcpServers", "enabledPlugins"]) {
        if (isPlainObject(f[container])) setOwn(merged, container, replaceEntries(f[container], b[container]));
      }
      if (isPlainObject(f.projects)) {
        const projects: Record<string, unknown> = isPlainObject(b.projects) ? { ...b.projects } : {};
        for (const [projectPath, value] of Object.entries(f.projects)) {
          if (!isPlainObject(value) || !isPlainObject(value.mcpServers)) continue;
          const existing = ownProp(projects, projectPath) ? projects[projectPath] : undefined;
          const project: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
          setOwn(project, "mcpServers", replaceEntries(value.mcpServers, project.mcpServers));
          setOwn(projects, projectPath, project);
        }
        setOwn(merged, "projects", projects);
      }
      return merged;
    },
    enumerate: enumerateClaudeJson,
    excluded: () => false,
  });
}

/** The importable slice of a `.claude.json`: the three owned structures and
 *  nothing else, so no other per-project field can cross. */
function claudeJsonOwned(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const container of ["mcpServers", "enabledPlugins"]) {
    if (isPlainObject(raw[container])) setOwn(out, container, raw[container]);
  }
  if (isPlainObject(raw.projects)) {
    const projects: Record<string, unknown> = {};
    for (const [projectPath, value] of Object.entries(raw.projects)) {
      if (isPlainObject(value) && isPlainObject(value.mcpServers)) {
        setOwn(projects, projectPath, { mcpServers: value.mcpServers });
      }
    }
    if (Object.keys(projects).length > 0) setOwn(out, "projects", projects);
  }
  return out;
}

function enumerateClaudeJson(doc: Record<string, unknown>): JsonEntry[] {
  const out = enumerateNamed(doc, ["mcpServers", "enabledPlugins"], false);
  if (isPlainObject(doc.projects)) {
    for (const [projectPath, value] of Object.entries(doc.projects)) {
      if (!isPlainObject(value) || !isPlainObject(value.mcpServers)) continue;
      for (const name of Object.keys(value.mcpServers)) {
        out.push({ key: `projects.${projectPath}.mcpServers.${name}`, segs: ["projects", projectPath, "mcpServers", name] });
      }
    }
  }
  return out;
}

// ---- plugin registries -----------------------------------------------------

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
async function mergePluginRegistry(ctx: MirrorCtx, rel: string): Promise<void> {
  const toPath = path.join(ctx.toRoot, rel);
  const texts = await loadMergeTexts(ctx, rel, path.join(ctx.fromRoot, rel), ctx.toRoot, toPath, { dotfile: false, emptyText: "{}" });
  if (!texts) return;
  const raw = parseJsonObject(texts.primaryText);
  const backup = parseJsonObject(texts.backupText ?? "{}");
  if (!raw) return void warn(ctx, `${rel}: primary file is not a JSON object — left alone`);
  if (!backup) return void warn(ctx, `${rel}: backup file is not a JSON object — left alone`);
  const rewritten = rewritePathPrefixes(raw, path.resolve(ctx.fromRoot), path.resolve(ctx.toRoot)) as Record<string, unknown>;
  // `installed_plugins.json` maps a plugin to an ARRAY of per-scope install
  // records. A generic array union kept the primary's AND the backup's `user`
  // record, so the CLI saw the same plugin installed twice at user scope
  // (review S1). Merge those arrays by install identity instead; every other
  // registry (and key) keeps the deep-merge rule.
  const installed = rel === "plugins/installed_plugins.json";
  // An entry whose URL embeds credentials (a token in a git remote) never crosses.
  const filtered: Record<string, unknown> = { ...rewritten };
  let credentialed = 0;
  const stripEntries = (container: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(container)) {
      if (containsUrlUserinfo(value)) credentialed++;
      else setOwn(out, name, value);
    }
    return out;
  };
  if (installed && isPlainObject(filtered.plugins)) filtered.plugins = stripEntries(filtered.plugins);
  if (!installed) for (const [name, value] of Object.entries(filtered)) {
    if (containsUrlUserinfo(value)) {
      delete filtered[name];
      credentialed++;
    }
  }
  if (credentialed > 0) {
    warn(ctx, `${rel}: did not copy ${credentialed} entr${credentialed === 1 ? "y" : "ies"} whose URL carries credentials`);
  }
  await mergeJsonDoc(ctx, {
    rel,
    texts,
    raw: rewritten,
    filtered,
    backup,
    mergeDoc: (f, b) => installed ? mergeInstalledPluginsJson(f, b) : (deepMerge(f, b) as Record<string, unknown>),
    enumerate: (doc) => installed
      ? enumerateNamed(doc, ["plugins"], true)
      : Object.keys(doc).map((k) => ({ key: k, segs: [k] })),
    excluded: () => false,
  });
}

// ---- Codex config.toml -----------------------------------------------------

/**
 * Section-preserving merge of Codex's `config.toml`. There is no TOML writer
 * dependency (plan §2.3), so this works on text blocks: every primary block
 * except `[projects.*]` replaces the backup block with the same header, new
 * primary blocks are appended, and backup-only blocks are kept. `[projects.*]`
 * trust entries are never inherited — directory trust is per-account and
 * security-sensitive — in header form AND as dotted/inline assignments
 * (`projects."/x".trust_level = "trusted"`).
 *
 * Login never crosses accounts: the primary's login-bearing keys
 * (`CODEX_LOGIN_BEARING_CONFIG_KEYS`: `model_provider`, `forced_login_method`,
 * `cli_auth_credentials_store`, …), every `[model_providers]`/
 * `[model_providers.*]` table (bearer tokens, auth headers) and the same keys
 * inside a profile are dropped — whether the profile is a `[profiles.<name>]`
 * table, dotted keys in a `[profiles]` table, or an inline profile table
 * (dropped whole, since it cannot be split). Secrets that are not logins do
 * not cross either: credential-shaped variables in
 * `[shell_environment_policy] set` (table, dotted or inline form; an inline
 * table is filtered member by member) and every `headers` under `[otel]`. The
 * backup's own keys and tables survive: its login assignments are carried into
 * a merged table even when the primary's same-named table has none. Safe mode
 * also drops `notify`, `hooks` and `permissions`.
 *
 * A table the primary defines replaces the backup's whole table, so the
 * backup's stale SUBTABLES under it that conflict with the primary's keys (a
 * primary that moved `env` inline would otherwise leave `[x.env]` behind and
 * the file could never parse again), or that belong to an `mcp_servers.<name>`
 * entry, are dropped (saved first, like any overwritten original).
 *
 * The result is validated twice: `Bun.TOML.parse` must accept it, and every key
 * the primary contributes and every backup key the merge was not meant to
 * replace must still exist in it; otherwise the write is refused.
 */
async function mergeCodexConfig(ctx: MirrorCtx): Promise<void> {
  const rel = "config.toml";
  const toPath = path.join(ctx.toRoot, rel);
  const texts = await loadMergeTexts(ctx, rel, path.join(ctx.fromRoot, rel), ctx.toRoot, toPath, { dotfile: true, emptyText: "" });
  if (!texts) return;
  const safe = ctx.safe;
  let primaryParsed: Record<string, unknown>;
  try {
    primaryParsed = Bun.TOML.parse(texts.primaryText) as Record<string, unknown>;
  } catch (err) {
    return void warn(ctx, `config.toml: primary file is not valid TOML — left alone (${err instanceof Error ? err.message : String(err)})`);
  }
  const primaryBlocks = splitTomlBlocks(texts.primaryText);
  const backupBlocks = splitTomlBlocks(texts.backupText ?? "");
  // Codex MCP OAuth tokens live in a store Agetor never copies (security
  // review deviation). The definitions do move, but a backup that has never
  // signed in to that server must do so once; warn instead of pretending the
  // mirror made it work.
  const primaryMcpSections = primaryBlocks.filter(
    (b) => b.header === "mcp_servers" || b.header.startsWith("mcp_servers."),
  ).length;
  const backupHeaders = new Map(backupBlocks.map((b) => [b.header, b.text] as const));
  let skippedProjects = 0;
  /** Login-bearing keys/tables of the primary that were not imported. */
  const loginSkipped = new Set<string>();
  const safeExcluded = (segments: readonly string[]) =>
    safe && segments.length > 0 && SAFE_MODE_EXCLUDED_CODEX_KEYS.includes(segments[0]!);
  /** Key paths whose primary content was deliberately not imported (backstop). */
  const droppedPrefixes: string[][] = [];
  /** Key paths the merge replaces from the primary, or removes (backstop). */
  const replacedPrefixes: string[][] = [];

  // Top-level scalars are their own merge: the primary's replace by key,
  // while a backup-only key (a model override, notify list, custom setting)
  // survives. The old whole-block replacement silently dropped every
  // backup-only top-level key.
  const primaryTopAssignments = splitTopLevelAssignments(
    primaryBlocks.filter((b) => b.header === "").map((b) => b.text).join("\n"),
  ).assignments;
  const backupTopText = backupBlocks.filter((b) => b.header === "").map((b) => b.text).join("\n");
  const backupTopAssignments = splitTopLevelAssignments(backupTopText).assignments;
  const backupTopByKey = new Map(backupTopAssignments.map((a) => [a.key, a] as const));
  const keptTop: Array<{ key: string; text: string }> = [];
  /** Backup `[table]` blocks that the primary's inline/dotted assignment of the
   *  same key replaces (TOML forbids defining a key both ways, so the table
   *  form cannot stay next to it). */
  const formConflictHeaders = new Set<string>();
  for (const a of primaryTopAssignments) {
    const segments = splitTomlKeyPath(a.key);
    // Directory trust is per account: a dotted or inline `projects` key never
    // crosses, exactly like a `[projects.*]` table.
    if (segments[0] === "projects") {
      skippedProjects++;
      droppedPrefixes.push(segments);
      continue;
    }
    const verdict = codexVerdict(segments, segments, a.text);
    if (verdict === "drop") {
      loginSkipped.add(segments.join("."));
      droppedPrefixes.push(segments);
      continue;
    }
    if (safeExcluded(segments)) {
      droppedPrefixes.push(segments);
      continue;
    }
    // The backup spells the same key as a `[table]` (mixed forms): merge
    // member-wise into one inline table, carrying the backup's credential
    // members, so non-secret members cross and the file stays valid TOML.
    const conflicting = backupBlocks.filter(
      (b) => b.header !== "" && isUnder(splitTomlKeyPath(b.header), segments),
    );
    const isShellSet = segments.length === 2 && segments[0] === "shell_environment_policy" && segments[1] === "set";
    if (conflicting.length > 0 && isShellSet && isPlainObject(inlineSetEntries(segments, segments, a.text))) {
      const table = conflicting.find((b) => b.header === segments.join("."));
      let tableEntries: Record<string, unknown> = {};
      if (table) {
        try {
          const body = table.text.split(/\r?\n/).slice(1).join("\n");
          tableEntries = Bun.TOML.parse(body) as Record<string, unknown>;
        } catch {
          tableEntries = {};
        }
      }
      const synthetic: TomlAssignment = { key: a.key, text: `${a.key} = ${renderInlineTable(tableEntries)}` } as TomlAssignment;
      for (const b of conflicting) formConflictHeaders.add(b.header);
      loginSkipped.add(segments.join("."));
      keptTop.push({ key: a.key, text: filterInlineSet(a, segments, segments, synthetic, droppedPrefixes) });
      replacedPrefixes.push(segments);
      continue;
    }
    if (verdict === "filter") {
      loginSkipped.add(segments.join("."));
      keptTop.push({ key: a.key, text: filterInlineSet(a, segments, segments, backupTopByKey.get(a.key), droppedPrefixes) });
      replacedPrefixes.push(segments);
      continue;
    }
    keptTop.push({ key: a.key, text: a.text.trimEnd() });
    replacedPrefixes.push(segments);
  }

  const keptBlocks: Array<{ header: string; text: string }> = [];
  for (const block of primaryBlocks) {
    if (block.header === "") continue;
    const segments = splitTomlKeyPath(block.header);
    if (segments[0] === "projects") {
      skippedProjects++;
      droppedPrefixes.push(segments);
      continue;
    }
    if (isCodexLoginBearingKeyPath(segments) || isCodexSecretKeyPath(segments)) {
      loginSkipped.add(segments.join("."));
      droppedPrefixes.push(segments);
      continue;
    }
    if (safeExcluded(segments)) {
      droppedPrefixes.push(segments);
      continue;
    }
    // Every assignment is judged by its FULL key path (header + key), so a
    // `[profiles]` table written in dotted (`work.model_provider = …`) or
    // inline (`work = { model_provider = … }`) form loses the primary's login
    // keys exactly like a `[profiles.work]` table does (review R-S1).
    const text = mergeBlockLoginKeys(block.text, backupHeaders.get(block.header), segments, loginSkipped, droppedPrefixes);
    keptBlocks.push({ header: block.header, text: text.trimEnd() });
    replacedPrefixes.push(segments);
  }
  const keptHeaders = new Set(keptBlocks.map((b) => b.header));
  const primaryHeaders = new Set(primaryBlocks.map((b) => b.header));

  // New values (canonical text per provenance key).
  const newValues = new Map<string, string>();
  for (const t of keptTop) newValues.set(t.key, canonicalToml(t.text));
  for (const b of keptBlocks) {
    const prior = newValues.get(b.header);
    const canon = canonicalToml(b.text);
    newValues.set(b.header, prior === undefined ? canon : `${prior}\n${canon}`);
  }
  // Current values on the backup.
  const oldValues = collectTomlValues(backupBlocks, backupTopAssignments);

  // Stale subtables of a table the primary replaces (see the doc comment).
  const staleHeaders = new Set<string>(formConflictHeaders);
  for (const kept of keptBlocks) {
    const keptSegments = splitTomlKeyPath(kept.header);
    const direct = new Set(
      splitTopLevelAssignments(kept.text.split(/\r?\n/).slice(1).join("\n")).assignments.map((a) => splitTomlKeyPath(a.key)[0]),
    );
    const isServerEntry = keptSegments.length === 2 && keptSegments[0] === "mcp_servers";
    for (const b of backupBlocks) {
      if (!b.header.startsWith(`${kept.header}.`) || primaryHeaders.has(b.header) || keptHeaders.has(b.header)) continue;
      const first = splitTomlKeyPath(b.header.slice(kept.header.length + 1))[0];
      if (isServerEntry || direct.has(first)) staleHeaders.add(b.header);
    }
  }

  // Deletion propagation (plan D8) and safe-mode unowning (plan D11).
  const ownedKeys = new Set(newValues.keys());
  const primaryKeys = new Set([...primaryTopAssignments.map((a) => a.key), ...primaryHeaders].filter((k) => k !== ""));
  const removeTop = new Set<string>();
  const removeHeaders = new Set<string>();
  const removals: string[] = [];
  const drops: string[] = [];
  if (ctx.propagate) {
    for (const row of [...ctx.rows.values()]) {
      if (row.path !== rel || row.scope !== "key" || ownedKeys.has(row.key) || staleHeaders.has(row.key) || isUnownedRow(row)) continue;
      await tick(ctx);
      const segments = splitTomlKeyPath(row.key);
      if (
        segments[0] === "projects"
        || isCodexLoginBearingKeyPath(segments)
        || isCodexSecretKeyPath(segments)
        || safeExcluded(segments)
        || primaryKeys.has(row.key)
      ) {
        drops.push(row.key);
        continue;
      }
      const current = oldValues.get(row.key);
      if (current === undefined || row.preexisted) {
        drops.push(row.key);
        continue;
      }
      if (sha256(current) !== row.valueHash) {
        ctx.plan.kept.push(`${rel}:${row.key}`);
        warn(ctx, `${rel}: ${row.key} was edited on this account since the mirror wrote it — kept, no longer mirrored`);
        drops.push(row.key);
        continue;
      }
      removals.push(row.key);
      if (backupTopByKey.has(row.key)) removeTop.add(row.key);
      else removeHeaders.add(row.key);
      replacedPrefixes.push(segments);
    }
  }

  // Assemble.
  const out: string[] = [];
  const topParts = keptTop.map((a) => a.text.trimEnd());
  const primaryTopKeys = new Set(keptTop.map((a) => a.key));
  for (const assignment of backupTopAssignments) {
    if (primaryTopKeys.has(assignment.key) || removeTop.has(assignment.key)) continue;
    topParts.push(assignment.text.trimEnd());
  }
  if (topParts.some((t) => t.trim().length > 0)) {
    out.push(topParts.join("\n"));
  } else if (!primaryTopAssignments.length && backupTopText.trim()) {
    // Primary has no top-level keys; keep the backup's block (comments incl.).
    out.push(backupTopText.trimEnd());
  }
  for (const block of keptBlocks) out.push(block.text);
  const foreign: ForeignRemoval[] = [];
  for (const block of backupBlocks) {
    if (block.header === "") continue;
    if (splitTomlKeyPath(block.header)[0] === "projects") {
      // Keep the backup's own trust entries verbatim. A primary `[projects.*]`
      // block was never written above, so the same header on both sides still
      // means only the backup's entry survives.
      const keep = backupHeaders.get(block.header);
      if (keep) out.push(keep.trimEnd());
      continue;
    }
    if (keptHeaders.has(block.header) || removeHeaders.has(block.header)) continue;
    if (staleHeaders.has(block.header)) {
      if (!foreign.some((f) => f.key === block.header)) {
        const row = getRow(ctx, rel, block.header);
        const ours = row !== undefined && !row.preexisted && row.valueHash === sha256(oldValues.get(block.header) ?? "");
        foreign.push({
          key: block.header,
          oldValue: oldValues.get(block.header),
          needsBackup: !ours,
        });
        droppedPrefixes.push(splitTomlKeyPath(block.header));
      }
      continue;
    }
    out.push(block.text.trimEnd());
  }
  const merged = `${out.filter(Boolean).join("\n\n")}\n`;
  let mergedParsed: Record<string, unknown>;
  try {
    mergedParsed = Bun.TOML.parse(merged) as Record<string, unknown>;
  } catch (err) {
    return void warn(ctx, `config.toml: merge produced invalid TOML — backup left untouched (${err instanceof Error ? err.message : String(err)})`);
  }
  // Backstop: nothing the primary contributes, and nothing of the backup's the
  // merge was not meant to replace, may be missing from the result.
  const lost = findLostKeys(
    primaryParsed,
    texts.backupText === null ? {} : (Bun.TOML.parse(texts.backupText) as Record<string, unknown>),
    mergedParsed,
    { isExcluded: (segments) => segments[0] === "projects" || isCodexLoginBearingKeyPath(segments) || isCodexSecretKeyPath(segments) || safeExcluded(segments), droppedPrefixes, replacedPrefixes },
  );
  if (lost) return void warn(ctx, `config.toml: the merge would have lost ${lost} — backup left untouched`);

  if (skippedProjects > 0) {
    warn(ctx, "config.toml: did not copy the primary's [projects.*] trust entries");
  }
  if (loginSkipped.size > 0) {
    warn(
      ctx,
      `config.toml: kept this account's own login and provider settings; did not copy ${[...loginSkipped].sort().join(", ")} from the primary`,
    );
  }
  if (primaryMcpSections > 0) {
    warn(ctx, "config.toml: MCP sign-in may need repeating on this account — OAuth tokens are not copied");
  }
  const upserts: KeyUpsert[] = [];
  const refresh: KeyRefresh[] = [];
  for (const [key, value] of newValues) {
    const old = oldValues.get(key);
    if (old === value) {
      const row = getRow(ctx, rel, key);
      if (row && (row.valueHash !== sha256(value) || isUnownedRow(row))) refresh.push({ key, valueHash: sha256(value) });
      continue;
    }
    upserts.push({
      key, valueHash: sha256(value), hasOld: old !== undefined, oldValue: old,
      oldHash: old === undefined ? undefined : sha256(old),
    });
  }
  await commitMerged(ctx, {
    rel,
    toBase: ctx.toRoot,
    toPath,
    text: merged,
    backupText: texts.backupText,
    upserts,
    removals,
    drops,
    foreign,
    refresh,
  });
}

/** Leaf key paths of a parsed TOML/JSON value (arrays and empty tables are
 *  leaves). */
function leafPaths(value: unknown, prefix: string[] = [], out: string[][] = []): string[][] {
  if (isPlainObject(value) && Object.keys(value).length > 0) {
    for (const [k, v] of Object.entries(value)) leafPaths(v, [...prefix, k], out);
  } else if (prefix.length > 0) {
    out.push(prefix);
  }
  return out;
}

function isUnder(segments: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= segments.length && prefix.every((s, i) => segments[i] === s);
}

/** A description of the first key the merge lost, or null. */
function findLostKeys(
  primary: Record<string, unknown>,
  backup: Record<string, unknown>,
  merged: Record<string, unknown>,
  policy: {
    isExcluded: (segments: readonly string[]) => boolean;
    droppedPrefixes: readonly string[][];
    replacedPrefixes: readonly string[][];
  },
): string | null {
  for (const leaf of leafPaths(primary)) {
    if (policy.isExcluded(leaf) || policy.droppedPrefixes.some((p) => isUnder(leaf, p))) continue;
    if (!getAt(merged, leaf).found) return `the primary's ${leaf.join(".")}`;
  }
  for (const leaf of leafPaths(backup)) {
    if (policy.replacedPrefixes.some((p) => isUnder(leaf, p) || isUnder(p, leaf))) continue;
    if (policy.droppedPrefixes.some((p) => isUnder(leaf, p))) continue;
    if (!getAt(merged, leaf).found) return `this account's ${leaf.join(".")}`;
  }
  return null;
}

/** Block / assignment text without leading and trailing comment or blank
 *  lines, so a neighbour's comment never changes a value's hash. */
function canonicalToml(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  const noise = (l: string) => l.trim() === "" || l.trim().startsWith("#");
  let start = 0;
  while (start < lines.length && noise(lines[start]!)) start++;
  let end = lines.length;
  while (end > start && noise(lines[end - 1]!)) end--;
  return lines.slice(start, end).join("\n");
}

/** The login-key names, for spotting one inside an inline-table value. */
const USERINFO_IN_TEXT_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s"']*@/;

const CODEX_LOGIN_KEY_IN_TEXT_RE =
  /\b(?:model_providers?|forced_login_method|forced_chatgpt_workspace_id|preferred_auth_method|cli_auth_credentials_store|mcp_oauth_credentials_store|mcp_enterprise_managed_auth|chatgpt_base_url|openai_base_url)\b/;

/** True for a primary assignment that must not be imported: a login-bearing
 *  key path, or a `profiles`/`profiles.<name>` inline table whose value names a
 *  login key (an inline profile can set `model_provider` too). */
function isCodexLoginAssignment(segments: readonly string[], text: string): boolean {
  if (isCodexLoginBearingKeyPath(segments)) return true;
  return segments[0] === "profiles" && segments.length < 3 && CODEX_LOGIN_KEY_IN_TEXT_RE.test(text);
}

/** `keep`: import as is. `drop`: never import (the backup's own survives).
 *  `filter`: an inline `shell_environment_policy.set` table with credential
 *  members: import the rest. */
type CodexVerdict = "keep" | "drop" | "filter";

function codexVerdict(fullPath: readonly string[], localKey: readonly string[], text: string): CodexVerdict {
  if (isCodexLoginAssignment(fullPath, text) || isCodexSecretKeyPath(fullPath)) return "drop";
  // A URL with userinfo in any `shell_environment_policy.set` member is a credential.
  if (fullPath[0] === "shell_environment_policy" && fullPath[1] === "set" && fullPath.length >= 3 && USERINFO_IN_TEXT_RE.test(text)) {
    return "drop";
  }
  // An inline exporter table that names `headers` (OTLP auth) is dropped whole.
  if (fullPath[0] === "otel" && /\bheaders\b/i.test(text)) return "drop";
  if (fullPath[0] === "shell_environment_policy" && (fullPath.length === 1 || (fullPath[1] === "set" && fullPath.length === 2))) {
    const entries = inlineSetEntries(fullPath, localKey, text);
    if (entries && Object.entries(entries).some(([k, v]) => isMirrorNeverImportedEnvEntry(k, v))) {
      return fullPath.length === 1 ? "drop" : "filter";
    }
  }
  return "keep";
}

/** The members of an inline `set = { … }` table, or null if it is not one. */
function inlineSetEntries(fullPath: readonly string[], localKey: readonly string[], text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch {
    return null;
  }
  let cur = getAt(parsed as Record<string, unknown>, localKey);
  if (cur.found && fullPath.length === 1 && isPlainObject(cur.value)) cur = getAt(cur.value, ["set"]);
  return cur.found && isPlainObject(cur.value) ? cur.value : null;
}

/** A flat table of primitive members as an inline TOML table. */
function renderInlineTable(entries: Record<string, unknown>): string {
  const rendered = Object.entries(entries)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`);
  return `{ ${rendered.join(", ")} }`;
}

/** An inline `set` table rewritten without the primary's credential members
 *  and with the backup's own credential members carried over. */
function filterInlineSet(
  a: TomlAssignment,
  fullPath: readonly string[],
  localKey: readonly string[],
  backupAssignment: TomlAssignment | undefined,
  droppedPrefixes: string[][],
): string {
  const members: Array<[string, unknown]> = [];
  const backupEntries = backupAssignment ? inlineSetEntries(fullPath, localKey, backupAssignment.text) : null;
  for (const [k, v] of Object.entries(backupEntries ?? {})) if (isMirrorNeverImportedEnvEntry(k, v)) members.push([k, v]);
  for (const [k, v] of Object.entries(inlineSetEntries(fullPath, localKey, a.text) ?? {})) {
    if (!isMirrorNeverImportedEnvEntry(k, v)) members.push([k, v]);
    // A member the filter stripped on purpose is not a "lost" key (backstop).
    else droppedPrefixes.push([...fullPath, ...(fullPath.length === 1 ? ["set"] : []), k]);
  }
  const rendered = members
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`);
  return `${a.key} = { ${rendered.join(", ")} }`;
}

/**
 * A primary table block with its never-imported assignments removed and the
 * backup's own from the same table carried over. The merged table replaces the
 * backup's, so the backup's `model_provider` (or any other login key) would
 * otherwise be lost — including when the primary's table has no login key at
 * all (review R-S2). Each assignment is judged by its full key path
 * `[...tableSegments, ...key]`, so `[profiles]` + `work.model_provider` and
 * `[profiles.work]` + `model_provider` are the same key. A block where neither
 * side has such an assignment is returned unchanged.
 */
function mergeBlockLoginKeys(
  primaryText: string,
  backupText: string | undefined,
  tableSegments: readonly string[],
  loginSkipped: Set<string>,
  droppedPrefixes: string[][],
): string {
  const [headerLine, ...body] = primaryText.split(/\r?\n/);
  const assignments = splitTopLevelAssignments(body.join("\n")).assignments;
  const backupAssignments = backupText === undefined
    ? []
    : splitTopLevelAssignments(backupText.split(/\r?\n/).slice(1).join("\n")).assignments;
  const fullPath = (a: TomlAssignment) => [...tableSegments, ...splitTomlKeyPath(a.key)];
  const verdictOf = (a: TomlAssignment) => codexVerdict(fullPath(a), splitTomlKeyPath(a.key), a.text);
  const verdicts = assignments.map(verdictOf);
  const backupVerdicts = backupAssignments.map(verdictOf);
  if (verdicts.every((v) => v === "keep") && backupVerdicts.every((v) => v === "keep")) return primaryText;
  const backupByKey = new Map(backupAssignments.map((a) => [a.key, a] as const));
  const kept: string[] = [];
  assignments.forEach((a, i) => {
    const v = verdicts[i]!;
    if (v === "keep") {
      kept.push(a.text.trimEnd());
      return;
    }
    loginSkipped.add(fullPath(a).join("."));
    if (v === "drop") droppedPrefixes.push(fullPath(a));
    else kept.push(filterInlineSet(a, fullPath(a), splitTomlKeyPath(a.key), backupByKey.get(a.key), droppedPrefixes));
  });
  const primaryKeys = new Set(assignments.map((a) => a.key));
  backupAssignments.forEach((a, i) => {
    const v = backupVerdicts[i]!;
    if (v === "drop" || (v === "filter" && !primaryKeys.has(a.key))) kept.push(a.text.trimEnd());
  });
  return [headerLine ?? "", ...kept].join("\n");
}

/** Split a TOML key path (`a.b`, `a."b.c"`, `'x'.y`) into unquoted segments.
 *  Whitespace outside quotes is ignored. */
export function splitTomlKeyPath(key: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < key.length; i++) {
    const ch = key[i]!;
    if (quote) {
      if (quote === '"' && ch === "\\" && i + 1 < key.length) {
        cur += key[++i];
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ".") {
      segments.push(cur);
      cur = "";
      continue;
    }
    if (/\s/.test(ch)) continue;
    cur += ch;
  }
  segments.push(cur);
  return segments;
}

interface TomlBlock {
  header: string;
  text: string;
}

/**
 * The line scanner behind both splitters. It tracks what a line leaves open:
 * a multi-line basic (`"""`) or literal (`'''`) string and the depth of `[`/`{`
 * brackets. A line is only a table header, or the start of a new assignment,
 * when nothing is open. Comments and ordinary strings on a line are skipped.
 */
class TomlScan {
  depth = 0;
  multiline: '"""' | "'''" | null = null;

  get clean(): boolean {
    return this.depth === 0 && this.multiline === null;
  }

  reset(): void {
    this.depth = 0;
    this.multiline = null;
  }

  scan(line: string, start: number): void {
    let i = start;
    while (i < line.length) {
      if (this.multiline) {
        const close = line.indexOf(this.multiline, i);
        if (close < 0) return;
        i = close + 3;
        this.multiline = null;
        continue;
      }
      const ch = line[i]!;
      if (ch === "#") return;
      if (ch === '"' || ch === "'") {
        const triple = line.slice(i, i + 3);
        if (triple === '"""' || triple === "'''") {
          const close = line.indexOf(triple, i + 3);
          if (close < 0) {
            this.multiline = triple;
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
      if (ch === "[" || ch === "{") this.depth++;
      else if (ch === "]" || ch === "}") this.depth = Math.max(0, this.depth - 1);
      i++;
    }
  }
}

/** Split TOML text into a leading top-level block plus one block per table
 *  header (`[a.b]` or `[[a.b]]`). Comments and blank lines stay with the block
 *  they precede. A `[x]` line inside a multi-line string or a multi-line array
 *  is part of that value, not a header. */
export function splitTomlBlocks(text: string): TomlBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: TomlBlock[] = [];
  let current: { header: string; lines: string[] } = { header: "", lines: [] };
  const state = new TomlScan();
  for (const line of lines) {
    if (state.clean) {
      const m = /^\s*(\[\[?)([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
      if (m) {
        if (current.lines.length > 0) blocks.push({ header: current.header, text: current.lines.join("\n") });
        current = { header: m[2]!.trim(), lines: [line] };
        continue;
      }
    }
    current.lines.push(line);
    state.scan(line, 0);
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
  const state = new TomlScan();

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
      state.reset();
      state.scan(line, match[0].length);
      if (state.clean) finish();
      continue;
    }
    current.lines.push(line);
    state.scan(line, 0);
    if (state.clean) finish();
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

// ---------------------------------------------------------------------------
// Restore (plan D9)
// ---------------------------------------------------------------------------

/** Canonical text per provenance key of a parsed TOML document: header blocks
 *  (same-header blocks joined) and top-level assignments. */
function collectTomlValues(blocks: readonly TomlBlock[], topAssignments: readonly TomlAssignment[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const a of topAssignments) values.set(a.key, canonicalToml(a.text));
  for (const b of blocks) {
    if (b.header === "") continue;
    const prior = values.get(b.header);
    const canon = canonicalToml(b.text);
    values.set(b.header, prior === undefined ? canon : `${prior}\n${canon}`);
  }
  return values;
}

/** `text` with the value at provenance `key` replaced by `replacement`, or
 *  removed when it is null. A header key replaces/removes its blocks, any other
 *  key is a top-level assignment. The file is re-assembled block by block. */
function replaceTomlKey(text: string, key: string, replacement: string | null): string {
  const blocks = splitTomlBlocks(text);
  const headerIdx = blocks.map((b, i) => (b.header === key ? i : -1)).filter((i) => i >= 0);
  const isHeaderText = replacement?.trimStart().startsWith("[") ?? false;
  if (headerIdx.length > 0) {
    const out: string[] = [];
    blocks.forEach((b, i) => {
      if (!headerIdx.includes(i)) out.push(b.text.trimEnd());
      else if (i === headerIdx[0] && replacement !== null) out.push(replacement.trimEnd());
    });
    return `${out.filter(Boolean).join("\n\n")}\n`;
  }
  if (replacement === null) {
    const topBlock = blocks.find((b) => b.header === "");
    if (!topBlock) return text;
    const assignments = splitTopLevelAssignments(topBlock.text).assignments.filter((a) => a.key !== key);
    const rest = blocks.filter((b) => b.header !== "").map((b) => b.text.trimEnd());
    return `${[assignments.map((a) => a.text.trimEnd()).join("\n"), ...rest].filter(Boolean).join("\n\n")}\n`;
  }
  if (isHeaderText) return `${[...blocks.map((b) => b.text.trimEnd()), replacement.trimEnd()].filter(Boolean).join("\n\n")}\n`;
  const topBlock = blocks.find((b) => b.header === "");
  const assignments = topBlock ? splitTopLevelAssignments(topBlock.text).assignments : [];
  const parts = assignments.some((a) => a.key === key)
    ? assignments.map((a) => (a.key === key ? replacement.trimEnd() : a.text.trimEnd()))
    : [...assignments.map((a) => a.text.trimEnd()), replacement.trimEnd()];
  const rest = blocks.filter((b) => b.header !== "").map((b) => b.text.trimEnd());
  return `${[parts.join("\n"), ...rest].filter(Boolean).join("\n\n")}\n`;
}

/** The object path of a provenance key in a JSON file (the key string joins
 *  names with dots, and a name may itself contain dots). */
function segsForKey(rel: string, key: string, doc: Record<string, unknown>): string[] {
  if (rel === ".claude.json" && key.startsWith("projects.") && isPlainObject(doc.projects)) {
    for (const projectPath of Object.keys(doc.projects)) {
      const prefix = `projects.${projectPath}.mcpServers.`;
      if (key.startsWith(prefix)) return ["projects", projectPath, "mcpServers", key.slice(prefix.length)];
    }
    const m = /^projects\.(.*)\.mcpServers\.(.*)$/.exec(key);
    if (m) return ["projects", m[1]!, "mcpServers", m[2]!];
  }
  for (const container of ["env", "mcpServers", "enabledPlugins", "plugins"]) {
    if (key.startsWith(`${container}.`)) return [container, key.slice(container.length + 1)];
  }
  return [key];
}

function enumeratorFor(rel: string): ((doc: Record<string, unknown>) => JsonEntry[]) | null {
  if (rel === "settings.json") return (doc) => enumerateNamed(doc, ["env", "mcpServers", "enabledPlugins"], true);
  if (rel === ".claude.json") return enumerateClaudeJson;
  if (rel === "plugins/installed_plugins.json") return (doc) => enumerateNamed(doc, ["plugins"], true);
  if (rel === "plugins/known_marketplaces.json") return (doc) => Object.keys(doc).map((k) => ({ key: k, segs: [k] }));
  return null;
}

/**
 * Restore an account to how it was before the mirror touched it (plan D9):
 * 1. every backed-up original goes back (files, links and keys), provided the
 *    item still holds what the mirror wrote;
 * 2. every item the mirror added (not `preexisted`) is removed while it is
 *    unedited;
 * 3. an item the account edited since is left alone and reported as `kept`.
 * Then the account's provenance is dropped, and (when nothing failed) its saved
 * originals are deleted. Every path is re-checked like a removal: the rows are
 * untrusted. Serialized with the account's mirror queue.
 */
export function restoreMirror(harnessId: string): Promise<MirrorRestoreResult> {
  // Key everything on the resolved account's id (a kind name such as
  // "claude-code" resolves to a synthetic built-in row).
  const id = harnesses.getByIdOrKind(harnessId)?.id ?? harnessId;
  return serializeForDestination(id, () => restoreOne(harnessId));
}

async function restoreOne(requestedId: string): Promise<MirrorRestoreResult> {
  const harness = harnesses.getByIdOrKind(requestedId);
  const harnessId = harness?.id ?? requestedId;
  const result: MirrorRestoreResult = { harnessId, restored: [], removed: [], kept: [], warnings: [] };
  if (!harness || (harness.kind !== "claude-code" && harness.kind !== "codex")) {
    mirrorProvenance.deleteForHarness(harnessId);
    mirrorSources.deleteForHarness(harnessId);
    await removeMirrorBackups(harnessId);
    result.warnings.push("the account no longer exists or cannot be mirrored — its mirror records were dropped");
    return result;
  }
  const kind = harness.kind;
  const root = mirrorRootFor(harness);
  const redirected = rootsRedirectRefusal([
    [root, "this account's config directory"],
    ...(kind === "claude-code" ? [[claudeJsonDirFor(harness), "this account's .claude.json directory"] as const] : []),
  ]);
  if (redirected) {
    result.warnings.push(redirected);
    return result;
  }
  const rows = mirrorProvenance.list(harnessId);
  const spec = MIRROR_SPECS[kind];
  let lastYield = Date.now();
  const yieldNow = async () => {
    if (Date.now() - lastYield >= YIELD_EVERY_MS) {
      await Bun.sleep(0);
      lastYield = Date.now();
    }
  };
  const failed = (message: string) => result.warnings.push(message);
  /** A row that was fully handled (restored, removed, nothing left to do, or
   *  garbage) goes away with its saved original; a kept or failed row stays so
   *  Restore can be retried. */
  const finish = async (row: MirrorProvenanceRow) => {
    mirrorProvenance.remove(harnessId, row.path, row.key);
    await removeBackupEntry(harnessId, row.scope, row.path, row.key);
  };

  // Files and links.
  for (const row of rows) {
    if (row.scope === "key") continue;
    await yieldNow();
    const rel = row.path;
    const abs = path.join(root, rel);
    if (!isMirrorCopyShape(kind, rel)) {
      await finish(row);
      continue;
    }
    // Only a path through a symlinked or non-directory parent is skipped. A
    // missing leaf is handled below (a preexisted original goes back), and a
    // symlink leaf is a link row's normal state, so neither is "unsafe".
    if (destinationState(root, abs) === "unsafe") {
      failed(`${rel}: path goes through a symlink — left alone`);
      continue;
    }
    const st = lstatOrNull(abs);
    try {
      if (row.scope === "file") {
        if (st && !st.isFile()) {
          failed(`${rel}: not a regular file — left alone`);
          continue;
        }
        const currentHash = st ? await hashFile(abs) : null;
        const untouched = currentHash !== null && row.valueHash !== null && currentHash === row.valueHash;
        if (row.preexisted) {
          const original = await readBackup(fileBackupRef(harnessId, rel));
          if (!original) {
            failed(`${rel}: the saved original is missing — left alone`);
          } else if (st && !untouched) {
            result.kept.push(rel);
            failed(`${rel}: edited since the mirror wrote it — kept, original not restored`);
          } else {
            await atomicWriteFile(abs, original, { root });
            const mode = await readBackupMode(harnessId, rel);
            if (mode !== null) chmodSync(abs, mode);
            result.restored.push(rel);
            await finish(row);
          }
        } else if (!st) {
          await finish(row);
        } else if (untouched) {
          unlinkSync(abs);
          pruneEmptyDirsUnder(root, path.dirname(abs));
          result.removed.push(rel);
          await finish(row);
        } else {
          result.kept.push(rel);
          failed(`${rel}: edited since the mirror wrote it — kept`);
        }
      } else {
        const current = st?.isSymbolicLink() ? readlinkSync(abs) : null;
        if (st && current === null) {
          failed(`${rel}: no longer a link — left alone`);
          continue;
        }
        const untouched = current !== null && current === row.valueHash;
        if (row.preexisted) {
          const original = await readBackup(linkRef(harnessId, rel));
          if (!original) {
            failed(`${rel}: the saved original link is missing — left alone`);
          } else if (st && !untouched) {
            result.kept.push(rel);
            failed(`${rel}: link changed since the mirror wrote it — kept, original not restored`);
          } else {
            ensurePlainDirUnder(root, path.dirname(abs));
            const tmp = path.join(path.dirname(abs), `.agetor-tmp-${randomUUID()}`);
            symlinkSync(original.toString("utf8"), tmp);
            renameSync(tmp, abs);
            result.restored.push(rel);
            await finish(row);
          }
        } else if (!st) {
          await finish(row);
        } else if (untouched) {
          unlinkSync(abs);
          result.removed.push(rel);
          await finish(row);
        } else {
          result.kept.push(rel);
          failed(`${rel}: link changed since the mirror wrote it — kept`);
        }
      }
    } catch (err) {
      failed(`${rel}: could not restore — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Keys, one merged file at a time.
  const byFile = new Map<string, MirrorProvenanceRow[]>();
  for (const row of rows) {
    if (row.scope !== "key") continue;
    byFile.set(row.path, [...(byFile.get(row.path) ?? []), row]);
  }
  for (const [rel, fileRows] of byFile) {
    await yieldNow();
    try {
      if (!spec.merge.includes(rel)) {
        failed(`${rel}: not a mirrored file — left alone`);
        for (const r of fileRows) await finish(r);
        continue;
      }
      const base = baseForPath(harness, rel);
      const toPath = path.join(base, rel);
      const state = destinationState(base, toPath);
      if (state === "unsafe") {
        failed(`${rel}: path goes through a symlink — left alone`);
        continue;
      }
      if (state === "absent") {
        // Nothing to restore into; an unrestorable original keeps its row.
        for (const row of fileRows) if (!row.preexisted) await finish(row);
        continue;
      }
      if (lstatOrNull(toPath)?.isSymbolicLink()) {
        failed(`${rel}: file is a symlink — left alone`);
        continue;
      }
      const read = readTextIfRegular(toPath, MAX_MIRROR_FILE_BYTES);
      if (!read.ok) {
        if (!read.missing) failed(`${rel}: could not be read safely — left alone`);
        continue;
      }
      const outcome = rel === "config.toml"
        ? await restoreTomlKeys(harnessId, rel, fileRows, read.text, result, failed)
        : await restoreJsonKeys(harnessId, rel, fileRows, read.text, result, failed);
      if (outcome.text !== null && outcome.text !== read.text) await atomicWriteFile(toPath, outcome.text, { root: base });
      // Only after the file is back in place do the handled rows go.
      for (const row of outcome.done) await finish(row);
    } catch (err) {
      failed(`${rel}: could not restore — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (mirrorProvenance.list(harnessId).length === 0) await removeMirrorBackups(harnessId);
  return result;
}

interface KeyRestore {
  /** The new text, or null when nothing changed. */
  text: string | null;
  /** Rows fully handled (their saved originals can go). */
  done: MirrorProvenanceRow[];
}

async function restoreJsonKeys(
  harnessId: string,
  rel: string,
  rows: MirrorProvenanceRow[],
  text: string,
  result: MirrorRestoreResult,
  failed: (m: string) => void,
): Promise<KeyRestore> {
  const doc = parseJsonObject(text);
  const enumerate = enumeratorFor(rel);
  if (!doc || !enumerate) {
    failed(`${rel}: not a JSON object — left alone`);
    return { text: null, done: [] };
  }
  const index = new Map(enumerate(doc).map((e) => [e.key, e] as const));
  const done: MirrorProvenanceRow[] = [];
  let changed = false;
  for (const row of rows) {
    const loc = index.get(row.key);
    const current = loc ? getAt(doc, loc.segs) : { found: false };
    const name = `${rel}:${row.key}`;
    const untouched = current.found && row.valueHash !== null && hashValue(current.value) === row.valueHash;
    if (row.preexisted) {
      const original = await readKeyBackup(harnessId, rel, row.key);
      if (!original.found) {
        failed(`${name}: the saved original is missing — left alone`);
      } else if (current.found && !untouched) {
        result.kept.push(name);
        failed(`${name}: edited since the mirror wrote it — kept, original not restored`);
      } else {
        setAt(doc, loc?.segs ?? segsForKey(rel, row.key, doc), original.value);
        result.restored.push(name);
        done.push(row);
        changed = true;
      }
    } else if (!loc || !current.found) {
      done.push(row);
    } else if (untouched) {
      deleteAt(doc, loc.segs);
      result.removed.push(name);
      done.push(row);
      changed = true;
    } else {
      result.kept.push(name);
      failed(`${name}: edited since the mirror wrote it — kept`);
    }
  }
  return { text: changed ? `${JSON.stringify(doc, null, 2)}\n` : null, done };
}

async function restoreTomlKeys(
  harnessId: string,
  rel: string,
  rows: MirrorProvenanceRow[],
  text: string,
  result: MirrorRestoreResult,
  failed: (m: string) => void,
): Promise<KeyRestore> {
  // Split once: keys are independent, so the values to compare against are the
  // ones the file holds now.
  const blocks = splitTomlBlocks(text);
  const values = collectTomlValues(
    blocks,
    splitTopLevelAssignments(blocks.filter((b) => b.header === "").map((b) => b.text).join("\n")).assignments,
  );
  let current = text;
  const done: MirrorProvenanceRow[] = [];
  const restoredNames: string[] = [];
  const removedNames: string[] = [];
  for (const row of rows) {
    const now = values.get(row.key);
    const name = `${rel}:${row.key}`;
    const untouched = now !== undefined && row.valueHash !== null && sha256(now) === row.valueHash;
    if (row.preexisted) {
      const original = await readKeyBackup(harnessId, rel, row.key);
      if (!original.found || typeof original.value !== "string") {
        failed(`${name}: the saved original is missing — left alone`);
      } else if (now !== undefined && !untouched) {
        result.kept.push(name);
        failed(`${name}: edited since the mirror wrote it — kept, original not restored`);
      } else {
        current = replaceTomlKey(current, row.key, original.value);
        restoredNames.push(name);
        done.push(row);
      }
    } else if (now === undefined) {
      done.push(row);
    } else if (untouched) {
      current = replaceTomlKey(current, row.key, null);
      removedNames.push(name);
      done.push(row);
    } else {
      result.kept.push(name);
      failed(`${name}: edited since the mirror wrote it — kept`);
    }
  }
  if (current === text) return { text: null, done };
  try {
    Bun.TOML.parse(current);
  } catch {
    failed(`${rel}: the restored file would not parse — left alone`);
    // Nothing was written, so nothing counts as restored or removed.
    return { text: null, done: [] };
  }
  result.restored.push(...restoredNames);
  result.removed.push(...removedNames);
  return { text: current, done };
}

/** Remove empty plain directories from `start` upwards below `root` (never an
 *  allowlist entry's own top directory). */
function pruneEmptyDirsUnder(root: string, start: string): void {
  let cur = path.resolve(start);
  const base = path.resolve(root);
  for (;;) {
    const rel = path.relative(base, cur);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel) || !rel.includes(path.sep)) return;
    const st = lstatOrNull(cur);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return;
    try {
      if (readdirSync(cur).length > 0) return;
      rmdirSync(cur);
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
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

/** Re-exported so the security review's paths list has one source. */
export { MIRROR_SPECS, isNeverCopyPath };

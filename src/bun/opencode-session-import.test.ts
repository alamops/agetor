import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, type AppEvent } from "../shared/types.ts";
import { OPENCODE_DEFAULT_MODEL } from "../shared/opencode.ts";
import { MISSING_FOLDER_IMPORT_ERROR } from "../shared/claude-session-meta.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-oc-import-db-"));
process.env.AGETOR_DATA_DIR ??= dataDir;

const { db, harnesses, preferences, projects, runs, tasks } = await import("./db.ts");
const restoreHarnesses = (await import("./test-harness-state.ts")).snapshotHarnessState();
const { clearOpencodeSessionScanCache } = await import("./opencode-session-scan.ts");
const {
  OPENCODE_BUSY_IMPORT_ERROR,
  OPENCODE_UNFINISHED_STATUS,
  importOpencodeSessions,
  opencodeImportLaunch,
  opencodeImportTitle,
  pendingOpencodeImportBackfill,
  resumeIncompleteOpencodeImports,
  retryOpencodeImport,
} = await import("./opencode-session-import.ts");
const { exportSummary, exportToEvents, parseOpencodeExport } = await import("./opencode-export.ts");
const { createTask } = await import("./orchestrator.ts");
const {
  clearPendingClaudeSessionsNotice,
  flushPendingClaudeSessionsNotice,
  startClaudeSessionLaunchScan,
} = await import("./claude-session-launch.ts");
const { subscribeAppEvents } = await import("./quit-guard.ts");

const FIXTURES = path.join(import.meta.dir, "fixtures", "opencode");
const scratch = mkdtempSync(path.join(tmpdir(), "agetor-oc-import-"));
const fix = path.join(scratch, "fix");
mkdirSync(fix);
const stub = path.join(scratch, "opencode");
// Same stand-in as the scan tests: lists per `<tag>-<cwd basename>`,
// exports per id, `--version` from OC_VERSION.
writeFileSync(stub, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "$OC_VERSION"; exit 0; fi
echo "$*" >> "$OC_FIX/calls-$OC_TAG.log"
if [ "$1" = "session" ] && [ "$2" = "list" ]; then
  f="$OC_FIX/list-$OC_TAG-$(basename "$(/bin/pwd -P)").json"
  [ -f "$f" ] || { echo "no list" >&2; exit 1; }
  cat "$f"; exit 0
fi
for a in "$@"; do id="$a"; done
f="$OC_FIX/export-$id.json"
[ -f "$f" ] || { echo "Error: Session not found: $id" >&2; exit 1; }
cat "$f"
`);
chmodSync(stub, 0o755);

const proj = path.join(scratch, "proj");
mkdirSync(proj);
projects.upsert(proj, "proj");

const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
const hA = harnesses.insert({
  id: `oc-imp-a-${suffix}`,
  kind: "opencode",
  label: "OpenCode A",
  bin: stub,
  env: { OC_VERSION: "opencode v2.1.3", OC_FIX: fix, OC_TAG: "a" },
});
const hB = harnesses.insert({
  id: `oc-imp-b-${suffix}`,
  kind: "opencode",
  label: "OpenCode B",
  bin: stub,
  env: { OC_VERSION: "opencode v2.1.3", OC_FIX: fix, OC_TAG: "b" },
});

afterAll(() => {
  harnesses.setEnabled(hA.id, false);
  harnesses.setEnabled(hB.id, false);
  rmSync(scratch, { recursive: true, force: true });
  restoreHarnesses();
  rmTestDataDir(dataDir);
});

beforeEach(() => {
  clearOpencodeSessionScanCache();
});

let counter = 0;
function sid(): string {
  counter += 1;
  return `ses_imp${suffix}${counter}x`;
}

interface Row { id: string; title?: string; updated: number; directory?: string }
/** Replace harness `tag`'s list for the project. */
function writeList(tag: "a" | "b", rows: Row[]): void {
  writeFileSync(
    path.join(fix, `list-${tag}-proj.json`),
    JSON.stringify(rows.map((r) => ({ projectId: "global", created: r.updated - 1000, directory: proj, ...r }))),
  );
}

/** A v2 export from the captured fixture, re-keyed to `id`. */
function v2Export(id: string, opts: { updated: number; unfinished?: boolean; agent?: string; variant?: string; title?: string }): Record<string, any> {
  const exp = JSON.parse(readFileSync(path.join(FIXTURES, "v2-session-export.json"), "utf8"));
  exp.info.id = id;
  exp.info.location.directory = proj;
  exp.info.time.updated = opts.updated;
  if (opts.title) exp.info.title = opts.title;
  if (opts.variant) exp.info.model.variant = opts.variant;
  if (opts.agent) {
    for (const m of exp.messages) if (m.type === "assistant") m.agent = opts.agent;
  }
  // Message ids are per session in real exports; keep them unique per test.
  for (const m of exp.messages) m.id = `${m.id}_${id}`;
  if (opts.unfinished) {
    exp.info.outcome = null;
    delete exp.info.time.idle;
    exp.messages = exp.messages.filter((m: { type: string }) => m.type !== "idle");
  }
  return exp;
}
function writeExport(id: string, exp: unknown): void {
  writeFileSync(path.join(fix, `export-${id}.json`), JSON.stringify(exp));
}
function dropExport(id: string): void {
  rmSync(path.join(fix, `export-${id}.json`), { force: true });
}
/** Plant one old, finished session listed under harness A. */
function plant(opts: Partial<Parameters<typeof v2Export>[1]> & { listTitle?: string } = {}): { id: string; exp: Record<string, any> } {
  const id = sid();
  const updated = opts.updated ?? Date.now() - 60 * 60_000;
  const exp = v2Export(id, { ...opts, updated });
  writeExport(id, exp);
  writeList("a", [{ id, updated, ...(opts.listTitle ? { title: opts.listTitle } : {}) }]);
  return { id, exp };
}

function eventsFor(runId: string): { stream: string; data: string; line_uuid: string | null }[] {
  return db.query<{ stream: string; data: string; line_uuid: string | null }, [string]>(
    `SELECT stream, data, line_uuid FROM run_events WHERE run_id = ? ORDER BY id`,
  ).all(runId);
}

async function importOne(id: string, opts?: Parameters<typeof importOpencodeSessions>[1]) {
  const { results } = await importOpencodeSessions([id], opts);
  expect(results.length).toBe(1);
  const r = results[0]!;
  if (r.taskId) await pendingOpencodeImportBackfill(r.taskId);
  return r;
}

test("maps the launch fields and the title from the export", () => {
  const exp = parseOpencodeExport(JSON.stringify(v2Export("ses_maponly1", { updated: 1, agent: "plan", variant: "high" })), 2)!;
  expect(opencodeImportLaunch(exportSummary(exp))).toEqual({ model: "opencode/glm-5.3-flash-free", effort: "high", mode: "plan" });
  const build = parseOpencodeExport(JSON.stringify(v2Export("ses_maponly2", { updated: 1 })), 2)!;
  expect(opencodeImportLaunch(exportSummary(build))).toEqual({ model: "opencode/glm-5.3-flash-free", effort: "auto", mode: "auto" });
  const noModel = v2Export("ses_maponly3", { updated: 1 });
  delete noModel.info.model;
  const s3 = exportSummary(parseOpencodeExport(JSON.stringify(noModel), 2)!);
  expect(opencodeImportLaunch(s3)).toEqual({ model: OPENCODE_DEFAULT_MODEL, effort: "auto", mode: "auto" });
  // No title anywhere: the first user line, cut; with no user text either, a placeholder.
  expect(opencodeImportTitle("ses_abcdefgh123", exportSummary(build), null).startsWith("Do exactly these steps")).toBe(true);
  expect(opencodeImportTitle("ses_abcdefgh123", exportSummary(build), null).length).toBeLessThanOrEqual(80);
  expect(opencodeImportTitle("ses_abcdefgh123", { ...exportSummary(build), firstUserText: null }, null)).toBe("OpenCode session abcdefgh");
  expect(opencodeImportTitle("ses_x", { ...exportSummary(build), title: "Own" }, "Listed")).toBe("Own");
});

test("an import creates a Review task bound to the session, with a seed run and the history", async () => {
  const { id, exp } = plant({ listTitle: "Listed title" });
  const r = await importOne(id);
  expect(r.error).toBeUndefined();
  const task = tasks.get(r.taskId!)!;
  expect(task.column).toBe("review");
  expect(task.isolation).toBe("none");
  expect(task.workdir).toBe(proj);
  expect(task.agent).toBe(hA.id);
  expect(task.title).toBe("Listed title");
  expect(task.prompt.startsWith("Do exactly these steps")).toBe(true);
  expect(task.model).toBe("opencode/glm-5.3-flash-free");
  expect(task.effort).toBe("auto");
  expect(task.mode).toBe("auto");
  expect(task.opencodeServer).toBe("shared");
  expect(task.importedOpencode).toMatchObject({ sessionId: id, harnessId: hA.id, directory: proj, status: "ready", error: null });
  const run = runs.get(task.runId!)!;
  expect(run.status).toBe("succeeded");
  expect(run.origin).toBe("imported");
  expect(run.opencodeSessionId).toBe(id);
  const expected = exportToEvents(parseOpencodeExport(JSON.stringify(exp), 2)!);
  const stored = eventsFor(run.id);
  expect(stored.map((e) => e.line_uuid)).toEqual(expected.map((e) => e.lineUuid));
  expect(stored.some((e) => e.data === OPENCODE_UNFINISHED_STATUS)).toBe(false);
  expect(tasks.get(task.id)!.unread).toBe(true);
  // The bound session no longer imports.
  expect((await importOne(id)).error).toBe("session is already imported");
});

test("plan agent and a variant map to plan mode and that effort", async () => {
  const { id } = plant({ agent: "plan", variant: "high" });
  const task = tasks.get((await importOne(id)).taskId!)!;
  expect(task.mode).toBe("plan");
  expect(task.effort).toBe("high");
});

test("two concurrent imports of one session: one wins, the other loses the claim", async () => {
  const { id } = plant();
  const [a, b] = await Promise.all([importOpencodeSessions([id]), importOpencodeSessions([id])]);
  const all = [...a.results, ...b.results];
  const winners = all.filter((r) => r.taskId);
  expect(winners.length).toBe(1);
  expect(all.filter((r) => r.error === "session is already imported").length).toBe(1);
  await pendingOpencodeImportBackfill(winners[0]!.taskId!);
  expect(tasks.findTaskByImportedOpencodeSession(id)?.id).toBe(winners[0]!.taskId);
});

test("a recent unfinished session is refused; an old one imports with a status line", async () => {
  const busy = plant({ updated: Date.now() - 30_000, unfinished: true });
  const before = tasks.list().length;
  const refused = await importOne(busy.id);
  expect(refused.error).toBe(OPENCODE_BUSY_IMPORT_ERROR);
  expect(tasks.list().length).toBe(before);

  const old = plant({ updated: Date.now() - 30 * 60_000, unfinished: true });
  const r = await importOne(old.id);
  expect(r.error).toBeUndefined();
  const task = tasks.get(r.taskId!)!;
  expect(task.importedOpencode?.status).toBe("ready");
  const stored = eventsFor(task.runId!);
  expect(stored.at(-1)).toMatchObject({ stream: "status", data: OPENCODE_UNFINISHED_STATUS });
});

test("refusals: unknown id, missing folder at commit, a failed export, an unknown harness", async () => {
  expect((await importOne("ses_neverlisted1")).error).toBe("session not found");

  const goneDir = path.join(scratch, "gone");
  mkdirSync(goneDir);
  const gone = sid();
  writeExport(gone, v2Export(gone, { updated: Date.now() - 60 * 60_000 }));
  writeList("a", [{ id: gone, updated: Date.now() - 60 * 60_000, directory: goneDir }]);
  // Listed while the folder existed, then removed before the commit.
  const { scanOpencodeSessions } = await import("./opencode-session-scan.ts");
  expect((await scanOpencodeSessions({ force: true })).find((s) => s.sessionId === gone)?.importable).toBe(true);
  rmSync(goneDir, { recursive: true });
  expect((await importOne(gone)).error).toBe(MISSING_FOLDER_IMPORT_ERROR);

  const { id: noExport } = plant();
  dropExport(noExport);
  expect((await importOne(noExport)).error).toContain("couldn't read OpenCode session");
  expect(tasks.findTaskByImportedOpencodeSession(noExport)).toBeNull();

  const { id } = plant();
  const r = await importOne(id, { harnessId: "no-such-harness" });
  expect(r.error).toBe('unknown OpenCode harness "no-such-harness"');
});

test("opts.harnessId runs the task under another OpenCode harness", async () => {
  const { id } = plant();
  const task = tasks.get((await importOne(id, { harnessId: hB.id })).taskId!)!;
  expect(task.agent).toBe(hB.id);
  // The history is read where the session lives.
  expect(task.importedOpencode?.harnessId).toBe(hA.id);
  expect(task.importedOpencode?.status).toBe("ready");
});

test("retry re-runs the export for a failed import", async () => {
  const { id } = plant();
  const r = await importOne(id);
  const taskId = r.taskId!;
  const current = tasks.get(taskId)!.importedOpencode!;
  tasks.setImportedOpencode(taskId, { ...current, status: "failed", error: "boom" });

  dropExport(id);
  const failed = await retryOpencodeImport(taskId);
  expect("error" in failed && failed.error).toContain("couldn't read OpenCode session");
  expect(tasks.get(taskId)!.importedOpencode?.status).toBe("failed");

  writeExport(id, v2Export(id, { updated: Date.now() - 60 * 60_000 }));
  const before = eventsFor(tasks.get(taskId)!.runId!).length;
  expect(await retryOpencodeImport(taskId)).toEqual({ ok: true });
  expect(tasks.get(taskId)!.importedOpencode).toMatchObject({ status: "ready", error: null });
  // Line uuids dedupe the re-written history.
  expect(eventsFor(tasks.get(taskId)!.runId!).length).toBe(before);

  expect(await retryOpencodeImport(taskId)).toEqual({ error: "import is not failed" });
  const plain = await createTask({ title: "plain", prompt: "p", workdir: proj, isolation: "none", agent: hA.id });
  if ("error" in plain) throw new Error(plain.error);
  expect(await retryOpencodeImport(plain.task.id)).toEqual({ error: "task is not an imported session" });
});

test("resume finishes an import a crash left between the claim and the seed run", async () => {
  const { id, exp } = plant();
  const created = await createTask({ title: "crashed", prompt: "p", workdir: proj, isolation: "none", column: "review", agent: hA.id });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  tasks.setImportedOpencode(taskId, {
    sessionId: id, harnessId: hA.id, directory: proj, importedAt: Date.now(), status: "importing", error: null,
  });
  expect(tasks.get(taskId)!.runId).toBeNull();
  await resumeIncompleteOpencodeImports({ sliceMs: 0 });
  await pendingOpencodeImportBackfill(taskId);
  const task = tasks.get(taskId)!;
  expect(task.importedOpencode?.status).toBe("ready");
  const run = runs.get(task.runId!)!;
  expect(run).toMatchObject({ origin: "imported", status: "succeeded", opencodeSessionId: id });
  expect(eventsFor(run.id).length).toBe(exportToEvents(parseOpencodeExport(JSON.stringify(exp), 2)!).length);
});

test("a task deleted mid-backfill stops the import quietly", async () => {
  const { id } = plant();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const { results } = await importOpencodeSessions([id], { backfillGate: gate });
  const taskId = results[0]!.taskId!;
  tasks.delete(taskId);
  open();
  await pendingOpencodeImportBackfill(taskId);
  expect(tasks.get(taskId)).toBeNull();
});

/* ─── launch scan ─────────────────────────────────────────────────────── */

function resetSeen(): void {
  db.run(`DELETE FROM claude_session_seen`);
}
function seenIds(): Set<string> {
  return new Set(db.query<{ session_id: string }, []>(`SELECT session_id FROM claude_session_seen`).all().map((r) => r.session_id));
}

/** The Claude half of the launch scan reads HOME; point it at an empty dir
 *  and stub its liveness probe so it never touches the real ~/.claude. */
async function withEmptyClaudeHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(path.join(scratch, "home-"));
  const agents = path.join(home, "agents.json");
  writeFileSync(agents, "[]");
  const prev = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, AGENTS: process.env.AGETOR_CLAUDE_AGENTS_JSON };
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.AGETOR_CLAUDE_AGENTS_JSON = agents;
  try {
    return await fn();
  } finally {
    const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore("HOME", prev.HOME);
    restore("CLAUDE_CONFIG_DIR", prev.CLAUDE_CONFIG_DIR);
    restore("AGETOR_CLAUDE_AGENTS_JSON", prev.AGENTS);
  }
}

test("the launch scan holds an OpenCode notice until a client connects, sends it once, and records the ids", async () => {
  const fresh = plant();
  const busy = sid();
  writeExport(busy, v2Export(busy, { updated: Date.now() - 20_000, unfinished: true }));
  writeList("a", [
    { id: fresh.id, updated: Date.now() - 60 * 60_000 },
    { id: busy, updated: Date.now() - 20_000 },
  ]);
  preferences.set(CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, "1");
  resetSeen();
  clearPendingClaudeSessionsNotice();
  await withEmptyClaudeHome(() => startClaudeSessionLaunchScan());
  // No `/app/events` client: nothing is recorded until the notice is sent.
  expect(seenIds().has(fresh.id)).toBe(false);

  const sent: AppEvent[] = [];
  flushPendingClaudeSessionsNotice((e) => sent.push(e));
  const notices = sent.filter((e) => e.type === "opencode_sessions_found");
  expect(notices.length).toBe(1);
  const notice = notices[0] as Extract<AppEvent, { type: "opencode_sessions_found" }>;
  // Busy rows aren't importable, so they aren't toasted.
  expect(notice.sessionIds).toEqual([fresh.id]);
  expect(notice.count).toBe(1);
  expect(seenIds().has(fresh.id)).toBe(true);

  // Sent once: the next client gets nothing, and the next launch skips seen ids.
  const again: AppEvent[] = [];
  flushPendingClaudeSessionsNotice((e) => again.push(e));
  expect(again).toEqual([]);
  clearOpencodeSessionScanCache();
  const live: AppEvent[] = [];
  const unsub = subscribeAppEvents((e) => live.push(e));
  try {
    await withEmptyClaudeHome(() => startClaudeSessionLaunchScan());
  } finally {
    unsub();
  }
  expect(live.filter((e) => e.type === "opencode_sessions_found")).toEqual([]);
});

test("a connected client gets the OpenCode notice live; a held id imported meanwhile is dropped", async () => {
  const live1 = plant();
  preferences.set(CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, "1");
  resetSeen();
  clearPendingClaudeSessionsNotice();
  const live: AppEvent[] = [];
  const unsub = subscribeAppEvents((e) => live.push(e));
  try {
    await withEmptyClaudeHome(() => startClaudeSessionLaunchScan());
  } finally {
    unsub();
  }
  const notices = live.filter((e) => e.type === "opencode_sessions_found") as Extract<AppEvent, { type: "opencode_sessions_found" }>[];
  expect(notices.map((n) => n.sessionIds)).toEqual([[live1.id]]);
  expect(seenIds().has(live1.id)).toBe(true);

  const held = plant();
  resetSeen();
  clearOpencodeSessionScanCache();
  await withEmptyClaudeHome(() => startClaudeSessionLaunchScan());
  await importOne(held.id);
  const sent: AppEvent[] = [];
  flushPendingClaudeSessionsNotice((e) => sent.push(e));
  expect(sent.filter((e) => e.type === "opencode_sessions_found")).toEqual([]);
  expect(seenIds().has(held.id)).toBe(false);
});

test("the scan preference off skips the OpenCode scan too", async () => {
  plant();
  preferences.set(CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, "0");
  resetSeen();
  clearPendingClaudeSessionsNotice();
  try {
    await withEmptyClaudeHome(() => startClaudeSessionLaunchScan());
    const sent: AppEvent[] = [];
    flushPendingClaudeSessionsNotice((e) => sent.push(e));
    expect(sent).toEqual([]);
    expect(seenIds().size).toBe(0);
  } finally {
    preferences.set(CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, "1");
  }
});

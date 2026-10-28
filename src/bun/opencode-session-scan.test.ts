import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";

const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-oc-scan-db-"));
process.env.AGETOR_DATA_DIR ??= dataDir;

const { harnesses, projects, runs, tasks } = await import("./db.ts");
const restoreHarnesses = (await import("./test-harness-state.ts")).snapshotHarnessState();
const { clearOpencodeSessionScanCache, parseOpencodeSessionList, scanOpencodeSessions } = await import("./opencode-session-scan.ts");
const { createTask } = await import("./orchestrator.ts");

const FIXTURES = path.join(import.meta.dir, "fixtures", "opencode");
const scratch = mkdtempSync(path.join(tmpdir(), "agetor-oc-scan-"));
const fix = path.join(scratch, "fix");
mkdirSync(fix);
const stub = path.join(scratch, "opencode");
// A stand-in `opencode`: `--version` from OC_VERSION, `session list` from
// `list-<tag>-<basename of cwd>.json`, an export from `export-<id>.json`.
// Every call is logged per harness tag so a test can count spawns.
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

const projA = path.join(scratch, "proj-a");
const projB = path.join(scratch, "proj-b");
mkdirSync(projA);
mkdirSync(projB);
projects.upsert(projA, "proj-a");
projects.upsert(projB, "proj-b");

const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
const hA = harnesses.insert({
  id: `oc-scan-a-${suffix}`,
  kind: "opencode",
  label: "OpenCode A",
  bin: stub,
  env: { OC_VERSION: "opencode v2.1.3", OC_FIX: fix, OC_TAG: "a" },
});
const hB = harnesses.insert({
  id: `oc-scan-b-${suffix}`,
  kind: "opencode",
  label: "OpenCode B (v1)",
  bin: stub,
  env: { OC_VERSION: "1.19.4", OC_FIX: fix, OC_TAG: "b" },
});

afterAll(() => {
  // A later file in the same process must not list these.
  harnesses.setEnabled(hA.id, false);
  harnesses.setEnabled(hB.id, false);
  rmSync(scratch, { recursive: true, force: true });
  restoreHarnesses();
  rmTestDataDir(dataDir);
});

beforeEach(() => {
  clearOpencodeSessionScanCache();
  for (const tag of ["a", "b"]) rmSync(path.join(fix, `calls-${tag}.log`), { force: true });
});

let counter = 0;
function sid(): string {
  counter += 1;
  return `ses_scan${suffix}${counter}x`;
}

interface Row { id: string; title?: string; updated: number; created?: number; directory: string }
function writeList(tag: "a" | "b", proj: string, rows: Row[]): void {
  writeFileSync(
    path.join(fix, `list-${tag}-${path.basename(proj)}.json`),
    JSON.stringify(rows.map((r) => ({ projectId: "global", created: r.updated - 1000, ...r }))),
  );
}
function clearLists(): void {
  for (const tag of ["a", "b"]) {
    for (const p of [projA, projB]) rmSync(path.join(fix, `list-${tag}-${path.basename(p)}.json`), { force: true });
  }
}

/** A v2 export built from the captured fixture. `unfinished` drops the idle
 *  marker and the outcome, the shape of a turn still running (or a killed one). */
function writeV2Export(id: string, dir: string, updated: number, unfinished = false): void {
  const exp = JSON.parse(readFileSync(path.join(FIXTURES, "v2-session-export.json"), "utf8"));
  exp.info.id = id;
  exp.info.location.directory = dir;
  exp.info.time.updated = updated;
  if (unfinished) {
    exp.info.outcome = null;
    delete exp.info.time.idle;
    exp.messages = exp.messages.filter((m: { type: string }) => m.type !== "idle");
  }
  writeFileSync(path.join(fix, `export-${id}.json`), JSON.stringify(exp));
}

function calls(tag: "a" | "b"): string[] {
  const f = path.join(fix, `calls-${tag}.log`);
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : [];
}

test("parses both lines' list JSON and drops rows without an id or directory", () => {
  const v2 = parseOpencodeSessionList(readFileSync(path.join(FIXTURES, "v2-session-list.json"), "utf8"));
  expect(v2.length).toBe(3);
  expect(v2[0]!.title).toBeNull();
  expect(v2[0]!.directory).toBe("/Users/test/project");
  const v1 = parseOpencodeSessionList(readFileSync(path.join(FIXTURES, "v1-session-list.json"), "utf8"));
  expect(v1[0]!.title).toBe("Reading missing file and subagent directory listing");
  expect(parseOpencodeSessionList(`banner\n[{"id":"nope","directory":"/x"},{"id":"ses_ok1","updated":5}]`)).toEqual([]);
  expect(parseOpencodeSessionList("not json")).toEqual([]);
});

test("lists across 2 projects × 2 harnesses, newest first, with each line's argv", async () => {
  clearLists();
  const old = Date.now() - 60 * 60_000;
  const [s1, s2, s3] = [sid(), sid(), sid()];
  writeList("a", projA, [{ id: s1, updated: old + 3, directory: projA }]);
  writeList("a", projB, [{ id: s2, title: "B work", updated: old + 2, directory: projB }]);
  writeList("b", projA, [{ id: s3, title: "v1 work", updated: old + 1, directory: projA }]);
  // No list for (b, proj-b): that call exits 1 and contributes nothing.

  const rows = (await scanOpencodeSessions()).filter((r) => [s1, s2, s3].includes(r.sessionId));
  expect(rows.map((r) => [r.sessionId, r.harnessId, r.directory])).toEqual([
    [s1, hA.id, projA],
    [s2, hA.id, projB],
    [s3, hB.id, projA],
  ]);
  expect(rows[0]!.title).toBeNull();
  expect(rows[0]!.harnessLabel).toBe("OpenCode A");
  expect(rows[1]!.title).toBe("B work");
  expect(rows.every((r) => r.importable && r.blockedReason === null && !r.busyUnknown)).toBe(true);
  expect(rows[0]!).not.toHaveProperty("major");

  // v2 lists with --standalone; v1 never gets the flag.
  expect(calls("a").filter((c) => c.startsWith("session list"))).toEqual([
    "session list --standalone --format json",
    "session list --standalone --format json",
  ]);
  expect(calls("b").filter((c) => c.startsWith("session list"))).toEqual([
    "session list --format json",
    "session list --format json",
  ]);
  // Old sessions are never probed for busy.
  expect(calls("a").some((c) => c.includes("export"))).toBe(false);
});

test("hides ids Agetor owns as a run or an import claim", async () => {
  clearLists();
  const old = Date.now() - 60 * 60_000;
  const [ownedRun, claimed, free] = [sid(), sid(), sid()];
  writeList("a", projA, [
    { id: ownedRun, updated: old, directory: projA },
    { id: claimed, updated: old, directory: projA },
    { id: free, updated: old, directory: projA },
  ]);
  const created = await createTask({ title: "owner", prompt: "p", workdir: projA, isolation: "none", agent: hA.id });
  if ("error" in created) throw new Error(created.error);
  runs.insert({
    id: randomUUID(), taskId: created.task.id, agent: hA.id, status: "succeeded", startedAt: 1, endedAt: 2,
    exitCode: 0, tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null,
    geminiSessionId: null, fxSessionId: null, opencodeSessionId: ownedRun,
  });
  const other = await createTask({ title: "claimer", prompt: "p", workdir: projA, isolation: "none", agent: hA.id });
  if ("error" in other) throw new Error(other.error);
  tasks.setImportedOpencode(other.task.id, {
    sessionId: claimed, harnessId: hA.id, directory: projA, importedAt: 1, status: "ready", error: null,
  });
  const ids = (await scanOpencodeSessions()).map((r) => r.sessionId);
  expect(ids).toContain(free);
  expect(ids).not.toContain(ownedRun);
  expect(ids).not.toContain(claimed);
});

test("a session whose folder is gone is listed blocked", async () => {
  clearLists();
  const gone = sid();
  writeList("a", projA, [{ id: gone, updated: Date.now() - 60 * 60_000, directory: path.join(scratch, "vanished") }]);
  const row = (await scanOpencodeSessions()).find((r) => r.sessionId === gone)!;
  expect(row.blockedReason).toBe("missing-folder");
  expect(row.importable).toBe(false);
});

test("recent + unfinished is busy; old unfinished imports; a failed probe is busy-unknown", async () => {
  clearLists();
  const now = Date.now();
  const [busy, recentDone, oldUnfinished, probeFails] = [sid(), sid(), sid(), sid()];
  writeList("a", projA, [
    { id: busy, updated: now - 30_000, directory: projA },
    { id: recentDone, updated: now - 20_000, directory: projA },
    { id: oldUnfinished, updated: now - 30 * 60_000, directory: projA },
    { id: probeFails, updated: now - 10_000, directory: projA },
  ]);
  writeV2Export(busy, projA, now - 30_000, true);
  writeV2Export(recentDone, projA, now - 20_000, false);
  writeV2Export(oldUnfinished, projA, now - 30 * 60_000, true);
  // No export file for `probeFails`: the stub exits 1.

  const byId = new Map((await scanOpencodeSessions()).map((r) => [r.sessionId, r]));
  expect(byId.get(busy)!.blockedReason).toBe("busy");
  expect(byId.get(busy)!.importable).toBe(false);
  expect(byId.get(recentDone)!.blockedReason).toBeNull();
  expect(byId.get(recentDone)!.busyUnknown).toBeUndefined();
  expect(byId.get(oldUnfinished)!.importable).toBe(true);
  expect(byId.get(probeFails)!.importable).toBe(true);
  expect(byId.get(probeFails)!.busyUnknown).toBe(true);
  // Only the three recent rows were probed, each with v2's --standalone export.
  const exports = calls("a").filter((c) => c.startsWith("session export"));
  expect(exports.sort()).toEqual([busy, probeFails, recentDone].map((id) => `session export --standalone ${id}`).sort());
});

test("a (harness, dir) answer is cached for 10 s; force re-lists", async () => {
  clearLists();
  const id = sid();
  writeList("a", projA, [{ id, updated: Date.now() - 60 * 60_000, directory: projA }]);
  await scanOpencodeSessions();
  const first = calls("a").length;
  await scanOpencodeSessions();
  expect(calls("a").length).toBe(first);
  await scanOpencodeSessions({ force: true });
  expect(calls("a").length).toBe(first * 2);
});

test("disabled harnesses and missing project folders are skipped", async () => {
  clearLists();
  const id = sid();
  writeList("a", projA, [{ id, updated: Date.now() - 60 * 60_000, directory: projA }]);
  const ghost = path.join(scratch, "ghost-project");
  projects.upsert(ghost, "ghost");
  harnesses.setEnabled(hB.id, false);
  try {
    const rows = await scanOpencodeSessions();
    expect(rows.some((r) => r.harnessId === hB.id)).toBe(false);
    expect(rows.find((r) => r.sessionId === id)?.harnessId).toBe(hA.id);
    expect(calls("b")).toEqual([]);
  } finally {
    harnesses.setEnabled(hB.id, true);
  }
});

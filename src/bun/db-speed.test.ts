// DB-level tests for the speed tier (docs/plans/fx-0.0.14-and-cursor-updates.md
// §3.1/§3.5, T3): `tasks.speed`/`agent_profiles.speed` (migration 072, which
// dropped the old `fast` INTEGER columns) round-tripping through the
// `tasks`/`agentProfiles` modules, the derived `fast` every read emits for
// older clients, and the lenient read of frozen snapshot JSON written before
// 072 (a task's `agent_profile` column and a pipeline run's
// `snapshot.profiles`), which only ever carries the legacy `fast` boolean.
// Same setup as agent-profiles.test.ts: AGETOR_DATA_DIR is set at module
// scope BEFORE `./db.ts` is dynamically imported (the db opens — and
// migrates — on module load), and `rmTestDataDir` tears the dir down.
import { test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-db-speed-"));
process.env.AGETOR_DATA_DIR = dataDir;

let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;
let agentProfiles: typeof import("./db.ts").agentProfiles;
let parsePipelineRunState: typeof import("./db.ts").parsePipelineRunState;

beforeAll(async () => {
  ({ db, tasks, agentProfiles, parsePipelineRunState } = await import("./db.ts"));
});

beforeEach(() => {
  db.run(`DELETE FROM tasks`);
  db.run(`DELETE FROM agent_profiles`);
});

afterAll(() => {
  rmTestDataDir(dataDir);
});

function makeTaskRow(overrides: Partial<Task> = {}): Task {
  return {
    id: randomUUID(),
    title: "t",
    prompt: "p",
    agent: "cursor",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    speed: "off",
    maxMode: false,
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    column: "ready",
    runId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    ...overrides,
  };
}

/** A snapshot JSON as written before migration 072 — only the legacy `fast`
 *  boolean (or nothing at all), no `speed`. */
function legacySnapshot(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "profile-legacy",
    name: "Legacy Agent",
    harness: "cursor",
    harnessKind: "cursor",
    harnessLabel: "Cursor",
    model: "model-a",
    effort: null,
    mode: "auto",
    maxMode: false,
    instructions: "",
    skills: [],
    capturedAt: 1,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

test("the fast columns are gone and speed defaults to off at the SQL level", () => {
  const taskCols = db.query<{ name: string }, []>(`PRAGMA table_info(tasks)`).all().map((c) => c.name);
  const profileCols = db.query<{ name: string }, []>(`PRAGMA table_info(agent_profiles)`).all().map((c) => c.name);
  expect(taskCols).toContain("speed");
  expect(taskCols).not.toContain("fast");
  expect(profileCols).toContain("speed");
  expect(profileCols).not.toContain("fast");
});

test("tasks.insert round-trips every speed tier and emits the derived fast", () => {
  for (const speed of ["off", "fast", "ultrafast"] as const) {
    const inserted = tasks.insert(makeTaskRow({ speed }));
    expect(inserted.speed).toBe(speed);
    expect(inserted.fast).toBe(speed !== "off");
    const read = tasks.get(inserted.id)!;
    expect(read.speed).toBe(speed);
    expect(read.fast).toBe(speed !== "off");
    expect(tasks.list().find((t) => t.id === inserted.id)?.speed).toBe(speed);
  }
});

test("tasks.update({speed}) persists and re-derives fast; an unrelated patch leaves speed alone", () => {
  const task = tasks.insert(makeTaskRow());
  expect(task.speed).toBe("off");

  const ultra = tasks.update(task.id, { speed: "ultrafast" })!;
  expect(ultra.speed).toBe("ultrafast");
  expect(ultra.fast).toBe(true);
  expect(db.query<{ speed: string }, [string]>(`SELECT speed FROM tasks WHERE id = ?`).get(task.id)?.speed).toBe("ultrafast");

  const renamed = tasks.update(task.id, { title: "renamed" })!;
  expect(renamed.speed).toBe("ultrafast");

  const off = tasks.update(task.id, { speed: "off" })!;
  expect(off.speed).toBe("off");
  expect(off.fast).toBe(false);
});

test("the speed CHECK refuses an unknown tier", () => {
  const task = tasks.insert(makeTaskRow());
  expect(() => db.run(`UPDATE tasks SET speed = 'bogus' WHERE id = ?`, [task.id])).toThrow();
  expect(tasks.get(task.id)!.speed).toBe("off");
});

// ---------------------------------------------------------------------------
// agent profiles
// ---------------------------------------------------------------------------

test("agentProfiles.insert defaults speed to off and round-trips an explicit tier", () => {
  const plain = agentProfiles.insert({ name: "Plain", harness: "cursor", model: "m" });
  expect(plain.speed).toBe("off");
  expect(plain.fast).toBe(false);

  const quick = agentProfiles.insert({ name: "Quick", harness: "fx", model: "m", speed: "ultrafast" });
  expect(quick.speed).toBe("ultrafast");
  expect(quick.fast).toBe(true);
  expect(agentProfiles.get(quick.id)!.speed).toBe("ultrafast");
  expect(agentProfiles.list().find((p) => p.id === quick.id)?.speed).toBe("ultrafast");
});

test("agentProfiles.update patches speed and keeps it across unrelated patches", () => {
  const created = agentProfiles.insert({ name: "Speedy", harness: "cursor", model: "m" });
  const fast = agentProfiles.update(created.id, { speed: "fast" })!;
  expect(fast.speed).toBe("fast");
  expect(fast.fast).toBe(true);

  const remodeled = agentProfiles.update(created.id, { model: "m2" })!;
  expect(remodeled.speed).toBe("fast");

  const off = agentProfiles.update(created.id, { speed: "off" })!;
  expect(off.speed).toBe("off");
  expect(off.fast).toBe(false);
});

// ---------------------------------------------------------------------------
// frozen snapshots (task agent_profile column)
// ---------------------------------------------------------------------------

test("a legacy task snapshot {fast:true} reads as speed fast, and {} as off", () => {
  const legacyFast = tasks.insert(makeTaskRow());
  db.run(`UPDATE tasks SET agent_profile_id = ?, agent_profile = ? WHERE id = ?`, [
    "profile-legacy", JSON.stringify(legacySnapshot({ fast: true })), legacyFast.id,
  ]);
  const a = tasks.get(legacyFast.id)!.agentProfile!;
  expect(a.speed).toBe("fast");
  expect(a.fast).toBe(true);

  const legacyNone = tasks.insert(makeTaskRow());
  db.run(`UPDATE tasks SET agent_profile_id = ?, agent_profile = ? WHERE id = ?`, [
    "profile-legacy", JSON.stringify(legacySnapshot({})), legacyNone.id,
  ]);
  const b = tasks.get(legacyNone.id)!.agentProfile!;
  expect(b.speed).toBe("off");
  expect(b.fast).toBe(false);
});

test("a task snapshot's own speed wins over a stale fast, and an invalid speed falls back to fast", () => {
  const task = tasks.insert(makeTaskRow());
  db.run(`UPDATE tasks SET agent_profile = ? WHERE id = ?`, [
    JSON.stringify(legacySnapshot({ speed: "ultrafast", fast: false })), task.id,
  ]);
  expect(tasks.get(task.id)!.agentProfile!.speed).toBe("ultrafast");

  db.run(`UPDATE tasks SET agent_profile = ? WHERE id = ?`, [
    JSON.stringify(legacySnapshot({ speed: "warp", fast: true })), task.id,
  ]);
  expect(tasks.get(task.id)!.agentProfile!.speed).toBe("fast");
});

test("setAgentProfile round-trips a snapshot's speed", () => {
  const task = tasks.insert(makeTaskRow());
  const snapshot = { ...legacySnapshot({}), speed: "ultrafast", fast: true } as unknown as NonNullable<Task["agentProfile"]>;
  const bound = tasks.setAgentProfile(task.id, "profile-legacy", snapshot)!;
  expect(bound.agentProfile!.speed).toBe("ultrafast");
  expect(bound.agentProfile!.fast).toBe(true);
});

// ---------------------------------------------------------------------------
// frozen snapshots (pipeline run snapshot.profiles)
// ---------------------------------------------------------------------------

function legacyRunJson(profiles: Record<string, unknown>): string {
  return JSON.stringify({
    pipelineId: "pipeline-legacy",
    pipelineName: "Legacy",
    status: "running",
    active: [],
    blocked: [],
    history: [],
    stepCount: 1,
    startedAt: 1,
    endedAt: null,
    snapshot: {
      graph: {
        steps: [{ id: "s1", name: "Step", position: { x: 0, y: 0 }, agentProfileId: "p-fast" }],
        edges: [],
        startStepId: "s1",
      },
      profiles,
      maxSteps: 25,
      capturedAt: 1,
    },
  });
}

test("a legacy pipeline-run snapshot profile {fast:true} reads as speed fast, and {} as off", () => {
  const raw = legacyRunJson({
    "p-fast": legacySnapshot({ id: "p-fast", fast: true }),
    "p-none": legacySnapshot({ id: "p-none" }),
  });

  const parsed = parsePipelineRunState(raw)!;
  expect(parsed.snapshot!.profiles["p-fast"]!.speed).toBe("fast");
  expect(parsed.snapshot!.profiles["p-fast"]!.fast).toBe(true);
  expect(parsed.snapshot!.profiles["p-none"]!.speed).toBe("off");
  expect(parsed.snapshot!.profiles["p-none"]!.fast).toBe(false);

  // Same read through a parent task's `pipeline_run` column.
  const parent = tasks.insert(makeTaskRow());
  db.run(`UPDATE tasks SET pipeline_id = ?, pipeline_run = ? WHERE id = ?`, ["pipeline-legacy", raw, parent.id]);
  const run = tasks.get(parent.id)!.pipelineRun!;
  expect(run.snapshot!.profiles["p-fast"]!.speed).toBe("fast");
  expect(run.snapshot!.profiles["p-none"]!.speed).toBe("off");
});

test("a pipeline-run snapshot profile the strict sanitizer refuses is still kept, with its speed normalized", () => {
  // No `model` — the task-column sanitizer would null it, but a run snapshot
  // keeps every plain-object profile (the lenient contract).
  const parsed = parsePipelineRunState(legacyRunJson({
    "p-odd": { id: "p-odd", name: "Odd", fast: true },
  }))!;
  const odd = parsed.snapshot!.profiles["p-odd"]!;
  expect(odd.name).toBe("Odd");
  expect(odd.speed).toBe("fast");
  expect(odd.fast).toBe(true);
});

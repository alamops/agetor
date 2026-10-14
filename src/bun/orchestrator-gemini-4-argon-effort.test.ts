import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AGENT_OPTIONS, DEFAULT_MODEL } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

/**
 * The default effort a new task stores after docs/plans/add-gemini-4-argon.md
 * (`createTask` → `defaultEffortFor`). Before this change every antigravity
 * model offered efforts, so an antigravity task stored `high`; now effort is
 * the model id's suffix, every `MODEL_EFFORT_SUPPORT.antigravity` set is
 * empty, and a new antigravity task stores `null` — matching the rows
 * migration 064 cleared. The other three Argon rows each follow their own
 * kind's rule: gemini none, cursor high, fx auto.
 *
 * Same harness as orchestrator-discovered-efforts.test.ts: a mkdtemp
 * AGETOR_DATA_DIR set before any db.ts import, and `isolation: "none"` so no
 * worktree is created in this checkout. createTask never reads
 * `harness.enabled`, so the built-in rows need no setup.
 */

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-argon-defaults-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

let createTask: typeof import("./orchestrator.ts").createTask;
let deleteTask: typeof import("./orchestrator.ts").deleteTask;
let defaultEffortFor: typeof import("./orchestrator.ts").defaultEffortFor;
const createdIds: string[] = [];

beforeAll(async () => {
  ({ createTask, deleteTask, defaultEffortFor } = await import("./orchestrator.ts"));
  // Other test files in the same `bun test` process may have populated the
  // discovery caches; this file pins the curated-table behaviour.
  (await import("./agent-discovery.ts")).__testing.resetForTests();
});

afterAll(async () => {
  for (const id of createdIds) await deleteTask(id).catch(() => {});
  rmTestDataDir(DATA_DIR);
});

async function create(agent: string, model?: string, effort?: string | null) {
  const created = await createTask({
    title: `argon-effort-${agent}-${model ?? "default"}`,
    prompt: "p",
    agent,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    workdir: process.cwd(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  createdIds.push(created.task.id);
  return created.task;
}

// --- defaultEffortFor ----------------------------------------------------------

test("defaultEffortFor: every curated antigravity model resolves to null (effort is the id suffix)", () => {
  for (const m of AGENT_OPTIONS.antigravity.models) {
    expect(defaultEffortFor("antigravity", m.id, "antigravity")).toBeNull();
  }
});

test("defaultEffortFor: a discovered-only antigravity id (e.g. a bare gemini-4-argon) also resolves to null", () => {
  expect(defaultEffortFor("antigravity", "gemini-4-argon", "antigravity")).toBeNull();
});

test("defaultEffortFor: Gemini 4 Argon follows each kind's own rule — gemini null, cursor high, fx auto", () => {
  expect(defaultEffortFor("gemini", "gemini-4-argon", "gemini")).toBeNull();
  expect(defaultEffortFor("cursor", "gemini-4-argon", "cursor")).toBe("high");
  expect(defaultEffortFor("fx", "google/gemini-4-argon", "fx")).toBe("auto");
});

// --- createTask ------------------------------------------------------------------

test("createTask (antigravity, no model, no effort): default model, effort null (was high before this change)", async () => {
  const task = await create("antigravity");
  expect(task.agent).toBe("antigravity");
  expect(task.model).toBe(DEFAULT_MODEL.antigravity);
  expect(task.effort).toBeNull();
});

test("createTask (antigravity, gemini-4-argon-low, no effort): effort null, model kept verbatim", async () => {
  const task = await create("antigravity", "gemini-4-argon-low");
  expect(task.model).toBe("gemini-4-argon-low");
  expect(task.effort).toBeNull();
});

test("createTask (gemini, gemini-4-argon): effort null — Gemini CLI has no effort flag", async () => {
  const task = await create("gemini", "gemini-4-argon");
  expect(task.model).toBe("gemini-4-argon");
  expect(task.effort).toBeNull();
});

test("createTask (cursor, gemini-4-argon): effort high — Cursor composes gemini-4-argon-high at launch", async () => {
  const task = await create("cursor", "gemini-4-argon");
  expect(task.model).toBe("gemini-4-argon");
  expect(task.effort).toBe("high");
});

test("createTask (cursor, gemini-4-argon, explicit medium): the explicit effort is stored", async () => {
  const task = await create("cursor", "gemini-4-argon", "medium");
  expect(task.effort).toBe("medium");
});

test("createTask (fx, google/gemini-4-argon): effort auto — fx's own default, which the model offers", async () => {
  const task = await create("fx", "google/gemini-4-argon");
  expect(task.model).toBe("google/gemini-4-argon");
  expect(task.effort).toBe("auto");
});

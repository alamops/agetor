import { test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureCore, stopDaemon } from "./daemon/supervisor.ts";
import { AgetorClient, ApiError, discoverCore } from "./api-client.ts";
import { coreCredsPath } from "../bun/core-creds.ts";

test("discoverCore returns null when no core is running", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-disc-"));
  expect(await discoverCore(dir)).toBeNull();
});

test("api-client task round-trip + ApiError on 404", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-apic-"));
  const core = await ensureCore({ dataDir: dir, port: 4494 });
  const client = new AgetorClient(core);
  try {
    // createTask returns the BARE Task (regression guard for the {task} bug).
    const task = await client.createTask({
      title: "Round-trip",
      prompt: "p",
      agent: "claude-code",
      isolation: "none",
      workdir: dir,
    });
    expect(typeof task.id).toBe("string");
    expect(task.title).toBe("Round-trip");
    expect(task.column).toBe("backlog");

    expect((await client.getTask(task.id)).id).toBe(task.id);
    expect(await client.listTasks()).toHaveLength(1);

    let err: unknown;
    try {
      await client.getTask("does-not-exist");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);

    await client.deleteTask(task.id);
    expect(await client.listTasks()).toHaveLength(0);
  } finally {
    await stopDaemon(dir);
    for (let i = 0; i < 30 && existsSync(coreCredsPath(dir)); i++) {
      await Bun.sleep(100);
    }
  }
}, 30_000);

test("edit/move/archive/unarchive round-trip returns the bare Task", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-mng-"));
  const core = await ensureCore({ dataDir: dir, port: 4495 });
  const client = new AgetorClient(core);
  try {
    const t = await client.createTask({
      title: "Orig",
      prompt: "p",
      agent: "claude-code",
      isolation: "none",
      workdir: dir,
    });
    // PATCH returns the bare updated Task (same contract as createTask).
    const renamed = await client.patchTask(t.id, { title: "Renamed" });
    expect(renamed.id).toBe(t.id);
    expect(renamed.title).toBe("Renamed");
    expect((await client.patchTask(t.id, { column: "done" })).column).toBe("done");
    expect((await client.archiveTask(t.id)).archivedAt).not.toBeNull();
    expect((await client.unarchiveTask(t.id)).archivedAt).toBeNull();
    await client.deleteTask(t.id);
  } finally {
    await stopDaemon(dir);
    for (let i = 0; i < 30 && existsSync(coreCredsPath(dir)); i++) {
      await Bun.sleep(100);
    }
  }
}, 30_000);

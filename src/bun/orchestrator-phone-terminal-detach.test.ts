// S5: archiving or deleting a task detaches the phone terminal attached to it (the tmux session is going away).
import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// `bun test` runs every file in one process, so what this file sets is put back after it (the data dir is the exception: `db.ts` keeps the
// first one it opened for the whole process).
const ENV_KEYS = ["AGETOR_DATA_DIR", "AGETOR_CLAUDE_DRIVER", "AGETOR_CLAUDE_BIN", "AGETOR_TMUX_BIN", "AGETOR_CLAUDE_ARGS"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-test-"));
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

async function newTask(title: string) {
  const { createTask } = await import("./orchestrator.ts");
  const created = await createTask({ title, prompt: "p", agent: "claude-code", workdir: mkdtempSync(path.join(tmpdir(), "agetor-detach-wd-")), isolation: "none" });
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}

test("archiveTask detaches the task's phone terminal with the reason task-archived", async () => {
  const { archiveTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const remote = await import("./remote/remote-status.ts");
  const spy = spyOn(remote, "detachPhoneTerminal").mockReturnValue(true);
  try {
    const id = await newTask("archive detach");
    tasks.update(id, { column: "done" });
    const res = await archiveTask(id);
    expect("task" in res).toBe(true);
    expect(spy).toHaveBeenCalledWith(id, "task-archived");
  } finally {
    spy.mockRestore();
  }
});

test("deleteTask detaches the task's phone terminal with the reason task-deleted", async () => {
  const { deleteTask } = await import("./orchestrator.ts");
  const remote = await import("./remote/remote-status.ts");
  const spy = spyOn(remote, "detachPhoneTerminal").mockReturnValue(true);
  try {
    const id = await newTask("delete detach");
    await deleteTask(id);
    expect(spy).toHaveBeenCalledWith(id, "task-deleted");
  } finally {
    spy.mockRestore();
  }
});

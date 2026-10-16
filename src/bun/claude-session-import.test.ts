import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { plainEncodedProjectPath, LONG_PATH_IMPORT_ERROR } from "../shared/claude-session-meta.ts";

const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-import-db-"));
process.env.AGETOR_DATA_DIR ??= dataDir;

const {
  checkoutSessionBranch,
  importClaudeSessions,
  pendingImportBackfill,
  resumeIncompleteImports,
} = await import("./claude-session-import.ts");
const { projects, runs, subagents, tasks } = await import("./db.ts");
const { teardownBranchesForTask } = await import("./orchestrator.ts");

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(stderr || stdout);
  return stdout.trim();
}

function plant(opts: {
  home: string;
  sessionId: string;
  cwd: string;
  dirName?: string;
  permissionMode?: string | null;
  lines?: unknown[];
  subagent?: boolean;
}): string {
  const config = path.join(opts.home, ".claude");
  const dirName = opts.dirName ?? plainEncodedProjectPath(opts.cwd);
  const dir = path.join(config, "projects", dirName);
  mkdirSync(dir, { recursive: true });
  const lines = opts.lines ?? [
    {
      type: "user",
      uuid: `${opts.sessionId}-user`,
      cwd: opts.cwd,
      gitBranch: "feature",
      timestamp: "2026-10-01T00:00:00.000Z",
      ...(opts.permissionMode != null ? { permissionMode: opts.permissionMode } : {}),
      message: { role: "user", content: "please fix the login" },
    },
    {
      type: "assistant",
      uuid: `${opts.sessionId}-assistant`,
      timestamp: "2026-10-01T00:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
      },
    },
  ];
  writeFileSync(path.join(dir, `${opts.sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  if (opts.subagent) {
    const sub = path.join(dir, opts.sessionId, "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, "agent-helper.jsonl"), JSON.stringify({
      type: "assistant",
      uuid: `${opts.sessionId}-sub`,
      message: { role: "assistant", content: [{ type: "text", text: "helped" }], stop_reason: "end_turn" },
    }) + "\n");
  }
  return config;
}

function baseOpts(home: string, config: string, extra: Record<string, unknown> = {}) {
  return {
    homeDir: home,
    harnesses: [{ id: "claude-code", kind: "claude-code", home: config }],
    encodePath: plainEncodedProjectPath,
    listLive: () => [] as { sessionId: string; kind: string | null }[],
    worktreeRoots: [] as string[],
    ...extra,
  };
}

test("import persists an in-place task, ask for default/missing/unknown, and plan for plan", async () => {
  const home = scratchDir("cc-import-home-");
  const cwd = path.join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const cases = [
    { id: "mode-default", permissionMode: "default" as string | null, mode: "ask" },
    { id: "mode-missing", permissionMode: null, mode: "ask" },
    { id: "mode-nope", permissionMode: "nope", mode: "ask" },
    { id: "mode-plan", permissionMode: "plan", mode: "plan" },
  ];
  let config = "";
  for (const c of cases) {
    config = plant({
      home,
      sessionId: c.id,
      cwd,
      permissionMode: c.permissionMode,
      subagent: c.id === "mode-default",
    });
  }
  const imported = await importClaudeSessions(cases.map((c) => c.id), baseOpts(home, config));
  expect(imported.results.every((r) => r.taskId && !r.error)).toBe(true);
  for (const result of imported.results) {
    await pendingImportBackfill(result.taskId!);
  }
  for (const c of cases) {
    const result = imported.results.find((r) => r.id === c.id)!;
    const task = tasks.get(result.taskId!)!;
    expect(task.isolation).toBe("none");
    expect(task.workdir).toBe(cwd);
    expect(task.column).toBe("review");
    expect(task.mode).toBe(c.mode);
    expect(task.runId).toBeTruthy();
    const run = runs.get(task.runId!)!;
    expect(run.origin).toBe("imported");
    expect(run.status).toBe("succeeded");
    expect(run.claudeSessionId).toBe(c.id);
    expect(runs.seenLineUuidsForRun(run.id).has(`${c.id}-user`)).toBe(true);
    expect(runs.seenLineUuidsForRun(run.id).has(`${c.id}-assistant`)).toBe(true);
    expect(task.importedClaude?.status).toBe("ready");
  }
  expect(projects.get(cwd)?.name).toBe("repo");
  const parent = tasks.get(imported.results.find((r) => r.id === "mode-default")!.taskId!)!;
  const subs = subagents.listForTask(parent.id);
  expect(subs.map((s) => s.id)).toEqual(["helper"]);
  expect(subs[0]?.status).toBe("completed");
  expect(subs[0]?.endedAt).not.toBeNull();
  const subEvents = runs.events(parent.runId!).filter((e) => e.subagentId === "helper");
  expect(subEvents.length).toBeGreaterThan(0);
  const again = await importClaudeSessions(["mode-default"], baseOpts(home, config));
  expect(again.results[0]?.error).toBe("session is already imported");
  expect(again.results[0]?.taskId).toBeUndefined();
  const plan = await teardownBranchesForTask(parent);
  expect(plan.branches).toEqual([]);
});

test("a live session and a long path write no task", async () => {
  const home = scratchDir("cc-import-live-");
  const cwd = path.join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const config = plant({ home, sessionId: "live-one", cwd });
  const before = runs.claudeSessionIds();
  const live = await importClaudeSessions(["live-one"], {
    ...baseOpts(home, config),
    listLive: () => [{ sessionId: "live-one", kind: null }],
  });
  expect(live.results[0]?.taskId).toBeUndefined();
  expect(live.results[0]?.error).toBe("Close it in your terminal first");
  expect(runs.claudeSessionIds().has("live-one")).toBe(false);

  const longCwd = `/${"p".repeat(210)}`;
  const longConfig = plant({ home, sessionId: "long-one", cwd: longCwd, dirName: "short" });
  const blocked = await importClaudeSessions(["long-one"], {
    ...baseOpts(home, longConfig),
    encodePath: plainEncodedProjectPath,
  });
  expect(blocked.results[0]?.error).toBe(LONG_PATH_IMPORT_ERROR);
  expect(blocked.results[0]?.taskId).toBeUndefined();
  expect(runs.claudeSessionIds().has("long-one")).toBe(before.has("long-one"));

  const open = await importClaudeSessions(["long-one"], {
    ...baseOpts(home, longConfig),
    encodePath: () => "short",
  });
  expect(open.results[0]?.error).toBeUndefined();
  expect(open.results[0]?.taskId).toBeTruthy();
  await pendingImportBackfill(open.results[0]!.taskId!);
});

test("dirty checkout is refused and a clean repo switches to the recorded branch", async () => {
  const home = scratchDir("cc-import-git-");
  const repo = path.join(home, "repo");
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-m", "init"]);
  await git(repo, ["checkout", "-b", "feature"]);
  await git(repo, ["checkout", "main"]);
  const config = plant({ home, sessionId: "git-one", cwd: repo });

  writeFileSync(path.join(repo, "dirty.txt"), "x\n");
  const dirty = await checkoutSessionBranch("git-one", baseOpts(home, config));
  expect("error" in dirty).toBe(true);
  if ("error" in dirty) expect(dirty.error).toContain("not clean");
  expect(await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");

  rmSync(path.join(repo, "dirty.txt"));
  const clean = await checkoutSessionBranch("git-one", baseOpts(home, config));
  expect(clean).toEqual({ ok: true, branch: "feature" });
  expect(await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature");
});

test("deleting the task mid-backfill does not throw, and a crashed import can resume", async () => {
  const home = scratchDir("cc-import-resume-");
  const cwd = path.join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const config = plant({ home, sessionId: "gate-one", cwd });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const started = await importClaudeSessions(["gate-one"], { ...baseOpts(home, config), backfillGate: gate });
  const taskId = started.results[0]?.taskId;
  expect(taskId).toBeTruthy();
  tasks.delete(taskId!);
  release();
  await expect(pendingImportBackfill(taskId!)).resolves.toBeUndefined();

  const config2 = plant({ home, sessionId: "resume-one", cwd });
  const imported = await importClaudeSessions(["resume-one"], baseOpts(home, config2));
  const id = imported.results[0]!.taskId!;
  await pendingImportBackfill(id);
  const ready = tasks.get(id)!;
  expect(ready.importedClaude?.status).toBe("ready");
  tasks.setImportedClaude(id, { ...ready.importedClaude!, status: "importing", backfillOffset: 0, error: null });
  await resumeIncompleteImports(baseOpts(home, config2));
  await pendingImportBackfill(id);
  expect(tasks.get(id)?.importedClaude?.status).toBe("ready");
});

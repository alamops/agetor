import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import — mirrors
// orchestrator.test.ts's own top-of-file setup.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-at-refs-test-"));
// Drive claude through the in-process fake instead of tmux + the real CLI.
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo"; // tmux probe in agent-status passes
process.env.AGETOR_CLAUDE_ARGS = "";
// Drive gemini through its own in-process fake (see orchestrator-gemini.test.ts).
process.env.AGETOR_GEMINI_DRIVER = "fake";
process.env.AGETOR_GEMINI_BIN = "/bin/echo";

// Standalone helper: run git in a directory (mirrors worktree.test.ts's /
// orchestrator.test.ts's own local `git()` helper).
async function git(args: string[], cwd: string) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

// A real temp git repo with README.md + src/app.ts committed at HEAD. Never
// point a task at a real repo in these tests — always mkdtemp (see the
// worktree isolation warning in CLAUDE.md).
async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-at-refs-repo-"));
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README.md"), "hi\n");
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "src", "app.ts"), "export {};\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  return repo;
}

async function settle(ms = 400) {
  await new Promise((r) => setTimeout(r, ms));
}

// Concatenate every "user"/"stdout" event persisted for a task — both the
// echoed launch/follow-up "user" bubble (which carries whatever
// startTask/sendInput actually handed the driver) and the fake driver's own
// "fake response to: <prompt>" stdout echo carry the (expanded) prompt text,
// so checking both is belt-and-suspenders against either carrying it.
function transcriptText(events: Array<{ stream: string; data: string }>): string {
  return events.filter((e) => e.stream === "user" || e.stream === "stdout").map((e) => e.data).join("\n");
}

test("startTask (claude, worktree isolation) expands @tokens to the worktree's absolute paths; unresolvable tokens stay verbatim; task.prompt keeps the raw @tokens", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, runs, harnesses } = await import("./db.ts");
  harnesses.setEnabled("claude-code", true);

  const repo = await makeRepo();
  const rawPrompt = "look at @README.md and @src/ and @nope.txt and @github";
  const created = await createTask({
    title: "at refs worktree",
    prompt: rawPrompt,
    agent: "claude-code",
    workdir: repo,
    isolation: "worktree",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  await settle(600); // worktree materialization (`git worktree add`) + the fake driver's ~20ms resolve

  const updated = tasks.get(taskId);
  expect(updated?.worktreePath).toBeTruthy();
  const wt = updated!.worktreePath!;

  const text = transcriptText(runs.eventsForTask(taskId));
  expect(text).toContain(`${wt}/README.md`);
  expect(text).toContain(`${wt}/src/`);
  // Unresolvable tokens (nonexistent file, and the `@name` extension-mention
  // syntax) are left exactly as typed — never dropped, never half-expanded.
  expect(text).toContain("@nope.txt");
  expect(text).toContain("@github");

  // The stored prompt is never mutated by expansion — only the text handed
  // to the agent is. This is what makes a re-run re-resolve against
  // whatever cwd that run gets.
  expect(updated?.prompt).toBe(rawPrompt);

  tasks.delete(taskId);
});

test("startTask (claude, isolation none) expands @tokens to <workdir>-rooted absolute paths", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const repo = await makeRepo();
  const created = await createTask({
    title: "at refs isolation none",
    prompt: "see @README.md",
    agent: "claude-code",
    workdir: repo,
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  await settle();

  const updated = tasks.get(taskId);
  expect(updated?.worktreePath ?? null).toBeNull();

  const text = transcriptText(runs.eventsForTask(taskId));
  expect(text).toContain(`${repo}/README.md`);

  tasks.delete(taskId);
});

test("sendInput (claude follow-up) expands @tokens against the task's live cwd (worktree)", async () => {
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const repo = await makeRepo();
  const created = await createTask({
    title: "at refs followup",
    prompt: "hello",
    agent: "claude-code",
    workdir: repo,
    isolation: "worktree",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  await settle(600); // let the first turn resolve — the fake driver never registers
  // real tmux session state (see agents.ts's AGETOR_CLAUDE_DRIVER=fake branch),
  // so the follow-up below always takes sendClaudeTurn's "no live session"
  // (spawnResumedSession) path rather than the fold-while-busy paste path —
  // that path is exercised by orchestrator.test.ts's own fold-while-busy test
  // via claude-tmux.ts's `__forTest.installSession` seam, not reachable here.

  const updated = tasks.get(taskId);
  expect(updated?.worktreePath).toBeTruthy();
  const wt = updated!.worktreePath!;

  const sent = await sendInput(started.runId, "now @src/app.ts");
  expect(sent.delivered).toBe(true);
  await settle(300);

  const text = transcriptText(runs.eventsForTask(taskId));
  expect(text).toContain(`${wt}/src/app.ts`);

  tasks.delete(taskId);
});

test("startTask (gemini) rejects before any run row exists when @ expansion pushes the prompt over the argv budget, even though the raw prompt fits", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, runs, harnesses } = await import("./db.ts");
  const { expandAtReferences } = await import("./project-files.ts");
  const { GEMINI_PROMPT_ARGV_MAX_BYTES } = await import("../shared/prompt-limits.ts");
  harnesses.setEnabled("gemini", true);

  const dir = mkdtempSync(path.join(tmpdir(), "agetor-at-refs-gemini-"));
  writeFileSync(path.join(dir, "README.md"), "hi\n");

  // Repeat a short `@README.md` token enough times that the RAW prompt stays
  // comfortably under the argv budget, but the fully EXPANDED prompt (each
  // token replaced by the absolute path) blows past it — true regardless of
  // how long this machine's tmpdir path happens to be: even in the
  // pathological limit of an empty `dir`, 350 * len("/README.md") alone
  // already exceeds the 4096-byte budget.
  const count = 350;
  const rawPrompt = Array(count).fill("@README.md").join(" ");
  const rawBytes = new TextEncoder().encode(rawPrompt).length;
  expect(rawBytes).toBeLessThan(GEMINI_PROMPT_ARGV_MAX_BYTES);
  const expandedBytes = new TextEncoder().encode(expandAtReferences(rawPrompt, dir)).length;
  expect(expandedBytes).toBeGreaterThan(GEMINI_PROMPT_ARGV_MAX_BYTES);

  const created = await createTask({
    title: "at refs gemini overage",
    prompt: rawPrompt,
    agent: "gemini",
    workdir: dir,
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const started = await startTask(taskId);
  expect("error" in started).toBe(true);
  if ("error" in started) {
    expect(started.error).toMatch(/byte/);
    expect(started.error).toMatch(/limit/);
  }

  // No run row was ever inserted, and the task never left its pre-start column.
  expect(runs.listForTask(taskId).length).toBe(0);
  const after = tasks.get(taskId);
  expect(after?.column).not.toBe("running");
  expect(after?.runId ?? null).toBeNull();

  tasks.delete(taskId);
});

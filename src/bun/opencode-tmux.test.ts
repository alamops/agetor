import { test, expect, describe, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunEventStream } from "../shared/types.ts";
import { FX_USAGE_STATUS_PREFIX, SESSION_DIED_STATUS_PREFIX } from "../shared/types.ts";
import { deriveTodoProgress } from "../shared/todo-progress.ts";

// db.ts captures AGETOR_DATA_DIR at first import — set it at module top
// level, before the dynamic imports below (same convention as siblings).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-opencode-tmux-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

const {
  mapOpencodeEvent,
  createOpencodeMapCtx,
  createOpencodeLineProcessor,
  opencodeInnerScript,
  spawnOpencodeViaTmux,
  dropOpencodeSession,
  interruptOpencodeTurn,
  opencodeSessionActive,
  opencodeLogPath,
  opencodePromptPath,
  reattachOpencodeSession,
  opencodeSessionNameFor,
  __forTest,
} = await import("./opencode-tmux.ts");
const exportMod = await import("./opencode-export.ts");
const { rmTestDataDir } = await import("./test-data-dir.ts");

afterAll(() => {
  rmTestDataDir(DATA_DIR);
});

const FIXTURES = path.join(import.meta.dir, "fixtures", "opencode");
function fixtureLines(name: string): string[] {
  return readFileSync(path.join(FIXTURES, name), "utf8").split("\n").filter((l) => l.trim() !== "");
}

type Chunk = { stream: RunEventStream; data: string; lineUuid?: string };
function runFixture(name: string, major: 1 | 2) {
  const chunks: Chunk[] = [];
  const subagents: unknown[] = [];
  const sessionIds: string[] = [];
  const seen = new Set<string>();
  const proc = createOpencodeLineProcessor({
    onChunk: (stream, data, lineUuid) => chunks.push({ stream, data, lineUuid }),
    onSessionId: (id) => sessionIds.push(id),
    onSubagent: (n) => subagents.push(n),
    seenLineUuids: seen,
    major,
  });
  for (const l of fixtureLines(name)) proc.feed(l);
  return { chunks, subagents, sessionIds, proc, seen };
}
function toolUses(chunks: Chunk[]) {
  return chunks.filter((c) => c.stream === "tool_use").map((c) => ({ ...JSON.parse(c.data), lineUuid: c.lineUuid }));
}
function toolResults(chunks: Chunk[]) {
  return chunks.filter((c) => c.stream === "tool_result").map((c) => ({ ...JSON.parse(c.data), lineUuid: c.lineUuid }));
}
function usages(chunks: Chunk[]) {
  return chunks
    .filter((c) => c.stream === "status" && c.data.startsWith(FX_USAGE_STATUS_PREFIX))
    .map((c) => ({ ...JSON.parse(c.data.slice(FX_USAGE_STATUS_PREFIX.length)), lineUuid: c.lineUuid }));
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Mapper (D-8 table, A4) against the captured v1 and v2 fixtures.
 * ────────────────────────────────────────────────────────────────────────── */

describe("mapOpencodeEvent — v2 fixtures", () => {
  test("basic run: session id, reasoning → thinking, text → assistant, read tool pair, cumulative usage", () => {
    const { chunks, sessionIds, proc } = runFixture("v2-run-basic.jsonl", 2);
    expect(sessionIds).toEqual(["ses_e82633d29ffe0DoEvC6EOxs6O7"]);
    const thinking = chunks.filter((c) => c.stream === "thinking");
    expect(thinking).toHaveLength(2);
    expect(thinking[0]!.lineUuid).toBe("opencode:reasoning:prt_17d9cca19001LOmo4QD9hoqaAf");
    const assistant = chunks.filter((c) => c.stream === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.lineUuid).toBe("opencode:text:prt_17d9cd735002vKr34jY075yQpG");
    expect(assistant[0]!.data).toContain("Directory contents");

    // v2: part.partID is the prt_ id (line uuid), part.id the call id (toolUseId).
    const [use] = toolUses(chunks);
    expect(use).toMatchObject({
      id: "f9f995c1-6ca1-4cfd-979a-1db375e9ffc3",
      name: "read",
      input: { path: "/Users/test/project" },
      lineUuid: "opencode:tool:prt_17d9cce30001uzhNcFAHImflvg:use",
    });
    expect(use.title).toBeUndefined(); // title equal to the tool name is dropped
    const [res] = toolResults(chunks);
    expect(res).toMatchObject({
      toolUseId: "f9f995c1-6ca1-4cfd-979a-1db375e9ffc3",
      isError: false,
      lineUuid: "opencode:tool:prt_17d9cce30001uzhNcFAHImflvg:result",
    });
    expect(res.content).toContain("a.txt");

    const u = usages(chunks);
    expect(u.map((x) => x.lineUuid)).toEqual([
      "opencode:usage:prt_17d9cce8c001ebJ6aykMaNmxAa",
      "opencode:usage:prt_17d9ce28b001CoKEnr7tKrUnQu",
    ]);
    // Cumulative over the run: 5164+546 input, 84+59 output, 191+145 reasoning, 0+4992 cache read.
    expect(u[1]).toMatchObject({
      turn: { inputTokens: 5710, outputTokens: 143, reasoningTokens: 336, cacheReadTokens: 4992, cacheWriteTokens: 0 },
      cost: { amount: 0, currency: "USD" },
    });
    expect(proc.result()).toEqual({ failed: false, lastError: null, sessionId: "ses_e82633d29ffe0DoEvC6EOxs6O7", resumeNotFound: false });
    expect(proc.stats()).toMatchObject({ stepStarts: 2, stepFinishes: 2 });
  });

  test("todowrite → a TodoWrite tool_use that deriveTodoProgress counts; shell exit 1 still completed", () => {
    const { chunks, proc } = runFixture("v2-run-tools-todowrite.jsonl", 2);
    const uses = toolUses(chunks);
    expect(uses.map((u) => u.name)).toEqual(["shell", "shell", "TodoWrite"]);
    expect(uses[2]!.input).toEqual({ todos: [{ content: "alpha", status: "completed" }, { content: "beta", status: "pending" }] });
    expect(toolResults(chunks).every((r) => r.isError === false)).toBe(true);
    const progress = deriveTodoProgress(chunks);
    expect(progress?.todos.map((i) => [i.content, i.status])).toEqual([["alpha", "completed"], ["beta", "pending"]]);
    expect(progress).toMatchObject({ completed: 1, total: 2 });
    // The last step has no step_finish (spike Q3b): two step_finish for three step_start.
    expect(proc.stats()).toMatchObject({ stepStarts: 3, stepFinishes: 2 });
  });

  test("foreground subagent: child id from metadata.metadata.sessionID; read error is isError with the message", () => {
    const { chunks, subagents } = runFixture("v2-run-subagent.jsonl", 2);
    expect(subagents).toEqual([{
      childSessionId: "ses_e82612922ffe6VVY5SiPNRsanX",
      description: "List files in current directory",
      agentType: "explore",
      toolUseId: "e378f6ce-23b8-41aa-b25a-5da46ebae15a",
      background: false,
    }]);
    const err = toolResults(chunks).find((r) => r.isError);
    expect(err).toMatchObject({ toolUseId: "1de40417-3388-46a1-9960-9d3a91f9b7d2", content: "File not found: ./missing-file.txt" });
  });

  test("background subagent is flagged background", () => {
    const { subagents } = runFixture("v2-run-subagent-background.jsonl", 2);
    expect(subagents).toEqual([expect.objectContaining({
      childSessionId: "ses_e8250f036ffepNNRrhaD7yBOwE",
      background: true,
      agentType: "explore",
      description: "Sleep then list files",
    })]);
  });

  test("error rows: in-session free-limit (with retry hint), pre-session (no session id), bad model, unknown variant", () => {
    const inSession = runFixture("v2-run-error-in-session.jsonl", 2);
    const st = inSession.chunks.filter((c) => c.stream === "status");
    expect(st).toHaveLength(1);
    expect(st[0]!.data).toMatch(/^opencode: Free usage limit reached\..* \(retry after 10h 5m\)$/);
    expect(st[0]!.lineUuid).toBe("opencode:error:1");
    expect(inSession.proc.result()).toMatchObject({ failed: true, sessionId: "ses_e825ffffffffUnknownSpike01", resumeNotFound: false });

    const pre = runFixture("v2-run-error-pre-session.jsonl", 2);
    expect(pre.sessionIds).toEqual([]);
    expect(pre.proc.result()).toEqual({ failed: true, lastError: "File not found: /nonexistent-spike-file", sessionId: null, resumeNotFound: false });

    expect(runFixture("v2-run-error-bad-model.jsonl", 2).proc.result().lastError).toBe("Model unavailable: nope/nothing");
    expect(runFixture("v2-run-error-unknown-variant.jsonl", 2).proc.result().lastError)
      .toBe("Variant unavailable for opencode/deepseek-v4.1-flash-free: bogus");
  });

  test("interrupted Shared run: only step_start, no error", () => {
    const { chunks, proc } = runFixture("v2-run-interrupted-shared.jsonl", 2);
    expect(chunks).toEqual([]);
    expect(proc.result().failed).toBe(false);
  });
});

describe("mapOpencodeEvent — v1 fixtures", () => {
  test("todowrite: v1 part.id is the line uuid, callID the toolUseId; priority dropped; every step closed", () => {
    const { chunks, proc } = runFixture("v1-run-tools-todowrite.jsonl", 1);
    const uses = toolUses(chunks);
    expect(uses.map((u) => u.name)).toEqual(["bash", "bash", "TodoWrite"]);
    expect(uses[0]).toMatchObject({ id: "d50a0b2c-967f-42f1-b8ba-1c0dffc83cdf", lineUuid: "opencode:tool:prt_17da0f1000011Qqeu11vOK26j0:use" });
    expect(uses[2]!.input).toEqual({ todos: [{ content: "alpha", status: "completed" }, { content: "beta", status: "pending" }] });
    expect(deriveTodoProgress(chunks)).toMatchObject({ completed: 1, total: 2 });
    expect(proc.stats()).toMatchObject({ stepStarts: 3, stepFinishes: 3 });
    // tokens.total is ignored; cumulative input 7813+272+250.
    expect(usages(chunks).at(-1)!.turn.inputTokens).toBe(8335);
  });

  test("task subagent: child id from metadata.sessionId; string state.error", () => {
    const { chunks, subagents } = runFixture("v1-run-subagent.jsonl", 1);
    expect(subagents).toEqual([{
      childSessionId: "ses_e825eafb7ffeOjjZhBrQwKVqet",
      description: "List files in directory",
      agentType: "explore",
      toolUseId: "chatcmpl-tool-b739a89a2a4b11d4",
      background: false,
    }]);
    expect(toolResults(chunks).find((r) => r.isError)?.content).toBe("File not found: /Users/test/project/missing-file.txt");
  });

  test("v1 error shape {name, data.message}", () => {
    const { proc } = runFixture("v1-run-error-bad-model.jsonl", 1);
    expect(proc.result()).toMatchObject({ failed: true, lastError: "Unexpected server error. Check server logs for details." });
  });

  test("non-JSON: plain chatter skipped; ANSI Error: line becomes the turn error; resume-not-found only without a session id", () => {
    const ctx = createOpencodeMapCtx(1);
    expect(mapOpencodeEvent("some yargs help text", ctx, 0).chunks).toEqual([]);
    const pre = readFileSync(path.join(FIXTURES, "v1-run-error-pre-session.txt"), "utf8");
    const r1 = mapOpencodeEvent(pre, ctx, 1);
    expect(r1.chunks).toEqual([{ stream: "status", data: "opencode: File not found: /nonexistent-spike-file", lineUuid: "opencode:error:1" }]);
    expect(r1.resumeNotFound).toBeUndefined();

    const notFound = readFileSync(path.join(FIXTURES, "v1-resume-not-found.txt"), "utf8");
    const ctx2 = createOpencodeMapCtx(1);
    const r2 = mapOpencodeEvent(notFound, ctx2, 0);
    expect(r2.resumeNotFound).toBe(true);
    expect(ctx2.resumeNotFound).toBe(true);

    const ctx3 = createOpencodeMapCtx(1);
    ctx3.sessionId = "ses_already";
    expect(mapOpencodeEvent(notFound, ctx3, 0).resumeNotFound).toBeUndefined();
  });

  test("unknown types skipped; the attempt marker resets the failure state", () => {
    const ctx = createOpencodeMapCtx(2);
    expect(mapOpencodeEvent(JSON.stringify({ type: "something_new", sessionID: "ses_x" }), ctx, 0).chunks).toEqual([]);
    expect(ctx.sessionId).toBe("ses_x");
    mapOpencodeEvent(JSON.stringify({ type: "error", sessionID: "ses_x", error: { message: "boom" } }), ctx, 1);
    expect(ctx.failed).toBe(true);
    mapOpencodeEvent(JSON.stringify({ type: "agetor_attempt", attempt: 2 }), ctx, 2);
    expect(ctx.failed).toBe(false);
    expect(ctx.lastError).toBeNull();
  });
});

test("line uuids are stable on replay: a second pass with the same seen set emits nothing", () => {
  const first = runFixture("v2-run-subagent.jsonl", 2);
  expect(first.chunks.length).toBeGreaterThan(0);
  const replay: Chunk[] = [];
  const proc = createOpencodeLineProcessor({
    onChunk: (stream, data, lineUuid) => replay.push({ stream, data, lineUuid }),
    seenLineUuids: first.seen,
    major: 2,
  });
  for (const l of fixtureLines("v2-run-subagent.jsonl")) proc.feed(l);
  expect(replay).toEqual([]);
  // And a fresh pass reproduces exactly the same uuids.
  const again = runFixture("v2-run-subagent.jsonl", 2);
  expect(again.chunks.map((c) => c.lineUuid)).toEqual(first.chunks.map((c) => c.lineUuid));
});

test("todowrite: cancelled reads as completed", () => {
  const ctx = createOpencodeMapCtx(2);
  const line = JSON.stringify({
    type: "tool_use",
    sessionID: "ses_t",
    part: {
      partID: "prt_1", id: "call_1", type: "tool", tool: "todowrite",
      state: { status: "completed", input: { todos: [{ content: "x", status: "cancelled", priority: "high" }] }, output: "ok" },
    },
  });
  const use = JSON.parse(mapOpencodeEvent(line, ctx, 0).chunks[0]!.data);
  expect(use.input).toEqual({ todos: [{ content: "x", status: "completed" }] });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Driver through a fake `tmux` that really runs the pane command.
 * ────────────────────────────────────────────────────────────────────────── */

const TMUX_DIR = mkdtempSync(path.join(tmpdir(), "agetor-opencode-faketmux-"));
const TMUX_LOG = path.join(TMUX_DIR, "argv.jsonl");
const TMUX_BIN = path.join(TMUX_DIR, "tmux");
writeFileSync(
  TMUX_BIN,
  `#!${process.execPath}
import { appendFileSync, writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
const STATE = ${JSON.stringify(TMUX_DIR)};
let argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(TMUX_LOG)}, JSON.stringify({ argv }) + "\\n");
if (argv[0] === "-L") argv = argv.slice(2);
const cmd = argv[0];
const tIdx = argv.indexOf("-t");
const target = tIdx >= 0 ? argv[tIdx + 1].replace(/^=/, "").replace(/:$/, "") : "";
const pidFile = (n) => path.join(STATE, n + ".pid");
const alive = (n) => {
  if (!existsSync(pidFile(n))) return 0;
  const pid = Number(readFileSync(pidFile(n), "utf8"));
  try { process.kill(pid, 0); return pid; } catch { return 0; }
};
if (cmd === "new-session") {
  if (process.env.FAKE_TMUX_FAIL_NEW === "1") { process.stderr.write("fake new-session failure"); process.exit(1); }
  const name = argv[argv.indexOf("-s") + 1];
  const cwd = argv[argv.indexOf("-c") + 1];
  const env = { ...process.env };
  for (let i = 0; i < argv.length; i++) if (argv[i] === "-e") { const kv = argv[i + 1]; const eq = kv.indexOf("="); env[kv.slice(0, eq)] = kv.slice(eq + 1); }
  const rest = argv.slice(argv.indexOf("--") + 1);
  const child = spawn(rest[0], rest.slice(1), { cwd, env, detached: true, stdio: "ignore" });
  writeFileSync(pidFile(name), String(child.pid));
  child.unref();
  process.exit(0);
}
if (cmd === "has-session") {
  if (alive(target)) process.exit(0);
  process.stderr.write("can't find session: " + target); process.exit(1);
}
if (cmd === "send-keys") {
  const pid = alive(target);
  if (!pid) { process.stderr.write("can't find pane: " + target); process.exit(1); }
  if (argv.includes("C-c")) { try { process.kill(-pid, "SIGINT"); } catch {} }
  process.exit(0);
}
if (cmd === "kill-session") {
  const pid = alive(target);
  if (pid) { try { process.kill(-pid, "SIGKILL"); } catch {} }
  try { unlinkSync(pidFile(target)); } catch {}
  process.exit(pid ? 0 : 1);
}
if (cmd === "list-panes") {
  for (const f of readdirSync(STATE)) if (f.endsWith(".pid")) { const n = f.slice(0, -4); const pid = alive(n); if (pid) process.stdout.write(n + "\\t" + pid + "\\n"); }
  process.exit(0);
}
process.exit(0);
`,
);
chmodSync(TMUX_BIN, 0o755);
process.env.AGETOR_TMUX_BIN = TMUX_BIN;

/** A fake `opencode` script: records its argv + stdin, prints a fixture,
 *  then either exits with a code or blocks until interrupted. */
function fakeOpencode(body: string): string {
  const p = path.join(TMUX_DIR, `oc-${randomUUID()}.sh`);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
function tmuxCalls(): string[][] {
  if (!existsSync(TMUX_LOG)) return [];
  return readFileSync(TMUX_LOG, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { argv: string[] }).argv);
}
function collectChunks() {
  const chunks: Chunk[] = [];
  return { chunks, onChunk: (stream: RunEventStream, data: string, lineUuid?: string) => chunks.push({ stream, data, lineUuid }) };
}
function ids() {
  return { taskId: `task-oc-${randomUUID()}`, runId: `run-oc-${randomUUID()}` };
}

test("wrapper argv: trap prefix, prompt on stdin (< prompt), prompt never in argv, -x 200 -y 50, env via -e", async () => {
  process.env.FAKE_TMUX_FAIL_NEW = "1";
  try {
    const { taskId, runId } = ids();
    const { chunks, onChunk } = collectChunks();
    const before = tmuxCalls().length;
    const agent = await spawnOpencodeViaTmux({
      taskId, runId,
      argv: ["opencode", "run", "--format", "json", "--thinking", "--standalone"],
      env: { XDG_DATA_HOME: "/tmp/oc-home/.local/share" },
      cwd: "/tmp",
      promptText: "fix the \"bug\" now",
      major: 2,
      onChunk,
    });
    expect(await agent.done).toBe(1);
    expect(chunks.some((c) => c.stream === "stderr" && c.data.includes("fake new-session failure"))).toBe(true);
    const ns = tmuxCalls().slice(before).find((a) => a.includes("new-session"))!;
    expect(ns[ns.indexOf("-x") + 1]).toBe("200");
    expect(ns[ns.indexOf("-y") + 1]).toBe("50");
    expect(ns.some((a, i) => a === "-e" && ns[i + 1] === "XDG_DATA_HOME=/tmp/oc-home/.local/share")).toBe(true);
    const inner = ns[ns.lastIndexOf("-c") + 1]!;
    expect(inner).toBe(opencodeInnerScript(runId));
    expect(inner.startsWith("trap 'true' INT; \"$@\" < '")).toBe(true);
    expect(inner).toContain(`< '${opencodePromptPath(runId)}'`);
    expect(inner).toContain("echo $? > '");
    expect(ns.slice(ns.lastIndexOf("-c") + 2)).toEqual(["sh", "opencode", "run", "--format", "json", "--thinking", "--standalone"]);
    expect(ns.join("\u0000")).not.toContain("fix the");
    expect(readFileSync(opencodePromptPath(runId), "utf8")).toBe("fix the \"bug\" now");
  } finally {
    delete process.env.FAKE_TMUX_FAIL_NEW;
  }
});

test("settle on exit 0: streams the fixture, reports the session id, prompt arrives on stdin, beforeSettle awaited first", async () => {
  const { taskId, runId } = ids();
  const stdinCopy = path.join(TMUX_DIR, `${runId}.stdin`);
  const bin = fakeOpencode(`cat > ${JSON.stringify(stdinCopy)}\ncat ${JSON.stringify(path.join(FIXTURES, "v1-run-tools-todowrite.jsonl"))}\nexit 0`);
  const { chunks, onChunk } = collectChunks();
  const sessionIds: string[] = [];
  const order: string[] = [];
  const agent = await spawnOpencodeViaTmux({
    taskId, runId, argv: [bin, "run"], env: {}, cwd: TMUX_DIR, promptText: "hello there", major: 1,
    onChunk, onSessionId: (id) => sessionIds.push(id),
    beforeSettle: async (info) => {
      order.push(`before:${info.code}:${info.sessionId}`);
      await new Promise((r) => setTimeout(r, 50));
    },
  });
  expect(opencodeSessionActive(taskId)).toBe(true);
  const code = await agent.done;
  order.push("done");
  expect(code).toBe(0);
  expect(sessionIds).toHaveLength(1);
  expect(order).toEqual([`before:0:${sessionIds[0]}`, "done"]);
  expect(readFileSync(stdinCopy, "utf8")).toBe("hello there");
  expect(chunks.filter((c) => c.stream === "tool_use")).toHaveLength(3);
  expect(opencodeSessionActive(taskId)).toBe(false);
});

test("settle on exit 0 with an error event reads as failed (1); exit 1 surfaces the error", async () => {
  const { taskId, runId } = ids();
  const bin = fakeOpencode(`cat > /dev/null\ncat ${JSON.stringify(path.join(FIXTURES, "v2-run-error-in-session.jsonl"))}\nexit 0`);
  const { chunks, onChunk } = collectChunks();
  const agent = await spawnOpencodeViaTmux({ taskId, runId, argv: [bin], env: {}, cwd: TMUX_DIR, promptText: "x", major: 2, onChunk });
  expect(await agent.done).toBe(1);
  expect(chunks.some((c) => c.stream === "status" && c.data.startsWith("opencode: Free usage limit reached"))).toBe(true);

  const b = ids();
  const bin2 = fakeOpencode(`cat > /dev/null\necho "usage: opencode run [message..]" >&2\nexit 1`);
  const c2 = collectChunks();
  const agent2 = await spawnOpencodeViaTmux({ taskId: b.taskId, runId: b.runId, argv: [bin2], env: {}, cwd: TMUX_DIR, promptText: "x", major: 1, onChunk: c2.onChunk });
  expect(await agent2.done).toBe(1);
  expect(c2.chunks.some((c) => c.data === "opencode: exited with code 1")).toBe(true);
});

test("settle on exit 130: Stop sends C-c, the trap keeps sh alive to record 130", async () => {
  const { taskId, runId } = ids();
  const bin = fakeOpencode(`cat > /dev/null\nsleep 30`);
  const { chunks, onChunk } = collectChunks();
  const before = tmuxCalls().length;
  const agent = await spawnOpencodeViaTmux({ taskId, runId, argv: [bin], env: {}, cwd: TMUX_DIR, promptText: "x", major: 1, onChunk });
  await new Promise((r) => setTimeout(r, 300));
  agent.kill();
  expect(await agent.done).toBe(130);
  const calls = tmuxCalls().slice(before);
  expect(calls.some((a) => a.includes("send-keys") && a.includes(`=${opencodeSessionNameFor(taskId)}:`) && a.includes("C-c"))).toBe(true);
  expect(chunks.some((c) => c.data.startsWith(SESSION_DIED_STATUS_PREFIX))).toBe(false);
  expect(chunks.some((c) => c.data.startsWith("opencode: exited with code"))).toBe(false);
});

test("fresh retry (D-9): v1 resume-not-found relaunches once with freshArgv and posts the breadcrumb", async () => {
  const { taskId, runId } = ids();
  const notFound = path.join(FIXTURES, "v1-resume-not-found.txt");
  const ok = path.join(FIXTURES, "v1-run-unknown-variant-accepted.jsonl");
  const bin = fakeOpencode(
    `cat > /dev/null\nfor a in "$@"; do if [ "$a" = "-s" ]; then cat ${JSON.stringify(notFound)} >&2; echo >&2; exit 1; fi; done\ncat ${JSON.stringify(ok)}\nexit 0`,
  );
  const { chunks, onChunk } = collectChunks();
  const sessionIds: string[] = [];
  const before = tmuxCalls().length;
  const agent = await spawnOpencodeViaTmux({
    taskId, runId,
    argv: [bin, "run", "-s", "ses_e825ffffffffUnknownSpike01"],
    freshArgv: [bin, "run", "--title", "My task"],
    env: {}, cwd: TMUX_DIR, promptText: "x", major: 1, onChunk, onSessionId: (id) => sessionIds.push(id),
  });
  expect(await agent.done).toBe(0);
  expect(chunks.some((c) => c.data === "couldn't resume OpenCode session ses_e825… — starting a fresh session")).toBe(true);
  expect(sessionIds).toEqual(["ses_e8258cb06ffe2TIM1rQNRs9f1p"]);
  const launches = tmuxCalls().slice(before).filter((a) => a.includes("new-session"));
  expect(launches).toHaveLength(2);
  expect(launches[0]).toContain("-s");
  expect(launches[1]!.slice(launches[1]!.lastIndexOf("-c") + 4)).toEqual(["run", "--title", "My task"]);
  // Both attempts share the one log; a reattach replay of it still settles succeeded.
  const log = readFileSync(opencodeLogPath(runId), "utf8");
  expect(log).toContain("Session not found");
  expect(log).toContain('"agetor_attempt"');
  const proc = createOpencodeLineProcessor({ onChunk: () => {}, major: 1 });
  for (const l of log.split("\n")) proc.feed(l);
  expect(proc.result()).toMatchObject({ failed: false, sessionId: "ses_e8258cb06ffe2TIM1rQNRs9f1p" });
});

test("no retry without freshArgv: resume-not-found just fails", async () => {
  const { taskId, runId } = ids();
  const bin = fakeOpencode(`cat > /dev/null\ncat ${JSON.stringify(path.join(FIXTURES, "v1-resume-not-found.txt"))} >&2\nexit 1`);
  const { chunks, onChunk } = collectChunks();
  const agent = await spawnOpencodeViaTmux({ taskId, runId, argv: [bin, "-s", "ses_x"], env: {}, cwd: TMUX_DIR, promptText: "x", major: 1, onChunk });
  expect(await agent.done).toBe(1);
  expect(chunks.some((c) => c.data === "opencode: Session not found")).toBe(true);
  expect(chunks.some((c) => c.data.startsWith("couldn't resume"))).toBe(false);
});

test("a throwing beforeSettle can't hang the run", async () => {
  const { taskId, runId } = ids();
  const bin = fakeOpencode(`cat > /dev/null\nexit 0`);
  const agent = await spawnOpencodeViaTmux({
    taskId, runId, argv: [bin], env: {}, cwd: TMUX_DIR, promptText: "x", major: 2, onChunk: () => {},
    beforeSettle: async () => { throw new Error("boom"); },
  });
  expect(await agent.done).toBe(0);
});

test("drop sends C-c, waits out the grace, then kills the session", async () => {
  const { taskId, runId } = ids();
  // Ignores SIGINT, so only the kill can end it.
  const bin = fakeOpencode(`trap '' INT\ncat > /dev/null\nsleep 30`);
  const agent = await spawnOpencodeViaTmux({ taskId, runId, argv: [bin], env: {}, cwd: TMUX_DIR, promptText: "x", major: 2, onChunk: () => {} });
  await new Promise((r) => setTimeout(r, 300));
  const before = tmuxCalls().length;
  const t0 = Date.now();
  await dropOpencodeSession(taskId, { graceMs: 600 });
  expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
  const calls = tmuxCalls().slice(before).map((a) => a.find((x) => ["send-keys", "has-session", "kill-session"].includes(x)));
  const firstCtrlC = calls.indexOf("send-keys");
  const kill = calls.lastIndexOf("kill-session");
  expect(firstCtrlC).toBeGreaterThanOrEqual(0);
  expect(kill).toBeGreaterThan(firstCtrlC);
  expect(calls.slice(firstCtrlC, kill).includes("has-session")).toBe(true);
  expect(await agent.done).toBe(130);
  expect(opencodeSessionActive(taskId)).toBe(false);
});

test("drop of a client that honors C-c returns quickly", async () => {
  const { taskId, runId } = ids();
  const bin = fakeOpencode(`cat > /dev/null\nsleep 30`);
  const agent = await spawnOpencodeViaTmux({ taskId, runId, argv: [bin], env: {}, cwd: TMUX_DIR, promptText: "x", major: 2, onChunk: () => {} });
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  await dropOpencodeSession(taskId, { graceMs: 5_000 });
  expect(Date.now() - t0).toBeLessThan(3_000);
  await agent.done;
});

test("Stop escalates to a kill when the client ignores C-c", async () => {
  const prev = __forTest.setStopEscalateMs(400);
  try {
    const { taskId, runId } = ids();
    const bin = fakeOpencode(`trap '' INT\ncat > /dev/null\nsleep 30`);
    const agent = await spawnOpencodeViaTmux({ taskId, runId, argv: [bin], env: {}, cwd: TMUX_DIR, promptText: "x", major: 2, onChunk: () => {} });
    await new Promise((r) => setTimeout(r, 300));
    agent.kill();
    expect(await agent.done).toBe(130);
  } finally {
    __forTest.setStopEscalateMs(prev);
  }
});

test("death watch: a session killed with no exit file posts the session-ended sentinel and fails", async () => {
  const { taskId, runId } = ids();
  const bin = fakeOpencode(`cat > /dev/null\nsleep 30`);
  const { chunks, onChunk } = collectChunks();
  const agent = await spawnOpencodeViaTmux({ taskId, runId, argv: [bin], env: {}, cwd: TMUX_DIR, promptText: "x", major: 2, onChunk });
  await new Promise((r) => setTimeout(r, 300));
  // Kill behind the driver's back (SIGKILL: the shell can't write the exit file).
  Bun.spawnSync([TMUX_BIN, "kill-session", "-t", `=${opencodeSessionNameFor(taskId)}`]);
  expect(await agent.done).toBe(1);
  expect(chunks.some((c) => c.stream === "status" && c.data.startsWith(SESSION_DIED_STATUS_PREFIX))).toBe(true);
}, 15_000);

test("death watch after a Stop: a dead pane with no exit file reads as cancelled (130), no sentinel", async () => {
  const { taskId, runId } = ids();
  const bin = fakeOpencode(`trap '' INT\ncat > /dev/null\nsleep 30`);
  const { chunks, onChunk } = collectChunks();
  const agent = await spawnOpencodeViaTmux({ taskId, runId, argv: [bin], env: {}, cwd: TMUX_DIR, promptText: "x", major: 1, onChunk });
  await new Promise((r) => setTimeout(r, 300));
  expect(await interruptOpencodeTurn(taskId)).toBe(true); // ignored by the client, but marks the turn cancelled
  Bun.spawnSync([TMUX_BIN, "kill-session", "-t", `=${opencodeSessionNameFor(taskId)}`]);
  expect(await agent.done).toBe(130);
  expect(chunks.some((c) => c.data.startsWith(SESSION_DIED_STATUS_PREFIX))).toBe(false);
  expect(await interruptOpencodeTurn(taskId)).toBe(false); // session gone
}, 15_000);

test("reattach: null when the session is gone; otherwise replays the log deduped and settles on the exit file", async () => {
  expect(await reattachOpencodeSession({
    taskId: "t-none", runId: "r-none", sessionName: "agetor-nope", onChunk: () => {}, seenLineUuids: new Set(), major: 2,
  })).toBeNull();

  const { taskId, runId } = ids();
  const bin = fakeOpencode(`cat > /dev/null\ncat ${JSON.stringify(path.join(FIXTURES, "v2-run-basic.jsonl"))}\nsleep 1\nexit 0`);
  const first = collectChunks();
  const agent = await spawnOpencodeViaTmux({ taskId, runId, argv: [bin], env: {}, cwd: TMUX_DIR, promptText: "x", major: 2, onChunk: first.onChunk });
  await new Promise((r) => setTimeout(r, 500));
  const seen = new Set(first.chunks.map((c) => c.lineUuid).filter((u): u is string => !!u));
  const replay = collectChunks();
  const re = await reattachOpencodeSession({
    taskId: `${taskId}-re`, runId, sessionName: opencodeSessionNameFor(taskId), onChunk: replay.onChunk, seenLineUuids: seen, major: 2,
  });
  expect(re).not.toBeNull();
  expect(await re!.done).toBe(0);
  await agent.done;
  expect(replay.chunks.filter((c) => c.lineUuid && first.chunks.some((f) => f.lineUuid === c.lineUuid))).toEqual([]);
});

test("v2 missing final step_finish: usage reconciled from the export before settle", async () => {
  const prev = exportMod.__forTest.setExportRunner(async (a) => {
    expect(a.standalone).toBe(true);
    return exportMod.parseOpencodeExport(readFileSync(path.join(FIXTURES, "v2-session-export.json"), "utf8"), 2);
  });
  try {
    const { taskId, runId } = ids();
    const bin = fakeOpencode(`cat > /dev/null\ncat ${JSON.stringify(path.join(FIXTURES, "v2-run-tools-todowrite.jsonl"))}\nexit 0`);
    const { chunks, onChunk } = collectChunks();
    const agent = await spawnOpencodeViaTmux({ taskId, runId, argv: [bin, "run", "--standalone"], env: {}, cwd: TMUX_DIR, promptText: "x", major: 2, onChunk });
    expect(await agent.done).toBe(0);
    const rec = chunks.find((c) => c.lineUuid === "opencode:usage:reconciled");
    expect(rec).toBeDefined();
    // Sum over the export's assistant messages after its last user message.
    expect(JSON.parse(rec!.data.slice(FX_USAGE_STATUS_PREFIX.length)).turn.inputTokens).toBe(5489 + 498 + 419);
  } finally {
    exportMod.__forTest.setExportRunner(prev);
  }
});

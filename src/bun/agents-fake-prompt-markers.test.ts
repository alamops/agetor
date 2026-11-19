import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

/* ────────────────────────────────────────────────────────────────────────── *
 * T13 — docs/plans/claude-enter-to-confirm-prompts.md. The fake claude driver's
 * Enter-only and OAuth-code markers register a card through the real matcher
 * chain (`registerFakePromptPane`) and hold the turn until the real card drive
 * answers it, so an e2e exercises the real route, allow-list, matcher and card.
 * ────────────────────────────────────────────────────────────────────────── */

const testDataDir = mkdtempSync(path.join(tmpdir(), "agetor-fake-prompt-markers-"));
process.env.AGETOR_DATA_DIR = testDataDir;
// `bun test` runs every file in one process: both restored in afterAll.
const savedDriver = process.env.AGETOR_CLAUDE_DRIVER;
const savedClaudeBin = process.env.AGETOR_CLAUDE_BIN;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
// `sessionExists` must reflect ONLY the fake pane: a tmux that never has a
// session (not the `/bin/echo` another file in this process may have left).
const savedTmuxBin = process.env.AGETOR_TMUX_BIN;
process.env.AGETOR_TMUX_BIN = "/usr/bin/false";

const { spawnAgent, FAKE_CLAUDE_ENTER_PROMPT_MARKER, FAKE_CLAUDE_PASTE_CODE_PROMPT_MARKER } = await import("./agents.ts");
const { answerTmuxPromptInPane, registerFakePromptPane, clearFakePromptPane, sessionExists } = await import("./claude-tmux.ts");
const { activeTmuxPromptsForTask } = await import("./interactions.ts");
const { tasks, runs } = await import("./db.ts");
const { makeTask } = await import("../cli/test-fixtures.ts");

afterAll(() => {
  if (savedDriver === undefined) delete process.env.AGETOR_CLAUDE_DRIVER;
  else process.env.AGETOR_CLAUDE_DRIVER = savedDriver;
  if (savedClaudeBin === undefined) delete process.env.AGETOR_CLAUDE_BIN;
  else process.env.AGETOR_CLAUDE_BIN = savedClaudeBin;
  if (savedTmuxBin === undefined) delete process.env.AGETOR_TMUX_BIN;
  else process.env.AGETOR_TMUX_BIN = savedTmuxBin;
  rmTestDataDir(testDataDir);
});

const HARNESS = { id: "claude-code", kind: "claude-code", label: "Claude Code", isBuiltin: true, home: null, bin: null, env: {}, enabled: true } as never;

async function start(marker: string) {
  const taskId = randomUUID();
  const runId = randomUUID();
  tasks.insert(makeTask({ id: taskId, runId: null, column: "running" }));
  runs.insert({
    id: runId, taskId, agent: "claude-code", status: "running", startedAt: Date.now(), endedAt: null, exitCode: null,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null,
    fxSessionId: null, antigravitySessionId: null,
  } as never);
  tasks.update(taskId, { runId });
  const chunks: Array<{ stream: string; data: string }> = [];
  const agent = await spawnAgent({
    taskId, runId, harness: HARNESS, prompt: `${marker} hello`, cwd: tmpdir(),
    onChunk: (stream, data) => { chunks.push({ stream, data }); },
    opts: { mode: null, model: "sonnet", effort: "high" },
  });
  const deadline = Date.now() + 5_000;
  while (activeTmuxPromptsForTask(taskId).length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  return { taskId, agent, chunks, cleanup: () => { try { tasks.delete(taskId); } catch { /* gone */ } } };
}

describe("fake Enter-only marker", () => {
  test("registers an enter card, and Enter completes the turn with 'continued'", async () => {
    const t = await start(FAKE_CLAUDE_ENTER_PROMPT_MARKER);
    try {
      const [card] = activeTmuxPromptsForTask(t.taskId);
      expect(card!.answerKind).toBe("enter");
      expect(card!.choices).toEqual([]);
      expect(card!.paneText).toContain("Press Enter to continue");
      expect(await sessionExists(t.taskId)).toBe(true); // the fake pane stands in for the tmux session
      const r = await answerTmuxPromptInPane(card!, { kind: "enter" });
      expect(r).toEqual({ ok: true });
      expect(await t.agent.done).toBe(0);
      expect(t.chunks.some((c) => c.stream === "assistant" && c.data === "continued")).toBe(true);
      expect(await sessionExists(t.taskId)).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  test("a wrong-kind answer is refused and the turn stays held", async () => {
    const t = await start(FAKE_CLAUDE_ENTER_PROMPT_MARKER);
    try {
      const [card] = activeTmuxPromptsForTask(t.taskId);
      expect(await answerTmuxPromptInPane(card!, { kind: "code", code: "abc" })).toEqual({ ok: false, reason: "wrong-kind" });
      expect(t.chunks.some((c) => c.data === "continued")).toBe(false);
      t.agent.kill();
    } finally {
      t.cleanup();
    }
  });
});

describe("fake OAuth-code marker", () => {
  test("registers a code card; the code completes the turn with its length only", async () => {
    const t = await start(FAKE_CLAUDE_PASTE_CODE_PROMPT_MARKER);
    try {
      const [card] = activeTmuxPromptsForTask(t.taskId);
      expect(card!.answerKind).toBe("code");
      const r = await answerTmuxPromptInPane(card!, { kind: "code", code: "test-code-123" });
      expect(r).toEqual({ ok: true });
      expect(await t.agent.done).toBe(0);
      expect(t.chunks.some((c) => c.stream === "assistant" && c.data === "code received (13 chars)")).toBe(true);
      expect(JSON.stringify(t.chunks)).not.toContain("test-code-123");
    } finally {
      t.cleanup();
    }
  });
});

describe("registerFakePromptPane / clearFakePromptPane", () => {
  test("are no-ops outside the fake driver", async () => {
    const saved = process.env.AGETOR_CLAUDE_DRIVER;
    delete process.env.AGETOR_CLAUDE_DRIVER;
    try {
      const taskId = randomUUID();
      registerFakePromptPane(taskId, { text: "Press Enter to continue…", onKeys: () => { throw new Error("must not be reached"); } });
      expect(activeTmuxPromptsForTask(taskId)).toEqual([]);
      clearFakePromptPane(taskId);
    } finally {
      process.env.AGETOR_CLAUDE_DRIVER = saved;
    }
  });

  test("kill() clears the pane so the session no longer reads as live", async () => {
    const t = await start(FAKE_CLAUDE_ENTER_PROMPT_MARKER);
    try {
      expect(await sessionExists(t.taskId)).toBe(true);
      t.agent.kill();
      expect(await sessionExists(t.taskId)).toBe(false);
    } finally {
      t.cleanup();
    }
  });
});

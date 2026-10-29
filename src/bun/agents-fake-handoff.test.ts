import { test, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Harness } from "../shared/types.ts";
import { classifyStepResponse, parseHandoff, splitHandoffMessage } from "../shared/pipeline.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// agents.ts reaches db.ts (tasks, subagents), which opens its sqlite
// connection at module-load time, so AGETOR_DATA_DIR must be set before a
// *dynamic* import of agents.ts (same bootstrap as agents.test.ts).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-fake-handoff-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
const priorDriver = process.env.AGETOR_CLAUDE_DRIVER;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
const { spawnAgent, FAKE_CLAUDE_HANDOFF_PROMPT_MARKER, fakeRichHandoffArtifacts } = await import("./agents.ts");

const scratchDirs: string[] = [];

afterAll(() => {
  if (priorDriver === undefined) delete process.env.AGETOR_CLAUDE_DRIVER;
  else process.env.AGETOR_CLAUDE_DRIVER = priorDriver;
  rmTestDataDir(DATA_DIR);
});

const claude: Harness = {
  id: "claude-code",
  kind: "claude-code",
  label: "claude-code",
  isBuiltin: true,
  home: null,
  bin: null,
  env: {},
  enabled: true,
};

function newCwd(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-fake-handoff-cwd-"));
  scratchDirs.push(dir);
  return dir;
}

let seq = 0;

/** One fake claude-code handoff turn; returns the assistant text it emitted. */
async function runTurn(taskId: string, suffix: string, cwd: string): Promise<string> {
  let assistantText = "";
  const handle = await spawnAgent({
    taskId,
    runId: `run-${taskId}-${seq++}`,
    harness: claude,
    prompt: `Do the step. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:${suffix}`,
    cwd,
    onChunk: (stream, data) => {
      if (stream === "assistant") assistantText += data;
    },
    opts: { model: "claude-opus-4-7", effort: "high" },
  });
  await handle.done;
  return assistantText;
}

const CANONICAL_SUMMARY = "**Rich** handoff with `code` and a list:\n- one\n- two\n- three\n- four\n- five";

test("fakeRichHandoffArtifacts lists the eight canonical entries, #2 absolute under cwd", () => {
  const cwd = "/work/example";
  expect(fakeRichHandoffArtifacts(cwd)).toEqual([
    "agetor-handoff/notes.md",
    "/work/example/agetor-handoff/report.txt",
    "https://example.invalid/pr/1",
    "agetor-handoff/notes.md (the plan)",
    "agetor-handoff/notes.md:12",
    "agetor-handoff/missing.md",
    "jubarteai:00000000-0000-4000-8000-000000000000 (note)",
    "commit 1234abc on feature/example",
  ]);
});

for (const [suffix, status] of [
  ["rich", "done"],
  ["rich-blocked", "blocked"],
] as const) {
  test(`fake handoff :${suffix} emits the canonical rich handoff and writes both files into cwd`, async () => {
    const cwd = newCwd();
    const text = await runTurn(`task-fake-handoff-${suffix}`, suffix, cwd);

    const split = splitHandoffMessage(text);
    expect(split.before).toContain("Here is the rich handoff.");
    expect(split.after.trim()).toBe("");
    expect(split.block).not.toBeNull();
    const result = split.block!.result;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.handoff).toEqual({
      schemaVersion: 1,
      purpose: "e2e rich purpose",
      summary: CANONICAL_SUMMARY,
      reason: "e2e rich reason uniquetoken-reason",
      next: null,
      artifacts: fakeRichHandoffArtifacts(cwd),
      openQuestions: ["First e2e question?", "Second e2e question?"],
      status,
    });

    // Entries 1 and 2 exist on disk; entry 6 is deliberately never written.
    const dir = path.join(cwd, "agetor-handoff");
    expect(existsSync(path.join(dir, "notes.md"))).toBe(true);
    expect(readFileSync(path.join(dir, "report.txt"), "utf8").length).toBeGreaterThan(0);
    expect(existsSync(fakeRichHandoffArtifacts(cwd)[1] as string)).toBe(true);
    expect(existsSync(path.join(dir, "missing.md"))).toBe(false);
  });
}

test("fake handoff :mention parses under the code-aware parser but not under codeAware:false", async () => {
  const text = await runTurn("task-fake-handoff-mention", "mention", newCwd());
  // The prose quotes the tag and a `{…}` shape in inline code.
  expect(text).toContain("`<handoff>`");
  expect(text).toContain("`{schemaVersion, …}`");

  const aware = parseHandoff(text);
  expect(aware.ok).toBe(true);
  if (aware.ok) expect(aware.handoff.next).toBeNull();
  expect(splitHandoffMessage(text).block?.result.ok).toBe(true);
  expect(classifyStepResponse({ runStatus: "succeeded", assistantText: text, pendingInteractions: 0 }).kind).toBe("handoff");

  // The legacy tokenizer pairs the quoted open tag with the real close tag.
  expect(parseHandoff(text, { codeAware: false }).ok).toBe(false);
});

test("fake handoff :fenced wraps a valid block in a fence, so it classifies as handoff-missing", async () => {
  const text = await runTurn("task-fake-handoff-fenced", "fenced", newCwd());
  expect(text).toContain("```");
  expect(text).toContain("<handoff>");
  expect(parseHandoff(text).ok).toBe(false);
  expect(splitHandoffMessage(text).block).toBeNull();
  expect(classifyStepResponse({ runStatus: "succeeded", assistantText: text, pendingInteractions: 0 }).kind).toBe(
    "handoff-missing",
  );
});

test("fake handoff :fenced-then-done is fenced on turn 1 and a valid handoff on turn 2", async () => {
  const taskId = "task-fake-handoff-fenced-then-done";
  const cwd = newCwd();
  const turn1 = await runTurn(taskId, "fenced-then-done", cwd);
  expect(parseHandoff(turn1).ok).toBe(false);
  const turn2 = await runTurn(taskId, "fenced-then-done", cwd);
  const parsed = parseHandoff(turn2);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.handoff.next).toBeNull();
    expect(parsed.handoff.status).toBe("done");
  }
});

test("fake handoff done / missing / invalid / <token> output is unchanged", async () => {
  const cwd = newCwd();
  const doneJson = (summary: string, next: string | null) =>
    JSON.stringify({
      schemaVersion: 1,
      purpose: "fake purpose",
      summary,
      reason: "fake reason",
      next,
      artifacts: [],
      openQuestions: [],
      status: "done",
    });

  expect(await runTurn("task-fake-handoff-plain-done", "done", cwd)).toBe(
    `Done.\n<handoff>\n${doneJson("fake summary for done", null)}\n</handoff>`,
  );
  expect(await runTurn("task-fake-handoff-plain-token", "StepB", cwd)).toBe(
    `Done.\n<handoff>\n${doneJson("fake summary for StepB", "StepB")}\n</handoff>`,
  );
  expect(await runTurn("task-fake-handoff-plain-missing", "missing", cwd)).toBe(
    "I finished the work but forgot the handoff.",
  );
  expect(await runTurn("task-fake-handoff-plain-invalid", "invalid", cwd)).toBe(
    "Done.\n<handoff>\n{not json\n</handoff>",
  );
  // None of the plain suffixes touch the cwd.
  expect(existsSync(path.join(cwd, "agetor-handoff"))).toBe(false);
});

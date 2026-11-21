import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentKind, Harness, Task, TaskRepository } from "../shared/types.ts";

// agents.ts imports db.ts, which opens its sqlite connection at module load:
// set the data dir at the top level and import dynamically (see
// agents-fake-md-image.test.ts).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-agents-pr-proposal-db-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
const { spawnAgent, FAKE_CLAUDE_PR_PROPOSAL_PROMPT_MARKER, FAKE_CLAUDE_HANDOFF_PROMPT_MARKER, renderFakePrProposalReply } =
  await import("./agents.ts");
const { tasks } = await import("./db.ts");
const { rmTestDataDir } = await import("./test-data-dir.ts");

const ORIGINAL_DRIVER = process.env.AGETOR_CLAUDE_DRIVER;
const ORIGINAL_BIN = process.env.AGETOR_CLAUDE_BIN;
beforeAll(() => {
  process.env.AGETOR_CLAUDE_DRIVER = "fake";
  process.env.AGETOR_CLAUDE_BIN = "claude";
});
afterAll(() => {
  if (ORIGINAL_DRIVER === undefined) delete process.env.AGETOR_CLAUDE_DRIVER;
  else process.env.AGETOR_CLAUDE_DRIVER = ORIGINAL_DRIVER;
  if (ORIGINAL_BIN === undefined) delete process.env.AGETOR_CLAUDE_BIN;
  else process.env.AGETOR_CLAUDE_BIN = ORIGINAL_BIN;
  rmTestDataDir(DATA_DIR);
});

const harness: Harness = {
  id: "claude-code",
  kind: "claude-code" as AgentKind,
  label: "claude-code",
  isBuiltin: true,
  home: null,
  bin: null,
  env: {},
  enabled: true,
};

const repo = (name: string, branch: string): TaskRepository => ({
  path: `/repos/${name}`,
  name,
  branch,
  branchSource: "created",
  worktreePath: null,
  baseRef: null,
  checkoutBranch: null,
  prUrl: null,
});

function insertTask(id: string, branch: string | null, repositories: TaskRepository[] = []): void {
  tasks.insert({
    id,
    title: "t",
    prompt: "p",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    speed: "off",
    maxMode: false,
    opencodeServer: "shared",
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    column: "ready",
    runId: null,
    repositories,
    multiRepo: repositories.length > 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
  } as Task);
}

const marker = (template: string) =>
  `${FAKE_CLAUDE_PR_PROPOSAL_PROMPT_MARKER}:${Buffer.from(template, "utf8").toString("base64url")}`;

async function run(taskId: string, prompt: string) {
  const chunks: { stream: string; data: string }[] = [];
  const handle = await spawnAgent({
    taskId,
    runId: `run-${taskId}`,
    harness,
    prompt,
    cwd: "/tmp",
    onChunk: (stream, data) => { chunks.push({ stream, data }); },
    opts: { mode: "auto", model: "opus-4.7", effort: "high" },
  });
  const exitCode = await handle.done;
  return { chunks, exitCode };
}

test("emits one assistant chunk with {{branch:<repo>}} and {{branch}} resolved, then completes", async () => {
  insertTask("pr-prop-1", "feature/solo", [repo("app", "feature/app-x"), repo("infra", "feature/infra-y")]);
  const template = [
    "Repository: app",
    "https://github.com/acme/app/compare/main...{{branch:app}}",
    "PR title:",
    "```",
    "Title for {{branch:infra}} / {{branch}}",
    "```",
  ].join("\n");
  const { chunks, exitCode } = await run("pr-prop-1", `go ${marker(template)}`);
  expect(exitCode).toBe(0);
  const assistant = chunks.filter((c) => c.stream === "assistant");
  expect(assistant).toHaveLength(1);
  expect(assistant[0]!.data).toContain("compare/main...feature/app-x");
  expect(assistant[0]!.data).toContain("Title for feature/infra-y / feature/solo");
  const status = chunks.filter((c) => c.stream === "status").map((c) => c.data);
  expect(status).toContain("turn complete");
  expect(chunks.some((c) => c.stream === "stdout")).toBe(false);
});

test("a placeholder with no matching repository is left verbatim", async () => {
  insertTask("pr-prop-2", null, [repo("app", "feature/a")]);
  const { chunks } = await run("pr-prop-2", marker("x {{branch:nope}} y {{branch}}"));
  expect(chunks.find((c) => c.stream === "assistant")!.data).toBe("x {{branch:nope}} y {{branch}}");
});

test("malformed base64 emits a bad-template status and still completes", async () => {
  insertTask("pr-prop-3", "feature/z");
  for (const prompt of [
    `${FAKE_CLAUDE_PR_PROPOSAL_PROMPT_MARKER}:!!!`,
    `${FAKE_CLAUDE_PR_PROPOSAL_PROMPT_MARKER}:A`,
    FAKE_CLAUDE_PR_PROPOSAL_PROMPT_MARKER,
  ]) {
    const { chunks, exitCode } = await run("pr-prop-3", prompt);
    expect(exitCode).toBe(0);
    expect(chunks.filter((c) => c.stream === "assistant")).toHaveLength(0);
    const status = chunks.filter((c) => c.stream === "status").map((c) => c.data);
    expect(status).toContain("fake pr proposal: bad template");
    expect(status).toContain("turn complete");
  }
});

test("without the marker the generic fake reply is unchanged", async () => {
  insertTask("pr-prop-4", "feature/z");
  const { chunks } = await run("pr-prop-4", "just hello");
  expect(chunks.filter((c) => c.stream === "stdout").map((c) => c.data)).toEqual(["fake response to: just hello"]);
});

test("renderFakePrProposalReply returns null for a template that isn't valid UTF-8 base64url", async () => {
  expect(await renderFakePrProposalReply("nope", `${FAKE_CLAUDE_PR_PROPOSAL_PROMPT_MARKER}:_w`)).toBeNull();
  expect(await renderFakePrProposalReply("nope", "no marker at all")).toBeNull();
});

test("with a pipeline handoff marker too, the proposal prints before the handoff on turn 1 only", async () => {
  // A pipeline step's composed prompt carries the goal's markers; the handoff
  // branch wins the fake driver's dispatch, so it must print the proposal itself.
  insertTask("pr-prop-5", "feature/step");
  const prompt = `go ${marker("Base: main\nPR title for {{branch}}")} ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done`;
  const first = await run("pr-prop-5", prompt);
  expect(first.exitCode).toBe(0);
  const texts = first.chunks.filter((c) => c.stream === "assistant").map((c) => c.data);
  expect(texts).toHaveLength(2);
  expect(texts[0]).toBe("Base: main\nPR title for feature/step");
  expect(texts[1]).toContain("<handoff>");
  const second = await run("pr-prop-5", prompt);
  const again = second.chunks.filter((c) => c.stream === "assistant").map((c) => c.data);
  expect(again.some((t) => t.includes("PR title for"))).toBe(false);
  expect(again.some((t) => t.includes("<handoff>"))).toBe(true);
});

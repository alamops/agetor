import { test, expect, mock, afterAll } from "bun:test";
import path from "node:path";
import type { AgetorClient, CreateTaskInput } from "../api-client.ts";
import type { Flags } from "../context.ts";
import type { GitHubComment, GitHubIssueThreadResult, GitHubListItem, Task } from "../../shared/types.ts";
import { buildIssueTaskPrompt, issueTaskTitle, renderIssueThreadMarkdown } from "../../shared/issue-task.ts";

/**
 * `cmdAdd` (in add.ts) obtains its client via `getClient(flags)` from
 * `../context.ts` and prints via `../output.ts` — neither is injectable as a
 * parameter, so (mirroring `src/cli/answer.test.ts`'s precedent) this suite
 * mocks both modules with `mock.module`, snapshots the real exports first so
 * unrelated exports keep working, and dynamically imports `./add.ts` only
 * after the mocks are registered so its internal `import "../context.ts"` /
 * `import "../output.ts"` resolve to the mocked versions. Both mocks are
 * restored in `afterAll` since `mock.module` mutates the shared module
 * registry for the whole `bun test` process.
 */

import * as realContext from "../context.ts";
import * as realOutput from "../output.ts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };

let currentClient: AgetorClient | null = null;

const outputs: string[] = [];
const jsonOutputs: unknown[] = [];

mock.module("../context.ts", () => ({
  ...realContextSnapshot,
  getClient: async () => {
    if (!currentClient) throw new Error("no fake client set for this test");
    return currentClient;
  },
}));

mock.module("../output.ts", () => ({
  ...realOutputSnapshot,
  // Force the non-interactive branch regardless of the runner's real tty
  // state, matching every other agetor-launched (headless) invocation.
  isTTY: false,
  out: (msg = "") => {
    outputs.push(msg);
  },
  printJson: (data: unknown) => {
    jsonOutputs.push(data);
  },
}));

afterAll(() => {
  mock.module("../context.ts", () => realContextSnapshot);
  mock.module("../output.ts", () => realOutputSnapshot);
});

const { parseAdd, cmdAdd, chooseAddPath } = await import("./add.ts");

// ── fixtures ─────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<GitHubListItem> = {}): GitHubListItem {
  return {
    kind: "issues",
    number: 7,
    title: "Widgets crash on startup",
    state: "open",
    draft: false,
    htmlUrl: "https://github.com/acme/widgets/issues/7",
    author: { login: "alice", avatarUrl: null, htmlUrl: null },
    assignees: [],
    milestone: null,
    body: "It crashes every time.",
    labels: [],
    comments: 2,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    closedAt: null,
    mergedAt: null,
    locked: false,
    sourcePath: null,
    ...overrides,
  };
}

function makeComment(overrides: Partial<GitHubComment> = {}): GitHubComment {
  return {
    id: 1,
    body: "Same here.",
    htmlUrl: "https://github.com/acme/widgets/issues/7#issuecomment-1",
    author: { login: "bob", avatarUrl: null, htmlUrl: null },
    createdAt: "2026-01-01T01:00:00Z",
    updatedAt: "2026-01-01T01:00:00Z",
    ...overrides,
  };
}

function makeThread(overrides: Partial<GitHubIssueThreadResult> = {}): GitHubIssueThreadResult {
  return {
    repo: "acme/widgets",
    item: makeItem(),
    comments: [makeComment(), makeComment({ id: 2, body: "Also seeing this on 2.0." })],
    truncated: false,
    refetchCommand: null,
    ...overrides,
  };
}

/** A fake `AgetorClient` exposing only the methods `cmdAdd`'s `--issue`
 *  path touches, with call recorders for each. Cast through `unknown`
 *  (the same idiom `answer.test.ts` uses) since a full `AgetorClient`
 *  implementation isn't needed for these tests. */
function makeClient(thread: GitHubIssueThreadResult) {
  const getIssueThreadCalls: Array<{ path: string; number: number }> = [];
  const createTaskCalls: CreateTaskInput[] = [];
  const startTaskCalls: string[] = [];
  let nextTaskId = "12345678-abcd-task";
  const client = {
    getIssueThread: async (path: string, number: number) => {
      getIssueThreadCalls.push({ path, number });
      return { ok: true as const, ...thread };
    },
    createTask: async (input: CreateTaskInput) => {
      createTaskCalls.push(input);
      return { id: nextTaskId, title: input.title } as unknown as Task;
    },
    startTask: async (id: string) => {
      startTaskCalls.push(id);
      return { runId: "run-1" };
    },
  } as unknown as AgetorClient;
  return { client, getIssueThreadCalls, createTaskCalls, startTaskCalls, setNextTaskId: (id: string) => (nextTaskId = id) };
}

function flags(overrides: Partial<Flags> = {}): Flags {
  return { json: false, plain: true, noDaemon: true, ...overrides };
}

function reset(): void {
  outputs.length = 0;
  jsonOutputs.length = 0;
}

// ── parseAdd ─────────────────────────────────────────────────────────────

test("parseAdd: --issue <url> sets issue", () => {
  const o = parseAdd(["--issue", "https://github.com/o/r/issues/7"]);
  expect(o.issue).toBe("https://github.com/o/r/issues/7");
});

test("parseAdd: --issue combined with --title, --workdir, --start, repeated --ref", () => {
  const o = parseAdd([
    "--issue",
    "https://github.com/o/r/issues/7",
    "--title",
    "Custom title",
    "--workdir",
    "/tmp/acme-widgets",
    "--start",
    "--ref",
    "a",
    "--ref",
    "b",
  ]);
  expect(o.issue).toBe("https://github.com/o/r/issues/7");
  expect(o.title).toBe("Custom title");
  expect(o.workdir).toBe("/tmp/acme-widgets");
  expect(o.start).toBe(true);
  expect(o.refs).toEqual(["a", "b"]);
});

test("parseAdd: no --issue leaves issue undefined", () => {
  const o = parseAdd(["--title", "T", "--prompt", "P"]);
  expect(o.issue).toBeUndefined();
});

// ── cmdAdd end-to-end (stubbed client) ──────────────────────────────────

test("cmdAdd: --issue --workdir --json derives title/prompt/issueUrl/issueSnapshot from the thread", async () => {
  reset();
  const thread = makeThread();
  const { client, getIssueThreadCalls, createTaskCalls, startTaskCalls } = makeClient(thread);
  currentClient = client;
  const dir = "/tmp/acme-widgets";

  await cmdAdd(["--issue", thread.item.htmlUrl, "--workdir", dir], flags({ json: true }));

  expect(getIssueThreadCalls).toEqual([{ path: dir, number: 7 }]);
  expect(createTaskCalls.length).toBe(1);
  const input = createTaskCalls[0]!;
  expect(input.title).toBe(issueTaskTitle(thread.item));
  expect(input.prompt).toBe(buildIssueTaskPrompt({ ...thread, snapshotAttached: true }).prompt);
  expect(input.issueUrl).toBe(thread.item.htmlUrl);
  expect(input.issueSnapshot).toBe(renderIssueThreadMarkdown(thread));
  expect(input.workdir).toBe(dir);
  expect(startTaskCalls).toEqual([]);

  expect(jsonOutputs.length).toBe(1);
  expect((jsonOutputs[0] as { started: boolean }).started).toBe(false);
});

test("cmdAdd: --issue --workdir --start --json also starts the created task", async () => {
  reset();
  const thread = makeThread();
  const { client, createTaskCalls, startTaskCalls, setNextTaskId } = makeClient(thread);
  setNextTaskId("started-task-id");
  currentClient = client;
  const dir = "/tmp/acme-widgets";

  await cmdAdd(["--issue", thread.item.htmlUrl, "--workdir", dir, "--start"], flags({ json: true }));

  expect(createTaskCalls.length).toBe(1);
  // `--start` matches the app's "Run task": created directly in "ready".
  expect(createTaskCalls[0]!.column).toBe("ready");
  expect(startTaskCalls).toEqual(["started-task-id"]);

  expect(jsonOutputs.length).toBe(1);
  const printed = jsonOutputs[0] as { started: boolean; task: { id: string } };
  expect(printed.started).toBe(true);
  expect(printed.task.id).toBe("started-task-id");
});

test("cmdAdd: --issue plus explicit --title/--prompt keeps them, but still attaches issueUrl/issueSnapshot", async () => {
  reset();
  const thread = makeThread();
  const { client, createTaskCalls } = makeClient(thread);
  currentClient = client;
  const dir = "/tmp/acme-widgets";

  await cmdAdd(
    [
      "--issue",
      thread.item.htmlUrl,
      "--workdir",
      dir,
      "--title",
      "My own title",
      "--prompt",
      "My own prompt text",
    ],
    flags({ json: true }),
  );

  expect(createTaskCalls.length).toBe(1);
  const input = createTaskCalls[0]!;
  expect(input.title).toBe("My own title");
  expect(input.prompt).toBe("My own prompt text");
  expect(input.issueUrl).toBe(thread.item.htmlUrl);
  expect(input.issueSnapshot).toBe(renderIssueThreadMarkdown(thread));
});

test("cmdAdd: --issue with an unparseable URL throws mentioning --issue, never calling getIssueThread", async () => {
  reset();
  const thread = makeThread();
  const { client, getIssueThreadCalls } = makeClient(thread);
  currentClient = client;

  await expect(
    cmdAdd(["--issue", "not-a-valid-url", "--workdir", "/tmp/acme-widgets"], flags()),
  ).rejects.toThrow(/--issue/);
  expect(getIssueThreadCalls).toEqual([]);
});

test("cmdAdd: --issue whose thread points at a different repo throws, never calling createTask", async () => {
  reset();
  const thread = makeThread({
    item: makeItem({ htmlUrl: "https://github.com/someone-else/other-repo/issues/7" }),
  });
  const { client, createTaskCalls } = makeClient(thread);
  currentClient = client;

  await expect(
    cmdAdd(
      ["--issue", "https://github.com/acme/widgets/issues/7", "--workdir", "/tmp/acme-widgets"],
      flags(),
    ),
  ).rejects.toThrow(/different repository/);
  expect(createTaskCalls).toEqual([]);
});

test("cmdAdd: no --issue, no --title, non-TTY throws an error that mentions --issue as an option", async () => {
  reset();
  const thread = makeThread();
  const { client } = makeClient(thread);
  currentClient = client;

  await expect(cmdAdd([], flags())).rejects.toThrow(/--issue/);
});

test("cmdAdd: a relative --workdir is resolved before getIssueThread and createTask both see it", async () => {
  reset();
  const thread = makeThread();
  const { client, getIssueThreadCalls, createTaskCalls } = makeClient(thread);
  currentClient = client;
  const rel = "../rel";
  const resolved = path.resolve(rel);

  await cmdAdd(["--issue", thread.item.htmlUrl, "--workdir", rel], flags({ json: true }));

  expect(getIssueThreadCalls).toEqual([{ path: resolved, number: 7 }]);
  expect(createTaskCalls.length).toBe(1);
  expect(createTaskCalls[0]!.workdir).toBe(resolved);
});

test("cmdAdd: --issue is accepted case-insensitively against the thread's htmlUrl (sameIssueUrl, not exact normalizeIssueUrl equality)", async () => {
  reset();
  const thread = makeThread({
    item: makeItem({ htmlUrl: "https://github.com/owner/repo/issues/7" }),
  });
  const { client, createTaskCalls } = makeClient(thread);
  currentClient = client;

  await cmdAdd(
    ["--issue", "https://github.com/Owner/Repo/issues/7", "--workdir", "/tmp/acme-widgets"],
    flags({ json: true }),
  );

  expect(createTaskCalls.length).toBe(1);
  expect(createTaskCalls[0]!.issueUrl).toBe(thread.item.htmlUrl);
});

test("cmdAdd: --issue whose thread has commentsError prints a terminal warning (non-JSON) and still creates a prompt mentioning 'not fetched'", async () => {
  reset();
  const commentsError =
    "GitLab requires a token to read this (401) — add a token for gitlab.com in Settings → Git host tokens";
  const thread = makeThread({ commentsError });
  const { client, createTaskCalls } = makeClient(thread);
  currentClient = client;
  const dir = "/tmp/acme-widgets";

  await cmdAdd(["--issue", thread.item.htmlUrl, "--workdir", dir], flags({ json: false }));

  expect(outputs.some((line) => line.includes("comments not fetched") && line.includes(commentsError))).toBe(true);
  expect(createTaskCalls.length).toBe(1);
  expect(createTaskCalls[0]!.prompt).toContain("not fetched");
  // Non-JSON mode never prints a `warnings` array.
  expect(jsonOutputs).toEqual([]);
});

test("cmdAdd: --issue whose thread has commentsError folds it into --json's warnings array, not the plain-text path", async () => {
  reset();
  const commentsError = "the configured token was rejected";
  const thread = makeThread({ commentsError });
  const { client, createTaskCalls } = makeClient(thread);
  currentClient = client;
  const dir = "/tmp/acme-widgets";

  await cmdAdd(["--issue", thread.item.htmlUrl, "--workdir", dir], flags({ json: true }));

  expect(createTaskCalls.length).toBe(1);
  expect(createTaskCalls[0]!.prompt).toContain("not fetched");
  expect(jsonOutputs.length).toBe(1);
  expect((jsonOutputs[0] as { warnings?: string[] }).warnings).toEqual([commentsError]);
  // The warning text is never separately printed to stdout in JSON mode.
  expect(outputs).toEqual([]);
});

test("cmdAdd: --issue infers taskType from the thread's labels when --type is omitted", async () => {
  reset();
  const thread = makeThread({
    item: makeItem({ labels: [{ name: "kind/defect", color: null }] }),
  });
  const { client, createTaskCalls } = makeClient(thread);
  currentClient = client;
  const dir = "/tmp/acme-widgets";

  await cmdAdd(["--issue", thread.item.htmlUrl, "--workdir", dir], flags({ json: true }));

  expect(createTaskCalls.length).toBe(1);
  expect(createTaskCalls[0]!.taskType).toBe("bug");
});

test("cmdAdd: --issue with an explicit --type keeps it, ignoring the thread's labels", async () => {
  reset();
  const thread = makeThread({
    item: makeItem({ labels: [{ name: "bug", color: null }] }),
  });
  const { client, createTaskCalls } = makeClient(thread);
  currentClient = client;
  const dir = "/tmp/acme-widgets";

  await cmdAdd(["--issue", thread.item.htmlUrl, "--workdir", dir, "--type", "spike"], flags({ json: true }));

  expect(createTaskCalls.length).toBe(1);
  expect(createTaskCalls[0]!.taskType).toBe("spike");
});

test("cmdAdd: --issue whose thread has unrelated (or no) labels falls back to the default task type", async () => {
  reset();
  const thread = makeThread({
    item: makeItem({ labels: [{ name: "good first issue", color: null }] }),
  });
  const { client, createTaskCalls } = makeClient(thread);
  currentClient = client;
  const dir = "/tmp/acme-widgets";

  await cmdAdd(["--issue", thread.item.htmlUrl, "--workdir", dir], flags({ json: true }));

  expect(createTaskCalls.length).toBe(1);
  expect(createTaskCalls[0]!.taskType).toBe("task");
});

test("cmdAdd: --issue whose thread has no commentsError omits `warnings` from the --json result entirely", async () => {
  reset();
  const thread = makeThread();
  const { client } = makeClient(thread);
  currentClient = client;
  const dir = "/tmp/acme-widgets";

  await cmdAdd(["--issue", thread.item.htmlUrl, "--workdir", dir], flags({ json: true }));

  expect(jsonOutputs.length).toBe(1);
  expect(jsonOutputs[0] as object).not.toHaveProperty("warnings");
});

// ── chooseAddPath (pure) ─────────────────────────────────────────────────
//
// `cmdAdd` always runs with the mocked `isTTY: false`, so it can't exercise
// the TTY/wizard branch end-to-end without driving `@clack/prompts`. The
// branching itself is factored into this pure, directly-testable helper —
// these tests cover the fix for `--issue` alone wrongly bypassing the wizard
// (its issue-derived title/prompt used to make `o.title && prompt` look
// "complete" even in a real terminal session).

test("chooseAddPath: --issue alone (not explicit) in a TTY without --json goes to the wizard", () => {
  expect(chooseAddPath({ explicit: false, isTTY: true, json: false })).toBe("wizard");
});

test("chooseAddPath: explicit --title + --prompt goes non-interactive even in a TTY without --json", () => {
  expect(chooseAddPath({ explicit: true, isTTY: true, json: false })).toBe("non-interactive");
});

test("chooseAddPath: non-TTY always goes non-interactive, explicit or not", () => {
  expect(chooseAddPath({ explicit: false, isTTY: false, json: false })).toBe("non-interactive");
  expect(chooseAddPath({ explicit: true, isTTY: false, json: false })).toBe("non-interactive");
});

test("chooseAddPath: --json always goes non-interactive, even in a TTY", () => {
  expect(chooseAddPath({ explicit: false, isTTY: true, json: true })).toBe("non-interactive");
});

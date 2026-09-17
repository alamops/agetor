// In-process CLI-against-real-server coverage for docs/plans/agent-profiles
// .md §5 TT6's CLI parity ground, run against a REAL `startApiServer()`
// instance (not a spawned daemon process — see the file's own name) so
// `cmdAgentProfile`/`cmdAdd`/`cmdShow` exercise the genuine HTTP round trip
// instead of a hand-rolled fake `AgetorClient` (that's what
// `src/cli/commands/agent-profile.test.ts` and `src/cli/commands/add.test.ts`
// already do — this file complements them, it doesn't replace them).
// `AGETOR_DATA_DIR` and a unique `AGETOR_API_PORT` are set BEFORE any
// `./db.ts`/`./server.ts` import, mirroring
// `src/bun/agent-profiles-endpoint.test.ts`. `getClient` (context.ts) and
// `out`/`printJson`/`isTTY` (output.ts) are mocked exactly like
// `src/cli/commands/add.test.ts` does — see that file's own header comment
// for why (`cmdAdd` et al. obtain both via bare imports, not parameters).
import { test, expect, beforeAll, afterAll, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgetorClient } from "./api-client.ts";
import type { Flags } from "./context.ts";
import type { AgentProfile, Task } from "../shared/types.ts";
import { rmTestDataDir } from "../bun/test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-cli-agent-profile-daemon-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Unique port — disjoint from every src/bun/*.test.ts AGETOR_API_PORT (up to
// 4597 at last check) and from e2e/fixtures.ts's worker range (4600+).
process.env.AGETOR_API_PORT = "4598";
// No task is ever started in this file (see individual test comments), but
// set per the task brief so nothing could accidentally shell out to a real
// claude-code binary if that ever changed.
process.env.AGETOR_CLAUDE_DRIVER = "fake";

const WORKDIR = mkdtempSync(path.join(tmpdir(), "agetor-cli-agent-profile-daemon-workdir-"));

import * as realContext from "./context.ts";
import * as realOutput from "./output.ts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };

let currentClient: AgetorClient | null = null;
const outputs: string[] = [];
const jsonOutputs: unknown[] = [];

mock.module("./context.ts", () => ({
  ...realContextSnapshot,
  getClient: async () => {
    if (!currentClient) throw new Error("no client set for this test");
    return currentClient;
  },
}));

mock.module("./output.ts", () => ({
  ...realOutputSnapshot,
  isTTY: false,
  out: (msg = "") => {
    outputs.push(msg);
  },
  printJson: (data: unknown) => {
    jsonOutputs.push(data);
  },
}));

afterAll(() => {
  mock.module("./context.ts", () => realContextSnapshot);
  mock.module("./output.ts", () => realOutputSnapshot);
});

const { cmdAgentProfile } = await import("./commands/agent-profile.ts");
const { cmdAdd } = await import("./commands/add.ts");
const { cmdShow } = await import("./commands/show.ts");

let server: { stop: () => void };

beforeAll(async () => {
  const { startApiServer, API_TOKEN } = await import("../bun/server.ts");
  const { AgetorClient: RealAgetorClient } = await import("./api-client.ts");
  server = startApiServer() as unknown as { stop: () => void };
  currentClient = new RealAgetorClient({ port: 4598, token: API_TOKEN });
});

afterAll(() => {
  server?.stop?.();
  rmTestDataDir(DATA_DIR);
});

function flags(overrides: Partial<Flags> = {}): Flags {
  return { json: false, plain: true, noDaemon: true, ...overrides };
}

function reset(): void {
  outputs.length = 0;
  jsonOutputs.length = 0;
}

const PROFILE_NAME = "Reviewer";
const PROFILE_NAME_V2 = "Reviewer v2";
// A curated claude-code model id (AGENT_OPTIONS["claude-code"].models —
// DEFAULT_MODEL["claude-code"]) — not itself asserted on beyond "it's the
// id we sent", so any curated id would do.
const CURATED_CLAUDE_MODEL = "opus-5";

let createdProfileId = "";
let createdTaskId = "";

test("cmdAgentProfile add: creates a profile with harness/model/skill/instructions", async () => {
  reset();
  await cmdAgentProfile(
    [
      "add",
      PROFILE_NAME,
      "--harness",
      "claude-code",
      "--model",
      CURATED_CLAUDE_MODEL,
      "--skill",
      "code-review",
      "--instructions",
      "Be careful.",
    ],
    flags({ json: true }),
  );

  expect(jsonOutputs.length).toBe(1);
  const created = jsonOutputs[0] as AgentProfile;
  expect(created.name).toBe(PROFILE_NAME);
  expect(created.harness).toBe("claude-code");
  expect(created.model).toBe(CURATED_CLAUDE_MODEL);
  expect(created.skills).toEqual(["code-review"]);
  expect(created.instructions).toBe("Be careful.");
  expect(created.taskCount).toBe(0);
  createdProfileId = created.id;
});

test("cmdAgentProfile ls: the table lists the profile's name, and --json reports taskCount 0", async () => {
  reset();
  await cmdAgentProfile(["ls"], flags());
  expect(outputs.length).toBeGreaterThan(0);
  const rendered = outputs.join("\n");
  expect(rendered).toContain(PROFILE_NAME);

  reset();
  await cmdAgentProfile(["ls"], flags({ json: true }));
  expect(jsonOutputs.length).toBe(1);
  const list = jsonOutputs[0] as AgentProfile[];
  const row = list.find((p) => p.id === createdProfileId);
  expect(row).toBeTruthy();
  expect(row!.taskCount).toBe(0);
});

test("cmdAgentProfile show: prints the profile's name/id/instructions", async () => {
  reset();
  await cmdAgentProfile(["show", createdProfileId], flags());
  const rendered = outputs.join("\n");
  expect(rendered).toContain(PROFILE_NAME);
  expect(rendered).toContain(createdProfileId);
  expect(rendered).toContain("Be careful.");
});

test("cmdAgentProfile add: a duplicate (case-insensitive) name is rejected", async () => {
  reset();
  await expect(
    cmdAgentProfile(
      ["add", PROFILE_NAME.toLowerCase(), "--harness", "claude-code", "--model", CURATED_CLAUDE_MODEL],
      flags(),
    ),
  ).rejects.toThrow();
});

test("cmdAgentProfile edit: renames and appends a skill", async () => {
  reset();
  await cmdAgentProfile(
    ["edit", createdProfileId, "--name", PROFILE_NAME_V2, "--skill", "simplify"],
    flags({ json: true }),
  );
  expect(jsonOutputs.length).toBe(1);
  const updated = jsonOutputs[0] as AgentProfile;
  expect(updated.name).toBe(PROFILE_NAME_V2);
  expect(updated.skills).toEqual(["code-review", "simplify"]);
});

test("cmdAdd --profile: resolves the profile by name, creates a task carrying agentProfileId, and rejects --profile combined with --model", async () => {
  reset();
  await cmdAdd(
    [
      "--title",
      "task from profile",
      "--prompt",
      "do it",
      "--profile",
      PROFILE_NAME_V2,
      "--workdir",
      WORKDIR,
      "--isolation",
      "none",
    ],
    flags({ json: true }),
  );
  expect(jsonOutputs.length).toBe(1);
  const printed = jsonOutputs[0] as { started: boolean; task: Task };
  expect(printed.started).toBe(false);
  expect(printed.task.agentProfileId).toBe(createdProfileId);
  createdTaskId = printed.task.id;

  reset();
  await expect(
    cmdAdd(
      ["--title", "t", "--prompt", "p", "--profile", PROFILE_NAME_V2, "--model", CURATED_CLAUDE_MODEL],
      flags(),
    ),
  ).rejects.toThrow(/--profile cannot be combined/);
});

test("cmdAgentProfile rm: the profile is gone from ls afterward", async () => {
  reset();
  await cmdAgentProfile(["rm", createdProfileId], flags({ json: true }));
  expect(jsonOutputs.length).toBe(1);
  expect((jsonOutputs[0] as { removed: string }).removed).toBe(createdProfileId);

  reset();
  await cmdAgentProfile(["ls"], flags({ json: true }));
  const list = jsonOutputs[0] as AgentProfile[];
  expect(list.find((p) => p.id === createdProfileId)).toBeUndefined();
});

test("agetor show <task>: prints the frozen 'profile:' line with a '(deleted)' suffix now that the live profile is gone", async () => {
  reset();
  await cmdShow([createdTaskId], flags());
  const rendered = outputs.join("\n");
  expect(rendered).toContain("profile:");
  expect(rendered).toContain(PROFILE_NAME_V2);
  expect(rendered).toContain("(deleted)");
  // Pin the vocabulary rename (docs/plans/task-details-agent-row.md D4):
  // the line is `profile: …`, not the pre-rename `agent profile: …`.
  expect(rendered).not.toContain("agent profile:");
});

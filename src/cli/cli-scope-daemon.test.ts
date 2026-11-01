// Every `AgetorClient` method against a REAL in-process core, authenticated the
// way the real `agetor` binary is: with the CLI token, read back from the creds
// file the core writes (docs/plans/master-token-agent-read.md TT15b, closing
// investigation S4 — ~20 client methods used to be covered only by mocks, so a
// route left on the app-only side of ROUTE_POLICY would 403 the CLI at runtime
// with every unit test green).
//
// The contract this file pins is deliberately narrow: no method may be refused
// with 401 (unknown credential) or 403 (`desktop-only`, or a CLI path gate).
// What else a call answers is a property of its fixtures and of the headless
// core (a missing task is 404, a precondition 409, a native-only route 501), and
// each row records which statuses it expects so a regression in either
// direction shows up.
//
// The call table is keyed by method name and compared with
// `Object.getOwnPropertyNames(AgetorClient.prototype)`: a new client method
// without a row fails the suite, and so does a row for a method that is gone.
//
// Isolation. `AGETOR_DATA_DIR` and the port are set before any `../bun/*` import
// (the db opens on import). Every agent binary is `/bin/echo` and the claude
// driver is the fake one, so nothing real is spawned; the two routes that read
// `$HOME` (Claude session scan, agent discovery) run under a throwaway HOME. All
// workdirs are temp git repos with `isolation: "none"`.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "../bun/test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-cli-scope-daemon-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Unique port — not used by any other src/ test (4589..4599 are taken) and
// below e2e/fixtures.ts's worker range (4600+).
const PORT = 4592;
process.env.AGETOR_API_PORT = String(PORT);
process.env.AGETOR_CLAUDE_DRIVER = "fake";
for (const kind of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) {
  process.env[`AGETOR_${kind}_BIN`] = "/bin/echo";
}
process.env.AGETOR_TMUX_BIN = "/bin/echo";
// The CLI's model-discovery probes (`POST /agent-models`) must not run a real
// binary; `/bin/echo` answers no JSON-RPC, so discovery just comes back empty.
const FAKE_HOME = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-cli-scope-home-")));
const AGENTS_STUB = path.join(FAKE_HOME, "agents.json");
writeFileSync(AGENTS_STUB, "[]");
mkdirSync(path.join(FAKE_HOME, ".claude", "projects"), { recursive: true });

import {
  AgetorClient,
  ApiError,
  discoverCore,
  type AgentProfileInput,
} from "./api-client.ts";
import { streamSse } from "./sse.ts";
import { CLI_TOKEN } from "../bun/api-config.ts";
import { writeCoreCreds } from "../bun/core-creds.ts";
import type { AgentProfile, PipelineGraph, Task } from "../shared/types.ts";

/** Methods on the prototype that are not API calls: the constructor and the two
 *  `private` request helpers (`req`, `bundleReq`). Listed explicitly — and
 *  asserted below — so a new public method can't hide behind this set. */
const NOT_API_CALLS = ["constructor", "req", "bundleReq"] as const;

type ClientMethod = Exclude<
  {
    [K in keyof AgetorClient]: AgetorClient[K] extends (...args: never[]) => unknown ? K : never;
  }[keyof AgetorClient],
  never
>;

interface Row {
  /** Statuses this call may legitimately answer (200 stands for any 2xx). */
  expect: number[];
  /** Why that outcome — the fixture or headless limit behind a non-200. */
  why: string;
  call: () => Promise<unknown>;
}

let server: { stop: () => void };
let client: AgetorClient;
let repo = "";

/** Fixtures created in `beforeAll` and consumed by the rows. */
const fx = {
  taskId: "",
  runId: "",
  extraTaskId: "",
  pipelineTaskId: "",
  profileId: "",
  pipelineId: "",
  stepId: "s1",
};

function git(cwd: string, ...args: string[]): void {
  const res = Bun.spawnSync(
    ["git", "-c", "user.name=scope", "-c", "user.email=scope@example.invalid", ...args],
    { cwd, stdout: "ignore", stderr: "pipe" },
  );
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
}

const profileInput = (name: string): AgentProfileInput => ({
  name,
  harness: "claude-code",
  model: "opus-5.5",
  effort: null,
  mode: null,
  speed: "off",
  maxMode: false,
  instructions: "Be careful.",
  skills: [],
});

const graph = (profileId: string): PipelineGraph => ({
  steps: [
    {
      id: fx.stepId,
      name: "Only",
      instructions: "Do it.",
      agentProfileId: profileId,
      position: { x: 0, y: 0 },
      subagents: { profileIds: [], cap: null },
      transition: "choose",
      join: "any",
    },
  ],
  edges: [],
  startStepId: fx.stepId,
});

/** Run `fn` with HOME pointing at the throwaway dir (the Claude session scan and
 *  agent discovery read user-level dirs under it) and the liveness stub set. */
async function withFakeHome<T>(fn: () => Promise<T>): Promise<T> {
  const prev = {
    HOME: process.env.HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    AGETOR_CLAUDE_AGENTS_JSON: process.env.AGETOR_CLAUDE_AGENTS_JSON,
  };
  process.env.HOME = FAKE_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.AGETOR_CLAUDE_AGENTS_JSON = AGENTS_STUB;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

beforeAll(async () => {
  repo = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-cli-scope-repo-")));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "scope\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");

  const { startApiServer } = await import("../bun/server.ts");
  // `POST /daemon/shutdown` on a headless core exits the process unless a
  // shutdown handler is wired; record the request instead (the `shutdownCore` row).
  server = startApiServer({
    onShutdownRequest: (mode) => shutdownRequests.push(mode),
  }) as unknown as { stop: () => void };

  // The same hand-off the real CLI does: the core's creds file → discovery →
  // client. `headless.ts` writes `CLI_TOKEN` there; so do we.
  writeCoreCreds(
    {
      port: PORT,
      token: CLI_TOKEN,
      pid: process.pid,
      kind: "cli-daemon",
      version: "test",
      startedAt: Date.now(),
    },
    DATA_DIR,
  );
  const core = await discoverCore(DATA_DIR);
  if (!core) throw new Error("the creds file did not lead to a live core with the CLI token");
  expect(core.token).toBe(CLI_TOKEN);
  client = new AgetorClient(core);

  // Fixtures, built through the client itself (every call below must work with
  // the CLI token anyway).
  const mk = (title: string): Promise<Task> =>
    client.createTask({ title, prompt: "scope check", agent: "claude-code", workdir: repo, isolation: "none" });
  fx.taskId = (await mk("scope task")).id;
  fx.extraTaskId = (await mk("scope extra task")).id;
  const profile = await client.createAgentProfile(profileInput("Scope fixture"));
  fx.profileId = profile.id;
  const pipeline = await client.createPipeline({ name: "Scope fixture", graph: graph(profile.id) });
  fx.pipelineId = pipeline.id;
  fx.pipelineTaskId = (
    await client.createTask({
      title: "scope pipeline task",
      prompt: "scope check",
      workdir: repo,
      isolation: "none",
      pipelineId: pipeline.id,
    })
  ).id;
});

afterAll(() => {
  server?.stop?.();
  rmSync(repo, { recursive: true, force: true });
  rmSync(FAKE_HOME, { recursive: true, force: true });
  rmTestDataDir(DATA_DIR);
});

/** `POST /daemon/shutdown` requests the in-process core received. */
const shutdownRequests: ("stop" | "handoff")[] = [];

/** An id no row will ever find. */
const MISSING = "00000000-0000-4000-8000-000000000000";

/**
 * One row per public `AgetorClient` method, in execution order: reads and
 * fixtures first, the run lifecycle in the middle, deletes last.
 */
const ROWS: Record<ClientMethod, Row> = {
  // ── core info and preferences ──────────────────────────────────────────────
  info: { expect: [200], why: "version probe", call: () => client.info() },
  defaults: { expect: [200], why: "home/cwd/dataDir", call: () => client.defaults() },
  getPreferences: { expect: [200], why: "preference map", call: () => client.getPreferences() },
  setPreference: {
    expect: [200],
    why: "an ordinary preference key (the disclaim switch has its own rule)",
    call: () => client.setPreference("scopeCheck", "1"),
  },

  // ── background core and remote access ──────────────────────────────────────
  // No login-item helper resolves in a test process, so the background state is
  // `unavailable`; the routes still answer the CLI token.
  getBackground: { expect: [200], why: "derived background status", call: () => client.getBackground() },
  turnOffBackground: {
    expect: [200],
    why: "turning off is allowed for the CLI (removing authority only)",
    call: () => client.turnOffBackground(),
  },
  startBackground: {
    expect: [409],
    why: "Start now needs an enabled registration with no live supervisor → 409 after auth",
    call: () => client.startBackground(),
  },
  getRemoteAccess: { expect: [200], why: "remote-access preview switch", call: () => client.getRemoteAccess() },
  turnOffRemoteAccess: {
    expect: [200],
    why: "DELETE /remote-access is allowlisted for the CLI",
    call: () => client.turnOffRemoteAccess(),
  },
  shutdownCore: {
    expect: [200],
    why: "the handoff request reaches the injected shutdown handler, which records it",
    call: async () => {
      const res = await client.shutdownCore("handoff");
      // The route answers first and runs the handler on the next tick.
      for (let i = 0; i < 50 && shutdownRequests.length === 0; i++) await Bun.sleep(10);
      expect(shutdownRequests).toEqual(["handoff"]);
      return res;
    },
  },

  // ── tasks ──────────────────────────────────────────────────────────────────
  listTasks: { expect: [200], why: "board list", call: () => client.listTasks() },
  getTask: { expect: [200], why: "seeded task", call: () => client.getTask(fx.taskId) },
  createTask: {
    expect: [200],
    why: "plain isolation:none task in a temp repo",
    call: () =>
      client.createTask({ title: "scope created", prompt: "p", agent: "claude-code", workdir: repo, isolation: "none" }),
  },
  patchTask: {
    expect: [200],
    why: "title is on the PATCH allow-list",
    call: () => client.patchTask(fx.taskId, { title: "scope task (patched)" }),
  },
  getTeardownPreview: {
    expect: [200],
    why: "preview for a never-started task (the client maps a 404 to null)",
    call: () => client.getTeardownPreview(fx.taskId),
  },
  getGitStatus: { expect: [200], why: "isolation:none task in a repo", call: () => client.getGitStatus(fx.taskId) },
  getDiff: { expect: [200], why: "isolation:none task in a repo", call: () => client.getDiff(fx.taskId) },
  pendingInteractions: { expect: [200], why: "empty list", call: () => client.pendingInteractions(fx.taskId) },
  detachTaskAgentProfile: {
    expect: [200],
    why: "task was never bound; detach is idempotent",
    call: () => client.detachTaskAgentProfile(fx.taskId),
  },

  // ── run lifecycle (fake claude driver) ─────────────────────────────────────
  startTask: {
    expect: [200],
    why: "fake claude driver; /bin/echo stands in for claude and tmux",
    call: async () => {
      const res = await client.startTask(fx.taskId);
      fx.runId = res.runId;
      return res;
    },
  },
  getRuns: { expect: [200], why: "run history of the started task", call: () => client.getRuns(fx.taskId) },
  rebuildEvents: {
    expect: [200],
    why: "JSONL rebuild; the fake run has no transcript, the route says so in `reason`",
    call: () => client.rebuildEvents(fx.runId),
  },
  sendInput: {
    expect: [200],
    why: "a follow-up to the started run (delivered, queued or pending — never refused)",
    call: () => client.sendInput(fx.runId, "follow up"),
  },
  cancelRun: { expect: [200], why: "Stop on the run", call: () => client.cancelRun(fx.runId) },

  // ── answer routes (ids no card carries) ────────────────────────────────────
  // An unknown card id is not an HTTP error for these routes: the route is reached
  // (past auth and the policy) and answers `{ ok: false }`, which the client
  // reports as a resolved call.
  answerAskQuestions: {
    expect: [200],
    why: "unknown card id → `{ ok: false }` from the route, after auth",
    call: () => client.answerAskQuestions(MISSING, [{ selected: ["a"] }]),
  },
  answerTmuxPrompt: {
    expect: [200],
    why: "unknown prompt id → `{ ok: false }` from the route, after auth",
    call: () => client.answerTmuxPrompt(MISSING, { key: "1" }),
  },
  answerFxPermission: {
    expect: [200],
    why: "unknown permission id → `{ ok: false }` from the route, after auth",
    call: () => client.answerFxPermission(MISSING, { cancel: true }),
  },
  resumeFxRecovery: {
    expect: [400],
    why: "only fx tasks can resume a paused response → 400 from the route, after auth",
    call: () => client.resumeFxRecovery(fx.taskId),
  },
  cancelFxAutoResume: {
    expect: [400],
    why: "no auto-resume is pending for this task → 400 from the route, after auth",
    call: () => client.cancelFxAutoResume(fx.taskId),
  },

  // ── pipelines ──────────────────────────────────────────────────────────────
  listPipelines: { expect: [200], why: "template list", call: () => client.listPipelines() },
  getPipeline: { expect: [200], why: "seeded template", call: () => client.getPipeline(fx.pipelineId) },
  createPipeline: {
    expect: [200],
    why: "single-step graph over the seeded Agent",
    call: () => client.createPipeline({ name: "Scope second", graph: graph(fx.profileId) }),
  },
  updatePipeline: {
    expect: [200],
    why: "description patch",
    call: () => client.updatePipeline(fx.pipelineId, { description: "scope" }),
  },
  getPipelineRun: {
    expect: [200],
    why: "an idle (never started) pipeline task still has a run view",
    call: () => client.getPipelineRun(fx.pipelineTaskId),
  },
  retryPipeline: {
    expect: [409],
    why: "nothing blocked or cancelled to retry on an idle run",
    call: () => client.retryPipeline(fx.pipelineTaskId),
  },
  cancelPipeline: {
    expect: [409],
    why: "run is not running",
    call: () => client.cancelPipeline(fx.pipelineTaskId),
  },
  advancePipeline: {
    expect: [409],
    why: "nothing to advance on an idle run",
    call: () => client.advancePipeline(fx.pipelineTaskId, { nextStepIds: null }),
  },
  restartPipeline: {
    expect: [200],
    why: "fresh run of the idle pipeline task (isolation:none, so no worktree to prepare)",
    call: () => client.restartPipeline(fx.pipelineTaskId),
  },

  // ── Agents (profiles) ──────────────────────────────────────────────────────
  listAgentProfiles: { expect: [200], why: "profile list", call: () => client.listAgentProfiles() },
  getAgentProfile: { expect: [200], why: "seeded profile", call: () => client.getAgentProfile(fx.profileId) },
  createAgentProfile: {
    expect: [200],
    why: "curated claude model",
    call: () => client.createAgentProfile(profileInput("Scope created")),
  },
  patchAgentProfile: {
    expect: [200],
    why: "instructions patch",
    call: () => client.patchAgentProfile(fx.profileId, { instructions: "Be very careful." }),
  },
  duplicateAgentProfile: {
    expect: [200],
    why: "copy of the seeded profile under a new name",
    call: () => client.duplicateAgentProfile(fx.profileId, { name: "Scope copy" }),
  },

  // ── bundle (export/import) ─────────────────────────────────────────────────
  exportBundle: {
    expect: [200],
    why: "export of the seeded Agent and Pipeline",
    call: () => client.exportBundle({ agentIds: [fx.profileId], pipelineIds: [fx.pipelineId] }),
  },
  previewBundleImport: {
    expect: [400],
    why: "text that is not a bundle → 400 from the parser (route reached, not refused)",
    call: () => client.previewBundleImport("not a bundle"),
  },
  importBundle: {
    expect: [400],
    why: "text that is not a bundle → 400 from the parser (route reached, not refused)",
    call: () => client.importBundle("not a bundle"),
  },

  // ── harnesses ──────────────────────────────────────────────────────────────
  listHarnesses: { expect: [200], why: "harnesses + statuses", call: () => client.listHarnesses() },
  createHarness: {
    expect: [200],
    why: "second claude-code account without home/bin",
    call: () => client.createHarness({ id: "scope-claude", kind: "claude-code", label: "Scope Claude" }),
  },
  patchHarness: {
    expect: [200],
    why: "label patch on the harness just created",
    call: () => client.patchHarness("scope-claude", { label: "Scope Claude 2" }),
  },
  harnessUsage: { expect: [200], why: "task counts for the harness", call: () => client.harnessUsage("scope-claude") },
  harnessShellEnv: {
    expect: [200],
    why: "env a terminal for the harness would carry",
    call: () => client.harnessShellEnv("scope-claude"),
  },
  deleteHarness: { expect: [200], why: "no task or Agent uses it", call: () => client.deleteHarness("scope-claude") },

  // ── model + capability discovery ───────────────────────────────────────────
  agentModels: { expect: [200], why: "kind-keyed model cache", call: () => client.agentModels() },
  harnessModels: { expect: [200], why: "harness-keyed model cache", call: () => client.harnessModels() },
  refreshAgentModels: {
    expect: [200],
    why: "re-probe with every agent binary stubbed to /bin/echo",
    call: () => client.refreshAgentModels(),
  },
  agentDiscovery: {
    expect: [200],
    why: "commands/extensions for claude-code in the temp repo (HOME is a throwaway dir)",
    call: () => withFakeHome(() => client.agentDiscovery("claude-code", repo, null)),
  },

  // ── projects, files, issue thread ──────────────────────────────────────────
  listProjects: { expect: [200], why: "project list", call: () => client.listProjects() },
  addProject: { expect: [200], why: "temp repo path passes the CLI path gate", call: () => client.addProject(repo, "scope") },
  listBranches: { expect: [200], why: "temp repo path passes the CLI path gate", call: () => client.listBranches(repo) },
  listProjectFiles: {
    expect: [200],
    why: "live-tree listing of the temp repo",
    call: () => client.listProjectFiles({ dir: repo, q: "readme" }),
  },
  getIssueThread: {
    expect: [400],
    why: "the temp repo has no git remote → 400 from the adapter, no network involved",
    call: () => client.getIssueThread(repo, 1),
  },
  cloneProject: {
    expect: [400],
    why: "an input the shared parser rejects → 400 before anything is cloned",
    call: () => client.cloneProject({ url: "definitely not a repository", eli5: false }),
  },
  cancelClone: {
    expect: [404],
    why: "no clone with this id is in flight",
    call: () => client.cancelClone(MISSING),
  },
  removeProject: { expect: [200], why: "the project added above", call: () => client.removeProject(repo) },

  // ── Claude sessions started outside Agetor ─────────────────────────────────
  listClaudeSessions: {
    expect: [200],
    why: "scan of an empty throwaway ~/.claude",
    call: () => withFakeHome(() => client.listClaudeSessions()),
  },
  recheckClaudeSessions: {
    expect: [200],
    why: "liveness stubbed through AGETOR_CLAUDE_AGENTS_JSON, then the same scan",
    call: () => withFakeHome(() => client.recheckClaudeSessions()),
  },
  importClaudeSessions: {
    expect: [200],
    why: "unknown ids come back as per-id errors in `results`, not an HTTP error",
    call: () => withFakeHome(() => client.importClaudeSessions([MISSING])),
  },

  // ── OpenCode sessions started outside Agetor ───────────────────────────────
  listOpencodeSessions: {
    expect: [200],
    why: "scan finds no session: no OpenCode harness in the throwaway core is installed",
    call: () => withFakeHome(() => client.listOpencodeSessions()),
  },
  recheckOpencodeSessions: {
    expect: [200],
    why: "the same scan with the 10 s cache bypassed",
    call: () => withFakeHome(() => client.recheckOpencodeSessions()),
  },
  importOpencodeSessions: {
    expect: [200],
    why: "unknown ids come back as per-id errors in `results`, not an HTTP error",
    call: () => withFakeHome(() => client.importOpencodeSessions([MISSING])),
  },
  retryOpencodeSessionImport: {
    expect: [404],
    why: "no task with this id",
    call: () => client.retryOpencodeSessionImport(MISSING),
  },

  // ── notifications ──────────────────────────────────────────────────────────
  notifyOS: {
    expect: [501],
    why: "headless core has no native host (the CLI falls back to osascript); 501 comes after auth",
    call: () => client.notifyOS({ title: "scope", body: "check" }),
  },

  // ── DB tools ───────────────────────────────────────────────────────────────
  dbStats: { expect: [200], why: "sizes and counts", call: () => client.dbStats() },
  runRetentionPass: {
    expect: [200, 409],
    why: "retention is on by default; 409 only if a scheduled pass happens to be running",
    call: () => client.runRetentionPass(),
  },
  compactDb: {
    expect: [200, 409],
    why: "409 while a run is still active (compaction blocks the core)",
    call: () => client.compactDb(),
  },

  // ── archive, delete and the remaining cleanup ──────────────────────────────
  archiveTask: {
    expect: [200],
    why: "only Done tasks archive, so park the never-started extra task there first",
    call: async () => {
      await client.patchTask(fx.extraTaskId, { column: "done" });
      return client.archiveTask(fx.extraTaskId);
    },
  },
  unarchiveTask: { expect: [200], why: "the task archived above", call: () => client.unarchiveTask(fx.extraTaskId) },
  deleteTask: { expect: [200], why: "the extra task (no run, no worktree)", call: () => client.deleteTask(fx.extraTaskId) },
  deleteAgentProfile: {
    expect: [200],
    why: "the copy made by duplicateAgentProfile (never blocked by tasks anyway)",
    call: async () => {
      const copy = (await client.listAgentProfiles()).find((p: AgentProfile) => p.name === "Scope copy");
      if (!copy) throw new Error("duplicateAgentProfile left no copy behind");
      return client.deleteAgentProfile(copy.id);
    },
  },
  deletePipeline: {
    expect: [200],
    why: "the second template (the run keeps its own frozen snapshot)",
    call: async () => {
      const second = (await client.listPipelines()).find((p) => p.name === "Scope second");
      if (!second) throw new Error("createPipeline left no template behind");
      return client.deletePipeline(second.id);
    },
  },
};

test("the exclusion set is exactly the constructor and the two private request helpers", () => {
  const names = Object.getOwnPropertyNames(AgetorClient.prototype);
  for (const excluded of NOT_API_CALLS) expect(names).toContain(excluded);
  // Anything else on the prototype must be a function with a call-table row.
  const api = names.filter((n) => !(NOT_API_CALLS as readonly string[]).includes(n)).sort();
  for (const name of api) {
    expect(typeof (AgetorClient.prototype as unknown as Record<string, unknown>)[name]).toBe("function");
  }
});

test("every public AgetorClient method has a call-table row (and no row is stale)", () => {
  const api = Object.getOwnPropertyNames(AgetorClient.prototype)
    .filter((n) => !(NOT_API_CALLS as readonly string[]).includes(n))
    .sort();
  expect(Object.keys(ROWS).sort()).toEqual(api);
});

async function statusOf(call: () => Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await call();
    return { status: 200, message: "" };
  } catch (e) {
    if (e instanceof ApiError) return { status: e.status, message: e.message };
    throw e;
  }
}

for (const [method, row] of Object.entries(ROWS) as [ClientMethod, Row][]) {
  test(`${method}: the CLI token is not refused (${row.expect.join("/")} — ${row.why})`, async () => {
    const { status, message } = await statusOf(row.call);
    // 0 = transport failure, 401 = unknown credential, 403 = desktop-only or a
    // CLI path gate: all three are the failure this suite exists to catch.
    expect([0, 401, 403], `${method} answered ${status}: ${message}`).not.toContain(status);
    expect(row.expect, `${method} answered ${status}: ${message}`).toContain(status);
  }, 90_000);
}

// ── the run's follow-ups, now that the start row has run ────────────────────────
test("the started run exists (sendInput/cancelRun/rebuildEvents rows above used a real run id)", () => {
  expect(fx.runId).not.toBe("");
});

// ── SSE with the CLI token (header, as `streamSse` sends it) ────────────────────
for (const sse of [
  { name: "/events", path: () => "/events" },
  { name: "/app/events", path: () => "/app/events" },
  { name: "/tasks/:id/events", path: () => `/tasks/${fx.taskId}/events` },
]) {
  test(`streamSse ${sse.name}: opens with the creds-file token`, async () => {
    let handle: { close(): void } | null = null;
    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no SSE response from ${sse.name}`)), 10_000);
      handle = streamSse(
        sse.path(),
        () => {},
        {
          dataDir: DATA_DIR,
          onOpen: () => {
            clearTimeout(timer);
            resolve();
          },
          onError: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        },
      );
    });
    try {
      await opened;
    } finally {
      (handle as { close(): void } | null)?.close();
    }
  });
}

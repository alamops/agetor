import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { AGENT_OPTIONS, DEFAULT_MODEL } from "../shared/types.ts";
import type { AgentProfile, Project, Task } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-clone-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Distinct from other server-test ports so parallel test runs don't fight.
process.env.AGETOR_API_PORT = "4437";
// The auto-created ELI5 task is started for real — route it into the fake
// claude driver so no tmux session or claude binary is involved.
process.env.AGETOR_CLAUDE_DRIVER = "fake";

const BASE = "http://127.0.0.1:4437";

const WORK_DIR = mkdtempSync(path.join(tmpdir(), "agetor-clone-endpoint-work-"));

let server: { stop: () => void };
let token: string;
let tasks: typeof import("./db.ts").tasks;
let agentProfiles: typeof import("./db.ts").agentProfiles;

beforeAll(async () => {
  ({ tasks, agentProfiles } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;

  // Local fixture repo standing in for GitHub via AGETOR_CLONE_SOURCE_OVERRIDE.
  const source = path.join(WORK_DIR, "source");
  mkdirSync(source);
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: source, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  };
  git("init", "-q");
  git("config", "user.email", "test@test");
  git("config", "user.name", "test");
  writeFileSync(path.join(source, "README.md"), "# fixture\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  process.env.AGETOR_CLONE_SOURCE_OVERRIDE = source;
});

afterAll(() => {
  delete process.env.AGETOR_CLONE_SOURCE_OVERRIDE;
  server?.stop?.();
  rmSync(WORK_DIR, { recursive: true, force: true });
});

const call = (p: string, init: RequestInit = {}) =>
  fetch(`${BASE}${p}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

test("POST /projects/clone without url returns 400", async () => {
  const res = await call("/projects/clone", { method: "POST", body: "{}" });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("url required");
});

test("POST /projects/clone rejects a non-GitHub url", async () => {
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "https://gitlab.com/foo/bar" }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("GitHub");
});

test("POST /projects/clone rejects a relative dest", async () => {
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "foo/bar", dest: "relative/path" }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("absolute");
});

test("clone + register + ELI5 task, end to end", async () => {
  const dest = path.join(WORK_DIR, "clone-with-eli5");
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "someowner/somerepo", dest }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    project: Project;
    eli5TaskId: string | null;
    eli5Error: string | null;
  };

  // The clone really happened.
  expect(existsSync(path.join(dest, "README.md"))).toBe(true);
  expect(existsSync(path.join(dest, ".git"))).toBe(true);

  // The destination is registered as a project, named after the repo.
  expect(body.project.path).toBe(dest);
  expect(body.project.name).toBe("somerepo");
  const listed = (await (await call("/projects")).json()) as Project[];
  expect(listed.some((p) => p.path === dest)).toBe(true);

  // The explainer task exists, targets the clone directly (no worktree), and
  // was started without error.
  expect(body.eli5Error).toBeNull();
  expect(body.eli5TaskId).not.toBeNull();
  const task = tasks.get(body.eli5TaskId!);
  expect(task).not.toBeNull();
  expect(task!.title).toBe("ELI5: somerepo");
  expect(task!.workdir).toBe(dest);
  expect(task!.isolation).toBe("none");
  expect(task!.prompt).toContain("ELI5.md");
  expect(task!.runId).not.toBeNull();
});

test("eli5:false clones and registers without creating a task", async () => {
  const before = tasks.list().length;
  const dest = path.join(WORK_DIR, "clone-no-eli5");
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "someowner/plainrepo", dest, eli5: false }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    project: Project;
    eli5TaskId: string | null;
    eli5Error: string | null;
  };
  expect(body.eli5TaskId).toBeNull();
  expect(body.eli5Error).toBeNull();
  expect(existsSync(path.join(dest, "README.md"))).toBe(true);
  expect(tasks.list().length).toBe(before);
});

test("a failing clone returns 502 and registers nothing", async () => {
  const dest = path.join(WORK_DIR, "clone-fails");
  // Point the seam at a nonexistent source so git clone fails.
  const prev = process.env.AGETOR_CLONE_SOURCE_OVERRIDE;
  process.env.AGETOR_CLONE_SOURCE_OVERRIDE = path.join(WORK_DIR, "no-such-source");
  try {
    const res = await call("/projects/clone", {
      method: "POST",
      body: JSON.stringify({ url: "someowner/deadrepo", dest }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("clone failed");
    const listed = (await (await call("/projects")).json()) as Project[];
    expect(listed.some((p) => p.path === dest)).toBe(false);
  } finally {
    process.env.AGETOR_CLONE_SOURCE_OVERRIDE = prev;
  }
});

test("route requires auth like every other project route", async () => {
  const res = await fetch(`${BASE}/projects/clone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "foo/bar" }),
  });
  expect(res.status).toBe(401);
});

// --- Launch-picker selection (docs/plans/clone-repository-launch-pickers.md
// §5 D3): manual agent/model/effort/mode + agentProfileId land on the
// explainer task, and the launch selection is validated BEFORE anything is
// cloned to disk. ---

// A claude-code model that is not the kind's own default, so a test that
// asserts "this exact model landed on the task" can't pass by coincidence
// (i.e. because it happens to equal what createTask would have defaulted to
// anyway).
const NON_DEFAULT_CLAUDE_MODEL = AGENT_OPTIONS["claude-code"].models.find(
  (m) => m.id !== DEFAULT_MODEL["claude-code"],
)!.id;
const NON_DEFAULT_CLAUDE_EFFORT = "high";

test("manual harness/model/effort/mode selection lands on the task", async () => {
  const dest = path.join(WORK_DIR, "clone-manual-launch");
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({
      url: "someowner/manuallaunch",
      dest,
      agent: "claude-code",
      model: NON_DEFAULT_CLAUDE_MODEL,
      effort: NON_DEFAULT_CLAUDE_EFFORT,
      mode: "ask",
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { eli5TaskId: string | null; eli5Error: string | null };
  expect(body.eli5Error).toBeNull();
  expect(body.eli5TaskId).not.toBeNull();
  const task = tasks.get(body.eli5TaskId!)!;
  expect(task).not.toBeNull();
  expect(task.agent).toBe("claude-code");
  expect(task.model).toBe(NON_DEFAULT_CLAUDE_MODEL);
  expect(task.effort).toBe(NON_DEFAULT_CLAUDE_EFFORT);
  expect(task.mode).toBe("ask");
});

test("agentProfileId binds and its model overrides a manual model field", async () => {
  const profile: AgentProfile = agentProfiles.insert({
    name: `Clone Launch Profile ${Date.now()}`,
    harness: "claude-code",
    model: NON_DEFAULT_CLAUDE_MODEL,
  });
  const dest = path.join(WORK_DIR, "clone-profile-launch");
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({
      url: "someowner/profilelaunch",
      dest,
      agentProfileId: profile.id,
      model: "something-else",
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { eli5TaskId: string | null; eli5Error: string | null };
  expect(body.eli5Error).toBeNull();
  expect(body.eli5TaskId).not.toBeNull();
  const task = tasks.get(body.eli5TaskId!)!;
  expect(task).not.toBeNull();
  expect(task.agentProfileId).toBe(profile.id);
  expect(task.agentProfile?.name).toBe(profile.name);
  // The profile's own model wins over the manual field sent alongside it.
  expect(task.model).toBe(NON_DEFAULT_CLAUDE_MODEL);
  expect(task.model).not.toBe("something-else");
});

test("unknown agentProfileId 400s before cloning anything", async () => {
  const dest = path.join(WORK_DIR, "clone-unknown-profile");
  const before = tasks.list().length;
  const projectsBefore = (await (await call("/projects")).json()) as Project[];

  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "someowner/unknownprofile", dest, agentProfileId: "no-such-profile" }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("unknown agent profile");

  expect(existsSync(dest)).toBe(false);
  const projectsAfter = (await (await call("/projects")).json()) as Project[];
  expect(projectsAfter.some((p) => p.path === dest)).toBe(false);
  expect(projectsAfter.length).toBe(projectsBefore.length);
  expect(tasks.list().length).toBe(before);
});

test("unknown harness 400s before cloning anything", async () => {
  const dest = path.join(WORK_DIR, "clone-unknown-harness");
  const before = tasks.list().length;

  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "someowner/unknownharness", dest, agent: "no-such-harness" }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("unknown harness");

  expect(existsSync(dest)).toBe(false);
  expect(tasks.list().length).toBe(before);
});

test("wrong-typed launch fields 400 before cloning anything", async () => {
  const cases: { field: string; body: Record<string, unknown> }[] = [
    { field: "agentProfileId", body: { agentProfileId: 5 } },
    { field: "model", body: { model: 5 } },
    { field: "effort", body: { effort: 5 } },
    { field: "fast", body: { fast: "yes" } },
  ];
  const before = tasks.list().length;
  for (const { field, body } of cases) {
    const dest = path.join(WORK_DIR, `clone-bad-${field}`);
    const res = await call("/projects/clone", {
      method: "POST",
      body: JSON.stringify({ url: `someowner/bad-${field}`, dest, ...body }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain(field);
    expect(existsSync(dest)).toBe(false);
  }
  expect(tasks.list().length).toBe(before);
});

test("eli5:false ignores launch fields entirely, even invalid ones", async () => {
  const dest = path.join(WORK_DIR, "clone-eli5-false-bad-launch");
  const before = tasks.list().length;
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({
      url: "someowner/eli5falselaunch",
      dest,
      eli5: false,
      agent: "no-such-harness",
      agentProfileId: "nope",
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { eli5TaskId: string | null; eli5Error: string | null };
  expect(body.eli5TaskId).toBeNull();
  expect(body.eli5Error).toBeNull();
  expect(existsSync(path.join(dest, "README.md"))).toBe(true);
  expect(tasks.list().length).toBe(before);
});

test("agentProfileId: null is accepted as no profile", async () => {
  const dest = path.join(WORK_DIR, "clone-null-profile");
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "someowner/nullprofile", dest, agentProfileId: null }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { eli5TaskId: string | null; eli5Error: string | null };
  expect(body.eli5Error).toBeNull();
  expect(body.eli5TaskId).not.toBeNull();
  const task = tasks.get(body.eli5TaskId!)!;
  expect(task).not.toBeNull();
  expect(task.agentProfileId ?? null).toBeNull();
});

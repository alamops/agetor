import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { AGENT_OPTIONS, DEFAULT_MODEL } from "../shared/types.ts";
import type { AgentProfile, AppEvent, Project, Task } from "../shared/types.ts";
import { CLONE_PROVIDERS } from "../shared/clone-input.ts";
import { makeBareSourceRepo, startAuthGitServer } from "./clone-test-util.ts";
import { subscribeAppEvents } from "./quit-guard.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
let harnesses: typeof import("./db.ts").harnesses;

// Fake codex binary whose `--version` echoes back the current value of
// `FAKE_CODEX_VERSION`, mirroring orchestrator-min-cli-version.test.ts's own
// fixture. Set on AGETOR_CODEX_BIN once here; FAKE_CODEX_VERSION varies per
// test. Setup must happen before any test calls the route — codex's
// `resolveBin` reads AGETOR_CODEX_BIN by kind-level env override regardless
// of whether the harness row exists/is enabled in the DB (`getByIdOrKind`
// synthesizes a default row for a known AgentKind id).
const codexBinDir = mkdtempSync(path.join(tmpdir(), "agetor-clone-endpoint-codex-bin-"));
const fakeCodexBin = path.join(codexBinDir, "codex");
writeFileSync(
  fakeCodexBin,
  `#!/bin/sh\n`
    + `if [ "$1" = "--version" ]; then echo "$FAKE_CODEX_VERSION"; exit 0; fi\n`
    + `exit 0\n`,
  { mode: 0o755 },
);
let clearApiHostCacheForTest: () => void;
let savedSshBin: string | undefined;

beforeAll(async () => {
  ({ tasks, agentProfiles, harnesses } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
  harnesses.setEnabled("codex", true);
  process.env.AGETOR_CODEX_BIN = fakeCodexBin;
  // The codex counterpart test's eli5:false clone doesn't touch the floor
  // check at all, but the eli5:true refused case must never reach
  // AGETOR_CODEX_DRIVER — the floor check runs (and 400s) before startTask
  // would ever spawn anything, so no fake-driver env is needed for codex.

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

  // Deterministic host resolution for the multi-provider tests below (GHES /
  // dotless-alias / Bitbucket-Server rejection): point AGETOR_SSH_BIN at a
  // throwaway identity stub instead of letting `apiHostForRemote` shell out
  // to the real `ssh` and this machine's actual ~/.ssh/config — same idiom
  // as `git-provider.test.ts`. An identity stub (`ssh -G -- <host>` just
  // echoes `<host>` back as `hostname <host>`) is enough for every case
  // here: none of these hostnames have a real alias to resolve, the point is
  // only to make "no matching config entry" deterministic across machines
  // rather than dependent on whatever the CI/dev box's real ssh reports.
  const { __clearApiHostCacheForTest } = await import("./git-provider.ts");
  clearApiHostCacheForTest = __clearApiHostCacheForTest;
  savedSshBin = process.env.AGETOR_SSH_BIN;
  const sshStubDir = path.join(WORK_DIR, "ssh-stub");
  mkdirSync(sshStubDir);
  const sshStubPath = path.join(sshStubDir, "ssh");
  writeFileSync(sshStubPath, '#!/bin/sh\necho "hostname $3"\n', { mode: 0o755 });
  process.env.AGETOR_SSH_BIN = sshStubPath;
  clearApiHostCacheForTest();
});

afterAll(() => {
  delete process.env.AGETOR_CLONE_SOURCE_OVERRIDE;
  if (savedSshBin === undefined) delete process.env.AGETOR_SSH_BIN;
  else process.env.AGETOR_SSH_BIN = savedSshBin;
  clearApiHostCacheForTest?.();
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

test("POST /projects/clone rejects an unsupported host", async () => {
  const projectsBefore = (await (await call("/projects")).json()) as Project[];
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "https://example.com/foo/bar" }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain('unsupported host "example.com"');
  expect(body.error).toContain("GitHub, GitLab or Bitbucket Cloud");
  const projectsAfter = (await (await call("/projects")).json()) as Project[];
  expect(projectsAfter.length).toBe(projectsBefore.length);
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
    const failBody = (await res.json()) as { error: string };
    expect(failBody.error.startsWith("clone failed:")).toBe(true);
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

// --- Pre-flight 1b on the clone route (§8b finding 7): the explainer's
// launch selection is validated against the minimum-CLI-version floor
// BEFORE the clone side effect, exactly like the unknown-profile/harness
// checks above. ---

test("codex + gpt-6-sol on a too-old CLI 400s before cloning anything", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.147.0";
  const dest = path.join(WORK_DIR, "clone-codex-too-old");
  const before = tasks.list().length;

  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "someowner/codextooold", dest, agent: "codex", model: "gpt-6-sol" }),
  });
  expect(res.status).toBe(400);
  const json = (await res.json()) as { error: string };
  expect(json.error).toContain("0.155.0");
  expect(json.error).toContain("0.147.0");

  // No clone side effect at all — the destination was never created.
  expect(existsSync(dest)).toBe(false);
  const projectsAfter = (await (await call("/projects")).json()) as Project[];
  expect(projectsAfter.some((p) => p.path === dest)).toBe(false);
  expect(tasks.list().length).toBe(before);
});

test("codex + gpt-6-sol on a too-old CLI is NOT refused when eli5:false (the floor check is only run when the explainer is actually launched)", async () => {
  process.env.FAKE_CODEX_VERSION = "codex-cli 0.147.0";
  const dest = path.join(WORK_DIR, "clone-codex-too-old-no-eli5");

  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({
      url: "someowner/codextoooldnoeli5",
      dest,
      eli5: false,
      agent: "codex",
      model: "gpt-6-sol",
    }),
  });
  // Whatever the route otherwise returns for a valid clone (200) — the point
  // under test is that it is NOT the floor's 400.
  expect(res.status).not.toBe(400);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { eli5TaskId: string | null; eli5Error: string | null };
  expect(body.eli5TaskId).toBeNull();
  expect(body.eli5Error).toBeNull();
  expect(existsSync(path.join(dest, "README.md"))).toBe(true);
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

// --- Multi-provider clone support (docs/plans/clone-repository-all-providers.md
// §3 D6, §5 TT3): every host/transport/shorthand combination the shared
// parser + resolveCloneRepo accept, the provider field in the route's
// response, and the rejection paths (unsupported host, Bitbucket Server,
// dotless-alias-over-https, bad `provider` values, cloud-port guard). All of
// these still go through AGETOR_CLONE_SOURCE_OVERRIDE — no real network
// clone ever happens — and the AGETOR_SSH_BIN identity stub installed in
// beforeAll makes the host-resolution-dependent rejections deterministic. ---

test("GitLab https URL with nested groups clones, registers the last segment as the project name, and reports provider gitlab", async () => {
  const dest = path.join(WORK_DIR, "clone-gitlab-nested");
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "https://gitlab.com/group/sub/project", dest, eli5: false }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { project: Project; provider: string };
  expect(body.provider).toBe("gitlab");
  expect(body.project.name).toBe("project");
  expect(body.project.path).toBe(dest);
  expect(existsSync(path.join(dest, "README.md"))).toBe(true);
});

test("Bitbucket https URL clones and reports provider bitbucket", async () => {
  const dest = path.join(WORK_DIR, "clone-bitbucket");
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "https://bitbucket.org/someowner/bbrepo", dest, eli5: false }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { project: Project; provider: string };
  expect(body.provider).toBe("bitbucket");
  expect(body.project.name).toBe("bbrepo");
  expect(existsSync(path.join(dest, "README.md"))).toBe(true);
});

test("scp-form GitHub URL clones through the override and reports provider github", async () => {
  const dest = path.join(WORK_DIR, "clone-github-scp");
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "git@github.com:foo/bar.git", dest, eli5: false }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { project: Project; provider: string };
  expect(body.provider).toBe("github");
  expect(body.project.name).toBe("bar");
  expect(existsSync(path.join(dest, "README.md"))).toBe(true);
});

test("shorthand + provider: gitlab accepts a nested group path", async () => {
  const dest = path.join(WORK_DIR, "clone-shorthand-gitlab");
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "group/sub/project", provider: "gitlab", dest, eli5: false }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { project: Project; provider: string };
  expect(body.provider).toBe("gitlab");
  expect(body.project.name).toBe("project");
});

test("the same 3-segment shorthand with no provider defaults to github and is rejected", async () => {
  const dest = path.join(WORK_DIR, "clone-shorthand-no-provider");
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "group/sub/project", dest }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("invalid repository path");
  expect(existsSync(dest)).toBe(false);
});

test('provider: "svn" is rejected as an unsupported provider value', async () => {
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "foo/bar", provider: "svn" }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe(`provider must be one of ${CLONE_PROVIDERS.join(", ")}`);
});

test("provider: 42 (non-string) is rejected the same way", async () => {
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "foo/bar", provider: 42 }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe(`provider must be one of ${CLONE_PROVIDERS.join(", ")}`);
});

test("provider: null is treated as absent (defaults to github)", async () => {
  const dest = path.join(WORK_DIR, "clone-provider-null");
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "someowner/nullprovider", provider: null, dest, eli5: false }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { provider: string };
  expect(body.provider).toBe("github");
});

test("a full URL's detected provider wins over a conflicting provider body field", async () => {
  const dest = path.join(WORK_DIR, "clone-provider-conflict");
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "https://gitlab.com/g/p", provider: "github", dest, eli5: false }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { provider: string; project: Project };
  expect(body.provider).toBe("gitlab");
  expect(body.project.name).toBe("p");
});

test("Bitbucket Server / Data Center is rejected up front, nothing on disk", async () => {
  const projectsBefore = (await (await call("/projects")).json()) as Project[];
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "https://bitbucket.company.com/scm/proj/repo.git" }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("Bitbucket Server / Data Center is not supported");
  const projectsAfter = (await (await call("/projects")).json()) as Project[];
  expect(projectsAfter.length).toBe(projectsBefore.length);
});

test("GitHub Enterprise Server over https is rejected", async () => {
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "https://github.mycompany.com/o/r" }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("GitHub Enterprise Server");
});

test("a dotless ssh-alias host over https is rejected with the SSH-URL hint", async () => {
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "https://github-work/o/r" }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("looks like an SSH alias");
  expect(body.error).toContain("paste the SSH URL instead");
});

test("a non-default port on a cloud host is rejected", async () => {
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "https://gitlab.com:8443/g/p" }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("unexpected port");
});

test("an invalid launch selection still 400s before cloning, even for a non-GitHub URL", async () => {
  const dest = path.join(WORK_DIR, "clone-order-multiprovider");
  const before = tasks.list().length;
  const projectsBefore = (await (await call("/projects")).json()) as Project[];

  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({
      url: "https://gitlab.com/someowner/ordertest",
      dest,
      agentProfileId: "no-such-profile",
    }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("unknown agent profile");

  expect(existsSync(dest)).toBe(false);
  const projectsAfter = (await (await call("/projects")).json()) as Project[];
  expect(projectsAfter.some((p) => p.path === dest)).toBe(false);
  expect(projectsAfter.length).toBe(projectsBefore.length);
  expect(tasks.list().length).toBe(before);
});

test("a successful clone's response is exactly {project, provider, cloneId, eli5TaskId, eli5Error}", async () => {
  const dest = path.join(WORK_DIR, "clone-response-shape");
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "someowner/shaperepo", dest, eli5: false }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["cloneId", "eli5Error", "eli5TaskId", "project", "provider"]);
  expect(body.provider).toBe("github");
  expect(body.cloneId).toMatch(UUID_RE);
  expect(body.eli5TaskId).toBeNull();
  expect(body.eli5Error).toBeNull();
});

// --- Clone id round-trip + progress/cancel (docs/plans/
// clone-repository-all-providers.md Addendum A, P2: the `cloneId` body/
// response field, the `clone_progress` AppEvent broadcast, and
// `DELETE /projects/clone/:cloneId`). ---

test("a cloneId is minted and returned when the caller doesn't send one", async () => {
  const dest = path.join(WORK_DIR, "clone-id-minted");
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "someowner/cloneidminted", dest, eli5: false }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { cloneId: string };
  expect(body.cloneId).toMatch(UUID_RE);
});

test("a caller-minted cloneId is echoed back verbatim", async () => {
  const dest = path.join(WORK_DIR, "clone-id-echoed");
  const sent = crypto.randomUUID();
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "someowner/cloneidechoed", dest, eli5: false, cloneId: sent }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { cloneId: string };
  expect(body.cloneId).toBe(sent);
});

test("a malformed cloneId is rejected with 400 before anything is resolved", async () => {
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "someowner/badcloneid", cloneId: "not-a-uuid" }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string; cloneId?: string };
  expect(body.error).toBe("cloneId must be a UUID");
  // The id was never accepted, so there's nothing to echo.
  expect(body.cloneId).toBeUndefined();
});

test("a non-string cloneId is rejected with 400", async () => {
  const res = await call("/projects/clone", {
    method: "POST",
    body: JSON.stringify({ url: "someowner/badcloneidtype", cloneId: 12345 }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe("cloneId must be a UUID");
});

test("clone_progress AppEvents are broadcast for a successful clone, tagged with the request's cloneId, starting with `starting` and ending with `done`, and never carry a credential-shaped line", async () => {
  const cloneId = crypto.randomUUID();
  const events: AppEvent[] = [];
  const unsubscribe = subscribeAppEvents((e) => {
    if (e.type === "clone_progress" && e.cloneId === cloneId) events.push(e);
  });
  try {
    const dest = path.join(WORK_DIR, "clone-progress-events");
    const res = await call("/projects/clone", {
      method: "POST",
      body: JSON.stringify({ url: "someowner/progressevents", dest, eli5: false, cloneId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cloneId: string };
    expect(body.cloneId).toBe(cloneId);

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]).toMatchObject({ type: "clone_progress", cloneId, phase: "starting" });
    expect(events.at(-1)).toMatchObject({ type: "clone_progress", cloneId, phase: "done" });
    for (const e of events) {
      if (e.type !== "clone_progress") continue;
      expect(e.line).not.toMatch(/authorization|bearer|basic\s+[a-z0-9+/=]{8,}/i);
    }
  } finally {
    unsubscribe();
  }
});

test("DELETE /projects/clone/:cloneId for an unknown id returns 404", async () => {
  const res = await call(`/projects/clone/${crypto.randomUUID()}`, { method: "DELETE" });
  expect(res.status).toBe(404);
  expect(((await res.json()) as { error: string }).error).toBe("no clone in flight with that id");
});

test("DELETE /projects/clone/:cloneId with a malformed id returns 400", async () => {
  const res = await call("/projects/clone/not-a-uuid", { method: "DELETE" });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe("cloneId must be a UUID");
});

test(
  "cancelling an in-flight clone via DELETE resolves the held POST 409 { cancelled: true }, registers nothing, leaves the destination absent, and broadcasts a terminal `cancelled` progress event",
  async () => {
    const sourceRoot = mkdtempSync(path.join(tmpdir(), "agetor-clone-endpoint-cancel-src-"));
    makeBareSourceRepo(sourceRoot);
    // A generous per-request delay gives this test a wide window to send the
    // DELETE while attempt 1's anonymous request is still held by the
    // server — same idiom as clone.test.ts's own cancel tests.
    const gitServer = startAuthGitServer(sourceRoot, { delayMs: 4_000 });
    const prevOverride = process.env.AGETOR_CLONE_SOURCE_OVERRIDE;
    process.env.AGETOR_CLONE_SOURCE_OVERRIDE = `${gitServer.url}/repo.git`;

    const cloneId = crypto.randomUUID();
    const events: AppEvent[] = [];
    const unsubscribe = subscribeAppEvents((e) => {
      if (e.type === "clone_progress" && e.cloneId === cloneId) events.push(e);
    });

    try {
      const dest = path.join(WORK_DIR, "clone-cancel-endpoint");
      const projectsBefore = (await (await call("/projects")).json()) as Project[];

      const postPromise = call("/projects/clone", {
        method: "POST",
        body: JSON.stringify({ url: "someowner/cancelendpoint", dest, eli5: false, cloneId }),
      });

      // Give git a moment to actually spawn, connect, and issue its first
      // request — then cancel while that request is still held by the
      // server's delay.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const delRes = await call(`/projects/clone/${cloneId}`, { method: "DELETE" });
      expect(delRes.status).toBe(200);
      expect(await delRes.json()).toEqual({ ok: true });

      const postRes = await postPromise;
      expect(postRes.status).toBe(409);
      expect(await postRes.json()).toEqual({ error: "clone cancelled", cancelled: true, cloneId });

      // `dest` never pre-existed, so a cancelled clone leaves it absent
      // entirely — see cloneRepo's own doc comment.
      expect(existsSync(dest)).toBe(false);
      const projectsAfter = (await (await call("/projects")).json()) as Project[];
      expect(projectsAfter.length).toBe(projectsBefore.length);
      expect(projectsAfter.some((p) => p.path === dest)).toBe(false);

      expect(events.some((e) => e.type === "clone_progress" && e.phase === "cancelled")).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "clone_progress", cloneId, phase: "cancelled" });
    } finally {
      unsubscribe();
      if (prevOverride === undefined) delete process.env.AGETOR_CLONE_SOURCE_OVERRIDE;
      else process.env.AGETOR_CLONE_SOURCE_OVERRIDE = prevOverride;
      gitServer.stop();
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  },
  30_000,
);

test(
  "a duplicate in-flight cloneId 409s the second POST, doesn't disturb the first, and frees up once the first settles",
  async () => {
    const sourceRoot = mkdtempSync(path.join(tmpdir(), "agetor-clone-endpoint-dup-src-"));
    makeBareSourceRepo(sourceRoot);
    // Same idiom as the cancel tests above: a generous per-request delay
    // keeps the first POST's clone in flight long enough to fire the
    // duplicate POST and the cancelling DELETE against it.
    const gitServer = startAuthGitServer(sourceRoot, { delayMs: 4_000 });
    const prevOverride = process.env.AGETOR_CLONE_SOURCE_OVERRIDE;
    process.env.AGETOR_CLONE_SOURCE_OVERRIDE = `${gitServer.url}/repo.git`;
    try {
      const cloneId = crypto.randomUUID();
      const dest1 = path.join(WORK_DIR, "clone-dup-id-1");
      const dest2 = path.join(WORK_DIR, "clone-dup-id-2");

      const firstPostPromise = call("/projects/clone", {
        method: "POST",
        body: JSON.stringify({ url: "someowner/dupclonefirst", dest: dest1, eli5: false, cloneId }),
      });

      // Give git a moment to actually spawn, connect, and issue its first
      // request — same wait as the cancel tests — before racing the
      // duplicate POST and the DELETE against the same id.
      await new Promise((resolve) => setTimeout(resolve, 500));

      // A second POST reusing the same in-flight cloneId is rejected...
      const dupRes = await call("/projects/clone", {
        method: "POST",
        body: JSON.stringify({ url: "someowner/dupclonesecond", dest: dest2, eli5: false, cloneId }),
      });
      expect(dupRes.status).toBe(409);
      expect(await dupRes.json()).toEqual({
        error: "a clone with that id is already in flight",
        cloneId,
      });
      // ...and nothing was cloned/registered for the rejected duplicate.
      expect(existsSync(dest2)).toBe(false);

      // The DELETE still targets the FIRST (real) clone under that id, not
      // the rejected duplicate — cancelling it still works exactly as
      // before the duplicate-guard existed.
      const delRes = await call(`/projects/clone/${cloneId}`, { method: "DELETE" });
      expect(delRes.status).toBe(200);
      expect(await delRes.json()).toEqual({ ok: true });

      const firstRes = await firstPostPromise;
      expect(firstRes.status).toBe(409);
      expect(await firstRes.json()).toEqual({ error: "clone cancelled", cancelled: true, cloneId });
      expect(existsSync(dest1)).toBe(false);

      // The id is free again now that the first request has settled: a
      // fresh POST reusing it succeeds (or fails) on its own merits, never
      // with the duplicate-in-flight error. Point the source override back
      // at the fast fixture repo from beforeAll (rather than the slow git
      // server) so this assertion doesn't also pay the 4s-per-request delay.
      process.env.AGETOR_CLONE_SOURCE_OVERRIDE = prevOverride;
      const dest3 = path.join(WORK_DIR, "clone-dup-id-reused");
      const reusedRes = await call("/projects/clone", {
        method: "POST",
        body: JSON.stringify({ url: "someowner/dupclonereused", dest: dest3, eli5: false, cloneId }),
      });
      expect(reusedRes.status).not.toBe(409);
      const reusedBody = (await reusedRes.json()) as { error?: string; cloneId?: string };
      expect(reusedBody.error).not.toBe("a clone with that id is already in flight");
    } finally {
      if (prevOverride === undefined) delete process.env.AGETOR_CLONE_SOURCE_OVERRIDE;
      else process.env.AGETOR_CLONE_SOURCE_OVERRIDE = prevOverride;
      gitServer.stop();
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  },
  30_000,
);

test("a second DELETE for an already-settled cloneId 404s (the registry entry is gone)", async () => {
  const sourceRoot = mkdtempSync(path.join(tmpdir(), "agetor-clone-endpoint-cancel-src2-"));
  makeBareSourceRepo(sourceRoot);
  const gitServer = startAuthGitServer(sourceRoot, { delayMs: 4_000 });
  const prevOverride = process.env.AGETOR_CLONE_SOURCE_OVERRIDE;
  process.env.AGETOR_CLONE_SOURCE_OVERRIDE = `${gitServer.url}/repo.git`;
  try {
    const cloneId = crypto.randomUUID();
    const dest = path.join(WORK_DIR, "clone-cancel-endpoint-twice");
    const postPromise = call("/projects/clone", {
      method: "POST",
      body: JSON.stringify({ url: "someowner/cancelendpointtwice", dest, eli5: false, cloneId }),
    });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const firstDelete = await call(`/projects/clone/${cloneId}`, { method: "DELETE" });
    expect(firstDelete.status).toBe(200);

    await postPromise;

    const secondDelete = await call(`/projects/clone/${cloneId}`, { method: "DELETE" });
    expect(secondDelete.status).toBe(404);
  } finally {
    if (prevOverride === undefined) delete process.env.AGETOR_CLONE_SOURCE_OVERRIDE;
    else process.env.AGETOR_CLONE_SOURCE_OVERRIDE = prevOverride;
    gitServer.stop();
    rmSync(sourceRoot, { recursive: true, force: true });
  }
}, 30_000);

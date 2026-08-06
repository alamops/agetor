import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureCore, stopDaemon } from "./daemon/supervisor.ts";
import { AgetorClient, ApiError } from "./api-client.ts";
import { cmdConfig } from "./commands/config.ts";
import { coreCredsPath } from "../bun/core-creds.ts";

async function withClient(
  port: number,
  fn: (client: AgetorClient, dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-mg-"));
  const core = await ensureCore({ dataDir: dir, port });
  try {
    await fn(new AgetorClient(core), dir);
  } finally {
    await stopDaemon(dir);
    for (let i = 0; i < 30 && existsSync(coreCredsPath(dir)); i++) {
      await Bun.sleep(100);
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("projects add/list/remove round-trip + listBranches returns BranchInfo[]", async () => {
  await withClient(4496, async (client) => {
    const repo = mkdtempSync(path.join(tmpdir(), "agetor-repo-"));
    Bun.spawnSync(["git", "init", "-q", repo]);
    Bun.spawnSync([
      "git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t",
      "commit", "--allow-empty", "-q", "-m", "init",
    ]);

    expect(await client.listProjects()).toHaveLength(0);
    const p = await client.addProject(repo, "Repo");
    expect(p.path).toBe(repo);
    expect(p.name).toBe("Repo");
    expect(await client.listProjects()).toHaveLength(1);

    const branches = await client.listBranches(repo);
    expect(Array.isArray(branches)).toBe(true);
    // Robust to the default branch name (main/master): there is a current one.
    const current = branches.find((b) => b.current);
    expect(current).toBeDefined();
    expect(typeof current!.name).toBe("string");

    await client.removeProject(repo);
    expect(await client.listProjects()).toHaveLength(0);
    rmSync(repo, { recursive: true, force: true });
  });
}, 30_000);

test("harness create/patch/enable/disable/delete + guard paths + {harnesses,statuses} shape", async () => {
  await withClient(4497, async (client) => {
    const listed = await client.listHarnesses();
    expect(Array.isArray(listed.harnesses)).toBe(true);
    expect(Array.isArray(listed.statuses)).toBe(true);
    expect(listed.harnesses.some((h) => h.id === "claude-code" && h.isBuiltin)).toBe(true);

    const created = await client.createHarness({
      id: "alias1",
      kind: "claude-code",
      label: "Alias One",
    });
    expect(created.id).toBe("alias1");
    expect(created.isBuiltin).toBe(false);
    expect(created.label).toBe("Alias One");

    expect((await client.patchHarness("alias1", { label: "Renamed" })).label).toBe("Renamed");
    expect((await client.patchHarness("alias1", { enabled: false })).enabled).toBe(false);
    expect((await client.patchHarness("alias1", { enabled: true })).enabled).toBe(true);

    // Codex is now an opt-in harness — main removed the old "coming soon" 400
    // lock (see server-auth.test.ts), so creating a codex alias succeeds.
    const cx = await client.createHarness({ id: "cx", kind: "codex", label: "X" });
    expect(cx.id).toBe("cx");
    expect(cx.isBuiltin).toBe(false);
    await client.deleteHarness("cx");

    // Guard: built-ins can't be deleted.
    let builtinErr: unknown;
    try {
      await client.deleteHarness("claude-code");
    } catch (e) {
      builtinErr = e;
    }
    expect(builtinErr).toBeInstanceOf(ApiError);

    await client.deleteHarness("alias1");
    expect((await client.listHarnesses()).harnesses.some((h) => h.id === "alias1")).toBe(false);
  });
}, 30_000);

test("preferences round-trip (get / set) via the client", async () => {
  await withClient(4500, async (client) => {
    expect(await client.getPreferences()).toEqual({});
    await client.setPreference("defaultHarness", "claude-code");
    await client.setPreference("lastModel:claude-code", "opus-4.7");
    const prefs = await client.getPreferences();
    expect(prefs.defaultHarness).toBe("claude-code");
    expect(prefs["lastModel:claude-code"]).toBe("opus-4.7"); // ':' in the key survives the round-trip
  });
}, 30_000);

test("cmdConfig sets a preference via the command (set path)", async () => {
  await withClient(4532, async (client, dir) => {
    await cmdConfig(["mykey", "my value"], { json: true, plain: true, noDaemon: false, dataDir: dir });
    expect((await client.getPreferences()).mykey).toBe("my value");
  });
}, 30_000);

test("agentDiscovery returns { commands, extensions } arrays", async () => {
  await withClient(4533, async (client) => {
    const repo = mkdtempSync(path.join(tmpdir(), "agetor-disc-"));
    const res = await client.agentDiscovery("claude-code", repo, null);
    expect(Array.isArray(res.commands)).toBe(true);
    expect(Array.isArray(res.extensions)).toBe(true);
    rmSync(repo, { recursive: true, force: true });
  });
}, 30_000);

test("agentModels returns discovered model ids per kind", async () => {
  await withClient(4535, async (client) => {
    const models = await client.agentModels();
    expect(Array.isArray(models["claude-code"])).toBe(true);
    expect(Array.isArray(models["codex"])).toBe(true);
  });
}, 30_000);

test("rebuildEvents 404s for an unknown run id", async () => {
  await withClient(4534, async (client) => {
    let err: unknown;
    try {
      await client.rebuildEvents("no-such-run");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });
}, 30_000);

test("harness shell-env resolves the harness env (CLAUDE_CONFIG_DIR + custom env)", async () => {
  await withClient(4499, async (client) => {
    const home = mkdtempSync(path.join(tmpdir(), "agetor-hcfg-"));
    await client.createHarness({ id: "envalias", kind: "claude-code", label: "Env", home, env: { FOO: "bar" } });
    const shellEnv = await client.harnessShellEnv("envalias");
    expect(shellEnv.env.CLAUDE_CONFIG_DIR).toBe(home); // claude-code maps home → CLAUDE_CONFIG_DIR
    expect(shellEnv.env.FOO).toBe("bar");
    expect(shellEnv.launch).toBe("claude");
    expect(shellEnv.kind).toBe("claude-code");
    expect(shellEnv.binDir).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });
}, 30_000);

test("getGitStatus reports uncommitted changes via { hasChanges }", async () => {
  await withClient(4498, async (client) => {
    const repo = mkdtempSync(path.join(tmpdir(), "agetor-gs-"));
    Bun.spawnSync(["git", "init", "-q", repo]);
    writeFileSync(path.join(repo, "a.txt"), "one\n");
    Bun.spawnSync(["git", "-C", repo, "add", "-A"]);
    Bun.spawnSync([
      "git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t",
      "commit", "-q", "-m", "init",
    ]);

    const t = await client.createTask({
      title: "GS", prompt: "p", agent: "claude-code", isolation: "none", workdir: repo,
    });
    // isolation "none" never resolves a workdirRoot in createTask, so baseRef
    // stays null — confirm that assumption, since it's what pins the `ahead`
    // expectation below to 0 rather than a baseRef..HEAD comparison.
    expect(t.baseRef).toBeNull();

    const clean = await client.getGitStatus(t.id);
    expect(clean.hasChanges).toBe(false);
    expect(typeof clean.ahead).toBe("number");
    // No upstream configured and no baseRef to fall back to → getAheadCount's
    // third tier: a bare 0, not null (see worktree.ts).
    expect(clean.ahead).toBe(0);
    expect(clean.ignored).toBe(false);

    writeFileSync(path.join(repo, "a.txt"), "two\n"); // modify a tracked file
    const dirty = await client.getGitStatus(t.id);
    expect(dirty.hasChanges).toBe(true);
    // An uncommitted change doesn't add a commit, so ahead is unaffected.
    expect(dirty.ahead).toBe(0);

    await client.deleteTask(t.id);
    rmSync(repo, { recursive: true, force: true });
  });
}, 30_000);

test("getGitStatus: ignored short-circuit for a non-git workdir", async () => {
  await withClient(4536, async (client) => {
    const dir = mkdtempSync(path.join(tmpdir(), "agetor-gs-nogit-"));

    const t = await client.createTask({
      title: "GS-nogit", prompt: "p", agent: "claude-code", isolation: "none", workdir: dir,
    });
    expect(await client.getGitStatus(t.id)).toEqual({
      hasChanges: false, ahead: 0, ignored: true, hasUpstream: false, remoteSynced: false,
    });

    await client.deleteTask(t.id);
    rmSync(dir, { recursive: true, force: true });
  });
}, 30_000);

test("getGitStatus: ahead reflects commits made after a pinned baseRef", async () => {
  await withClient(4537, async (client) => {
    const repo = mkdtempSync(path.join(tmpdir(), "agetor-gs-ahead-"));
    Bun.spawnSync(["git", "init", "-q", repo]);
    writeFileSync(path.join(repo, "a.txt"), "one\n");
    Bun.spawnSync(["git", "-C", repo, "add", "-A"]);
    Bun.spawnSync([
      "git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t",
      "commit", "-q", "-m", "init",
    ]);

    // isolation "worktree" against a git repo pins baseRef to HEAD's sha at
    // create time, even though the worktree itself isn't materialized until
    // the task is started — dir = t.worktreePath ?? t.workdir falls back to
    // the repo itself, so a direct commit here is what getAheadCount compares
    // baseRef against (no upstream configured, so it's tier 2: baseRef..HEAD).
    const t = await client.createTask({
      title: "GS-ahead", prompt: "p", agent: "claude-code", isolation: "worktree", workdir: repo,
    });
    expect(typeof t.baseRef).toBe("string");
    expect((await client.getGitStatus(t.id)).ahead).toBe(0);

    writeFileSync(path.join(repo, "b.txt"), "two\n");
    Bun.spawnSync(["git", "-C", repo, "add", "-A"]);
    Bun.spawnSync([
      "git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t",
      "commit", "-q", "-m", "second",
    ]);

    const status = await client.getGitStatus(t.id);
    expect(status.ahead).toBe(1);
    expect(status.hasChanges).toBe(false);

    await client.deleteTask(t.id);
    rmSync(repo, { recursive: true, force: true });
  });
}, 30_000);

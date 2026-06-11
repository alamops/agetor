import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureCore, stopDaemon } from "./daemon/supervisor.ts";
import { AgetorClient, ApiError } from "./api-client.ts";
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

    // Guard: codex aliases are "coming soon" → 400.
    let codexErr: unknown;
    try {
      await client.createHarness({ id: "cx", kind: "codex", label: "X" });
    } catch (e) {
      codexErr = e;
    }
    expect(codexErr).toBeInstanceOf(ApiError);
    expect((codexErr as ApiError).status).toBe(400);

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
    expect((await client.getGitStatus(t.id)).hasChanges).toBe(false);

    writeFileSync(path.join(repo, "a.txt"), "two\n"); // modify a tracked file
    expect((await client.getGitStatus(t.id)).hasChanges).toBe(true);

    await client.deleteTask(t.id);
    rmSync(repo, { recursive: true, force: true });
  });
}, 30_000);

// `pullTargets` against real temp git repos and injected fake forge deps
// (docs/plans/create-all-prs-title-and-base.md T9). No network, no `git fetch`.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ForgeBranch, ProviderRepoInfo } from "../shared/types.ts";
import type { GitResult, PullTargetsDeps } from "./pr-targets.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// pr-targets.ts reaches db.ts through the forge adapters: set the data dir at
// the top level and import dynamically.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pr-targets-db-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
const { pullTargets } = await import("./pr-targets.ts");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  rmTestDataDir(DATA_DIR);
});

async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out;
}

/** A repo with main@r0, topic@t1 (off main), and returns the shas. */
async function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-pr-targets-"));
  dirs.push(dir);
  await git(["init", "-q", "-b", "main"], dir);
  const commit = async (file: string) => {
    writeFileSync(path.join(dir, file), `${file}\n`);
    await git(["add", "."], dir);
    await git(["commit", "-q", "-m", file], dir);
    return git(["rev-parse", "HEAD"], dir);
  };
  const r0 = await commit("r0");
  await git(["checkout", "-q", "-b", "topic"], dir);
  const t1 = await commit("t1");
  await git(["checkout", "-q", "main"], dir);
  return { dir, commit, r0, t1 };
}

const info: ProviderRepoInfo = { provider: "github", host: "github.com", remoteHost: "github.com", owner: "acme", name: "app" };

interface FakeForge {
  branches?: ForgeBranch[];
  truncated?: boolean;
  listError?: string;
  defaultBranch?: string;
  extra?: Record<string, ForgeBranch | null>;
}

function depsFor(forge: FakeForge, gitCalls: string[][] = [], dirOverride?: string): PullTargetsDeps {
  return {
    providerRemote: async () => ({ info, remote: "origin" }),
    listBranches: async () =>
      forge.listError
        ? { ok: false, error: forge.listError }
        : { ok: true, branches: forge.branches ?? [], truncated: forge.truncated ?? false },
    branchInfo: async ({ name }) => ({ ok: true, branch: forge.extra?.[name] ?? null }),
    remoteDefaultBranch: async () =>
      forge.defaultBranch ? { ok: true, name: forge.defaultBranch } : { ok: false, error: "none" },
    git: async (args, cwd): Promise<GitResult> => {
      gitCalls.push(args);
      const proc = Bun.spawn(["git", ...args], { cwd: dirOverride ?? cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return { ok: code === 0, stdout: out.trim(), exitCode: code };
    },
  };
}

const NO_FORGE_SHA = "a".repeat(40);

describe("stale check", () => {
  test("(a) the base advanced on the remote while the head still contains the pinned sha → not stale", async () => {
    const { dir, t1 } = await makeRepo();
    await git(["checkout", "-q", "-b", "task", "topic"], dir);
    writeFileSync(path.join(dir, "k"), "k\n");
    await git(["add", "."], dir);
    await git(["commit", "-q", "-m", "k"], dir);
    // The remote tip is an object this repo doesn't have.
    const res = await pullTargets(
      { dir, heads: ["task"], storedBase: "topic", storedBaseSha: t1, liveHead: "task" },
      depsFor({ branches: [{ name: "topic", sha: NO_FORGE_SHA }, { name: "task", sha: null }] }),
    );
    expect(res.ok && res.storedBase).toEqual({ name: "topic", onRemote: true, stale: false });
  });

  test("(b) the head was reset onto another branch (neither pinned nor tip is an ancestor) → stale", async () => {
    const { dir, t1 } = await makeRepo();
    await git(["checkout", "-q", "-b", "task", "main"], dir);
    writeFileSync(path.join(dir, "k"), "k\n");
    await git(["add", "."], dir);
    await git(["commit", "-q", "-m", "k"], dir);
    const res = await pullTargets(
      { dir, heads: ["task"], storedBase: "topic", storedBaseSha: t1, liveHead: "task" },
      depsFor({ branches: [{ name: "topic", sha: t1 }, { name: "task", sha: null }] }),
    );
    expect(res.ok && res.storedBase?.stale).toBe(true);
  });

  test("(b') the same reset, with the remote tip unknown locally, is still stale", async () => {
    const { dir, t1 } = await makeRepo();
    await git(["checkout", "-q", "-b", "task", "main"], dir);
    const res = await pullTargets(
      { dir, heads: ["task"], storedBase: "topic", storedBaseSha: t1, liveHead: "task" },
      depsFor({ branches: [{ name: "topic", sha: NO_FORGE_SHA }, { name: "task", sha: null }] }),
    );
    expect(res.ok && res.storedBase?.stale).toBe(true);
  });

  test("(c) the pinned sha is not an ancestor but the remote tip is (base force-pushed, head rebased) → not stale", async () => {
    const { dir, t1, commit } = await makeRepo();
    await git(["checkout", "-q", "-b", "topic2", "main"], dir);
    const u1 = await commit("u1");
    await git(["checkout", "-q", "-b", "task"], dir);
    await commit("k");
    const res = await pullTargets(
      { dir, heads: ["task"], storedBase: "topic", storedBaseSha: t1, liveHead: "task" },
      depsFor({ branches: [{ name: "topic", sha: u1 }, { name: "task", sha: null }] }),
    );
    expect(res.ok && res.storedBase?.stale).toBe(false);
  });

  test("(d) no pinned sha and the tip object missing locally → unknown", async () => {
    const { dir } = await makeRepo();
    await git(["checkout", "-q", "-b", "task", "main"], dir);
    const res = await pullTargets(
      { dir, heads: ["task"], storedBase: "topic", storedBaseSha: null, liveHead: "task" },
      depsFor({ branches: [{ name: "topic", sha: NO_FORGE_SHA }] }),
    );
    expect(res.ok && res.storedBase?.stale).toBeNull();
  });

  test("a missing live head ref or no live head is unknown, not an error", async () => {
    const { dir, t1 } = await makeRepo();
    const deps = depsFor({ branches: [{ name: "topic", sha: t1 }] });
    const a = await pullTargets({ dir, heads: [], storedBase: "topic", storedBaseSha: t1, liveHead: "ghost" }, deps);
    expect(a.ok && a.storedBase?.stale).toBeNull();
    const b = await pullTargets({ dir, heads: [], storedBase: "topic", storedBaseSha: t1 }, deps);
    expect(b.ok && b.storedBase?.stale).toBeNull();
  });
});

describe("branch facts", () => {
  test("heads and the stored base report onRemote from the listing; a missing stored base is flagged", async () => {
    const { dir } = await makeRepo();
    const res = await pullTargets(
      { dir, heads: ["feature/a", "feature/missing"], storedBase: "gone" },
      depsFor({ branches: [{ name: "main", sha: null }, { name: "feature/a", sha: null }] }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.heads).toEqual([
      { name: "feature/a", onRemote: true },
      { name: "feature/missing", onRemote: false },
    ]);
    expect(res.storedBase).toMatchObject({ name: "gone", onRemote: false });
    expect(res.branches).toEqual(["main", "feature/a"]);
    expect(res.branchesError).toBeNull();
    expect(res.remote).toBe("origin");
  });

  test("beyond a truncated listing a name is checked one by one through branchInfo", async () => {
    const { dir } = await makeRepo();
    const res = await pullTargets(
      { dir, heads: ["deep", "nope"] },
      depsFor({ branches: [{ name: "main", sha: null }], truncated: true, extra: { deep: { name: "deep", sha: null } } }),
    );
    expect(res.ok && res.branchesTruncated).toBe(true);
    expect(res.ok && res.heads).toEqual([
      { name: "deep", onRemote: true },
      { name: "nope", onRemote: false },
    ]);
  });

  test("listBranches:false never lists; each name is asked of the forge individually", async () => {
    const { dir } = await makeRepo();
    let listed = 0;
    const deps = depsFor({ branches: [{ name: "main", sha: null }], extra: { deep: { name: "deep", sha: null } } });
    const res = await pullTargets(
      { dir, heads: ["deep", "nope"], storedBase: "deep", listBranches: false },
      { ...deps, listBranches: async () => { listed += 1; return { ok: true, branches: [], truncated: false }; } },
    );
    expect(listed).toBe(0);
    expect(res.ok && res.branches).toEqual([]);
    expect(res.ok && res.heads).toEqual([
      { name: "deep", onRemote: true },
      { name: "nope", onRemote: false },
    ]);
    expect(res.ok && res.storedBase?.onRemote).toBe(true);
  });

  test("a failed listing leaves existence unknown and reports the error", async () => {
    const { dir } = await makeRepo();
    const res = await pullTargets({ dir, heads: ["a"], storedBase: "b" }, depsFor({ listError: "rate limited" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.branchesError).toBe("rate limited");
    expect(res.heads).toEqual([{ name: "a", onRemote: null }]);
    expect(res.storedBase).toMatchObject({ onRemote: null, stale: null });
    expect(res.branches).toEqual([]);
  });

  test("the listing is capped at 1000 names", async () => {
    const { dir } = await makeRepo();
    const many = Array.from({ length: 1200 }, (_, i) => ({ name: `b${i}`, sha: null }));
    const res = await pullTargets({ dir, heads: [] }, depsFor({ branches: many }));
    expect(res.ok && res.branches).toHaveLength(1000);
    expect(res.ok && res.branchesTruncated).toBe(true);
  });

  test("a project with no supported remote is an error", async () => {
    const { dir } = await makeRepo();
    const deps = { ...depsFor({}), providerRemote: async () => null };
    const res = await pullTargets({ dir, heads: [] }, deps);
    expect(res.ok).toBe(false);
  });
});

describe("default branch", () => {
  test("<remote>/HEAD wins; the forge default is the fallback; neither gives null", async () => {
    const { dir } = await makeRepo();
    await git(["update-ref", "refs/remotes/origin/develop", "HEAD"], dir);
    await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"], dir);
    const local = await pullTargets({ dir, heads: [] }, depsFor({ defaultBranch: "trunk" }));
    expect(local.ok && local.defaultBranch).toBe("develop");

    const bare = await makeRepo();
    const forge = await pullTargets({ dir: bare.dir, heads: [] }, depsFor({ defaultBranch: "trunk" }));
    expect(forge.ok && forge.defaultBranch).toBe("trunk");
    const none = await pullTargets({ dir: bare.dir, heads: [] }, depsFor({}));
    expect(none.ok && none.defaultBranch).toBeNull();
  });
});

describe("input safety and process rules", () => {
  test("names that fail validation or start with '-' never reach git, and never count as on the remote", async () => {
    const { dir, t1 } = await makeRepo();
    const calls: string[][] = [];
    const evil = ["--upload-pack=x", "-rf", "a b", "a..b", "x:y"];
    const res = await pullTargets(
      { dir, heads: evil, storedBase: "--evil", storedBaseSha: t1, liveHead: "--evil" },
      depsFor({ branches: evil.map((name) => ({ name, sha: null })) }, calls),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.heads.every((h) => h.onRemote === false)).toBe(true);
    expect(res.storedBase).toMatchObject({ name: "--evil", onRemote: false, stale: null });
    const joined = calls.flat();
    for (const bad of evil) expect(joined).not.toContain(bad);
    expect(joined.some((a) => a.includes("--evil"))).toBe(false);
  });

  test("the ancestry check uses --end-of-options, and no git command fetches", async () => {
    const { dir, t1 } = await makeRepo();
    await git(["checkout", "-q", "-b", "task", "topic"], dir);
    const calls: string[][] = [];
    await pullTargets(
      { dir, heads: ["task"], storedBase: "topic", storedBaseSha: t1, liveHead: "task" },
      depsFor({ branches: [{ name: "topic", sha: t1 }] }, calls),
    );
    const merge = calls.find((c) => c[0] === "merge-base");
    expect(merge).toEqual(["merge-base", "--is-ancestor", "--end-of-options", t1, "refs/heads/task"]);
    expect(calls.some((c) => c.includes("fetch") || c.includes("ls-remote") || c.includes("pull"))).toBe(false);
  });

  test("a non-hex pinned sha is never passed to git", async () => {
    const { dir } = await makeRepo();
    const calls: string[][] = [];
    await pullTargets(
      { dir, heads: [], storedBase: "topic", storedBaseSha: "--output=/tmp/x", liveHead: "main" },
      depsFor({ branches: [{ name: "topic", sha: null }] }, calls),
    );
    expect(calls.flat().some((a) => a.includes("--output"))).toBe(false);
  });
});

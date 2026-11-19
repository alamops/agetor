// `resolveBaseBranchName` (docs/plans/create-all-prs-title-and-base.md T12):
// the branch NAME a requested base ref resolves to at task creation.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-base-branch-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
const { resolveBaseBranchName, resolveBaseRefAndBranch } = await import("./worktree.ts");

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

async function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-base-branch-"));
  dirs.push(dir);
  await git(["init", "-q", "-b", "main"], dir);
  writeFileSync(path.join(dir, "f"), "1\n");
  await git(["add", "."], dir);
  await git(["commit", "-q", "-m", "c1"], dir);
  return dir;
}

test("a local branch name resolves to itself, including slashes", async () => {
  const dir = await makeRepo();
  await git(["branch", "develop"], dir);
  await git(["branch", "release/1.2"], dir);
  expect(await resolveBaseBranchName(dir, "develop")).toBe("develop");
  expect(await resolveBaseBranchName(dir, "release/1.2")).toBe("release/1.2");
  expect(await resolveBaseBranchName(dir, "refs/heads/develop")).toBe("develop");
});

test("a remote-tracking ref resolves to its branch name, remote stripped", async () => {
  const dir = await makeRepo();
  await git(["update-ref", "refs/remotes/origin/release/1.2", "HEAD"], dir);
  expect(await resolveBaseBranchName(dir, "origin/release/1.2")).toBe("release/1.2");
  expect(await resolveBaseBranchName(dir, "refs/remotes/origin/release/1.2")).toBe("release/1.2");
});

test("a tag, a sha and a missing ref give null", async () => {
  const dir = await makeRepo();
  await git(["tag", "v1"], dir);
  const sha = await git(["rev-parse", "HEAD"], dir);
  expect(await resolveBaseBranchName(dir, "v1")).toBeNull();
  expect(await resolveBaseBranchName(dir, sha)).toBeNull();
  expect(await resolveBaseBranchName(dir, sha.slice(0, 10))).toBeNull();
  expect(await resolveBaseBranchName(dir, "does-not-exist")).toBeNull();
});

test("a bare remote name resolves to the branch its HEAD points at, never to 'HEAD'", async () => {
  const dir = await makeRepo();
  await git(["update-ref", "refs/remotes/origin/main", "HEAD"], dir);
  await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], dir);
  expect(await resolveBaseBranchName(dir, "origin")).toBe("main");
});

test("HEAD on a branch whose remote-tracking ref exists gives the branch", async () => {
  const dir = await makeRepo();
  await git(["update-ref", "refs/remotes/origin/main", "HEAD"], dir);
  expect(await resolveBaseBranchName(dir, "HEAD")).toBe("main");
});

test("HEAD on a local-only branch, or detached, gives null", async () => {
  const dir = await makeRepo();
  expect(await resolveBaseBranchName(dir, "HEAD")).toBeNull();
  await git(["update-ref", "refs/remotes/origin/main", "HEAD"], dir);
  await git(["checkout", "-q", "--detach"], dir);
  expect(await resolveBaseBranchName(dir, "HEAD")).toBeNull();
});

test("HEAD honors the branch's configured upstream remote", async () => {
  const dir = await makeRepo();
  await git(["config", "branch.main.remote", "upstream"], dir);
  await git(["update-ref", "refs/remotes/origin/main", "HEAD"], dir);
  expect(await resolveBaseBranchName(dir, "HEAD")).toBeNull();
  await git(["update-ref", "refs/remotes/upstream/main", "HEAD"], dir);
  expect(await resolveBaseBranchName(dir, "HEAD")).toBe("main");
});

test("a name starting with '-' or empty gives null without a git call", async () => {
  const missing = path.join(tmpdir(), "agetor-no-such-dir-for-base-branch");
  // The directory doesn't exist: only a short-circuit can answer without throwing.
  expect(await resolveBaseBranchName(missing, "--upload-pack=x")).toBeNull();
  expect(await resolveBaseBranchName(missing, "-x")).toBeNull();
  expect(await resolveBaseBranchName(missing, "  ")).toBeNull();
});

test("a non-git directory gives null", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-base-branch-nongit-"));
  dirs.push(dir);
  expect(await resolveBaseBranchName(dir, "main")).toBeNull();
  expect(await resolveBaseBranchName(dir, "HEAD")).toBeNull();
});

// `resolveBaseRefAndBranch`: the pinned sha and the recorded name come from one
// identity, so a checkout that changes mid-create can't mix them.
test("resolveBaseRefAndBranch: HEAD on a pushed branch pins that branch's tip and records its name", async () => {
  const dir = await makeRepo();
  await git(["checkout", "-q", "-b", "topic"], dir);
  writeFileSync(path.join(dir, "f"), "2\n");
  await git(["commit", "-q", "-am", "c2"], dir);
  await git(["update-ref", "refs/remotes/origin/topic", "HEAD"], dir);
  const tip = await git(["rev-parse", "refs/heads/topic"], dir);
  expect(await resolveBaseRefAndBranch(dir, "HEAD")).toEqual({ sha: tip, baseBranch: "topic" });
});

test("resolveBaseRefAndBranch: HEAD on a local-only branch or detached pins the commit with no name", async () => {
  const dir = await makeRepo();
  const tip = await git(["rev-parse", "HEAD"], dir);
  expect(await resolveBaseRefAndBranch(dir, "HEAD")).toEqual({ sha: tip, baseBranch: null });
  await git(["update-ref", "refs/remotes/origin/main", "HEAD"], dir);
  await git(["checkout", "-q", "--detach"], dir);
  expect(await resolveBaseRefAndBranch(dir, " HEAD ")).toEqual({ sha: tip, baseBranch: null });
});

test("resolveBaseRefAndBranch: a named branch records it; a tag or sha keeps a null name; a missing ref gives nulls", async () => {
  const dir = await makeRepo();
  const tip = await git(["rev-parse", "HEAD"], dir);
  await git(["branch", "release/1.2"], dir);
  await git(["tag", "v1"], dir);
  expect(await resolveBaseRefAndBranch(dir, "release/1.2")).toEqual({ sha: tip, baseBranch: "release/1.2" });
  expect(await resolveBaseRefAndBranch(dir, "v1")).toEqual({ sha: tip, baseBranch: null });
  expect(await resolveBaseRefAndBranch(dir, tip)).toEqual({ sha: tip, baseBranch: null });
  expect(await resolveBaseRefAndBranch(dir, "does-not-exist")).toEqual({ sha: null, baseBranch: null });
});

test("resolveBaseRefAndBranch: HEAD on a branch that shares its name with a tag pins the branch, not the tag", async () => {
  const dir = await makeRepo();
  await git(["tag", "topic"], dir); // the tag stays on c1
  await git(["checkout", "-q", "-b", "topic"], dir);
  writeFileSync(path.join(dir, "f"), "2\n");
  await git(["commit", "-q", "-am", "c2"], dir);
  await git(["update-ref", "refs/remotes/origin/topic", "HEAD"], dir);
  const branchTip = await git(["rev-parse", "refs/heads/topic"], dir);
  expect(branchTip).not.toBe(await git(["rev-parse", "refs/tags/topic"], dir));
  // `symbolic-ref --short` would answer `heads/topic` here.
  expect(await git(["symbolic-ref", "--short", "HEAD"], dir)).toBe("heads/topic");
  expect(await resolveBaseRefAndBranch(dir, "HEAD")).toEqual({ sha: branchTip, baseBranch: "topic" });
  expect(await resolveBaseBranchName(dir, "HEAD")).toBe("topic");
});

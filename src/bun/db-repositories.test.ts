import { test, expect, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Task, TaskRepository } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-db-repos-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

const { db, tasks } = await import("./db.ts");

afterAll(() => {
  rmTestDataDir(DATA_DIR);
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: randomUUID(),
    title: "t",
    prompt: "p",
    agent: "claude-code",
    workdir: "/tmp/frontend",
    isolation: "worktree",
    taskType: "task",
    branch: "feature/x",
    branchSource: "created",
    worktreePath: null,
    baseRef: "abc",
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
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    ...overrides,
  };
}

const repo = (name: string, over: Partial<TaskRepository> = {}): TaskRepository => ({
  path: `/tmp/${name}`,
  name,
  branch: "feature/x",
  branchSource: "created",
  worktreePath: `/data/worktrees/t/${name}`,
  baseRef: "abc",
  checkoutBranch: "feature/x",
  prUrl: null,
  ...over,
});

test("087 applies to an 086 DB and lands last", async () => {
  const { migrations } = await import("./migrations/index.ts");
  const { migrate } = await import("./migrate.ts");
  const { Database } = await import("bun:sqlite");
  const mem = new Database(":memory:");
  migrate(mem, migrations.slice(0, migrations.findIndex((m) => m.id === "086_normalize_cursor_fable_5_2") + 1));
  expect(mem.query(`SELECT 1 FROM pragma_table_info('tasks') WHERE name = 'repositories'`).get()).toBeNull();
  expect(migrate(mem, migrations)).toEqual(["087_task_repositories"]);
  const cols = mem
    .query<{ name: string; dflt_value: string | null }, []>(`SELECT name, dflt_value FROM pragma_table_info('tasks')`)
    .all();
  expect(cols.find((c) => c.name === "repositories")?.dflt_value).toBe("'[]'");
  expect(cols.find((c) => c.name === "issue_repo_path")).toBeTruthy();
  mem.close();
});

test("a multi-repository insert round-trips paths, names, branches and PRs", () => {
  const t = makeTask({
    repositories: [repo("frontend"), repo("backend", { prUrl: "https://gh/pr/2" })],
    issueRepoPath: "/tmp/backend",
  });
  tasks.insert(t);
  const got = tasks.get(t.id)!;
  expect(got.repositories?.map((r) => r.name)).toEqual(["frontend", "backend"]);
  expect(got.repositories?.[1]?.prUrl).toBe("https://gh/pr/2");
  expect(got.issueRepoPath).toBe("/tmp/backend");
  const raw = db
    .query<{ repositories: string }, [string]>(`SELECT repositories FROM tasks WHERE id = ?`)
    .get(t.id)!;
  expect(JSON.parse(raw.repositories)).toHaveLength(2);
  tasks.delete(t.id);
});

test("a single-repository insert stores '[]' and derives exactly one entry", () => {
  const t = makeTask({ repositories: [repo("frontend")] });
  tasks.insert(t);
  const raw = db
    .query<{ repositories: string }, [string]>(`SELECT repositories FROM tasks WHERE id = ?`)
    .get(t.id)!;
  expect(raw.repositories).toBe("[]");
  const got = tasks.get(t.id)!;
  expect(got.repositories).toHaveLength(1);
  expect(got.repositories?.[0]).toMatchObject({
    path: "/tmp/frontend",
    name: "frontend",
    branch: "feature/x",
    worktreePath: null,
    baseRef: "abc",
  });
  tasks.delete(t.id);
});

test("a legacy row with no repositories column value reads as one derived entry", () => {
  const t = makeTask();
  tasks.insert(t);
  db.run(`UPDATE tasks SET repositories = '[]' WHERE id = ?`, [t.id]);
  expect(tasks.get(t.id)?.repositories).toHaveLength(1);
  tasks.delete(t.id);
});

test("malformed JSON falls back to the derived single entry instead of throwing", () => {
  const t = makeTask();
  tasks.insert(t);
  for (const junk of ["not json", "{}", "[{\"path\":\"/x\"}]", "null"]) {
    db.run(`UPDATE tasks SET repositories = ? WHERE id = ?`, [junk, t.id]);
    expect(tasks.get(t.id)?.repositories).toHaveLength(1);
  }
  tasks.delete(t.id);
});

test("the generic tasks.update never touches repositories or issue_repo_path", () => {
  const t = makeTask({ repositories: [repo("a"), repo("b")], issueRepoPath: "/tmp/b", updatedAt: 1000 });
  tasks.insert(t);
  const raw = () =>
    db
      .query<{ repositories: string; issue_repo_path: string | null; updated_at: number }, [string]>(
        `SELECT repositories, issue_repo_path, updated_at FROM tasks WHERE id = ?`,
      )
      .get(t.id)!;
  const before = raw();
  expect(before.updated_at).toBe(1000);
  // A caller carrying a (stale or hostile) repositories/issueRepoPath value
  // through the generic patch must not land it: the SET clause skips both
  // server-managed columns, so only the title changes.
  const patched = tasks.update(t.id, {
    title: "renamed",
    repositories: [repo("x", { prUrl: "https://gh/pr/evil" })],
    issueRepoPath: "/tmp/x",
  })!;
  const after = raw();
  expect(after.repositories).toBe(before.repositories);
  expect(after.issue_repo_path).toBe("/tmp/b");
  expect(patched.title).toBe("renamed");
  expect(patched.repositories?.map((r) => r.name)).toEqual(["a", "b"]);
  expect(patched.repositories?.every((r) => r.prUrl === null)).toBe(true);
  expect(patched.issueRepoPath).toBe("/tmp/b");
  // updated_at semantics: the generic update still bumps it for the title
  // edit it did apply (only the targeted writers leave it alone).
  expect(after.updated_at).toBeGreaterThan(1000);
  // A patch of ONLY the server-managed fields changes neither column.
  tasks.update(t.id, { repositories: [], issueRepoPath: null });
  expect(raw().repositories).toBe(before.repositories);
  expect(raw().issue_repo_path).toBe("/tmp/b");
  tasks.delete(t.id);
});

test("setRepositories is a targeted writer that does not bump updated_at", () => {
  const t = makeTask({ repositories: [repo("a"), repo("b")], updatedAt: 1234 });
  tasks.insert(t);
  const before = tasks.get(t.id)!.updatedAt;
  const next = tasks.setRepositories(t.id, [
    repo("a", { worktreePath: "/data/worktrees/t/a", branch: "feature/x" }),
    repo("b", { worktreePath: "/data/worktrees/t/b", branch: "feature/x-2" }),
  ])!;
  expect(next.repositories?.[1]?.branch).toBe("feature/x-2");
  expect(next.updatedAt).toBe(before);
  tasks.delete(t.id);
});

test("setRepositories merges a stale snapshot without erasing a PR stamp or recorded checkout", () => {
  // Review should-fix: the caller's array was read before `prepareTaskWorkdir`
  // awaited, so writing it wholesale erased a concurrent `setRepositoryPrUrl`
  // or `setRepositoryCheckout` write.
  const t = makeTask({
    repositories: [repo("a", { checkoutBranch: null }), repo("b", { checkoutBranch: null })],
  });
  tasks.insert(t);
  tasks.setRepositoryPrUrl(t.id, "b", "https://gh/pr/9");
  tasks.setRepositoryCheckout(t.id, "a", "feature/live");
  const next = tasks.setRepositories(t.id, [
    repo("a", { worktreePath: "/data/worktrees/t/a", checkoutBranch: "feature/x" }),
    repo("b", { worktreePath: "/data/worktrees/t/b", checkoutBranch: "feature/x", prUrl: null }),
  ])!;
  expect(next.repositories?.[0]?.checkoutBranch).toBe("feature/live");
  expect(next.repositories?.[1]?.prUrl).toBe("https://gh/pr/9");
  // Materialization-owned fields from the snapshot still land.
  expect(next.repositories?.[0]?.worktreePath).toBe("/data/worktrees/t/a");
  expect(next.repositories?.[1]?.worktreePath).toBe("/data/worktrees/t/b");
  tasks.delete(t.id);
});

test("setRepositories accepts the prepare's checkout when nothing is stored yet", () => {
  const t = makeTask({
    repositories: [repo("a", { checkoutBranch: null }), repo("b", { checkoutBranch: null })],
  });
  tasks.insert(t);
  const next = tasks.setRepositories(t.id, [
    repo("a", { worktreePath: "/data/worktrees/t/a", checkoutBranch: "agetor/abc-a" }),
    repo("b", { worktreePath: "/data/worktrees/t/b", checkoutBranch: "agetor/abc-b" }),
  ])!;
  expect(next.repositories?.map((r) => r.checkoutBranch)).toEqual(["agetor/abc-a", "agetor/abc-b"]);
  tasks.delete(t.id);
});

test("setRepositoryPrUrl is first-write-wins per entry and never touches task.prUrl", () => {
  const t = makeTask({ repositories: [repo("a"), repo("b")], prUrl: null });
  tasks.insert(t);
  const first = tasks.setRepositoryPrUrl(t.id, "b", "https://gh/pr/1")!;
  expect(first.repositories?.[1]?.prUrl).toBe("https://gh/pr/1");
  expect(first.repositories?.[0]?.prUrl).toBeNull();
  const second = tasks.setRepositoryPrUrl(t.id, "/tmp/b", "https://gh/pr/2")!;
  expect(second.repositories?.[1]?.prUrl).toBe("https://gh/pr/1");
  expect(second.prUrl).toBeNull();
  tasks.delete(t.id);
});

test("setRepositoryPrUrl is a no-op for a single-repository row", () => {
  const t = makeTask({ repositories: [] });
  tasks.insert(t);
  const got = tasks.setRepositoryPrUrl(t.id, "frontend", "https://gh/pr/1")!;
  expect(got.prUrl).toBeNull();
  expect(got.repositories).toHaveLength(1);
  tasks.delete(t.id);
});

test("setRepositoryCheckout records a live branch per entry without bumping updated_at", () => {
  const t = makeTask({ repositories: [repo("a"), repo("b")], updatedAt: 999 });
  tasks.insert(t);
  const before = tasks.get(t.id)!.updatedAt;
  const next = tasks.setRepositoryCheckout(t.id, "b", "feature/other")!;
  expect(next.repositories?.[1]?.checkoutBranch).toBe("feature/other");
  expect(next.repositories?.[0]?.checkoutBranch).toBe("feature/x");
  expect(next.updatedAt).toBe(before);
  tasks.delete(t.id);
});

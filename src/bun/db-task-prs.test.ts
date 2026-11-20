// Migration 092 (`base_branch`, `prs`), the read-time conversion of legacy
// `prUrl` data, and the append-only PR writers (docs/architecture/persistence.md).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Task, TaskPr, TaskRepository } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-db-task-prs-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

const { db, tasks } = await import("./db.ts");
const { migrations } = await import("./migrations/index.ts");
const { migrate } = await import("./migrate.ts");
const { Database } = await import("bun:sqlite");

afterAll(() => rmTestDataDir(DATA_DIR));

const pr = (n: number, head: string | null = "feature/x"): TaskPr => ({
  url: `https://github.com/o/r/pull/${n}`,
  head,
  base: "main",
  number: n,
  createdAt: n,
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
    updatedAt: 1000,
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
  prs: [],
  baseBranch: null,
  ...over,
});

const rawRow = (id: string) =>
  db
    .query<{ prs: string; base_branch: string | null; pr_url: string | null; repositories: string; updated_at: number }, [string]>(
      `SELECT prs, base_branch, pr_url, repositories, updated_at FROM tasks WHERE id = ?`,
    )
    .get(id)!;

test("migration 092 backfills prs from pr_url on a 091 database and leaves pr_url alone; a re-run is a no-op", () => {
  const mem = new Database(":memory:");
  const at = migrations.findIndex((m) => m.id === "091_task_repositories");
  migrate(mem, migrations.slice(0, at + 1));
  const insert = (id: string, prUrl: string | null, branch: string | null, checkout: string | null) =>
    mem.run(
      `INSERT INTO tasks (id, title, prompt, "column", agent, workdir, branch, pr_url, checkout_branch, created_at, updated_at)
       VALUES (?, 't', 'p', 'review', 'claude-code', '/w', ?, ?, ?, 1, 4242)`,
      [id, branch, prUrl, checkout],
    );
  insert("with-pr", "https://github.com/o/r/pull/7", "feature/a", "drifted/b");
  insert("branch-only", "https://github.com/o/r/pull/8", "feature/c", null);
  insert("no-pr", null, "feature/d", null);
  insert("empty-pr", "", "feature/e", null);

  expect(migrate(mem, migrations)).toEqual(["092_task_base_branch_and_prs", "093_task_revs"]);
  const rows = Object.fromEntries(
    mem
      .query<{ id: string; prs: string; pr_url: string | null; base_branch: string | null }, []>(
        `SELECT id, prs, pr_url, base_branch FROM tasks`,
      )
      .all()
      .map((r) => [r.id, r]),
  );
  expect(JSON.parse(rows["with-pr"]!.prs)).toEqual([
    { url: "https://github.com/o/r/pull/7", head: "drifted/b", base: null, number: null, createdAt: 4242 },
  ]);
  expect(JSON.parse(rows["branch-only"]!.prs)[0].head).toBe("feature/c");
  expect(rows["no-pr"]!.prs).toBe("[]");
  expect(rows["empty-pr"]!.prs).toBe("[]");
  expect(rows["with-pr"]!.pr_url).toBe("https://github.com/o/r/pull/7");
  expect(rows["with-pr"]!.base_branch).toBeNull();
  expect(migrate(mem, migrations)).toEqual([]);
  mem.close();
});

test("toTask derives prUrl from prs and reads baseBranch; a multi task's task-level prs stays empty", () => {
  const t = makeTask({ baseBranch: "develop", prs: [pr(1), pr(2)] });
  tasks.insert(t);
  const got = tasks.get(t.id)!;
  expect(got.prs).toEqual([pr(1), pr(2)]);
  expect(got.prUrl).toBe(pr(1).url);
  expect(got.baseBranch).toBe("develop");
  expect(got.repositories?.[0]).toMatchObject({ baseBranch: "develop", prUrl: pr(1).url });
  expect(got.repositories?.[0]?.prs).toEqual([pr(1), pr(2)]);
  // pr_url is retired: new rows leave it NULL.
  expect(rawRow(t.id).pr_url).toBeNull();
  tasks.delete(t.id);
});

test("insert converts an older-shape caller's prUrl into prs", () => {
  const t = makeTask({ prUrl: "https://github.com/o/r/pull/3" });
  tasks.insert(t);
  expect(tasks.get(t.id)!.prs).toEqual([
    { url: "https://github.com/o/r/pull/3", head: "feature/x", base: null, number: null, createdAt: 1000 },
  ]);
  tasks.delete(t.id);
});

test("a stored repositories entry written with only a legacy prUrl converts on read, and a stored prs wins", () => {
  const t = makeTask({ repositories: [repo("a"), repo("b")] });
  tasks.insert(t);
  db.run(`UPDATE tasks SET repositories = ? WHERE id = ?`, [
    JSON.stringify([
      { path: "/tmp/a", name: "a", branch: "feature/a", branchSource: "created", worktreePath: null, baseRef: null, checkoutBranch: "drifted", prUrl: "https://gh/pr/1" },
      { path: "/tmp/b", name: "b", branch: "feature/b", branchSource: "created", worktreePath: null, baseRef: null, checkoutBranch: null, prUrl: "https://gh/legacy", prs: [pr(5, "feature/b")], baseBranch: "develop" },
    ]),
    t.id,
  ]);
  const got = tasks.get(t.id)!;
  expect(got.repositories?.[0]?.prs).toEqual([{ url: "https://gh/pr/1", head: "drifted", base: null, number: null, createdAt: 0 }]);
  expect(got.repositories?.[0]?.prUrl).toBe("https://gh/pr/1");
  expect(got.repositories?.[1]?.prs).toEqual([pr(5, "feature/b")]);
  expect(got.repositories?.[1]?.baseBranch).toBe("develop");
  tasks.delete(t.id);
});

test("every repositories write persists entries without a prUrl key", () => {
  const t = makeTask({ repositories: [repo("a", { prs: [pr(1)] }), repo("b")] });
  tasks.insert(t);
  const keys = (id: string) => JSON.parse(rawRow(id).repositories).map((r: Record<string, unknown>) => Object.keys(r));
  expect(keys(t.id).every((k: string[]) => !k.includes("prUrl") && k.includes("prs"))).toBe(true);
  tasks.setRepositories(t.id, [repo("a"), repo("b")]);
  expect(keys(t.id).every((k: string[]) => !k.includes("prUrl"))).toBe(true);
  tasks.setRepositoryCheckout(t.id, "a", "feature/live");
  expect(keys(t.id).every((k: string[]) => !k.includes("prUrl"))).toBe(true);
  tasks.appendRepositoryPr(t.id, "b", pr(2));
  expect(keys(t.id).every((k: string[]) => !k.includes("prUrl"))).toBe(true);
  tasks.delete(t.id);
});

test("appendPr appends, dedupes by url, and does not bump updated_at", () => {
  const t = makeTask({});
  tasks.insert(t);
  tasks.appendPr(t.id, pr(1));
  const second = tasks.appendPr(t.id, pr(2, "feature/y"))!;
  expect(second.prs?.map((p) => p.url)).toEqual([pr(1).url, pr(2).url]);
  expect(second.prUrl).toBe(pr(1).url);
  const dup = tasks.appendPr(t.id, { ...pr(1), head: "other" })!;
  expect(dup.prs).toHaveLength(2);
  expect(rawRow(t.id).updated_at).toBe(1000);
  expect(tasks.appendPr(randomUUID(), pr(1))).toBeNull();
  tasks.delete(t.id);
});

test("appendPr is a no-op on a multi-repository task; appendRepositoryPr is a no-op on a single one", () => {
  const multi = makeTask({ repositories: [repo("a"), repo("b")] });
  tasks.insert(multi);
  const m = tasks.appendPr(multi.id, pr(1))!;
  expect(m.prs).toEqual([]);
  expect(m.repositories?.every((r) => (r.prs ?? []).length === 0)).toBe(true);
  tasks.delete(multi.id);

  const single = makeTask({});
  tasks.insert(single);
  const s = tasks.appendRepositoryPr(single.id, "frontend", pr(1))!;
  expect(s.prs).toEqual([]);
  tasks.delete(single.id);
});

test("appendRepositoryPr matches by name, path or worktree path and doesn't bump updated_at", () => {
  const t = makeTask({ repositories: [repo("a"), repo("b")] });
  tasks.insert(t);
  tasks.appendRepositoryPr(t.id, "a", pr(1));
  tasks.appendRepositoryPr(t.id, "/tmp/b", pr(2));
  const got = tasks.appendRepositoryPr(t.id, "/data/worktrees/t/a", pr(3))!;
  expect(got.repositories?.[0]?.prs?.map((p) => p.url)).toEqual([pr(1).url, pr(3).url]);
  expect(got.repositories?.[1]?.prs?.map((p) => p.url)).toEqual([pr(2).url]);
  expect(tasks.appendRepositoryPr(t.id, "nope", pr(4))!.repositories?.flatMap((r) => r.prs ?? [])).toHaveLength(3);
  expect(rawRow(t.id).updated_at).toBe(1000);
  tasks.delete(t.id);
});

test("the generic update leaves prs, base_branch and pr_url unchanged, even when the patch names all three", () => {
  const t = makeTask({ baseBranch: "develop", prs: [pr(1)] });
  tasks.insert(t);
  const before = rawRow(t.id);
  tasks.update(t.id, { title: "renamed", prs: [], baseBranch: "evil", prUrl: "https://forged" });
  const after = rawRow(t.id);
  expect(after.prs).toBe(before.prs);
  expect(after.base_branch).toBe("develop");
  expect(after.pr_url).toBeNull();
  tasks.delete(t.id);
});

test("setRepositories keeps stored prs and baseBranch over an incoming snapshot", () => {
  const t = makeTask({ repositories: [repo("a", { baseBranch: "develop" }), repo("b")] });
  tasks.insert(t);
  tasks.appendRepositoryPr(t.id, "a", pr(1));
  const next = tasks.setRepositories(t.id, [repo("a", { prs: [], baseBranch: "stale" }), repo("b")])!;
  expect(next.repositories?.[0]?.prs).toEqual([pr(1)]);
  expect(next.repositories?.[0]?.baseBranch).toBe("develop");
  tasks.delete(t.id);
});

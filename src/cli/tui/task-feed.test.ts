import { test, expect } from "bun:test";
import { createTaskFeed, TASK_FEED_FULL_RESYNC_MS } from "./task-feed.ts";
import type { Task, TaskDelta, TaskListOptions } from "../../shared/types.ts";

const t = (id: string, createdAt: number, title = id): Task =>
  ({ id, createdAt, title, column: "backlog" }) as unknown as Task;

const delta = (over: Partial<TaskDelta>): TaskDelta => ({
  format: "delta",
  cursor: "c1",
  snapshot: false,
  tasks: [],
  removedIds: [],
  decorations: {},
  ...over,
});

type Call = { filter: TaskListOptions; since: string | null };

function harness(responses: Array<TaskDelta | Task[] | Error | (() => Promise<TaskDelta | Task[]>)>) {
  const calls: Call[] = [];
  const changes: Task[][] = [];
  let i = 0;
  const feed = createTaskFeed({
    filter: { archived: "exclude" },
    fetch: async (filter, since) => {
      calls.push({ filter, since });
      const r = responses[Math.min(i++, responses.length - 1)]!;
      if (r instanceof Error) throw r;
      return typeof r === "function" ? r() : r;
    },
    onChange: (x) => changes.push(x),
  });
  return { feed, calls, changes };
}

test("snapshot first (no cursor), then deltas send since=<cursor> and merge", async () => {
  const { feed, calls, changes } = harness([
    delta({ snapshot: true, cursor: "c1", tasks: [t("a", 2), t("b", 1)] }),
    delta({ cursor: "c2", tasks: [t("c", 3), t("b", 1, "renamed")], removedIds: ["a"] }),
  ]);
  await feed.poll();
  await feed.poll();
  expect(calls.map((c) => c.since)).toEqual([null, "c1"]);
  expect(changes[0]!.map((x) => x.id)).toEqual(["a", "b"]);
  expect(feed.current().map((x) => `${x.id}:${x.title}`)).toEqual(["c:c", "b:renamed"]);
});

test("an unchanged delta keeps the array and row identity (no onChange)", async () => {
  const { feed, changes } = harness([
    delta({ snapshot: true, cursor: "c1", tasks: [t("a", 2), t("b", 1)] }),
    delta({ cursor: "c2", tasks: [t("a", 2)] }), // deep-equal to the held row
  ]);
  await feed.poll();
  const first = feed.current();
  const rowB = first[1];
  await feed.poll();
  expect(feed.current()).toBe(first);
  expect(feed.current()[1]).toBe(rowB);
  expect(changes).toHaveLength(1);
});

test("a changed row replaces only itself; the others keep identity", async () => {
  const { feed } = harness([
    delta({ snapshot: true, cursor: "c1", tasks: [t("a", 2), t("b", 1)] }),
    delta({ cursor: "c2", tasks: [t("a", 2, "new")] }),
  ]);
  await feed.poll();
  const [, b0] = feed.current();
  await feed.poll();
  expect(feed.current()[0]!.title).toBe("new");
  expect(feed.current()[1]).toBe(b0!);
});

test("setFilter drops the cursor: the next fetch has no since and uses the new filter", async () => {
  const { feed, calls } = harness([
    delta({ snapshot: true, cursor: "c1", tasks: [t("a", 1)] }),
    delta({ snapshot: true, cursor: "z1", tasks: [] }),
  ]);
  await feed.poll();
  feed.setFilter({ archived: "only" });
  await feed.poll();
  expect(calls[1]).toEqual({ filter: { archived: "only" }, since: null });
  expect(feed.current()).toEqual([]);
});

test("a legacy bare array is a full list, no cursor is kept, identity survives", async () => {
  const { feed, calls } = harness([[t("a", 2), t("b", 1)], [t("a", 2), t("b", 1)]]);
  await feed.poll();
  const first = feed.current();
  await feed.poll();
  expect(calls.map((c) => c.since)).toEqual([null, null]);
  expect(feed.current()).toBe(first);
});

test("never overlaps: a poll during a fetch is skipped, a push re-runs once after", async () => {
  let active = 0;
  let maxActive = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let n = 0;
  const feed = createTaskFeed({
    filter: { archived: "exclude" },
    fetch: async () => {
      n++;
      active++;
      maxActive = Math.max(maxActive, active);
      if (n === 1) await gate;
      active--;
      return delta({ snapshot: true, cursor: `c${n}`, tasks: [t("a", 1)] });
    },
    onChange: () => {},
  });
  const first = feed.poll();
  void feed.poll(); // skipped
  void feed.notify("pushed"); // queued: exactly one more fetch
  void feed.notify("pushed2");
  release();
  await first;
  expect(maxActive).toBe(1);
  expect(n).toBe(2);
});

test("tasks-changed with the held cursor does not fetch; a new one does", async () => {
  const { feed, calls } = harness([
    delta({ snapshot: true, cursor: "c1", tasks: [t("a", 1)] }),
    delta({ cursor: "c2", tasks: [t("a", 1, "x")] }),
  ]);
  await feed.poll();
  await feed.notify("c1");
  expect(calls).toHaveLength(1);
  await feed.notify("c2");
  expect(calls).toHaveLength(2);
  expect(calls[1]!.since).toBe("c1");
});

test("a fetch for the old filter that lands after setFilter is discarded", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let n = 0;
  const seen: Array<string | undefined> = [];
  const emitted: string[] = [];
  const feed = createTaskFeed({
    filter: { archived: "exclude" },
    fetch: async (filter) => {
      n++;
      seen.push(filter.archived);
      if (n === 1) await gate;
      return delta({ snapshot: true, cursor: `c${n}`, tasks: [t(`from-${filter.archived}`, 1)] });
    },
    onChange: (x) => emitted.push(...x.map((r) => r.id)),
  });
  const p = feed.poll();
  feed.setFilter({ archived: "only" });
  release();
  await p;
  expect(seen).toEqual(["exclude", "only"]);
  expect(feed.current().map((x) => x.id)).toEqual(["from-only"]);
  expect(emitted).toEqual(["from-only"]); // the stale answer was never shown
});

test("a failed fetch keeps the last list and cursor", async () => {
  const { feed, calls } = harness([
    delta({ snapshot: true, cursor: "c1", tasks: [t("a", 1)] }),
    new Error("boom"),
    delta({ cursor: "c2", tasks: [] }),
  ]);
  await feed.poll();
  await feed.poll();
  await feed.poll();
  expect(calls.map((c) => c.since)).toEqual([null, "c1", "c1"]);
  expect(feed.current().map((x) => x.id)).toEqual(["a"]);
});

test("a held cursor is dropped for a full snapshot after the resync interval", async () => {
  let clock = 0;
  const calls: Array<string | null> = [];
  const feed = createTaskFeed({
    filter: { archived: "exclude" },
    now: () => clock,
    fetch: async (_f, since) => {
      calls.push(since);
      return delta({ snapshot: since === null, cursor: "c" + calls.length, tasks: since === null ? [t("a", 1)] : [] });
    },
    onChange: () => {},
  });
  await feed.poll();
  clock = TASK_FEED_FULL_RESYNC_MS - 1;
  await feed.poll();
  clock = TASK_FEED_FULL_RESYNC_MS + 1;
  await feed.poll(); // resync: no cursor
  await feed.poll(); // clock restarted at the snapshot
  expect(calls).toEqual([null, "c1", null, "c3"]);
});

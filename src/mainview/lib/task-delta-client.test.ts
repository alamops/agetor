import { expect, test } from "bun:test";
import type { Task, TaskDelta, TaskListOptions } from "../../shared/types.ts";
import {
  TASK_POLL_CONNECTED_MS,
  TASK_POLL_DISCONNECTED_MS,
  createTaskDeltaClient,
  taskFilterKey,
  type TaskDeltaApplied,
} from "./task-delta-client.ts";

// Plain controller tests with a scripted fetch and an injected clock (house
// convention: no React/jsdom).

function task(id: string, createdAt: number, extra: Partial<Task> = {}): Task {
  return { id, title: `t-${id}`, createdAt, archivedAt: null, ...extra } as unknown as Task;
}

function delta(over: Partial<TaskDelta> & { cursor: string }): TaskDelta {
  return { format: "delta", snapshot: false, tasks: [], removedIds: [], decorations: {}, ...over };
}

interface Call { opts: TaskListOptions; since: string | null; resolve(v: TaskDelta | Task[]): void; reject(e: unknown): void }

function harness(initialOpts: TaskListOptions = { archived: "exclude" }) {
  const calls: Call[] = [];
  const commits: Task[][] = [];
  const applied: TaskDeltaApplied[] = [];
  let opts = initialOpts;
  let clock = 1_000_000;
  const client = createTaskDeltaClient({
    fetch: (o, since) => new Promise((resolve, reject) => { calls.push({ opts: o, since, resolve, reject }); }),
    getOpts: () => opts,
    commit: (l) => commits.push(l),
    onApplied: (a) => applied.push(a),
    cache: new Map(),
    now: () => clock,
  });
  return {
    client, calls, commits, applied,
    setOpts: (o: TaskListOptions) => { opts = o; },
    advance: (ms: number) => { clock += ms; },
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test("a snapshot then a delta: the cursor is held and sent back", async () => {
  const h = harness();
  const p1 = h.client.refresh();
  expect(h.calls[0]!.since).toBeNull();
  h.calls[0]!.resolve(delta({ cursor: "c1", snapshot: true, tasks: [task("a", 20), task("b", 10)] }));
  expect((await p1)!.map((t) => t.id)).toEqual(["a", "b"]);
  expect(h.client.cursor).toBe("c1");

  const p2 = h.client.refresh();
  expect(h.calls[1]!.since).toBe("c1");
  h.calls[1]!.resolve(delta({ cursor: "c2", tasks: [task("c", 30), task("b", 10, { title: "renamed" })], removedIds: ["a"] }));
  expect((await p2)!.map((t) => t.id)).toEqual(["c", "b"]);
  expect(h.client.list.find((t) => t.id === "b")!.title).toBe("renamed");
  expect(h.client.cursor).toBe("c2");
});

test("unchanged tasks keep their object identity across deltas", async () => {
  const h = harness();
  const p1 = h.client.refresh();
  h.calls[0]!.resolve(delta({ cursor: "c1", snapshot: true, tasks: [task("a", 20), task("b", 10)] }));
  const first = (await p1)!;
  const p2 = h.client.refresh();
  h.calls[1]!.resolve(delta({ cursor: "c2", tasks: [task("b", 10, { title: "x" })] }));
  const second = (await p2)!;
  expect(second[0]).toBe(first[0]);
  expect(second[1]).not.toBe(first[1]);

  // A delta that changes nothing returns the very same array.
  const p3 = h.client.refresh();
  h.calls[2]!.resolve(delta({ cursor: "c3", tasks: [task("a", 20)] }));
  expect(await p3).toBe(second);
});

test("the cursor is dropped when the filter changes, and a stale answer is re-fetched", async () => {
  const h = harness({ archived: "exclude", keep: [] });
  const p1 = h.client.refresh();
  h.calls[0]!.resolve(delta({ cursor: "c1", snapshot: true, tasks: [task("a", 20)] }));
  await p1;

  h.setOpts({ archived: "exclude", keep: ["a"] });
  const p2 = h.client.refresh();
  expect(h.calls[1]!.since).toBeNull(); // new keep set: no cursor sent
  // The filter changes again while that is in flight: its answer is discarded.
  h.setOpts({ archived: "include" });
  h.calls[1]!.resolve(delta({ cursor: "stale", snapshot: true, tasks: [task("a", 20)] }));
  await tick();
  expect(h.calls.length).toBe(3);
  expect(h.calls[2]!.since).toBeNull();
  expect(h.calls[2]!.opts.archived).toBe("include");
  h.calls[2]!.resolve(delta({ cursor: "c3", snapshot: true, tasks: [task("a", 20), task("z", 5, { archivedAt: 9 })] }));
  await p2;
  expect(h.client.cursor).toBe("c3");
  expect(h.commits.length).toBe(2); // the stale answer was never committed
  expect(taskFilterKey({ archived: "exclude", keep: ["b", "a", "a"] })).toBe(taskFilterKey({ archived: "exclude", keep: ["a", "b"] }));
});

test("an older core's bare array is merged as a full list with no cursor", async () => {
  const h = harness();
  const p1 = h.client.refresh();
  h.calls[0]!.resolve([task("a", 20), task("b", 10)]);
  const first = (await p1)!;
  expect(first.map((t) => t.id)).toEqual(["a", "b"]);
  expect(h.client.cursor).toBeNull();
  const p2 = h.client.refresh();
  expect(h.calls[1]!.since).toBeNull();
  h.calls[1]!.resolve([task("a", 20), task("b", 10)]);
  expect(await p2).toBe(first); // identity preserved
});

test("pushes during a fetch coalesce into exactly one follow-up", async () => {
  const h = harness();
  const p1 = h.client.refresh();
  for (let i = 0; i < 5; i++) h.client.notify(`push-${i}`);
  const p2 = h.client.refresh();
  expect(h.calls.length).toBe(1); // nothing parallel
  h.calls[0]!.resolve(delta({ cursor: "c1", snapshot: true, tasks: [task("a", 20)] }));
  await p1;
  await tick();
  expect(h.calls.length).toBe(2);
  expect(h.calls[1]!.since).toBe("c1");
  h.calls[1]!.resolve(delta({ cursor: "c2" }));
  await p2;
  await tick();
  expect(h.calls.length).toBe(2); // and no third
});

test("a push whose cursor equals the held one fetches nothing", async () => {
  const h = harness();
  const p1 = h.client.refresh();
  h.calls[0]!.resolve(delta({ cursor: "c1", snapshot: true, tasks: [task("a", 20)] }));
  await p1;
  h.client.notify("c1");
  await tick();
  expect(h.calls.length).toBe(1);
  h.client.notify("c2");
  await tick();
  expect(h.calls.length).toBe(2);
});

test("a removed task is reported as vanished; an archived row is reported archived", async () => {
  const h = harness();
  const p1 = h.client.refresh();
  h.calls[0]!.resolve(delta({ cursor: "c1", snapshot: true, tasks: [task("a", 20), task("b", 10)] }));
  await p1;
  expect(h.applied[0]!.vanishedIds).toEqual([]); // first fetch never sweeps

  const p2 = h.client.refresh();
  h.calls[1]!.resolve(delta({ cursor: "c2", removedIds: ["a"], tasks: [task("b", 10, { archivedAt: 5 })] }));
  await p2;
  expect(h.applied[1]!.vanishedIds).toEqual(["a"]);
  expect(h.applied[1]!.archivedIds).toEqual(["b"]);
  expect([...h.applied[1]!.ids]).toEqual(["b"]);
  expect(h.client.list.map((t) => t.id)).toEqual(["b"]);
});

test("a failed fetch keeps the list and the cursor, and returns null", async () => {
  const h = harness();
  const p1 = h.client.refresh();
  h.calls[0]!.resolve(delta({ cursor: "c1", snapshot: true, tasks: [task("a", 20)] }));
  await p1;
  const p2 = h.client.refresh();
  h.calls[1]!.reject(new Error("boom"));
  expect(await p2).toBeNull();
  expect(h.client.cursor).toBe("c1");
  expect(h.commits.length).toBe(1);
});

test("the safety poll runs every 15 s while connected and every 2 s while not", async () => {
  const h = harness();
  const p1 = h.client.refresh();
  h.calls[0]!.resolve(delta({ cursor: "c1", snapshot: true, tasks: [task("a", 20)] }));
  await p1;

  async function ticksUntilFetch(): Promise<number> {
    const before = h.calls.length;
    let ticks = 0;
    while (h.calls.length === before && ticks < 20) {
      h.advance(2_000);
      ticks += 1;
      h.client.poll();
    }
    const c = h.calls[h.calls.length - 1]!;
    c.resolve(delta({ cursor: `c${h.calls.length}` }));
    await tick();
    return ticks;
  }

  h.client.setConnected(true);
  expect((await ticksUntilFetch()) * 2_000).toBe(TASK_POLL_CONNECTED_MS + 1_000); // 8 ticks = 16 s
  h.client.setConnected(false);
  expect((await ticksUntilFetch()) * 2_000).toBe(TASK_POLL_DISCONNECTED_MS);

  // A tick while a fetch is in flight is skipped.
  h.advance(60_000);
  h.client.poll();
  h.client.poll();
  expect(h.calls.length).toBe(4);
});

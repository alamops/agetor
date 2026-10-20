import { describe, expect, test } from "bun:test";
import { createTaskNotifier, type TaskNotification } from "./task-notifier.ts";

/** A fake helper: every spawn is recorded and stays running until the test
 *  settles it, so ordering and concurrency are observable. */
function makeHarness(opts: { bin?: string | null; listOutput?: string; listCode?: number } = {}) {
  const spawns: Array<{ argv: string[]; settle: (code: number) => void; reject: (err: unknown) => void }> = [];
  const plains: TaskNotification[] = [];
  const logs: string[] = [];
  const autoSettle = new Map<string, number>();

  const notifier = createTaskNotifier({
    plain: (n) => plains.push(n),
    resolveBin: () => (opts.bin === undefined ? "/fake/notifier" : opts.bin),
    log: (msg) => logs.push(msg),
    spawn: (argv) => {
      if (argv[1] === "--list") {
        const text = opts.listOutput ?? "";
        return {
          exited: Promise.resolve(opts.listCode ?? 0),
          stdout: new Response(text).body,
        };
      }
      let settle!: (code: number) => void;
      let reject!: (err: unknown) => void;
      const exited = new Promise<number>((res, rej) => {
        settle = res;
        reject = rej;
      });
      spawns.push({ argv, settle, reject });
      const auto = autoSettle.get(argv[1]!);
      if (auto !== undefined) settle(auto);
      return { exited };
    },
  });
  return { notifier, spawns, plains, logs, autoSettle };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

describe("posting", () => {
  test("a task post spawns the helper with the fixed id, url, kind, urgency and sound-over", async () => {
    const h = makeHarness();
    h.notifier.post({ title: "T", body: "B", taskId: "t1", kind: "waiting" });
    await tick();
    expect(h.spawns).toHaveLength(1);
    const argv = h.spawns[0]!.argv;
    expect(argv[0]).toBe("/fake/notifier");
    expect(flag(argv, "--id")).toBe("agetor.task.t1");
    expect(flag(argv, "--url")).toBe("agetor://task/t1");
    expect(flag(argv, "--kind")).toBe("waiting");
    expect(flag(argv, "--urgency")).toBe("needs-you");
    expect(argv.filter((a) => a === "--sound-over")).toHaveLength(2);
    h.spawns[0]!.settle(0);
    await h.notifier.whenIdle();
    expect(h.plains).toEqual([]);
  });

  test("a quiet kind passes no sound-over", async () => {
    const h = makeHarness();
    h.notifier.post({ title: "T", taskId: "t1", kind: "succeeded" });
    await tick();
    expect(flag(h.spawns[0]!.argv, "--urgency")).toBe("quiet");
    expect(h.spawns[0]!.argv).not.toContain("--sound-over");
    h.spawns[0]!.settle(0);
  });

  test("posts for one task run one at a time, in order (D15)", async () => {
    const h = makeHarness();
    h.notifier.post({ title: "first", taskId: "t1" });
    h.notifier.post({ title: "second", taskId: "t1" });
    await tick();
    expect(h.spawns.map((s) => flag(s.argv, "--title"))).toEqual(["first"]);
    h.spawns[0]!.settle(0);
    await tick();
    expect(h.spawns.map((s) => flag(s.argv, "--title"))).toEqual(["first", "second"]);
    h.spawns[1]!.settle(0);
    await h.notifier.whenIdle();
  });

  test("different tasks run concurrently", async () => {
    const h = makeHarness();
    h.notifier.post({ title: "a", taskId: "t1" });
    h.notifier.post({ title: "b", taskId: "t2" });
    await tick();
    expect(h.spawns).toHaveLength(2);
    h.spawns.forEach((s) => s.settle(0));
    await h.notifier.whenIdle();
  });
});

describe("fallbacks", () => {
  test("no taskId → plain immediately, no spawn", () => {
    const h = makeHarness();
    h.notifier.post({ title: "T" });
    expect(h.plains).toHaveLength(1);
    expect(h.spawns).toHaveLength(0);
  });

  test("no helper → plain immediately", () => {
    const h = makeHarness({ bin: null });
    h.notifier.post({ title: "T", taskId: "t1" });
    expect(h.plains).toHaveLength(1);
    expect(h.spawns).toHaveLength(0);
  });

  test("exit 2 (permission denied) → no plain fallback", async () => {
    const h = makeHarness();
    h.notifier.post({ title: "T", taskId: "t1" });
    await tick();
    h.spawns[0]!.settle(2);
    await h.notifier.whenIdle();
    expect(h.plains).toEqual([]);
    expect(h.logs.some((l) => l.includes("permission"))).toBe(true);
  });

  test("exit 1 → plain once", async () => {
    const h = makeHarness();
    h.notifier.post({ title: "T", taskId: "t1" });
    await tick();
    h.spawns[0]!.settle(1);
    await h.notifier.whenIdle();
    expect(h.plains.map((p) => p.title)).toEqual(["T"]);
  });

  test("a rejected exit → plain once", async () => {
    const h = makeHarness();
    h.notifier.post({ title: "T", taskId: "t1" });
    await tick();
    h.spawns[0]!.reject(new Error("boom"));
    await h.notifier.whenIdle();
    expect(h.plains).toHaveLength(1);
  });

  test("a synchronous spawn throw → plain once, and the queue keeps going", async () => {
    const plains: TaskNotification[] = [];
    let calls = 0;
    const notifier = createTaskNotifier({
      plain: (n) => plains.push(n),
      resolveBin: () => "/fake/notifier",
      log: () => {},
      spawn: () => {
        calls++;
        if (calls === 1) throw new Error("ENOENT");
        return { exited: Promise.resolve(0) };
      },
    });
    notifier.post({ title: "a", taskId: "t1" });
    notifier.post({ title: "b", taskId: "t1" });
    await notifier.whenIdle();
    expect(plains.map((p) => p.title)).toEqual(["a"]);
    expect(calls).toBe(2);
  });

  test("a throwing plain fallback is contained", async () => {
    const notifier = createTaskNotifier({
      plain: () => {
        throw new Error("ffi");
      },
      resolveBin: () => null,
      log: () => {},
    });
    expect(() => notifier.post({ title: "T", taskId: "t1" })).not.toThrow();
  });
});

describe("removal", () => {
  test("remove argv targets the task's id and url, with --if-kind when conditional", async () => {
    const h = makeHarness();
    h.autoSettle.set("--remove", 0);
    h.notifier.remove({ taskId: "t1", ifKinds: ["waiting"] });
    await h.notifier.whenIdle();
    expect(h.spawns[0]!.argv).toEqual([
      "/fake/notifier",
      "--remove", "--id", "agetor.task.t1", "--url", "agetor://task/t1",
      "--if-kind", "waiting",
    ]);
  });

  test("no helper → remove is a no-op", async () => {
    const h = makeHarness({ bin: null });
    h.notifier.remove({ taskId: "t1" });
    await h.notifier.whenIdle();
    expect(h.spawns).toHaveLength(0);
  });

  test("an unconditional remove drops queued, not-yet-started posts", async () => {
    const h = makeHarness();
    h.notifier.post({ title: "running", taskId: "t1" });
    h.notifier.post({ title: "queued", taskId: "t1" });
    h.notifier.remove({ taskId: "t1" });
    await tick();
    h.spawns[0]!.settle(0);
    await tick();
    expect(h.spawns).toHaveLength(2);
    expect(h.spawns[1]!.argv).toContain("--remove");
    h.spawns[1]!.settle(0);
    await h.notifier.whenIdle();
    expect(h.spawns.some((s) => flag(s.argv, "--title") === "queued")).toBe(false);
  });

  test("a conditional remove keeps queued posts", async () => {
    const h = makeHarness();
    h.notifier.post({ title: "running", taskId: "t1" });
    h.notifier.post({ title: "queued", taskId: "t1" });
    h.notifier.remove({ taskId: "t1", ifKinds: ["waiting"] });
    await tick();
    h.spawns[0]!.settle(0);
    await tick();
    h.spawns[1]!.settle(0);
    await tick();
    expect(h.spawns.map((s) => flag(s.argv, "--title") ?? "remove")).toEqual(["running", "queued", "remove"]);
    h.spawns[2]!.settle(0);
    await h.notifier.whenIdle();
  });
});

describe("may-be-delivered set", () => {
  test("an unseeded remove always spawns", async () => {
    const h = makeHarness();
    h.autoSettle.set("--remove", 0);
    h.notifier.remove({ taskId: "never-posted" });
    await h.notifier.whenIdle();
    expect(h.spawns).toHaveLength(1);
  });

  test("seeded: a remove for a task with nothing delivered is skipped", async () => {
    const h = makeHarness({ listOutput: "agetor://task/known\n" });
    await h.notifier.seed();
    h.notifier.remove({ taskId: "unknown" });
    await h.notifier.whenIdle();
    expect(h.spawns).toHaveLength(0);
  });

  test("seeded: a task listed by --list is removed", async () => {
    const h = makeHarness({ listOutput: "agetor://task/known\n" });
    h.autoSettle.set("--remove", 0);
    await h.notifier.seed();
    h.notifier.remove({ taskId: "known" });
    await h.notifier.whenIdle();
    expect(h.spawns).toHaveLength(1);
  });

  test("a post adds the task; an exit-0 unconditional remove takes it out", async () => {
    const h = makeHarness();
    h.autoSettle.set("--title", 0);
    h.autoSettle.set("--remove", 0);
    await h.notifier.seed();
    h.notifier.post({ title: "T", taskId: "t1" });
    await h.notifier.whenIdle();
    h.notifier.remove({ taskId: "t1" });
    await h.notifier.whenIdle();
    expect(h.spawns).toHaveLength(2);
    h.notifier.remove({ taskId: "t1" });
    await h.notifier.whenIdle();
    expect(h.spawns).toHaveLength(2);
  });

  test("a conditional remove keeps the task in the set", async () => {
    const h = makeHarness();
    h.autoSettle.set("--title", 0);
    h.autoSettle.set("--remove", 0);
    await h.notifier.seed();
    h.notifier.post({ title: "T", taskId: "t1", kind: "succeeded" });
    await h.notifier.whenIdle();
    h.notifier.remove({ taskId: "t1", ifKinds: ["waiting"] });
    await h.notifier.whenIdle();
    h.notifier.remove({ taskId: "t1" });
    await h.notifier.whenIdle();
    expect(h.spawns).toHaveLength(3);
  });

  test("a failed unconditional remove keeps the task in the set", async () => {
    const h = makeHarness();
    h.autoSettle.set("--title", 0);
    h.autoSettle.set("--remove", 1);
    await h.notifier.seed();
    h.notifier.post({ title: "T", taskId: "t1" });
    await h.notifier.whenIdle();
    h.notifier.remove({ taskId: "t1" });
    await h.notifier.whenIdle();
    h.notifier.remove({ taskId: "t1" });
    await h.notifier.whenIdle();
    expect(h.spawns).toHaveLength(3);
  });

  test("a post enqueued behind a remove stays tracked after the remove exits 0", async () => {
    const h = makeHarness();
    await h.notifier.seed();
    h.autoSettle.set("--title", 0);
    h.notifier.post({ title: "T", taskId: "t1" });
    await h.notifier.whenIdle();
    h.autoSettle.delete("--remove");
    h.notifier.remove({ taskId: "t1" });
    await tick();
    h.notifier.post({ title: "newer", taskId: "t1" });
    h.spawns[1]!.settle(0); // the remove
    await h.notifier.whenIdle();
    h.autoSettle.set("--remove", 0);
    h.notifier.remove({ taskId: "t1" });
    await h.notifier.whenIdle();
    expect(h.spawns.map((s) => flag(s.argv, "--title") ?? "remove")).toEqual(["T", "remove", "newer", "remove"]);
  });

  test("seed parses url lines and ignores junk", async () => {
    const h = makeHarness({
      listOutput: "agetor://task/a\nnot a url\nagetor://task/b%2Fc\nhttps://example.invalid/x\n\n",
    });
    h.autoSettle.set("--remove", 0);
    await h.notifier.seed();
    for (const id of ["a", "b/c", "x", "junk"]) h.notifier.remove({ taskId: id });
    await h.notifier.whenIdle();
    expect(h.spawns.map((s) => flag(s.argv, "--id"))).toEqual(["agetor.task.a", "agetor.task.b/c"]);
  });

  test("a failed seed stays unseeded, so removals are never skipped", async () => {
    const h = makeHarness({ listCode: 1, listOutput: "agetor://task/a\n" });
    h.autoSettle.set("--remove", 0);
    await h.notifier.seed();
    h.notifier.remove({ taskId: "other" });
    await h.notifier.whenIdle();
    expect(h.spawns).toHaveLength(1);
  });

  test("seed() is idempotent", async () => {
    let lists = 0;
    const notifier = createTaskNotifier({
      plain: () => {},
      resolveBin: () => "/fake/notifier",
      log: () => {},
      spawn: (argv) => {
        if (argv[1] === "--list") lists++;
        return { exited: Promise.resolve(0), stdout: new Response("").body };
      },
    });
    await Promise.all([notifier.seed(), notifier.seed()]);
    await notifier.seed();
    expect(lists).toBe(1);
  });
});

test("the module never imports electrobun", async () => {
  const src = await Bun.file(new URL("./task-notifier.ts", import.meta.url)).text();
  expect(src).not.toMatch(/from\s+["']electrobun/);
});

import { describe, expect, test } from "bun:test";
import { HARNESS_QUOTA_STALE_MS } from "../../shared/harness-limits.ts";
import type {
  AgentKind,
  AgentStatus,
  Harness,
  HarnessLimitState,
  HarnessQuota,
  HarnessStack,
  Task,
} from "../../shared/types.ts";
import { accountState, buildHarnessBarModel, type HarnessBarInput } from "./harness-bar.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

function harness(id: string, o: Partial<Harness> = {}): Harness {
  return { id, kind: "claude-code", label: id, isBuiltin: false, home: null, bin: null, env: {}, enabled: true, ...o };
}
function status(id: string, o: Partial<AgentStatus> = {}): AgentStatus {
  return {
    harnessId: id,
    kind: "claude-code",
    bin: "claude",
    available: true,
    path: "/bin/claude",
    version: "1.0.0",
    reason: null,
    installHint: null,
    account: null,
    usage: null,
    loggedIn: null,
    authHelp: null,
    ...o,
  } as AgentStatus;
}
function quota(id: string, o: Partial<HarnessQuota> & { five?: number; weekly?: number; reset?: number | null } = {}): HarnessQuota {
  const meters = [];
  if (o.five !== undefined) meters.push({ id: "five_hour", label: "Session (5h)", usedPercent: o.five, resetsAtMs: o.reset ?? null });
  if (o.weekly !== undefined) meters.push({ id: "seven_day", label: "Weekly", usedPercent: o.weekly, resetsAtMs: o.reset ?? null });
  return {
    harnessId: id,
    kind: "claude-code" as AgentKind,
    planType: null,
    status: "ok",
    source: "api",
    fetchedAtMs: NOW - MIN,
    meters,
    reason: null,
    ...(o.meters ? { meters: o.meters } : {}),
    ...(o.status ? { status: o.status } : {}),
    ...(o.fetchedAtMs !== undefined ? { fetchedAtMs: o.fetchedAtMs } : {}),
  };
}
function stack(id: string, ids: string[], kind: "claude-code" | "codex" = "claude-code"): HarnessStack {
  return {
    id,
    label: `${id} label`,
    kind,
    mirrorMode: "safe",
    members: ids.map((h, i) => ({ harnessId: h, position: i, label: h, kind, enabled: true })),
    createdAt: 0,
    updatedAt: 0,
    warnings: [],
  };
}
function limit(harnessId: string, until: number, model: string | null = null): HarnessLimitState {
  return { harnessId, reason: "quota", source: "claude-pane", message: null, exhaustedUntilMs: until, updatedAt: 0, model };
}
function task(id: string, o: Record<string, unknown> = {}): Task {
  return { id, title: `title ${id}`, column: "ready", agent: "acct-a", archivedAt: null, ...o } as unknown as Task;
}
function input(o: Partial<HarnessBarInput> & { ids?: string[] }): HarnessBarInput {
  const ids = o.ids ?? [];
  return {
    agents: o.agents ?? ids.map((id) => status(id)),
    harnesses: o.harnesses ?? ids.map((id) => harness(id)),
    stacks: o.stacks ?? [],
    limitStates: o.limitStates ?? [],
    usage: o.usage ?? {},
    tasks: o.tasks ?? [],
  };
}

describe("accountState (D-P6 precedence)", () => {
  const h = harness("acct-a");
  const state = (s: AgentStatus | undefined, l: HarnessLimitState[] = [], q?: HarnessQuota) =>
    accountState(h, s, l, q, [], NOW);

  test("a missing status row is unavailable / Status unknown", () => {
    const a = state(undefined);
    expect(a.state).toBe("unavailable");
    expect(a.statusText).toBe("Status unknown");
    expect(a.tone).toBe("danger");
  });

  test("not available beats logged-out, cooling and out-of-quota", () => {
    const a = state(status("acct-a", { available: false, loggedIn: false, reason: "not found" }), [limit("acct-a", NOW + HOUR)], quota("acct-a", { five: 100, reset: NOW + HOUR }));
    expect(a.state).toBe("unavailable");
    expect(a.detail).toBe("not found");
  });

  test("logged out beats cooling", () => {
    const a = state(status("acct-a", { loggedIn: false, authHelp: "run claude login" }), [limit("acct-a", NOW + HOUR)]);
    expect(a.state).toBe("logged-out");
    expect(a.tone).toBe("warning");
    expect(a.detail).toBe("run claude login");
  });

  test("an account-wide cooldown beats an exhausted quota and carries the end", () => {
    const a = state(status("acct-a"), [limit("acct-a", NOW + HOUR)], quota("acct-a", { five: 100, reset: NOW + 2 * HOUR }));
    expect(a.state).toBe("cooling");
    expect(a.blockedUntil).toBe(NOW + HOUR);
    expect(a.statusText).toMatch(/^Cooling until /);
  });

  test("a per-model cooldown alone leaves the account ready, with one chip", () => {
    const a = state(status("acct-a"), [limit("acct-a", NOW + HOUR, "sonnet-4.6")]);
    expect(a.state).toBe("ready");
    expect(a.cooldowns).toHaveLength(1);
    expect(a.blockedUntil).toBeNull();
  });

  test("an expired cooldown is not cooling", () => {
    expect(state(status("acct-a"), [limit("acct-a", NOW - 1)]).state).toBe("ready");
  });

  test("a full blocking window with a future reset is out of quota until that reset", () => {
    const a = state(status("acct-a"), [], quota("acct-a", { five: 100, reset: NOW + HOUR }));
    expect(a.state).toBe("out-of-quota");
    expect(a.blockedUntil).toBe(NOW + HOUR);
    expect(a.statusText).toMatch(/^Out of quota until /);
  });

  test("out of quota with no known reset says so without a time", () => {
    const a = state(status("acct-a"), [], quota("acct-a", { five: 100, reset: null }));
    expect(a.state).toBe("out-of-quota");
    expect(a.statusText).toBe("Out of quota");
    expect(a.blockedUntil).toBeNull();
  });

  test("a reset in the past is not blocked", () => {
    expect(state(status("acct-a"), [], quota("acct-a", { five: 100, reset: NOW - 1 })).state).toBe("ready");
  });

  test("a stale snapshot dims but never blocks, and still reports its percent", () => {
    const q = quota("acct-a", { five: 100, reset: NOW + HOUR, fetchedAtMs: NOW - HARNESS_QUOTA_STALE_MS - 1 });
    const a = state(status("acct-a"), [], q);
    expect(a.state).toBe("ready");
    expect(a.stale).toBe(true);
    expect(a.usedPercent).toBe(100);
  });

  test("a credits meter with headroom keeps a full window from blocking (the shared rule)", () => {
    const q = quota("acct-a", {
      meters: [
        { id: "five_hour", label: "Session", usedPercent: 100, resetsAtMs: NOW + HOUR },
        { id: "extra_usage", label: "Extra", usedPercent: 10, resetsAtMs: null },
      ],
    });
    expect(state(status("acct-a"), [], q).state).toBe("ready");
  });

  test("usedPercent is the worst blocking meter and is null without one or when not ok", () => {
    expect(state(status("acct-a"), [], quota("acct-a", { five: 20, weekly: 60 })).usedPercent).toBe(60);
    expect(state(status("acct-a"), [], quota("acct-a", {})).usedPercent).toBeNull();
    expect(state(status("acct-a"), [], quota("acct-a", { five: 20, status: "error" })).usedPercent).toBeNull();
    expect(state(status("acct-a")).usedPercent).toBeNull();
    expect(state(status("acct-a")).stale).toBe(false);
  });

  test("a disabled harness is disabled and muted", () => {
    const a = accountState(harness("acct-a", { enabled: false }), status("acct-a"), [], undefined, [], NOW);
    expect(a.state).toBe("disabled");
    expect(a.tone).toBe("muted");
  });

  test("runningTasks counts only non-archived running tasks on the account", () => {
    const tasks = [
      task("t1", { column: "running" }),
      task("t2", { column: "running", archivedAt: 5 }),
      task("t3", { column: "ready" }),
      task("t4", { column: "running", agent: "acct-b" }),
    ];
    expect(accountState(h, status("acct-a"), [], undefined, tasks, NOW).runningTasks).toBe(1);
  });
});

describe("buildHarnessBarModel", () => {
  test("(a)(b) one 2-member stack and five other accounts", () => {
    const ids = ["acct-a", "acct-b", "acct-c", "acct-d", "cx", "cu", "oc"];
    const m = buildHarnessBarModel(input({ ids, stacks: [stack("s1", ["acct-a", "acct-b"])] }), NOW);
    expect(m.stacks).toHaveLength(1);
    expect(m.stacks[0]?.members.map((x) => x.positionLabel)).toEqual(["Primary", "Backup 1"]);
    expect(m.accounts).toHaveLength(5);
    expect(m.button.enabledCount).toBe(7);
  });

  test("(e) a stack with one enabled and one disabled member is no stack; the enabled one is a plain account", () => {
    const hs = [harness("acct-a"), harness("acct-b", { enabled: false })];
    const m = buildHarnessBarModel(input({ harnesses: hs, agents: [status("acct-a"), status("acct-b")], stacks: [stack("s1", ["acct-a", "acct-b"])] }), NOW);
    expect(m.stacks).toHaveLength(0);
    expect(m.accounts.map((a) => a.harnessId)).toEqual(["acct-a"]);
  });

  test("(e) a 3-member stack with one disabled member keeps a disabled member row", () => {
    const hs = [harness("acct-a"), harness("acct-b"), harness("acct-c", { enabled: false })];
    const m = buildHarnessBarModel(input({ harnesses: hs, agents: hs.map((x) => status(x.id)), stacks: [stack("s1", ["acct-a", "acct-b", "acct-c"])] }), NOW);
    expect(m.stacks).toHaveLength(1);
    expect(m.stacks[0]?.members.map((x) => x.state)).toEqual(["ready", "ready", "disabled"]);
    expect(m.stacks[0]?.usableCount).toBe(2);
    expect(m.button.enabledCount).toBe(2);
  });

  test("(d) headroom is the lowest worst-% among usable members and skips members without a figure", () => {
    const ids = ["acct-a", "acct-b", "acct-c"];
    const usage = { "acct-a": quota("acct-a", { five: 80 }), "acct-b": quota("acct-b", { five: 30 }) };
    const m = buildHarnessBarModel(input({ ids, usage, stacks: [stack("s1", ids)] }), NOW);
    expect(m.stacks[0]?.headroomPercent).toBe(30);
    expect(m.stacks[0]?.headroomSource).toBe("acct-b");
  });

  test("(d) a cooling member is not usable and its percent is ignored", () => {
    const ids = ["acct-a", "acct-b"];
    const usage = { "acct-a": quota("acct-a", { five: 5 }), "acct-b": quota("acct-b", { five: 50 }) };
    const m = buildHarnessBarModel(input({ ids, usage, limitStates: [limit("acct-a", NOW + HOUR)], stacks: [stack("s1", ids)] }), NOW);
    expect(m.stacks[0]?.usableCount).toBe(1);
    expect(m.stacks[0]?.headroomPercent).toBe(50);
  });

  test("(d) headroom is null when no usable member reports a figure", () => {
    const ids = ["acct-a", "acct-b"];
    const m = buildHarnessBarModel(input({ ids, stacks: [stack("s1", ids)] }), NOW);
    expect(m.stacks[0]?.headroomPercent).toBeNull();
  });

  test("(d) no usable member: 100 and the earliest known reset", () => {
    const ids = ["acct-a", "acct-b"];
    const limitStates = [limit("acct-a", NOW + 3 * HOUR), limit("acct-b", NOW + HOUR)];
    const m = buildHarnessBarModel(input({ ids, limitStates, stacks: [stack("s1", ids)] }), NOW);
    expect(m.stacks[0]?.usableCount).toBe(0);
    expect(m.stacks[0]?.headroomPercent).toBe(100);
    expect(m.stacks[0]?.blockedUntil).toBe(NOW + HOUR);
  });

  test("(f) the meter is the tightest unit; ties go to the earlier one in panel order", () => {
    const ids = ["acct-a", "acct-b", "acct-c", "acct-d"];
    const usage = {
      "acct-a": quota("acct-a", { five: 40 }),
      "acct-b": quota("acct-b", { five: 40 }),
      "acct-c": quota("acct-c", { five: 75 }),
      "acct-d": quota("acct-d", { five: 75 }),
    };
    const m = buildHarnessBarModel(input({ ids, usage, stacks: [stack("s1", ["acct-a", "acct-b"])] }), NOW);
    expect(m.button.meter?.usedPercent).toBe(75);
    // acct-c and acct-d tie: the first in panel order names the source.
    expect(m.button.meter?.source).toBe(m.accounts[0]?.label);
  });

  test("(f) stack headroom, not the primary's own %, feeds the meter", () => {
    const ids = ["acct-a", "acct-b"];
    const usage = { "acct-a": quota("acct-a", { five: 95 }), "acct-b": quota("acct-b", { five: 10 }) };
    const m = buildHarnessBarModel(input({ ids, usage, stacks: [stack("s1", ids)] }), NOW);
    expect(m.button.meter?.usedPercent).toBe(10);
    expect(m.button.meter?.source).toContain("s1 label");
  });

  test("(f) no figure anywhere: no meter; unavailable and logged-out accounts never feed it", () => {
    const hs = [harness("acct-a"), harness("acct-b")];
    const agents = [status("acct-a", { available: false }), status("acct-b", { loggedIn: false })];
    const usage = { "acct-a": quota("acct-a", { five: 99 }), "acct-b": quota("acct-b", { five: 98 }) };
    const m = buildHarnessBarModel(input({ harnesses: hs, agents, usage }), NOW);
    expect(m.button.meter).toBeNull();
  });

  test("(f) stale comes from the chosen unit", () => {
    const usage = { "acct-a": quota("acct-a", { five: 50, fetchedAtMs: NOW - HARNESS_QUOTA_STALE_MS - 1 }) };
    const m = buildHarnessBarModel(input({ ids: ["acct-a"], usage }), NOW);
    expect(m.button.meter?.stale).toBe(true);
  });

  test("(g) every runnable unit blocked: allBlocked with the earliest reset", () => {
    const ids = ["acct-a", "acct-b", "acct-c"];
    const limitStates = [limit("acct-a", NOW + 2 * HOUR), limit("acct-b", NOW + 2 * HOUR), limit("acct-c", NOW + HOUR)];
    const m = buildHarnessBarModel(input({ ids, limitStates, stacks: [stack("s1", ["acct-a", "acct-b"])] }), NOW);
    expect(m.button.allBlocked).toBe(true);
    expect(m.button.until).toBe(NOW + HOUR);
    expect(m.button.summaryText).toContain("out of quota");
  });

  test("(g) one runnable unit left means not blocked and no until", () => {
    const ids = ["acct-a", "acct-b"];
    const m = buildHarnessBarModel(input({ ids, limitStates: [limit("acct-a", NOW + HOUR)] }), NOW);
    expect(m.button.allBlocked).toBe(false);
    expect(m.button.until).toBeNull();
  });

  test("(g) blocked with no reset known: allBlocked, until null, no time in the text", () => {
    const usage = { "acct-a": quota("acct-a", { five: 100, reset: null }) };
    const m = buildHarnessBarModel(input({ ids: ["acct-a"], usage }), NOW);
    expect(m.button.allBlocked).toBe(true);
    expect(m.button.until).toBeNull();
    expect(m.button.summaryText).toContain("Every account is out of quota");
    expect(m.button.summaryText).not.toContain(" until ");
  });

  test("(g) accounts that cannot run in principle do not make 'allBlocked'", () => {
    const hs = [harness("acct-a"), harness("acct-b")];
    const agents = [status("acct-a", { available: false }), status("acct-b", { loggedIn: false })];
    expect(buildHarnessBarModel(input({ harnesses: hs, agents }), NOW).button.allBlocked).toBe(false);
  });

  test("(h) the dot is the worst tone; none at zero enabled", () => {
    const base = (agents: AgentStatus[]) =>
      buildHarnessBarModel(input({ harnesses: agents.map((a) => harness(a.harnessId)), agents }), NOW).button.dot;
    expect(base([status("acct-a")])).toBe("success");
    expect(base([status("acct-a"), status("acct-b", { loggedIn: false })])).toBe("warning");
    expect(base([status("acct-a"), status("acct-b", { loggedIn: false }), status("acct-c", { available: false })])).toBe("danger");
    expect(buildHarnessBarModel(input({}), NOW).button.dot).toBe("none");
    expect(buildHarnessBarModel(input({}), NOW).button.enabledCount).toBe(0);
  });

  test("(i) accounts order running → problem → DB order, stable", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const agents = ids.map((id) => status(id, id === "c" ? { loggedIn: false } : {}));
    const tasks = [task("t1", { column: "running", agent: "e" })];
    const usage = { d: quota("d", { five: 95 }) };
    const m = buildHarnessBarModel(input({ harnesses: ids.map((id) => harness(id)), agents, tasks, usage }), NOW);
    expect(m.accounts.map((a) => a.harnessId)).toEqual(["e", "c", "d", "a", "b"]);
  });

  test("(j) failover tasks: archived excluded, pendingSwap wins, step keeps parentId, unknown stack goes to other", () => {
    const ids = ["acct-a", "acct-b"];
    const exhausted = { stackId: "s1", position: 0, tried: [], pendingSwap: null, allExhausted: { at: 0, attempts: 1, max: 3, nextAttemptAt: 0, earliestResetAtMs: NOW + HOUR, reason: "quota" } };
    const swap = { stackId: "s1", position: 0, tried: [], pendingSwap: { from: "acct-a", to: "acct-b", reason: "quota", runId: "r", startedAt: 0 }, allExhausted: exhausted.allExhausted };
    const tasks = [
      task("t-wait", { harnessState: exhausted }),
      task("t-swap", { harnessState: swap }),
      task("t-arch", { harnessState: exhausted, archivedAt: 1 }),
      task("t-step", { harnessState: exhausted, pipelineParentId: "p1" }),
      task("t-gone", { harnessState: { ...exhausted, stackId: "deleted" } }),
      task("t-none"),
    ];
    const m = buildHarnessBarModel(input({ ids, tasks, stacks: [stack("s1", ids)] }), NOW);
    const live = m.stacks[0]?.failoverTasks ?? [];
    expect(live.map((f) => f.taskId).sort()).toEqual(["t-step", "t-swap", "t-wait"]);
    expect(live.find((f) => f.taskId === "t-swap")).toMatchObject({ kind: "switching", text: "switching to acct-b" });
    expect(live.find((f) => f.taskId === "t-wait")?.kind).toBe("waiting");
    expect(live.find((f) => f.taskId === "t-wait")?.text).toMatch(/^waiting for quota until /);
    expect(live.find((f) => f.taskId === "t-step")?.parentId).toBe("p1");
    expect(m.otherFailoverTasks.map((f) => f.taskId)).toEqual(["t-gone"]);
    expect(m.button.badgeCount).toBe(4);
  });

  test("(j) waiting with no reset (or a past one) omits the time", () => {
    const hs = (reset: number | null) => ({ stackId: "s1", position: 0, tried: [], pendingSwap: null, allExhausted: { at: 0, attempts: 1, max: 3, nextAttemptAt: 0, earliestResetAtMs: reset, reason: "quota" } });
    const ids = ["acct-a", "acct-b"];
    const run = (reset: number | null) =>
      buildHarnessBarModel(input({ ids, tasks: [task("t", { harnessState: hs(reset) })], stacks: [stack("s1", ids)] }), NOW).stacks[0]?.failoverTasks[0]?.text;
    expect(run(null)).toBe("waiting for quota");
    expect(run(NOW - 1)).toBe("waiting for quota");
  });

  test("(k) nextChangeAt is the earliest future instant, never at or before now, null when none", () => {
    const ids = ["acct-a", "acct-b"];
    const usage = { "acct-a": quota("acct-a", { five: 10, reset: NOW + 3 * HOUR, fetchedAtMs: NOW - MIN }) };
    const limitStates = [limit("acct-b", NOW + 10 * MIN), limit("acct-b", NOW - 5, "m")];
    const m = buildHarnessBarModel(input({ ids, usage, limitStates }), NOW);
    expect(m.nextChangeAt).toBe(NOW + 10 * MIN);
    // The stale threshold of the snapshot is a change instant too.
    const only = buildHarnessBarModel(input({ ids: ["acct-a"], usage }), NOW);
    expect(only.nextChangeAt).toBe(NOW - MIN + HARNESS_QUOTA_STALE_MS);
    expect(buildHarnessBarModel(input({ ids }), NOW).nextChangeAt).toBeNull();
  });

  test("(k) a failover task's earliest reset counts", () => {
    const state = { stackId: "s1", position: 0, tried: [], pendingSwap: null, allExhausted: { at: 0, attempts: 1, max: 3, nextAttemptAt: 0, earliestResetAtMs: NOW + 5 * MIN, reason: "quota" } };
    const m = buildHarnessBarModel(input({ ids: ["acct-a"], tasks: [task("t", { harnessState: state })] }), NOW);
    expect(m.nextChangeAt).toBe(NOW + 5 * MIN);
  });

  test("an enabled harness whose status row has not arrived is an unavailable account", () => {
    const m = buildHarnessBarModel(input({ harnesses: [harness("acct-a")], agents: [] }), NOW);
    expect(m.accounts[0]?.statusText).toBe("Status unknown");
    expect(m.button.enabledCount).toBe(1);
  });
});

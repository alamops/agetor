import { test, expect, mock, afterAll, beforeEach } from "bun:test";
import { ApiError, type AgetorClient } from "./api-client.ts";
import type { HarnessLimitState, HarnessQuota, HarnessStack, MirrorPreview, Task } from "../shared/types.ts";
import { makeTask } from "./test-fixtures.ts";

/** Same mocking idiom as harness.test.ts: fake client via `getClient`, `out()`
 *  captured, `c.*` as identity. */
import * as realContext from "./context.ts";
import * as realOutput from "./output.ts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };

let currentClient: AgetorClient | null = null;
const outputs: string[] = [];

mock.module("./context.ts", () => ({
  ...realContextSnapshot,
  getClient: async () => {
    if (!currentClient) throw new Error("no fake client set for this test");
    return currentClient;
  },
}));

mock.module("./output.ts", () => ({
  ...realOutputSnapshot,
  c: {
    dim: (s: string) => s, bold: (s: string) => s, red: (s: string) => s, green: (s: string) => s,
    yellow: (s: string) => s, cyan: (s: string) => s, gray: (s: string) => s, magenta: (s: string) => s,
    blue: (s: string) => s,
  },
  out: (msg = "") => { outputs.push(msg); },
  printJson: (data: unknown) => { outputs.push(JSON.stringify(data)); },
  errln: () => {},
}));

afterAll(() => {
  mock.module("./context.ts", () => realContextSnapshot);
  mock.module("./output.ts", () => realOutputSnapshot);
});

const { cmdHarness, applyMemberOps, STACK_CHANGED_MESSAGE } = await import("./commands/harness.ts");
const { cmdSwitchAccount } = await import("./commands/switch-account.ts");
const { resolveStack } = await import("./resolve-stack.ts");
const { agentCell } = await import("./commands/ls.ts");

const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdHarness>[1];
const jsonFlags = { json: true, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdHarness>[1];

beforeEach(() => {
  outputs.length = 0;
  currentClient = null;
});

function member(id: string, label: string, position = 0) {
  return { harnessId: id, position, label, kind: "claude-code" as const, enabled: true };
}

function stack(over: Partial<HarnessStack> = {}): HarnessStack {
  return {
    id: "stk-aaaa1111",
    label: "Train",
    kind: "claude-code",
    mirrorMode: "full",
    members: [member("a", "A", 0), member("b", "B", 1), member("c", "C", 2)],
    createdAt: 1,
    updatedAt: 42,
    warnings: [],
    ...over,
  };
}

const NO_OVERWRITE: MirrorPreview = { plans: [], overwrites: false };
const OVERWRITE: MirrorPreview = {
  overwrites: true,
  plans: [{
    harnessId: "b",
    label: "B\u001b[2J",
    files: { add: ["x.json"], update: ["settings.json", "p2", "p3", "p4"], remove: [] },
    keys: [{ file: "settings.json", key: "env", action: "update" }],
    backups: ["settings.json"],
    kept: ["mine.json"],
    warnings: ["careful\u001b[0m"],
  }],
};

function fakeClient(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const client = {
    listHarnessStacks: async () => ({ stacks: [stack()], limitStates: [] as HarnessLimitState[] }),
    getHarnessStack: async () => ({ stack: stack(), limitStates: [] as HarnessLimitState[] }),
    previewHarnessMirror: async (d: unknown) => { calls.push(`preview:${JSON.stringify(d)}`); return NO_OVERWRITE; },
    patchHarnessStack: async (id: string, p: unknown) => {
      calls.push(`patch:${id}:${JSON.stringify(p)}`);
      return { stack: stack(), warnings: [], mirror: { copied: [], warnings: [] } };
    },
    createHarnessStack: async (i: unknown) => {
      calls.push(`create:${JSON.stringify(i)}`);
      return { stack: stack(), warnings: [], mirror: { copied: [], warnings: [] } };
    },
    ...over,
  };
  return { client: client as unknown as AgetorClient, calls };
}

// ── resolver (D17) ───────────────────────────────────────────────────────────

test("resolveStack: exact id, exact label, unique prefix; duplicate label lists escaped ids", async () => {
  const s1 = stack({ id: "stk-1111", label: "One" });
  const s2 = stack({ id: "stk-2222", label: "Dup" });
  const s3 = stack({ id: "stk-3333\u001b[2J", label: "Dup" });
  const { client } = fakeClient({ listHarnessStacks: async () => ({ stacks: [s1, s2, s3], limitStates: [] }) });
  expect((await resolveStack(client, "stk-1111")).id).toBe("stk-1111");
  expect((await resolveStack(client, "One")).id).toBe("stk-1111");
  expect((await resolveStack(client, "stk-1")).id).toBe("stk-1111");
  await expect(resolveStack(client, "Dup")).rejects.toThrow(/label of 2 stacks \(stk-2222, stk-3333/);
  await expect(resolveStack(client, "Dup")).rejects.not.toThrow(/\u001b/);
  await expect(resolveStack(client, "stk-")).rejects.toThrow(/ambiguous/);
  await expect(resolveStack(client, "nope")).rejects.toThrow(/no stack matches/);
});

test("resolveStack: an exact id wins over another stack's identical label", async () => {
  const a = stack({ id: "x", label: "y" });
  const b = stack({ id: "y", label: "z" });
  const { client } = fakeClient({ listHarnessStacks: async () => ({ stacks: [a, b], limitStates: [] }) });
  expect((await resolveStack(client, "y")).id).toBe("y");
});

// ── edit --add/--remove/--move ───────────────────────────────────────────────

test("applyMemberOps applies add/remove/move in order, 1-based", () => {
  const s = stack();
  expect(applyMemberOps(s, [{ op: "add", account: "d" }])).toEqual(["a", "b", "c", "d"]);
  expect(applyMemberOps(s, [{ op: "remove", account: "a" }])).toEqual(["b", "c"]);
  expect(applyMemberOps(s, [{ op: "move", account: "c", position: 1 }])).toEqual(["c", "a", "b"]);
  expect(applyMemberOps(s, [{ op: "add", account: "d" }, { op: "move", account: "d", position: 2 }, { op: "remove", account: "a" }])).toEqual(["d", "b", "c"]);
  // a member can be named by its unique label too
  expect(applyMemberOps(s, [{ op: "remove", account: "B" }])).toEqual(["a", "c"]);
  expect(() => applyMemberOps(s, [{ op: "add", account: "a" }])).toThrow(/already a member/);
  expect(() => applyMemberOps(s, [{ op: "remove", account: "zz" }])).toThrow(/not a member/);
  expect(() => applyMemberOps(s, [{ op: "move", account: "a", position: 4 }])).toThrow(/between 1 and 3/);
  expect(() => applyMemberOps(stack({ members: [member("a", "A")] }), [{ op: "remove", account: "a" }])).toThrow(/last member/);
});

test("stack edit --add/--move sends the computed list with expectedUpdatedAt, after a preview", async () => {
  const { client, calls } = fakeClient();
  currentClient = client;
  await cmdHarness(["stack", "edit", "Train", "--add", "d", "--move", "d:1"], flags);
  expect(calls[0]).toContain('preview:{"kind":"claude-code","members":["d","a","b","c"],"mirrorMode":"full","stackId":"stk-aaaa1111"}');
  expect(calls.at(-1)).toBe('patch:stk-aaaa1111:{"members":["d","a","b","c"],"expectedUpdatedAt":42}');
});

test("stack edit refuses --member mixed with --add/--remove/--move, and bad --move values", async () => {
  currentClient = fakeClient().client;
  await expect(cmdHarness(["stack", "edit", "Train", "--member", "a", "--add", "b"], flags)).rejects.toThrow(/cannot be combined/);
  await expect(cmdHarness(["stack", "edit", "Train", "--move", "a"], flags)).rejects.toThrow(/<account>:<position>/);
  await expect(cmdHarness(["stack", "edit", "Train", "--move", "a:0"], flags)).rejects.toThrow(/1-based/);
  await expect(cmdHarness(["stack", "create", "T", "--member", "a", "--add", "b"], flags)).rejects.toThrow(/unknown flag/);
});

test("stack edit: a label-only change skips the preview", async () => {
  const { client, calls } = fakeClient();
  currentClient = client;
  await cmdHarness(["stack", "edit", "Train", "--label", "New"], flags);
  expect(calls.some((c) => c.startsWith("preview"))).toBe(false);
  expect(calls.at(-1)).toBe('patch:stk-aaaa1111:{"label":"New","expectedUpdatedAt":42}');
});

test("stack edit: 409 stack-changed prints the re-run message", async () => {
  const { client } = fakeClient({
    patchHarnessStack: async () => { throw new ApiError(409, { code: "stack-changed", stack: stack() }, "stack changed"); },
  });
  currentClient = client;
  await expect(cmdHarness(["stack", "edit", "Train", "--label", "x"], flags)).rejects.toThrow(STACK_CHANGED_MESSAGE);
  expect(STACK_CHANGED_MESSAGE).toBe("the stack changed since it was read — re-run the command");
});

test("stack edit: any other 409 propagates unchanged", async () => {
  const { client } = fakeClient({
    patchHarnessStack: async () => { throw new ApiError(409, { error: "boom" }, "boom"); },
  });
  currentClient = client;
  await expect(cmdHarness(["stack", "edit", "Train", "--label", "x"], flags)).rejects.toThrow("boom");
});

// ── preview gate (D10) ───────────────────────────────────────────────────────

test("--dry-run prints the escaped preview and saves nothing", async () => {
  const { client, calls } = fakeClient({ previewHarnessMirror: async () => OVERWRITE });
  currentClient = client;
  await cmdHarness(["stack", "edit", "Train", "--remove", "c", "--dry-run"], flags);
  const text = outputs.join("\n");
  expect(calls.some((c) => c.startsWith("patch"))).toBe(false);
  expect(text).toContain("files added 1: x.json");
  expect(text).toContain("files updated 4: settings.json, p2, p3 (+1 more)");
  expect(text).toContain("key settings.json: env (update)");
  expect(text).toContain("backed up first 1: settings.json");
  expect(text).toContain("kept (edited on the backup) 1: mine.json");
  expect(text).toContain("careful");
  expect(text).not.toContain("\u001b");
  expect(text).toContain("nothing saved");
});

test("--dry-run --json prints { saved:false, preview }", async () => {
  const { client, calls } = fakeClient({ previewHarnessMirror: async () => OVERWRITE });
  currentClient = client;
  await cmdHarness(["stack", "edit", "Train", "--remove", "c", "--dry-run"], jsonFlags);
  const parsed = JSON.parse(outputs[0]!);
  expect(parsed.saved).toBe(false);
  expect(parsed.preview.overwrites).toBe(true);
  expect(calls.some((c) => c.startsWith("patch"))).toBe(false);
});

test("an overwriting save without --yes prints the preview and refuses; with --yes it saves", async () => {
  const { client, calls } = fakeClient({ previewHarnessMirror: async () => OVERWRITE });
  currentClient = client;
  await expect(cmdHarness(["stack", "edit", "Train", "--remove", "c"], flags)).rejects.toThrow(
    "this would overwrite or remove files on a backup account (originals are backed up); re-run with --yes",
  );
  expect(outputs.join("\n")).toContain("mirror preview");
  expect(calls.some((c) => c.startsWith("patch"))).toBe(false);

  await cmdHarness(["stack", "edit", "Train", "--remove", "c", "--yes"], flags);
  expect(calls.at(-1)).toContain("patch:");
});

test("stack create previews first, refuses on overwrite without --yes", async () => {
  const { client, calls } = fakeClient({ previewHarnessMirror: async () => OVERWRITE });
  currentClient = client;
  await expect(cmdHarness(["stack", "create", "T", "--member", "a", "--member", "b"], flags)).rejects.toThrow(/re-run with --yes/);
  expect(calls.some((c) => c.startsWith("create"))).toBe(false);
  await cmdHarness(["stack", "create", "T", "--member", "a", "--member", "b", "--yes"], flags);
  expect(calls.at(-1)).toContain("create:");
});

test("stack preview prints the current stack's preview", async () => {
  const { client, calls } = fakeClient({ previewHarnessMirror: async (d: unknown) => { calls.push(JSON.stringify(d)); return OVERWRITE; } });
  currentClient = client;
  await cmdHarness(["stack", "preview", "Train"], flags);
  expect(calls[0]).toContain('"stackId":"stk-aaaa1111"');
  expect(outputs.join("\n")).toContain("mirror preview");
});

// ── history ──────────────────────────────────────────────────────────────────

test("stack history: one escaped line per event, cursor line, --json", async () => {
  const page = {
    events: [{
      id: "e1", stackId: "stk-aaaa1111", taskId: "abcdefgh12345678", taskTitle: "Fix \u001b[2J it",
      fromHarnessId: "a", fromLabel: "A\u001b[2J", toHarnessId: "b", toLabel: "B", trigger: "limit" as const,
      reason: "quota" as const, source: null, message: null, model: null, resetsAtMs: null,
      fromRunId: null, toRunId: null, continuation: null, at: 1_700_000_000_000,
    }],
    nextCursor: "cur-1",
  };
  const seen: unknown[] = [];
  const { client } = fakeClient({ getHarnessStackHistory: async (id: string, o: unknown) => { seen.push([id, o]); return page; } });
  currentClient = client;
  await cmdHarness(["stack", "history", "Train", "--limit", "5", "--before", "cur-0"], flags);
  expect(seen[0]).toEqual(["stk-aaaa1111", { limit: 5, before: "cur-0" }]);
  const text = outputs.join("\n");
  expect(text).toContain("limit:");
  expect(text).toContain('(task abcdefgh "Fix');
  expect(text).toContain("more: --before cur-1");
  expect(text).not.toContain("\u001b");

  outputs.length = 0;
  await cmdHarness(["stack", "history", "Train"], jsonFlags);
  expect(JSON.parse(outputs[0]!).nextCursor).toBe("cur-1");

  await expect(cmdHarness(["stack", "history", "Train", "--limit", "0"], flags)).rejects.toThrow(/positive/);
});

// ── cooldown / restore ───────────────────────────────────────────────────────

test("harness cooldown clear calls the client and warns the provider may still refuse", async () => {
  const seen: unknown[] = [];
  const left: HarnessLimitState = { harnessId: "a", reason: "quota", source: "claude-pane", message: null, exhaustedUntilMs: 5, updatedAt: 1, model: "opus" };
  currentClient = { clearHarnessCooldown: async (id: string, m?: string) => { seen.push([id, m]); return { cleared: true as const, limitStates: [left] }; } } as unknown as AgetorClient;
  await cmdHarness(["cooldown", "clear", "a", "--model", "sonnet"], flags);
  expect(seen[0]).toEqual(["a", "sonnet"]);
  const text = outputs.join("\n");
  expect(text).toContain("cleared the cooldown on a for sonnet");
  expect(text).toContain("still cooling: usage limit until");
  expect(text).toContain("the provider may still refuse until its own reset");
  await expect(cmdHarness(["cooldown", "wat", "a"], flags)).rejects.toThrow(/usage:/);
});

test("harness restore: a backup member needs --yes; otherwise prints the result", async () => {
  const result = { harnessId: "b", restored: ["settings.json"], removed: ["x.json"], kept: ["mine.json"], warnings: ["w\u001b[0m"] };
  let restored = 0;
  currentClient = fakeClient({ restoreHarnessMirror: async () => { restored++; return result; } }).client;
  await expect(cmdHarness(["restore", "b"], flags)).rejects.toThrow(/next mirror will re-apply the primary's config/);
  expect(restored).toBe(0);
  await cmdHarness(["restore", "b", "--yes"], flags);
  const text = outputs.join("\n");
  expect(restored).toBe(1);
  expect(text).toContain("restored 1: settings.json");
  expect(text).toContain("removed 1: x.json");
  expect(text).toContain("kept (edited since the mirror wrote them) 1: mine.json");
  expect(text).not.toContain("\u001b");

  // the primary, or an account in no stack, needs no confirmation
  outputs.length = 0;
  await cmdHarness(["restore", "a"], flags);
  await cmdHarness(["restore", "zzz"], flags);
  expect(restored).toBe(3);
});

// ── ls / show surfaces (D14/D15, 22d) ────────────────────────────────────────

const QUOTA: HarnessQuota = {
  harnessId: "a", kind: "claude-code", planType: null, status: "ok", source: "api",
  fetchedAtMs: Date.now() - 30 * 60_000,
  meters: [
    { id: "five_hour", label: "5-hour", usedPercent: 42.4, resetsAtMs: null },
    { id: "seven_day", label: "Weekly", usedPercent: 10, resetsAtMs: null },
  ],
  reason: null,
} as unknown as HarnessQuota;

test("harness ls: several limit rows, quota with stale marker, escaped id, --json carries limitStates and quota", async () => {
  const rows: HarnessLimitState[] = [
    { harnessId: "a", reason: "quota", source: "claude-pane", message: null, exhaustedUntilMs: 9e12, updatedAt: 1, model: null },
    { harnessId: "a", reason: "rate_limit", source: "codex-error", message: null, exhaustedUntilMs: 9e12, updatedAt: 1, model: "gpt-x" },
  ];
  currentClient = {
    listHarnesses: async () => ({
      harnesses: [{ id: "a\u001b[2J", kind: "claude-code", label: "A", home: null, bin: null, env: {}, isBuiltin: false, createdAt: 0, enabled: true }],
      statuses: [], stacks: [stack()], limitStates: rows.map((r) => ({ ...r, harnessId: "a\u001b[2J" })),
    }),
    getUsage: async () => [{ ...QUOTA, harnessId: "a\u001b[2J" }],
  } as unknown as AgetorClient;
  await cmdHarness(["ls"], flags);
  const text = outputs.join("\n");
  expect(text).not.toContain("\u001b");
  expect(text).toContain("usage limit until");
  expect(text).toContain("rate limit until");
  expect(text).toContain("for gpt-x");
  expect(text).toContain("5-hour 42%");
  expect(text).toContain("Weekly 10%");
  expect(text).toContain("stale");

  outputs.length = 0;
  await cmdHarness(["ls"], jsonFlags);
  const parsed = JSON.parse(outputs[0]!);
  expect(parsed.limitStates).toHaveLength(2);
  expect(parsed.limitStates[1].model).toBe("gpt-x");
  expect(parsed.quota).toHaveLength(1);
});

test("harness ls survives a failing /usage", async () => {
  currentClient = {
    listHarnesses: async () => ({ harnesses: [], statuses: [], stacks: [], limitStates: [] }),
    getUsage: async () => { throw new Error("down"); },
  } as unknown as AgetorClient;
  await cmdHarness(["ls"], flags);
  expect(outputs.length).toBeGreaterThan(0);
});

test("stack show: member cooling reason, message, quota; one-member stack has no n/m", async () => {
  const one = stack({ members: [member("a", "A")] });
  const row: HarnessLimitState = { harnessId: "a", reason: "insufficient_credits", source: "claude-pane", message: "out\u001b[31m of credits", exhaustedUntilMs: 9e12, updatedAt: 1, model: null };
  currentClient = fakeClient({
    listHarnessStacks: async () => ({ stacks: [one], limitStates: [row] }),
    getHarnessStack: async () => ({ stack: one, limitStates: [row] }),
    getUsage: async () => [QUOTA],
  }).client;
  await cmdHarness(["stack", "show", "Train"], flags);
  let text = outputs.join("\n");
  expect(text).toContain("cooling: out of credits until");
  expect(text).toContain("out of credits");
  expect(text).toContain("quota: 5-hour 42%");
  expect(text).not.toContain("\u001b");
  expect(text).not.toMatch(/\b1\/1\b/);

  outputs.length = 0;
  await cmdHarness(["stack", "ls"], flags);
  text = outputs.join("\n");
  expect(text).not.toMatch(/\b1\/1\b/);
  expect(text).toContain("primary A");

  outputs.length = 0;
  await cmdHarness(["stack", "show", "Train"], jsonFlags);
  const parsed = JSON.parse(outputs[0]!);
  expect(parsed.limitStates[0].reason).toBe("insufficient_credits");
  expect(parsed.quota).toHaveLength(1);
});

// ── ls agent cell markers ────────────────────────────────────────────────────

test("agentCell: cooling, out of quota, blocked, scheduled markers; one-member stack has no position; ids escaped", () => {
  const multi = stack();
  const solo = stack({ members: [member("a", "A")] });
  const byHarness = new Map<string, HarnessStack>([["a", multi]]);
  const cool: HarnessLimitState = { harnessId: "a", reason: "quota", source: "claude-pane", message: null, exhaustedUntilMs: 9e12, updatedAt: 1, model: null };
  const perModel: HarnessLimitState = { ...cool, model: "other-model" };

  expect(agentCell(makeTask({ agent: "a" }), byHarness, [])).toBe("a · 1/3");
  expect(agentCell(makeTask({ agent: "a" }), byHarness, [cool])).toContain("⏳");
  // a per-model row only marks a task on that model
  expect(agentCell(makeTask({ agent: "a", model: "mine" }), byHarness, [perModel])).not.toContain("⏳");
  expect(agentCell(makeTask({ agent: "a", model: "OTHER-model" }), byHarness, [perModel])).toContain("⏳");
  expect(agentCell(makeTask({ agent: "a" }), new Map([["a", solo]]), [])).toBe("a");

  const exhausted = (reason: "quota" | "no-usable-member"): Task => makeTask({
    agent: "a",
    harnessState: { stackId: "s", position: 0, tried: [], pendingSwap: null, lastMove: null,
      allExhausted: { at: 1, attempts: 0, max: 3, nextAttemptAt: 0, earliestResetAtMs: null, reason } },
  });
  expect(agentCell(exhausted("quota"), byHarness, [cool])).toContain("out of quota");
  expect(agentCell(exhausted("quota"), byHarness, [cool])).not.toContain("⏳");
  expect(agentCell(exhausted("no-usable-member"), byHarness, [])).toContain("blocked: no usable account");

  const scheduled = makeTask({
    agent: "a",
    harnessState: { stackId: "s", position: 0, tried: [], pendingSwap: null, lastMove: null, allExhausted: null, scheduledSwitch: { requestedAt: 1 } },
  });
  expect(agentCell(scheduled, byHarness, [])).toContain("⇄");
  expect(agentCell(makeTask({ agent: "x\u001b[2Jy" }), new Map(), [])).not.toContain("\u001b");
});

// ── switch-account (D12) ─────────────────────────────────────────────────────

function taskClient(over: Record<string, unknown>) {
  const t = makeTask({ id: "abcdefgh12345678", agent: "b" });
  return {
    listTasks: async () => [t],
    listHarnessStacks: async () => ({ stacks: [stack()], limitStates: [] }),
    ...over,
  } as unknown as AgetorClient;
}

test("switch-account: switched prints the new label and position", async () => {
  currentClient = taskClient({ switchTaskAccount: async () => ({ status: "switched", task: makeTask({ agent: "b" }) }) });
  await cmdSwitchAccount(["abcdefgh"], flags);
  expect(outputs.join("\n")).toBe("✓ switched to B (2/3) — continuing this conversation");
});

test("switch-account: scheduled prints the cancel hint", async () => {
  currentClient = taskClient({ switchTaskAccount: async () => ({ status: "scheduled", task: makeTask() }) });
  await cmdSwitchAccount(["abcdefgh"], flags);
  expect(outputs.join("\n")).toContain("switch to the next account scheduled for the end of this turn (agetor switch-account abcdefgh --cancel to undo)");
});

test("switch-account: a 409 prints the error and each escaped reason, and throws", async () => {
  currentClient = taskClient({
    switchTaskAccount: async () => {
      throw new ApiError(409, { code: "no-usable-member", reasons: [
        { harnessId: "a", label: "A\u001b[2J", reason: "cooling until 15:00" },
        { harnessId: "c", label: "C", reason: "logged out" },
      ] }, "no account can take this task");
    },
  });
  const err = await cmdSwitchAccount(["abcdefgh"], flags).then(() => null, (e: Error) => e);
  expect(err).not.toBeNull();
  expect(err!.message).toContain("no account can take this task");
  expect(err!.message).toContain("- A");
  expect(err!.message).toContain("cooling until 15:00");
  expect(err!.message).toContain("- C: logged out");
  expect(err!.message).not.toContain("\u001b");
});

test("switch-account: other errors propagate; --cancel calls the cancel route; usage on no ref", async () => {
  currentClient = taskClient({ switchTaskAccount: async () => { throw new ApiError(0, null, "cannot reach core — the switch may have gone through") ; } });
  await expect(cmdSwitchAccount(["abcdefgh"], flags)).rejects.toThrow(/may have gone through/);

  const cancelled: string[] = [];
  currentClient = taskClient({ cancelScheduledAccountSwitch: async (id: string) => { cancelled.push(id); return { task: makeTask() }; } });
  await cmdSwitchAccount(["abcdefgh", "--cancel"], flags);
  expect(cancelled).toEqual(["abcdefgh12345678"]);
  expect(outputs.join("\n")).toContain("cancelled");

  await expect(cmdSwitchAccount([], flags)).rejects.toThrow(/usage: agetor switch-account/);
});

// ── item 19: edit --agent ────────────────────────────────────────────────────

test("edit --agent: the transport 'may have gone through' message is surfaced unchanged; a live-run 409 suggests switch-account", async () => {
  const { cmdEdit } = await import("./commands/manage.ts");
  const t = makeTask({ id: "abcdefgh12345678" });
  currentClient = {
    listTasks: async () => [t],
    patchTask: async () => { throw new ApiError(0, null, "core did not respond — the switch may have gone through; check 'agetor show abcdefgh12345678' before retrying"); },
  } as unknown as AgetorClient;
  await expect(cmdEdit(["abcdefgh", "--agent", "b"], flags)).rejects.toThrow(
    "core did not respond — the switch may have gone through; check 'agetor show abcdefgh12345678' before retrying",
  );

  currentClient = {
    listTasks: async () => [t],
    patchTask: async () => { throw new ApiError(409, { error: "stop the run before switching accounts" }, "stop the run before switching accounts"); },
  } as unknown as AgetorClient;
  await expect(cmdEdit(["abcdefgh", "--agent", "b"], flags)).rejects.toThrow(
    "stop the run before switching accounts — or run 'agetor switch-account abcdefgh' to schedule the switch for the end of the turn",
  );
});

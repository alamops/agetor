import { test, expect, mock, afterAll } from "bun:test";
import { ApiError, type AgetorClient } from "./api-client.ts";
import type { FxPermissionRequest } from "../bun/interactions.ts";

/**
 * `answerFx` (in commands/answer.ts) isn't exported — only `cmdAnswer` is —
 * and it drives `@clack/prompts` directly plus reaches for a client via
 * `getClient(flags)` internally rather than accepting one as a parameter. To
 * exercise it without modifying commands/answer.ts (test-files-only scope),
 * this suite mocks its three module dependencies (`./context.ts` for
 * `getClient`, `./output.ts` for the `isTTY` guard, and `@clack/prompts` for
 * the interactive prompt) and drives the real `cmdAnswer` end to end with a
 * fake AgetorClient that has exactly one pending fx_permission interaction.
 *
 * Each mocked module is snapshotted before mocking and restored in
 * `afterAll` — `mock.module` overwrites the module record in place (Bun's
 * documented behavior for already-loaded modules), and other test files in
 * the same `bun test` process import these same modules.
 */

import * as realContext from "./context.ts";
import * as realOutput from "./output.ts";
import * as realClack from "@clack/prompts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };
const realClackSnapshot = { ...realClack };

let currentClient: AgetorClient | null = null;

type SelectOption = { value: unknown; label: string };
type SelectImpl = (opts: { message: string; options: SelectOption[] }) => Promise<unknown>;

let selectImpl: SelectImpl = async () => {
  throw new Error("select() not stubbed for this test");
};
type TextImpl = (opts: { message: string }) => Promise<unknown>;
let textImpl: TextImpl = async () => {
  throw new Error("text() not stubbed for this test");
};
const cancelCalls: string[] = [];
const CANCEL = Symbol("cancel");
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
  isTTY: true, // bypass cmdAnswer's "needs an interactive terminal" guard
  c: {
    dim: (s: string) => s,
    bold: (s: string) => s,
    red: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    cyan: (s: string) => s,
    gray: (s: string) => s,
    magenta: (s: string) => s,
    blue: (s: string) => s,
  },
  out: (msg = "") => {
    outputs.push(msg);
  },
}));

mock.module("@clack/prompts", () => ({
  ...realClackSnapshot,
  select: async (opts: { message: string; options: SelectOption[] }) => selectImpl(opts),
  text: async (opts: { message: string }) => textImpl(opts),
  isCancel: (v: unknown) => v === CANCEL,
  cancel: (msg?: string) => {
    cancelCalls.push(msg ?? "");
  },
  note: () => {},
}));

afterAll(() => {
  mock.module("./context.ts", () => realContextSnapshot);
  mock.module("./output.ts", () => realOutputSnapshot);
  mock.module("@clack/prompts", () => realClackSnapshot);
});

const { cmdAnswer } = await import("./commands/answer.ts");

function fxReq(overrides: Partial<FxPermissionRequest> = {}): FxPermissionRequest {
  return {
    kind: "fx_permission",
    id: "fx1",
    taskId: "t1",
    runId: "r1",
    createdAt: 0,
    toolCall: { toolCallId: "tc1", title: "Write file", kind: "edit" },
    options: [
      { optionId: "opt-allow", name: "Allow once" },
      { optionId: "opt-always", name: "Allow always" },
    ],
    mode: "ask",
    ...overrides,
  } as FxPermissionRequest;
}

function makeClient(
  req: FxPermissionRequest,
  answerResult: { ok: boolean } = { ok: true },
): { client: AgetorClient; calls: Array<{ id: string; body: unknown }> } {
  const calls: Array<{ id: string; body: unknown }> = [];
  const client = {
    listTasks: async () => [{ id: "t1", title: "T" }],
    pendingInteractions: async () => [req],
    answerFxPermission: async (id: string, body: unknown) => {
      calls.push({ id, body });
      return answerResult;
    },
  } as unknown as AgetorClient;
  return { client, calls };
}

const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdAnswer>[1];

test("answerFx (via cmdAnswer): picking an option posts { optionId }", async () => {
  outputs.length = 0;
  const req = fxReq();
  const { client, calls } = makeClient(req);
  currentClient = client;
  selectImpl = async (opts) => opts.options[0]!.value; // pick "Allow once"
  await cmdAnswer(["t1"], flags);
  expect(calls).toEqual([{ id: "fx1", body: { optionId: "opt-allow" } }]);
});

test("answerFx (via cmdAnswer): picking Dismiss posts { cancel: true }", async () => {
  outputs.length = 0;
  const req = fxReq();
  const { client, calls } = makeClient(req);
  currentClient = client;
  selectImpl = async (opts) => opts.options.find((o) => o.label === "Dismiss (reject)")!.value;
  await cmdAnswer(["t1"], flags);
  expect(calls).toEqual([{ id: "fx1", body: { cancel: true } }]);
});

test("answerFx (via cmdAnswer): isCancel aborts without posting — interaction stays pending", async () => {
  outputs.length = 0;
  cancelCalls.length = 0;
  const req = fxReq();
  const { client, calls } = makeClient(req);
  currentClient = client;
  selectImpl = async () => CANCEL;
  await cmdAnswer(["t1"], flags);
  expect(calls).toEqual([]); // never posted — the interaction is left pending
  expect(cancelCalls.length).toBeGreaterThan(0);
});

test("cursor skip: a 400 is printed and does not throw", async () => {
  outputs.length = 0;
  const req = {
    kind: "ask_questions",
    id: "q1",
    taskId: "t1",
    runId: "r1",
    createdAt: 0,
    source: "cursor",
    questions: [{ question: "Which?", options: [{ label: "Alpha" }] }],
  };
  currentClient = {
    listTasks: async () => [{ id: "t1", title: "T" }],
    pendingInteractions: async () => [req],
    answerAskQuestions: async () => {
      throw new ApiError(400, { error: "run not found" }, "run not found");
    },
  } as unknown as AgetorClient;
  selectImpl = async (opts) => opts.options.find((o) => o.label === "Skip")!.value;
  await cmdAnswer(["t1"], flags);
  expect(outputs.some((line) => line.includes("run not found"))).toBe(true);
  expect(outputs.some((line) => line.includes("skipped"))).toBe(false);
});

test("answerFx (via cmdAnswer): { ok: false } from the server prints 'already resolved'", async () => {
  outputs.length = 0;
  const req = fxReq();
  const { client, calls } = makeClient(req, { ok: false });
  currentClient = client;
  selectImpl = async (opts) => opts.options[0]!.value;
  await cmdAnswer(["t1"], flags);
  expect(calls).toEqual([{ id: "fx1", body: { optionId: "opt-allow" } }]);
  expect(outputs.some((line) => line.includes("already resolved"))).toBe(true);
});

// ── OpenCode cards (docs/plans/opencode-server-driver.md T10) ─────────────

function ocPermReq(overrides: Partial<FxPermissionRequest> = {}): FxPermissionRequest {
  return fxReq({
    id: "oc1",
    harness: "opencode",
    allowReason: true,
    toolCall: { toolCallId: "tc1", title: "bash", kind: "execute", rawInput: { command: "rm -rf build" } },
    options: [
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      { optionId: "always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
    ...overrides,
  });
}

const pickLabel = (label: string): SelectImpl => async (opts) => opts.options.find((o) => o.label === label)!.value;

test("opencode permission: Reject with --reason posts { optionId: reject, message } and asks nothing", async () => {
  outputs.length = 0;
  const { client, calls } = makeClient(ocPermReq());
  currentClient = client;
  selectImpl = pickLabel("Reject");
  textImpl = async () => {
    throw new Error("must not ask for a reason when --reason was given");
  };
  await cmdAnswer(["t1", "--reason", "too risky"], flags);
  expect(calls).toEqual([{ id: "oc1", body: { optionId: "reject", message: "too risky" } }]);
  expect(outputs.some((l) => l.includes("turn stops"))).toBe(false);
});

test("opencode permission: the list is the card's own three options, with no Dismiss row", async () => {
  outputs.length = 0;
  const { client } = makeClient(ocPermReq());
  currentClient = client;
  let labels: string[] = [];
  selectImpl = async (opts) => {
    labels = opts.options.map((o) => o.label);
    return CANCEL;
  };
  await cmdAnswer(["t1"], flags);
  expect(labels).toEqual(["Allow once", "Always allow", "Reject"]);
});

test("opencode permission: Reject with no --reason asks for one; typing it sends it", async () => {
  outputs.length = 0;
  const { client, calls } = makeClient(ocPermReq());
  currentClient = client;
  selectImpl = pickLabel("Reject");
  const asked: string[] = [];
  textImpl = async (opts) => {
    asked.push(opts.message);
    return "  use the dry-run flag  ";
  };
  await cmdAnswer(["t1"], flags);
  expect(asked.length).toBe(1);
  expect(asked[0]).toContain("skips");
  expect(asked[0]).not.toContain("stops");
  expect(calls).toEqual([{ id: "oc1", body: { optionId: "reject", message: "use the dry-run flag" } }]);
});

test("opencode permission: Reject with an empty reason sends none and says the agent continues", async () => {
  outputs.length = 0;
  const { client, calls } = makeClient(ocPermReq());
  currentClient = client;
  selectImpl = pickLabel("Reject");
  textImpl = async () => "";
  await cmdAnswer(["t1"], flags);
  expect(calls).toEqual([{ id: "oc1", body: { optionId: "reject" } }]);
  expect(outputs.some((l) => l.includes("action is skipped and the agent continues"))).toBe(true);
  expect(outputs.some((l) => l.includes("turn stops"))).toBe(false);
});

test("opencode permission: Esc at the reason prompt posts nothing", async () => {
  outputs.length = 0;
  cancelCalls.length = 0;
  const { client, calls } = makeClient(ocPermReq());
  currentClient = client;
  selectImpl = pickLabel("Reject");
  textImpl = async () => CANCEL;
  await cmdAnswer(["t1"], flags);
  expect(calls).toEqual([]);
  expect(cancelCalls.length).toBeGreaterThan(0);
});

test("opencode permission: --reason with Allow once or Always allow is an error and posts nothing", async () => {
  for (const label of ["Allow once", "Always allow"]) {
    const { client, calls } = makeClient(ocPermReq());
    currentClient = client;
    selectImpl = pickLabel(label);
    await expect(cmdAnswer(["t1", "--reason", "because"], flags)).rejects.toThrow(
      "--reason can only be used when rejecting",
    );
    expect(calls).toEqual([]);
  }
});

test("opencode permission: Allow once without --reason posts { optionId: once }", async () => {
  const { client, calls } = makeClient(ocPermReq());
  currentClient = client;
  selectImpl = pickLabel("Allow once");
  await cmdAnswer(["t1"], flags);
  expect(calls).toEqual([{ id: "oc1", body: { optionId: "once" } }]);
});

test("--reason on a non-OpenCode card is refused before any prompt", async () => {
  const { client, calls } = makeClient(fxReq());
  currentClient = client;
  selectImpl = async () => {
    throw new Error("must not prompt");
  };
  await expect(cmdAnswer(["t1", "--reason", "x"], flags)).rejects.toThrow("only to an OpenCode permission");
  expect(calls).toEqual([]);
});

test("a fx card still shows its Dismiss row and ignores the OpenCode path", async () => {
  const { client, calls } = makeClient(fxReq());
  currentClient = client;
  selectImpl = pickLabel("Dismiss (reject)");
  await cmdAnswer(["t1"], flags);
  expect(calls).toEqual([{ id: "fx1", body: { cancel: true } }]);
});

test("opencode permission: control characters in the title and raw input print escaped", async () => {
  outputs.length = 0;
  const { client } = makeClient(
    ocPermReq({ toolCall: { toolCallId: "tc1", title: "bash\u001b[2J", kind: "execute", rawInput: { command: "echo \u001b[31m" } } }),
  );
  currentClient = client;
  selectImpl = async () => CANCEL;
  await cmdAnswer(["t1"], flags);
  const printed = outputs.join("\n");
  expect(printed).not.toContain("\u001b");
  expect(printed).toContain("\\u001b");
});

function ocAskReq(over: Record<string, unknown> = {}) {
  return {
    kind: "ask_questions",
    id: "oq1",
    taskId: "t1",
    runId: "r1",
    createdAt: 0,
    source: "opencode",
    delivery: "live",
    allowReason: true,
    allowCustom: true,
    questions: [
      {
        id: "scope",
        question: "Which scope?",
        allowCustom: true,
        options: [
          { id: "narrow", label: "Narrow" },
          { id: "wide", label: "Wide" },
        ],
      },
    ],
    ...over,
  };
}

function askClient(req: unknown, answerImpl?: (id: string, body: unknown) => Promise<unknown>) {
  const calls: Array<{ id: string; body: unknown }> = [];
  currentClient = {
    listTasks: async () => [{ id: "t1", title: "T" }],
    pendingInteractions: async () => [req],
    answerAskQuestions: async (id: string, body: unknown) => {
      calls.push({ id, body });
      return answerImpl ? answerImpl(id, body) : { ok: true };
    },
  } as unknown as AgetorClient;
  return calls;
}

test("opencode question: an option is posted by id, labels alongside", async () => {
  outputs.length = 0;
  const calls = askClient(ocAskReq());
  selectImpl = pickLabel("Wide");
  await cmdAnswer(["t1"], flags);
  expect(calls).toEqual([{ id: "oq1", body: [{ selected: ["Wide"], selectedOptionIds: ["wide"] }] }]);
});

test("opencode question: where allowCustom, Other takes typed text (and only that)", async () => {
  outputs.length = 0;
  const calls = askClient(ocAskReq());
  let labels: string[] = [];
  selectImpl = async (opts) => {
    labels = opts.options.map((o) => o.label);
    return opts.options.find((o) => o.label.startsWith("✎ Other"))!.value;
  };
  textImpl = async () => "  somewhere in between ";
  await cmdAnswer(["t1"], flags);
  expect(labels).toEqual(["Narrow", "Wide", "✎ Other — type a custom answer", "Skip"]);
  expect(calls).toEqual([{ id: "oq1", body: [{ selected: [], custom: "somewhere in between" }] }]);
});

test("opencode question: no Other row where the question takes no typed text", async () => {
  const base = ocAskReq();
  const req = ocAskReq({ allowCustom: false, questions: [{ ...base.questions[0]!, allowCustom: false }] });
  const calls = askClient(req);
  let labels: string[] = [];
  selectImpl = async (opts) => {
    labels = opts.options.map((o) => o.label);
    return opts.options[0]!.value;
  };
  await cmdAnswer(["t1"], flags);
  expect(labels).toEqual(["Narrow", "Wide", "Skip"]);
  expect(calls[0]!.body).toEqual([{ selected: ["Narrow"], selectedOptionIds: ["narrow"] }]);
});

test("opencode question: --skip posts { skip: true } with no prompt, and --reason rides along", async () => {
  const calls = askClient(ocAskReq());
  selectImpl = async () => {
    throw new Error("must not prompt");
  };
  await cmdAnswer(["t1", "--skip"], flags);
  await cmdAnswer(["t1", "--skip", "--reason", "not relevant"], flags);
  expect(calls).toEqual([
    { id: "oq1", body: { skip: true } },
    { id: "oq1", body: { skip: true, message: "not relevant" } },
  ]);
});

test("opencode question: an empty --reason is omitted from the skip", async () => {
  const calls = askClient(ocAskReq());
  await cmdAnswer(["t1", "--skip", "--reason", "   "], flags);
  expect(calls).toEqual([{ id: "oq1", body: { skip: true } }]);
});

test("opencode question: the Skip row asks for a reason, and an empty one skips without words", async () => {
  const calls = askClient(ocAskReq());
  selectImpl = pickLabel("Skip");
  textImpl = async () => "I will decide later";
  await cmdAnswer(["t1"], flags);
  textImpl = async () => "";
  await cmdAnswer(["t1"], flags);
  expect(calls).toEqual([
    { id: "oq1", body: { skip: true, message: "I will decide later" } },
    { id: "oq1", body: { skip: true } },
  ]);
});

test("opencode question: --reason without --skip is refused; --skip on a claude question is refused", async () => {
  const calls = askClient(ocAskReq());
  await expect(cmdAnswer(["t1", "--reason", "x"], flags)).rejects.toThrow("needs --skip");
  expect(calls).toEqual([]);
  const claudeCalls = askClient({ ...ocAskReq(), source: undefined });
  await expect(cmdAnswer(["t1", "--skip"], flags)).rejects.toThrow("only skips an OpenCode question");
  expect(claudeCalls).toEqual([]);
});

test("opencode question: a refused skip (400) is printed and leaves the card pending", async () => {
  outputs.length = 0;
  askClient(ocAskReq(), async () => {
    throw new ApiError(400, { error: "message is too long (max 4096 characters)" }, "message is too long (max 4096 characters)");
  });
  await cmdAnswer(["t1", "--skip", "--reason", "x"], flags);
  expect(outputs.some((l) => l.includes("too long"))).toBe(true);
  expect(outputs.some((l) => l.includes("skipped"))).toBe(false);
});

test("opencode question: text from the card prints escaped", async () => {
  outputs.length = 0;
  const base = ocAskReq();
  askClient(ocAskReq({ title: "Pick\u001b[2J", questions: [{ ...base.questions[0]!, question: "Q\u001b[31m?" }] }));
  selectImpl = async () => CANCEL;
  await cmdAnswer(["t1"], flags);
  expect(outputs.join("\n")).not.toContain("\u001b");
});

test("opencode permission: --reason with two permission cards pending answers neither", async () => {
  const calls: Array<{ id: string; body: unknown }> = [];
  currentClient = {
    listTasks: async () => [{ id: "t1", title: "T" }],
    pendingInteractions: async () => [ocPermReq({ id: "oc1" }), ocPermReq({ id: "oc2" })],
    answerFxPermission: async (id: string, body: unknown) => {
      calls.push({ id, body });
      return { ok: true };
    },
  } as unknown as AgetorClient;
  selectImpl = async () => {
    throw new Error("must not prompt");
  };
  await expect(cmdAnswer(["t1", "--reason", "no"], flags)).rejects.toThrow("several are pending");
  expect(calls).toEqual([]);
});

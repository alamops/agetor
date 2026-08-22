import { test, expect, mock, afterAll } from "bun:test";
import type { AgetorClient } from "./api-client.ts";
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

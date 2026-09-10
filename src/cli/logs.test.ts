import { test, expect, mock, afterAll } from "bun:test";
import type { AgetorClient } from "./api-client.ts";
import type { RunEvent } from "../shared/types.ts";
import { FX_RECOVERY_STATUS_PREFIX, FX_USAGE_STATUS_PREFIX, PERMISSION_MODE_STATUS_PREFIX } from "../shared/types.ts";
import { fxRecoveryNoticeText, parseFxRecoveryPayload } from "../shared/fx-recovery.ts";

/**
 * `formatEvent`/`shouldSkipEvent`/`createLineRenderer` (in commands/logs.ts)
 * aren't exported — only `cmdLogs` is. Most of this suite drives `cmdLogs`'s
 * `--rebuild` branch, which calls `client.rebuildEvents(...)` once and
 * formats the result synchronously — no SSE involved, so only `./context.ts`
 * (for `getClient`) and `./output.ts` (to capture `out()`) need mocking for
 * those tests. A handful of fx-recovery tests below additionally exercise the
 * streaming (`--no-follow`) path — proving `createLineRenderer` is the SAME
 * renderer both branches share — by mocking `./sse.ts` the way
 * `Dashboard.test.tsx` does, capturing the `/tasks/:id/events` subscription's
 * `onEvent` callback so the test can push synthetic `RunEvent`s by hand.
 *
 * All three mocked modules are snapshotted before mocking and restored in
 * `afterAll` — `mock.module` overwrites the module record in place (Bun's
 * documented behavior for already-loaded modules), and other test files in
 * the same `bun test` process import these same modules.
 */

import * as realContext from "./context.ts";
import * as realOutput from "./output.ts";
import * as realSse from "./sse.ts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };
const realSseSnapshot = { ...realSse };

let currentClient: AgetorClient | null = null;
const outputs: string[] = [];
let onTaskEvents: ((e: RunEvent) => void) | null = null;

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
  errln: () => {},
}));

mock.module("./sse.ts", () => ({
  ...realSseSnapshot,
  streamSse: (pathname: string, onEvent: (e: unknown) => void) => {
    if (pathname.startsWith("/tasks/") && pathname.includes("/events")) {
      onTaskEvents = onEvent as (e: RunEvent) => void;
    }
    return { close: () => {} };
  },
}));

afterAll(() => {
  mock.module("./context.ts", () => realContextSnapshot);
  mock.module("./output.ts", () => realOutputSnapshot);
  mock.module("./sse.ts", () => realSseSnapshot);
});

const { cmdLogs } = await import("./commands/logs.ts");

function makeClient(events: RunEvent[]): AgetorClient {
  return {
    listTasks: async () => [{ id: "t1", title: "T" }],
    getRuns: async () => [{ id: "run1" }],
    rebuildEvents: async () => ({ events }),
  } as unknown as AgetorClient;
}

const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdLogs>[1];
const jsonFlags = { ...flags, json: true } as unknown as Parameters<typeof cmdLogs>[1];

test("logs --rebuild: an fx_permission interaction gets the fx-specific line", async () => {
  outputs.length = 0;
  const e: RunEvent = {
    runId: "run1", taskId: "t1", stream: "interaction",
    data: JSON.stringify({ kind: "fx_permission" }), ts: 1,
  };
  currentClient = makeClient([e]);
  await cmdLogs(["t1", "--rebuild"], flags);
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toContain("! fx is requesting permission — agetor answer t1");
});

test("logs --rebuild: a non-fx interaction gets the generic '(kind)' line", async () => {
  outputs.length = 0;
  const e: RunEvent = {
    runId: "run1", taskId: "t1", stream: "interaction",
    data: JSON.stringify({ kind: "ask_questions" }), ts: 1,
  };
  currentClient = makeClient([e]);
  await cmdLogs(["t1", "--rebuild"], flags);
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toContain("! needs answer (ask_questions) — agetor answer t1");
});

test("logs --rebuild: internal-only status sentinels (fx-usage, permission-mode) are suppressed", async () => {
  outputs.length = 0;
  const events: RunEvent[] = [
    { runId: "run1", taskId: "t1", stream: "status", data: `${FX_USAGE_STATUS_PREFIX}{"used":1,"size":2}`, ts: 1 },
    { runId: "run1", taskId: "t1", stream: "status", data: `${PERMISSION_MODE_STATUS_PREFIX}auto`, ts: 2 },
    { runId: "run1", taskId: "t1", stream: "status", data: "plain status text", ts: 3 },
  ];
  currentClient = makeClient(events);
  await cmdLogs(["t1", "--rebuild"], flags);
  // Only the plain status line survives the human-readable render.
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toContain("plain status text");
  expect(outputs.join("\n")).not.toContain(FX_USAGE_STATUS_PREFIX);
  expect(outputs.join("\n")).not.toContain(PERMISSION_MODE_STATUS_PREFIX);
});

test("logs --rebuild --json: sentinel status events are still emitted raw for programmatic consumers", async () => {
  outputs.length = 0;
  const events: RunEvent[] = [
    { runId: "run1", taskId: "t1", stream: "status", data: `${FX_USAGE_STATUS_PREFIX}{"used":1,"size":2}`, ts: 1 },
  ];
  currentClient = makeClient(events);
  await cmdLogs(["t1", "--rebuild"], jsonFlags);
  expect(outputs).toHaveLength(1);
  expect(JSON.parse(outputs[0]!)).toEqual(events[0]);
});

// --- fx-recovery sentinel rendering (src/shared/fx-recovery.ts, docs/plans/
// fix-fx-harness-rate-limit.md) --------------------------------------------
// `createLineRenderer` special-cases `FX_RECOVERY_STATUS_PREFIX` BEFORE the
// generic `shouldSkipEvent` check: an `active` payload is fx's own live
// retry-progress line and prints in yellow; every other state
// (`paused`/`recovered`/`cleared`) — or a body that fails to parse — prints
// nothing, since the driver already persists a separate plain status line at
// those terminal transitions (rendered by the ordinary "status" case, not
// this branch). `--json` always emits the raw event regardless of state.

function fxRecoveryEvent(payload: Record<string, unknown>, ts = 1): RunEvent {
  return {
    runId: "run1", taskId: "t1", stream: "status",
    data: `${FX_RECOVERY_STATUS_PREFIX}${JSON.stringify(payload)}`,
    ts,
  };
}

test("logs --rebuild: an fx-recovery 'active' sentinel renders one yellow line equal to fxRecoveryNoticeText(payload)", async () => {
  outputs.length = 0;
  const payload = {
    state: "active", kind: "auto_retry", cause: "rate_limited", action: "retrying_request",
    attempt: 5, attemptLimit: 10, delaySeconds: 8, durable: true,
    message: "⚠ Rate limited · HTTP 429 · rate_limit_exceeded: … · retrying request in 8s · attempt 5/10",
  };
  currentClient = makeClient([fxRecoveryEvent(payload)]);
  await cmdLogs(["t1", "--rebuild"], flags);
  expect(outputs).toHaveLength(1);
  // `c.yellow` is mocked to identity above, so the printed line is exactly
  // `fxRecoveryNoticeText`'s output (here, fx's own verbatim `message`).
  expect(outputs[0]).toBe(fxRecoveryNoticeText(parseFxRecoveryPayload(JSON.stringify(payload))!));
  expect(outputs[0]).toBe(payload.message);
});

test("logs --rebuild: paused/recovered/cleared fx-recovery sentinels render nothing; a plain status line still prints", async () => {
  outputs.length = 0;
  const events: RunEvent[] = [
    fxRecoveryEvent({ state: "paused", message: "⚠ Rate limited · HTTP 429 · … · recovery paused after 10/10 attempts" }, 1),
    fxRecoveryEvent({ state: "recovered", message: "✓ recovered · succeeded on attempt 3/10" }, 2),
    fxRecoveryEvent({ state: "cleared" }, 3),
    { runId: "run1", taskId: "t1", stream: "status", data: "plain status text", ts: 4 },
  ];
  currentClient = makeClient(events);
  await cmdLogs(["t1", "--rebuild"], flags);
  // Only the plain status line survives the human-readable render — the
  // driver's own persisted plain lines cover paused/recovered, and cleared
  // has nothing to show at all.
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toContain("plain status text");
});

test("logs --rebuild: a REPLAYED fx-recovery 'active' sentinel renders nothing; a LIVE 'active' sentinel still renders", async () => {
  outputs.length = 0;
  const events: RunEvent[] = [
    fxRecoveryEvent({ state: "active", message: "stale replayed attempt", replayed: true }, 1),
    fxRecoveryEvent({ state: "paused", message: "stale replayed pause", replayed: true }, 2),
    fxRecoveryEvent({ state: "active", message: "live attempt 1/3" }, 3),
  ];
  currentClient = makeClient(events);
  await cmdLogs(["t1", "--rebuild"], flags);
  // On `session/resume` fx replays the prior turn's recovery updates onto
  // the new run, and the driver stamps those with `replayed: true` — they
  // must not read as live retry progress. Only the LIVE active sentinel
  // (no `replayed` flag) prints.
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toBe("live attempt 1/3");
});

test("logs --rebuild: a malformed fx-recovery sentinel body renders nothing and doesn't throw", async () => {
  outputs.length = 0;
  const bad: RunEvent = {
    runId: "run1", taskId: "t1", stream: "status",
    data: `${FX_RECOVERY_STATUS_PREFIX}not json`, ts: 1,
  };
  currentClient = makeClient([bad]);
  await expect(cmdLogs(["t1", "--rebuild"], flags)).resolves.toBeUndefined();
  expect(outputs).toHaveLength(0);
});

test("logs --rebuild --json: fx-recovery sentinels of every state (and a malformed one) are still emitted raw", async () => {
  outputs.length = 0;
  const events: RunEvent[] = [
    fxRecoveryEvent({ state: "active", attempt: 1, attemptLimit: 3 }, 1),
    fxRecoveryEvent({ state: "paused" }, 2),
    fxRecoveryEvent({ state: "recovered" }, 3),
    fxRecoveryEvent({ state: "cleared" }, 4),
    { runId: "run1", taskId: "t1", stream: "status", data: `${FX_RECOVERY_STATUS_PREFIX}not json`, ts: 5 },
  ];
  currentClient = makeClient(events);
  await cmdLogs(["t1", "--rebuild"], jsonFlags);
  expect(outputs).toHaveLength(events.length);
  outputs.forEach((line, i) => expect(JSON.parse(line)).toEqual(events[i]));
});

test("logs (streaming, --no-follow): the fx-recovery renderer is the SAME as --rebuild's — an 'active' sentinel prints yellow, a plain status prints normally", async () => {
  onTaskEvents = null;
  outputs.length = 0;
  currentClient = makeClient([]); // rebuildEvents unused on this path
  const payload = { state: "active", cause: "rate_limited", action: "retrying_request", attempt: 2, attemptLimit: 3 };

  const done = cmdLogs(["t1", "--no-follow"], flags);
  // Let the promise executor run far enough to open the SSE subscription
  // (a handful of already-resolved microtasks: `resolveTask`'s stubbed
  // `listTasks()`, then the synchronous `streamSse` call inside the
  // `new Promise` executor) before pushing synthetic events into it.
  await new Promise((r) => setTimeout(r, 20));
  expect(onTaskEvents).not.toBeNull();

  onTaskEvents!(fxRecoveryEvent(payload));
  onTaskEvents!({ runId: "run1", taskId: "t1", stream: "status", data: "plain status text", ts: 2 });
  await done; // `--no-follow` resolves on its own once the replay burst goes quiet

  expect(outputs).toEqual([
    fxRecoveryNoticeText(parseFxRecoveryPayload(JSON.stringify(payload))!),
    "• plain status text",
  ]);
});

test("logs (streaming, --no-follow): a REPLAYED 'active' sentinel prints nothing on the streaming path either — same renderer as --rebuild", async () => {
  onTaskEvents = null;
  outputs.length = 0;
  currentClient = makeClient([]); // rebuildEvents unused on this path

  const done = cmdLogs(["t1", "--no-follow"], flags);
  await new Promise((r) => setTimeout(r, 20));
  expect(onTaskEvents).not.toBeNull();

  onTaskEvents!(fxRecoveryEvent({ state: "active", message: "stale replayed attempt", replayed: true }, 1));
  onTaskEvents!(fxRecoveryEvent({ state: "active", message: "live attempt 1/3" }, 2));
  await done;

  expect(outputs).toEqual(["live attempt 1/3"]);
});

// --- userMessageLines rendering (src/shared/user-message.ts) --------------
// `formatEvent`'s "user" case is a thin wrapper over `userMessageLines` +
// `colorLabel`; with `output.ts`'s `c` helpers mocked to identity above, the
// colored label is indistinguishable from the raw label text, so these
// assert on the exact rendered strings.

test("logs --rebuild: an ordinary user event still renders you› <text>, unchanged", async () => {
  outputs.length = 0;
  const e: RunEvent = {
    runId: "run1", taskId: "t1", stream: "user",
    data: "hello there", ts: 1,
  };
  currentClient = makeClient([e]);
  await cmdLogs(["t1", "--rebuild"], flags);
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toBe("you› hello there");
});

test("logs --rebuild: a forked-skill-launch user event renders cmd›/skill› lines with no raw tags", async () => {
  outputs.length = 0;
  const data =
    "<local-command-stdout>Running in the background as @code-review</local-command-stdout>\n" +
    '<forked-skill-launch>{"agentId":"a7db6829e09d1ba9b","skillName":"code-review","description":"/code-review"}</forked-skill-launch>';
  const e: RunEvent = { runId: "run1", taskId: "t1", stream: "user", data, ts: 1 };
  currentClient = makeClient([e]);
  await cmdLogs(["t1", "--rebuild"], flags);
  expect(outputs).toHaveLength(1);
  expect(outputs[0]!.split("\n")).toEqual([
    "cmd› Running in the background as @code-review",
    "skill› /code-review launched in background (agent a7db6829)",
  ]);
  expect(outputs[0]).not.toContain("<forked-skill-launch");
  expect(outputs[0]).not.toContain("<local-command-stdout");
});

test("logs --rebuild: a bash-input/bash-stdout/bash-stderr pair renders sh›/err› with no out› line", async () => {
  outputs.length = 0;
  const events: RunEvent[] = [
    {
      runId: "run1", taskId: "t1", stream: "user",
      data: "<bash-input>supabase db push --linked</bash-input>", ts: 1,
    },
    {
      runId: "run1", taskId: "t1", stream: "user",
      data: "<bash-stdout></bash-stdout><bash-stderr>(eval):1: command not found: supabase\n</bash-stderr>",
      ts: 2,
    },
  ];
  currentClient = makeClient(events);
  await cmdLogs(["t1", "--rebuild"], flags);
  expect(outputs).toHaveLength(2);
  expect(outputs[0]).toBe("sh› $ supabase db push --linked");
  expect(outputs[1]).toBe("err› (eval):1: command not found: supabase");
  expect(outputs.join("\n")).not.toContain("out›");
});

test("logs --rebuild: a user-typed <context> tag renders a context› line followed by you›", async () => {
  outputs.length = 0;
  const e: RunEvent = {
    runId: "run1", taskId: "t1", stream: "user",
    data: "<context>\nWe migrate X\n</context>\n\nPlease do Y", ts: 1,
  };
  currentClient = makeClient([e]);
  await cmdLogs(["t1", "--rebuild"], flags);
  expect(outputs).toHaveLength(1);
  expect(outputs[0]!.split("\n")).toEqual([
    "context› We migrate X",
    "you› Please do Y",
  ]);
});

test("logs --rebuild: the slash-command XML twin renders you› /name args", async () => {
  outputs.length = 0;
  const e: RunEvent = {
    runId: "run1", taskId: "t1", stream: "user",
    data: "<command-message>x</command-message>\n<command-name>/x</command-name>\n<command-args>do it</command-args>",
    ts: 1,
  };
  currentClient = makeClient([e]);
  await cmdLogs(["t1", "--rebuild"], flags);
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toBe("you› /x do it");
});

// --- Phase 8 review fix: command args containing tags (src/shared/user-message.ts Fix 5a) ---

test("logs --rebuild: a slash-command whose args contain a tag renders you›/name then per-segment lines, no raw <context>", async () => {
  outputs.length = 0;
  const e: RunEvent = {
    runId: "run1", taskId: "t1", stream: "user",
    data:
      "<command-message>x</command-message>\n<command-name>/x</command-name>\n<command-args>see <context>ctx</context> now</command-args>",
    ts: 1,
  };
  currentClient = makeClient([e]);
  await cmdLogs(["t1", "--rebuild"], flags);
  expect(outputs).toHaveLength(1);
  expect(outputs[0]!.split("\n")).toEqual([
    "you› /x",
    "you› see",
    "context› ctx",
    "you› now",
  ]);
  expect(outputs[0]).not.toContain("<context>");
});

// --- SendUserFile pairing (src/shared/sent-files.ts) -----------------------
// A `SendUserFile` tool_use always renders its "sending" form on its own
// line; when a later `tool_result` event carries the matching `toolUseId`,
// that tool_result line renders the final `sent …` / `send failed …` form
// INSTEAD of the generic `↳ result`/`↳ error` — both lines print (this is a
// scrolling log, not a live-redrawn card), which is what lets `--rebuild`
// and `--follow` show progress the same way.

test("logs --rebuild: a SendUserFile tool_use renders a 'sending' line", async () => {
  outputs.length = 0;
  const e: RunEvent = {
    runId: "run1", taskId: "t1", stream: "tool_use",
    data: JSON.stringify({
      id: "toolu_1", name: "SendUserFile",
      input: { files: ["/tmp/a.png", "/tmp/b.md"], caption: "here", status: "normal" },
    }),
    ts: 1,
  };
  currentClient = makeClient([e]);
  await cmdLogs(["t1", "--rebuild"], flags);
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toBe("📎 sending 2 files: a.png, b.md");
});

test("logs --rebuild: a SendUserFile tool_use paired with a delivered tool_result renders 'sending' then 'sent … (size)'", async () => {
  outputs.length = 0;
  const events: RunEvent[] = [
    {
      runId: "run1", taskId: "t1", stream: "tool_use",
      data: JSON.stringify({
        id: "toolu_1", name: "SendUserFile",
        input: { files: ["/tmp/a.png", "/tmp/b.md"], caption: "here", status: "normal" },
      }),
      ts: 1,
    },
    {
      runId: "run1", taskId: "t1", stream: "tool_result",
      data: JSON.stringify({
        toolUseId: "toolu_1",
        content: "2 files delivered to user.\n  /tmp/a.png → file_uuid: abc\n  /tmp/b.md → file_uuid: def",
        isError: false,
        attachments: [
          { path: "/tmp/a.png", size: 2048, isImage: true, media_type: "image/png" },
          { path: "/tmp/b.md", size: null, isImage: false, media_type: null },
        ],
      }),
      ts: 2,
    },
  ];
  currentClient = makeClient(events);
  await cmdLogs(["t1", "--rebuild"], flags);
  expect(outputs).toHaveLength(2);
  expect(outputs[0]).toBe("📎 sending 2 files: a.png, b.md");
  expect(outputs[1]).toBe("📎 sent 2 files: a.png (2.0 KB), b.md");
});

test("logs --rebuild: a SendUserFile tool_use paired with an errored tool_result renders 'send failed (…): <error>' instead of ↳ error", async () => {
  outputs.length = 0;
  const events: RunEvent[] = [
    {
      runId: "run1", taskId: "t1", stream: "tool_use",
      data: JSON.stringify({
        id: "toolu_2", name: "SendUserFile",
        input: { files: ["/tmp/dir"], status: "normal" },
      }),
      ts: 1,
    },
    {
      runId: "run1", taskId: "t1", stream: "tool_result",
      data: JSON.stringify({
        toolUseId: "toolu_2",
        content: '<tool_use_error>Attachment "/tmp/dir" is not a regular file.</tool_use_error>',
        isError: true,
      }),
      ts: 2,
    },
  ];
  currentClient = makeClient(events);
  await cmdLogs(["t1", "--rebuild"], flags);
  expect(outputs).toHaveLength(2);
  expect(outputs[0]).toBe("📎 sending 1 file: dir");
  expect(outputs[1]).toBe('📎 send failed (dir): Attachment "/tmp/dir" is not a regular file.');
  expect(outputs[1]).not.toContain("↳");
  expect(outputs[1]).not.toContain("<tool_use_error>");
});

test("logs --rebuild: an ordinary (non-SendUserFile) tool_use/tool_result pair is unaffected", async () => {
  outputs.length = 0;
  const events: RunEvent[] = [
    { runId: "run1", taskId: "t1", stream: "tool_use", data: JSON.stringify({ id: "toolu_9", name: "Bash", input: { command: "ls" } }), ts: 1 },
    { runId: "run1", taskId: "t1", stream: "tool_result", data: JSON.stringify({ toolUseId: "toolu_9", content: "ok", isError: false }), ts: 2 },
  ];
  currentClient = makeClient(events);
  await cmdLogs(["t1", "--rebuild"], flags);
  expect(outputs).toHaveLength(2);
  expect(outputs[0]).toBe("▸ Bash");
  expect(outputs[1]).toBe("  ↳ result");
});

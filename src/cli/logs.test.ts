import { test, expect, mock, afterAll } from "bun:test";
import type { AgetorClient } from "./api-client.ts";
import type { RunEvent } from "../shared/types.ts";
import { FX_USAGE_STATUS_PREFIX, PERMISSION_MODE_STATUS_PREFIX } from "../shared/types.ts";

/**
 * `formatEvent`/`shouldSkipEvent` (in commands/logs.ts) aren't exported —
 * only `cmdLogs` is. Rather than exercise the SSE-follow path (which would
 * need to mock `../sse.ts` the way Dashboard.test.tsx does), this suite
 * drives `cmdLogs`'s `--rebuild` branch, which calls
 * `client.rebuildEvents(...)` once and formats the result synchronously —
 * no SSE involved, so only `./context.ts` (for `getClient`) and `./output.ts`
 * (to capture `out()`) need mocking.
 *
 * Both mocked modules are snapshotted before mocking and restored in
 * `afterAll` — `mock.module` overwrites the module record in place (Bun's
 * documented behavior for already-loaded modules), and other test files in
 * the same `bun test` process import these same modules.
 */

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

afterAll(() => {
  mock.module("./context.ts", () => realContextSnapshot);
  mock.module("./output.ts", () => realOutputSnapshot);
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

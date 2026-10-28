import { test, expect, describe, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deriveTodoProgress } from "../shared/todo-progress.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-opencode-export-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

const {
  parseOpencodeExport,
  exportToEvents,
  exportIsComplete,
  exportOutcome,
  exportSummary,
  exportTurnUsage,
  opencodeExportArgv,
  runOpencodeExport,
  fakeOpencodeChildExport,
  __forTest,
} = await import("./opencode-export.ts");
const { rmTestDataDir } = await import("./test-data-dir.ts");

afterAll(() => {
  rmTestDataDir(DATA_DIR);
});

const FIXTURES = path.join(import.meta.dir, "fixtures", "opencode");
function load(name: string, major: 1 | 2) {
  const exp = parseOpencodeExport(readFileSync(path.join(FIXTURES, name), "utf8"), major);
  if (!exp) throw new Error(`fixture ${name} did not parse`);
  return exp;
}

describe("v2 session export", () => {
  test("events: user text, reasoning, text, tool pairs with opencode:<messageId>:<index> uuids", () => {
    const events = exportToEvents(load("v2-session-export.json", 2));
    expect(events[0]).toMatchObject({ stream: "user", lineUuid: "opencode:msg_17d9ec75e001Uf4pGKwCsNMK0E:user" });
    expect(events[0]!.data).toStartWith("Do exactly these steps");
    const err = events.find((e) => e.lineUuid === "opencode:msg_17d9ec7c6001prAtY1IaP7YKCE:1:result")!;
    expect(JSON.parse(err.data)).toEqual({
      toolUseId: "1de40417-3388-46a1-9960-9d3a91f9b7d2",
      content: "File not found: ./missing-file.txt",
      isError: true,
    });
    const sub = events.find((e) => e.lineUuid === "opencode:msg_17d9ecff1001Ed4XZJ9KuBr41I:2:use")!;
    expect(JSON.parse(sub.data)).toMatchObject({ id: "e378f6ce-23b8-41aa-b25a-5da46ebae15a", name: "subagent" });
    const subRes = JSON.parse(events.find((e) => e.lineUuid === "opencode:msg_17d9ecff1001Ed4XZJ9KuBr41I:2:result")!.data);
    expect(subRes.content).toContain('<subagent sessionID="ses_e82612922ffe6VVY5SiPNRsanX"');
    expect(events.filter((e) => e.stream === "thinking")).toHaveLength(3);
    expect(events.at(-1)).toEqual({ stream: "assistant", data: "DONE", lineUuid: "opencode:msg_17d9ede21001PUEoOHh0CabOSp:1" });
    // Every uuid is unique, and a re-map yields the same list.
    const uuids = events.map((e) => e.lineUuid);
    expect(new Set(uuids).size).toBe(uuids.length);
    expect(exportToEvents(load("v2-session-export.json", 2)).map((e) => e.lineUuid)).toEqual(uuids);
  });

  test("sinceMessageCount skips leading messages", () => {
    const events = exportToEvents(load("v2-session-export.json", 2), { sinceMessageCount: 3 });
    expect(events.map((e) => e.stream)).toEqual(["thinking", "assistant"]);
  });

  test("completeness and outcome: finished parent/child vs the dead background child", () => {
    expect(exportIsComplete(load("v2-session-export.json", 2))).toBe(true);
    expect(exportOutcome(load("v2-session-export-child.json", 2))).toBe("succeeded");
    const dead = load("v2-session-export-bg-child-dead.json", 2);
    expect(exportIsComplete(dead)).toBe(false);
    expect(exportOutcome(dead)).toBe("unfinished");
  });

  test("summary: parent and child", () => {
    expect(exportSummary(load("v2-session-export.json", 2))).toEqual({
      sessionId: "ses_e8261398affehUf22D8iOXNtgS",
      title: null,
      directory: "/Users/test/project",
      model: "opencode/glm-5.3-flash-free",
      variant: "default",
      agent: "build",
      firstUserText: expect.stringContaining("Do exactly these steps"),
      updatedAt: 1793108926663,
      createdAt: 1793108920151,
      complete: true,
    });
    expect(exportSummary(load("v2-session-export-child.json", 2))).toMatchObject({
      title: "List files in current directory",
      agent: "explore",
      complete: true,
    });
  });

  test("turn usage sums the assistant messages after the last user message", () => {
    expect(exportTurnUsage(load("v2-session-export.json", 2))).toEqual({
      input: 5489 + 498 + 419,
      output: 13 + 57 + 2,
      reasoning: 218 + 35 + 33,
      cacheRead: 5248 + 5504,
      cacheWrite: 0,
      cost: 0,
    });
    expect(exportTurnUsage(load("v2-session-export-bg-child-dead.json", 2))).toBeNull();
  });

  test("todowrite in an export is surfaced as TodoWrite", () => {
    const exp = parseOpencodeExport(JSON.stringify({
      info: { id: "ses_t", outcome: "succeeded" },
      messages: [{
        id: "msg_a", type: "assistant",
        content: [{ type: "tool", id: "c1", name: "todowrite", state: { status: "completed", input: { todos: [{ content: "a", status: "cancelled" }] }, content: [{ type: "text", text: "ok" }] } }],
      }],
    }), 2)!;
    const events = exportToEvents(exp);
    expect(JSON.parse(events[0]!.data)).toMatchObject({ name: "TodoWrite", input: { todos: [{ content: "a", status: "completed" }] } });
    expect(deriveTodoProgress(events)).toMatchObject({ completed: 1, total: 1 });
  });
});

describe("v1 export", () => {
  test("events reuse the run mapper's part uuids; user text parts become user events", () => {
    const events = exportToEvents(load("v1-session-export.json", 1));
    expect(events[0]).toMatchObject({ stream: "user", lineUuid: "opencode:text:prt_17da13f19001vPP26aWmXtSUid" });
    expect(events.find((e) => e.lineUuid === "opencode:tool:prt_17da14900001XvwH5fyF5FUIZ8:result")).toBeDefined();
    expect(events.find((e) => e.lineUuid === "opencode:tool:prt_17da14f26001CEiXMmgv7UAXv9:use")).toBeDefined();
    expect(events.at(-1)).toEqual({ stream: "assistant", data: "DONE", lineUuid: "opencode:text:prt_17da16711001Fgl9hIq7o8ezFL" });
    // step parts produce nothing
    expect(events.some((e) => e.data.includes("step-finish"))).toBe(false);
  });

  test("completeness, summary and usage", () => {
    const exp = load("v1-session-export.json", 1);
    expect(exportIsComplete(exp)).toBe(true);
    expect(exportOutcome(exp)).toBe("succeeded");
    expect(exportSummary(exp)).toMatchObject({
      sessionId: "ses_e825ec104ffenteQsfLQHUAZwn",
      title: "Reading missing file and subagent directory listing",
      directory: "/Users/test/project",
      model: "opencode/glm-5.3-flash-free",
      agent: "build",
      firstUserText: expect.stringContaining("Do exactly these steps"),
      complete: true,
    });
    expect(exportTurnUsage(exp)).toMatchObject({ input: 7758 + 3077 + 3212, output: 92 + 54 + 3 });
    const child = load("v1-session-export-child.json", 1);
    expect(exportSummary(child)).toMatchObject({ agent: "explore", title: "List files in directory (@explore subagent)" });
    expect(exportToEvents(child).filter((e) => e.stream === "tool_use")).toHaveLength(1);
  });

  test("an unfinished v1 export (last assistant without time.completed) is incomplete", () => {
    const raw = JSON.parse(readFileSync(path.join(FIXTURES, "v1-session-export-child.json"), "utf8"));
    delete raw.messages.at(-1).info.time.completed;
    const exp = parseOpencodeExport(JSON.stringify(raw), 1)!;
    expect(exportIsComplete(exp)).toBe(false);
    expect(exportOutcome(exp)).toBe("unfinished");
  });
});

test("parse tolerates chatter around the JSON and rejects non-exports", () => {
  expect(parseOpencodeExport(`Exporting session: x\n{"info":{"id":"ses_a"},"messages":[]}\n`, 1)).not.toBeNull();
  expect(parseOpencodeExport("not json", 2)).toBeNull();
  expect(parseOpencodeExport(`{"info":{},"messages":[]}`, 2)).toBeNull();
  expect(parseOpencodeExport(`{"info":{"id":"x"}}`, 2)).toBeNull();
});

test("export argv per line", () => {
  expect(opencodeExportArgv({ bin: "oc", sessionId: "ses_a", major: 2, standalone: true })).toEqual(["oc", "session", "export", "--standalone", "ses_a"]);
  expect(opencodeExportArgv({ bin: "oc", sessionId: "ses_a", major: 2, standalone: false })).toEqual(["oc", "session", "export", "ses_a"]);
  expect(opencodeExportArgv({ bin: "oc", sessionId: "ses_a", major: 1, standalone: true })).toEqual(["oc", "export", "ses_a"]);
});

test("runOpencodeExport runs the binary with the harness env; non-zero exit → null", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-opencode-export-bin-"));
  const bin = path.join(dir, "opencode");
  const fixture = path.join(FIXTURES, "v1-session-export.json");
  writeFileSync(bin, `#!/bin/sh
echo "$@" > ${JSON.stringify(path.join(dir, "argv"))}
echo "$XDG_DATA_HOME" > ${JSON.stringify(path.join(dir, "env"))}
if [ "$2" = "ses_missing" ]; then echo "Error: Session not found: ses_missing" >&2; exit 1; fi
echo "Exporting session: $2" >&2
cat ${JSON.stringify(fixture)}
`);
  chmodSync(bin, 0o755);
  const exp = await runOpencodeExport({ sessionId: "ses_e825ec104ffenteQsfLQHUAZwn", bin, env: { XDG_DATA_HOME: "/x/share" }, cwd: dir, major: 1, standalone: false });
  expect(exp?.major).toBe(1);
  expect(readFileSync(path.join(dir, "argv"), "utf8").trim()).toBe("export ses_e825ec104ffenteQsfLQHUAZwn");
  expect(readFileSync(path.join(dir, "env"), "utf8").trim()).toBe("/x/share");
  expect(await runOpencodeExport({ sessionId: "ses_missing", bin, env: {}, cwd: dir, major: 1, standalone: false })).toBeNull();
  expect(await runOpencodeExport({ sessionId: "ses_a", bin: path.join(dir, "nope"), env: {}, cwd: dir, major: 2, standalone: true })).toBeNull();
});

test("runOpencodeExport times out", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-opencode-export-slow-"));
  const bin = path.join(dir, "opencode");
  writeFileSync(bin, "#!/bin/sh\nsleep 5\n");
  chmodSync(bin, 0o755);
  const t0 = Date.now();
  expect(await runOpencodeExport({ sessionId: "ses_a", bin, env: {}, cwd: dir, major: 2, standalone: true, timeoutMs: 300 })).toBeNull();
  expect(Date.now() - t0).toBeLessThan(3_000);
});

test("fake seam: ses_fakechild ids get the canned complete child export; __forTest override wins", async () => {
  const prevDriver = process.env.AGETOR_OPENCODE_DRIVER;
  process.env.AGETOR_OPENCODE_DRIVER = "fake";
  try {
    const exp = await runOpencodeExport({ sessionId: "ses_fakechild01", bin: "/nonexistent", env: {}, cwd: "/tmp", major: 2, standalone: true });
    expect(exp).not.toBeNull();
    expect(exportIsComplete(exp!)).toBe(true);
    const events = exportToEvents(exp!);
    expect(events.some((e) => e.stream === "assistant")).toBe(true);
    expect(events.filter((e) => e.stream === "tool_use")).toHaveLength(1);
    expect(events.filter((e) => e.stream === "tool_result")).toHaveLength(1);
    // A non-fakechild id still goes to the (missing) binary.
    expect(await runOpencodeExport({ sessionId: "ses_other", bin: "/nonexistent", env: {}, cwd: "/tmp", major: 2, standalone: true })).toBeNull();

    const prev = __forTest.setExportRunner(async () => fakeOpencodeChildExport("ses_override", "/tmp"));
    try {
      expect(exportSummary((await runOpencodeExport({ sessionId: "ses_other", bin: "x", env: {}, cwd: "/tmp", major: 2, standalone: true }))!).sessionId)
        .toBe("ses_override");
    } finally {
      __forTest.setExportRunner(prev);
    }
  } finally {
    if (prevDriver === undefined) delete process.env.AGETOR_OPENCODE_DRIVER;
    else process.env.AGETOR_OPENCODE_DRIVER = prevDriver;
  }
});

import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../../shared/types.ts";
import { projectEvent } from "./projection.ts";

let id = 100;
const ev = (stream: RunEvent["stream"], data: string, over: Partial<RunEvent> = {}): RunEvent => ({
  id: ++id, runId: "r1", taskId: "t1", stream, data, ts: 1_800_000_000_000, subagentId: null, ...over,
}) as RunEvent;

describe("user messages", () => {
  test("a plain message has no tagged form, and its text is delivered clean", () => {
    const p = projectEvent(ev("user", "please continue"));
    expect(p.parsed).toEqual({ kind: "user", text: "please continue", message: null });
    expect(p.raw.data).toBe("please continue");
  });

  test("a slash-command expansion is parsed into a command", () => {
    const text = "<command-message>implement</command-message>\n<command-name>/implement</command-name>\n<command-args>add a thing</command-args>";
    const p = projectEvent(ev("user", text));
    expect(p.parsed).toMatchObject({ kind: "user", message: { kind: "command", command: { name: "/implement" } } });
  });

  test("local command output is parsed", () => {
    const p = projectEvent(ev("user", "<local-command-stdout>ok done</local-command-stdout>"));
    expect(p.parsed).toMatchObject({ message: { kind: "command-output", output: "ok done" } });
  });

  test("a tagged message with control tags carries its segments", () => {
    const p = projectEvent(ev("user", "<system-reminder>be careful</system-reminder>\nhello"));
    expect((p.parsed as { message: { kind: string } }).message.kind).toBe("tagged");
  });

  test("a bracketed paste wrapper is unwrapped in the text, the raw stays raw", () => {
    const wrapped = '<pasted_content id="ab12">\nmy follow-up\n</pasted_content id="ab12">';
    const p = projectEvent(ev("user", wrapped));
    expect((p.parsed as { text: string }).text).toBe("my follow-up");
    expect(p.raw.data).toBe(wrapped);
  });
});

describe("assistant text", () => {
  test("a handoff block is located, with its inner text", () => {
    const text = 'Done.\n<handoff>{"summary":"x","next":"review"}</handoff>';
    const p = projectEvent(ev("assistant", JSON.stringify({ text })));
    const blocks = (p.parsed as { blocks: Array<{ inner: string }> }).blocks;
    expect(p.parsed).toMatchObject({ kind: "handoff" });
    expect(blocks[0]!.inner).toBe('{"summary":"x","next":"review"}');
  });

  test("plain text and text with no handoff have no parsed form", () => {
    expect(projectEvent(ev("assistant", JSON.stringify({ text: "hello" }))).parsed).toBeNull();
    expect(projectEvent(ev("assistant", "just text")).parsed).toBeNull();
    expect(projectEvent(ev("assistant", "mentions <handoff> but never closes it")).parsed).toBeNull();
  });
});

describe("tool use", () => {
  test("SendUserFile is a sent-files request", () => {
    const p = projectEvent(ev("tool_use", JSON.stringify({ id: "tu1", name: "SendUserFile", input: { files: ["/tmp/a.png"], caption: "chart" } })));
    expect(p.parsed).toMatchObject({ kind: "sent-files-request", request: { files: ["/tmp/a.png"], caption: "chart" } });
  });

  test("TodoWrite is the TODO tracker state", () => {
    const input = { todos: [{ content: "A", status: "completed", activeForm: "Doing A" }, { content: "B", status: "in_progress", activeForm: "Doing B" }] };
    const p = projectEvent(ev("tool_use", JSON.stringify({ id: "tu2", name: "TodoWrite", input })));
    expect(p.parsed).toMatchObject({ kind: "todo" });
    expect((p.parsed as { progress: { todos: unknown[]; completed: number; total: number } }).progress).toMatchObject({ completed: 1, total: 2 });
  });

  test("any other tool, a malformed row and a bad request have none", () => {
    expect(projectEvent(ev("tool_use", JSON.stringify({ id: "tu3", name: "Bash", input: { command: "ls" } }))).parsed).toBeNull();
    expect(projectEvent(ev("tool_use", "not json")).parsed).toBeNull();
    expect(projectEvent(ev("tool_use", JSON.stringify({ name: "SendUserFile", input: { files: [] } }))).parsed).toBeNull();
  });
});

describe("tool results", () => {
  test("a result with attachments is a sent-files delivery", () => {
    const data = JSON.stringify({ toolUseId: "tu1", content: "1 file delivered to user", isError: false, attachments: [{ path: "/tmp/a.png", name: "a.png", mime: "image/png", size: 10 }] });
    const p = projectEvent(ev("tool_result", data));
    expect(p.parsed).toMatchObject({ kind: "sent-files-result", result: { delivered: true } });
    expect(p.truncated).toBeUndefined();
  });

  test("a small plain result is unchanged and has no parsed form", () => {
    const data = JSON.stringify({ toolUseId: "tu1", content: "ok", isError: false });
    const p = projectEvent(ev("tool_result", data));
    expect(p.parsed).toBeNull();
    expect(p.raw.data).toBe(data);
  });

  test("a result over 16 KB goes out cut, with the full size and the event id to fetch it by", () => {
    const big = "x".repeat(20_000);
    const e = ev("tool_result", JSON.stringify({ toolUseId: "tu9", content: big, isError: false }));
    const p = projectEvent(e, 1_800_000_000_000);
    expect(p.truncated).toEqual({ eventId: e.id!, fullBytes: e.data.length });
    expect(p.raw.data.length).toBeLessThan(17_500);
    expect(p.raw.data.length).toBeGreaterThan(16_000);
    const cut = JSON.parse(p.raw.data) as { retention: { trimmed: boolean; originalBytes: number }; toolUseId: string };
    expect(cut.retention).toMatchObject({ trimmed: true, originalBytes: e.data.length });
    expect(cut.toolUseId).toBe("tu9");
    // The stored event object itself is never modified.
    expect(e.data.length).toBeGreaterThan(20_000);
  });

  test("a result of exactly 16 KB or less is not cut", () => {
    const e = ev("tool_result", JSON.stringify({ toolUseId: "t", content: "y".repeat(15_900), isError: false }));
    expect(projectEvent(e).truncated).toBeUndefined();
  });

  test("a result that is not a JSON envelope cannot be cut, and says nothing it does not know", () => {
    const e = ev("tool_result", "z".repeat(30_000));
    const p = projectEvent(e);
    expect(p.truncated).toBeUndefined();
    expect(p.raw.data).toBe(e.data);
  });
});

describe("other streams", () => {
  test("a compaction summary carries its digest and size", () => {
    const text = "This session is being continued from a previous conversation.\nMore detail follows.";
    const p = projectEvent(ev("compaction_summary", text));
    expect(p.parsed).toMatchObject({ kind: "compaction-summary", bytes: text.length });
    expect((p.parsed as { line: string }).line).toContain("This session is being continued");
    expect((p.parsed as { line: string }).line).not.toContain("More detail follows");
  });

  test("streams with no shared parser go out raw", () => {
    for (const stream of ["stdout", "stderr", "status", "thinking", "subagent", "interaction"] as const) {
      const p = projectEvent(ev(stream, "whatever"));
      expect(p.parsed).toBeNull();
      expect(p.raw.data).toBe("whatever");
    }
  });
});

describe("projection never changes what was stored", () => {
  test("the input event object is untouched for every stream", () => {
    const events = [
      ev("user", "<system-reminder>x</system-reminder>"),
      ev("tool_result", JSON.stringify({ toolUseId: "t", content: "q".repeat(30_000), isError: false })),
      ev("assistant", JSON.stringify({ text: "<handoff>{}</handoff>" })),
    ];
    for (const e of events) {
      const before = JSON.stringify(e);
      projectEvent(e);
      expect(JSON.stringify(e)).toBe(before);
    }
  });

  test("a throwing parser path degrades to raw-only (fuzzed rows never throw)", () => {
    for (let i = 0; i < 500; i++) {
      const streams = ["user", "assistant", "tool_use", "tool_result", "compaction_summary"] as const;
      const data = Math.random() < 0.5 ? crypto.getRandomValues(new Uint8Array(40)).reduce((s, b) => s + String.fromCharCode(b), "") : JSON.stringify({ name: "SendUserFile", input: { files: [Math.random()] }, content: [null], attachments: "x" });
      expect(() => projectEvent(ev(streams[i % streams.length]!, data))).not.toThrow();
    }
  });
});

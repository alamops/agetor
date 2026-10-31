import { describe, expect, test } from "bun:test";
import { createSseParser, type SseFrame } from "./sse-parse.ts";

/** Feed `chunks` one by one and collect every frame. */
function parse(...chunks: string[]): SseFrame[] {
  const p = createSseParser();
  return chunks.flatMap((c) => p.push(c));
}

describe("createSseParser", () => {
  test("an unnamed event defaults to message", () => {
    expect(parse("data: hello\n\n")).toEqual([{ event: "message", data: "hello" }]);
  });

  test("a named event carries its type", () => {
    expect(parse("event: task\ndata: {\"a\":1}\n\n")).toEqual([
      { event: "task", data: '{"a":1}' },
    ]);
  });

  test("an empty event value dispatches as message", () => {
    expect(parse("event:\ndata: x\n\n")).toEqual([{ event: "message", data: "x" }]);
  });

  test("event type resets between frames", () => {
    expect(parse("event: a\ndata: 1\n\ndata: 2\n\n")).toEqual([
      { event: "a", data: "1" },
      { event: "message", data: "2" },
    ]);
  });

  test("multi-line data joins with a newline", () => {
    expect(parse("data: one\ndata: two\ndata:\ndata: four\n\n")).toEqual([
      { event: "message", data: "one\ntwo\n\nfour" },
    ]);
  });

  test("strips exactly one leading space from the value", () => {
    expect(parse("data:  two\n\ndata:none\n\n")).toEqual([
      { event: "message", data: " two" },
      { event: "message", data: "none" },
    ]);
  });

  test("a line without a colon is a field with an empty value", () => {
    // `data` alone is a data line with ""; it dispatches (the buffer isn't empty).
    expect(parse("data\n\n")).toEqual([{ event: "message", data: "" }]);
  });

  test("a bare `data:` dispatches an empty payload", () => {
    expect(parse("data:\n\n")).toEqual([{ event: "message", data: "" }]);
  });

  test("a colon inside the value is kept", () => {
    expect(parse("data: a:b: c\n\n")).toEqual([{ event: "message", data: "a:b: c" }]);
  });

  test("comments and keepalive pings are dropped", () => {
    expect(parse(": ping\n\n: another\n: comment\ndata: x\n\n")).toEqual([
      { event: "message", data: "x" },
    ]);
  });

  test("a comment line does not end a block", () => {
    expect(parse("data: a\n: mid\ndata: b\n\n")).toEqual([
      { event: "message", data: "a\nb" },
    ]);
  });

  test("a block without data, id or retry is not dispatched", () => {
    expect(parse("event: lonely\n\n")).toEqual([]);
    expect(parse("foo: bar\n\n")).toEqual([]);
    expect(parse("\n\n\n")).toEqual([]);
  });

  test("an event-only block does not leak its type into the next frame", () => {
    expect(parse("event: lonely\n\ndata: x\n\n")).toEqual([
      { event: "message", data: "x" },
    ]);
  });

  test("unknown fields are ignored", () => {
    expect(parse("foo: bar\ndata: x\n\n")).toEqual([
      { event: "message", data: "x" },
    ]);
  });

  test("id rides on the frame of its block", () => {
    expect(parse("id: 42\nfoo: bar\ndata: x\n\n")).toEqual([
      { event: "message", data: "x", id: "42" },
    ]);
    expect(parse("event: task\nid:7\ndata: y\n\n")).toEqual([
      { event: "task", data: "y", id: "7" },
    ]);
  });

  test("an id-only block yields a control frame", () => {
    expect(parse("id: 7\n\n")).toEqual([{ event: "", data: "", id: "7" }]);
  });

  test("an id is not carried over to a later block", () => {
    expect(parse("id: 7\ndata: a\n\ndata: b\n\n")).toEqual([
      { event: "message", data: "a", id: "7" },
      { event: "message", data: "b" },
    ]);
  });

  test("an id containing NUL is ignored", () => {
    expect(parse("id: 1\u00002\ndata: x\n\n")).toEqual([
      { event: "message", data: "x" },
    ]);
    expect(parse("id: 1\u00002\n\n")).toEqual([]);
  });

  test("an empty id value is reported as an empty string", () => {
    expect(parse("id:\ndata: x\n\n")).toEqual([{ event: "message", data: "x", id: "" }]);
    expect(parse("id\n\n")).toEqual([{ event: "", data: "", id: "" }]);
  });

  test("id and retry together", () => {
    expect(parse("id: 9\nretry: 500\ndata: x\n\n")).toEqual([
      { event: "message", data: "x", id: "9", retry: 500 },
    ]);
    expect(parse("retry: 500\nid: 9\n\n")).toEqual([
      { event: "", data: "", id: "9", retry: 500 },
    ]);
  });

  test("a chunk split inside an id line still parses it", () => {
    const p = createSseParser();
    expect(p.push("id: 12")).toEqual([]);
    expect(p.push("34\ndata: x\n")).toEqual([]);
    expect(p.push("\n")).toEqual([{ event: "message", data: "x", id: "1234" }]);
    const text = "id: 5\ndata: z\n\n";
    const q = createSseParser();
    const got: SseFrame[] = [];
    for (const ch of text) got.push(...q.push(ch));
    expect(got).toEqual([{ event: "message", data: "z", id: "5" }]);
  });

  test("retry rides on the frame of its block", () => {
    expect(parse("retry: 3000\ndata: x\n\n")).toEqual([
      { event: "message", data: "x", retry: 3000 },
    ]);
  });

  test("a retry-only block yields a control frame with an empty event", () => {
    expect(parse("retry: 1500\n\n")).toEqual([{ event: "", data: "", retry: 1500 }]);
  });

  test("retry is not carried over to a later block", () => {
    expect(parse("retry: 1500\n\ndata: x\n\n")).toEqual([
      { event: "", data: "", retry: 1500 },
      { event: "message", data: "x" },
    ]);
  });

  test("a non-numeric retry is ignored", () => {
    expect(parse("retry: soon\ndata: x\n\n")).toEqual([
      { event: "message", data: "x" },
    ]);
    expect(parse("retry: 12ms\ndata: x\n\n")).toEqual([
      { event: "message", data: "x" },
    ]);
    expect(parse("retry: -5\ndata: x\n\n")).toEqual([
      { event: "message", data: "x" },
    ]);
    expect(parse("retry:\n\n")).toEqual([]);
  });

  test("LF, CRLF and CR line endings all parse", () => {
    const want = [
      { event: "message", data: "a" },
      { event: "message", data: "b" },
    ];
    expect(parse("data: a\n\ndata: b\n\n")).toEqual(want);
    expect(parse("data: a\r\n\r\ndata: b\r\n\r\n")).toEqual(want);
    expect(parse("data: a\r\rdata: b\r\r")).toEqual(want);
  });

  test("mixed line endings in one block", () => {
    expect(parse("event: e\r\ndata: a\ndata: b\r\r")).toEqual([
      { event: "e", data: "a\nb" },
    ]);
  });

  test("a CRLF split across chunks is one line break, not two", () => {
    // If the trailing CR and the leading LF were read as two breaks the
    // second one would be an empty line and dispatch a frame early.
    const p = createSseParser();
    expect(p.push("data: a\r")).toEqual([]);
    expect(p.push("\ndata: b\r\n\r\n")).toEqual([{ event: "message", data: "a\nb" }]);
  });

  test("a CR at the end of a chunk followed by a non-LF starts the next line", () => {
    const p = createSseParser();
    expect(p.push("data: a\r")).toEqual([]);
    expect(p.push("data: b\r\r")).toEqual([{ event: "message", data: "a\nb" }]);
  });

  test("a blank-line CRLF split across chunks dispatches once", () => {
    const p = createSseParser();
    expect(p.push("data: a\r\n\r")).toEqual([{ event: "message", data: "a" }]);
    expect(p.push("\ndata: b\r\n\r\n")).toEqual([{ event: "message", data: "b" }]);
  });

  test("a frame split across many chunks (down to single characters)", () => {
    const text = "event: task\ndata: {\"id\":1}\ndata: tail\nretry: 250\n\n";
    const p = createSseParser();
    const got: SseFrame[] = [];
    for (const ch of text) got.push(...p.push(ch));
    expect(got).toEqual([
      { event: "task", data: '{"id":1}\ntail', retry: 250 },
    ]);
  });

  test("single-character chunks match the one-shot parse for CRLF input", () => {
    const text = ": ping\r\n\r\nevent: a\r\ndata: 1\r\n\r\ndata: 2\r\rdata: 3\n\n";
    const whole = parse(text);
    const p = createSseParser();
    const split: SseFrame[] = [];
    for (const ch of text) split.push(...p.push(ch));
    expect(split).toEqual(whole);
    expect(whole).toEqual([
      { event: "a", data: "1" },
      { event: "message", data: "2" },
      { event: "message", data: "3" },
    ]);
  });

  test("multiple frames in one chunk, and a partial one held back", () => {
    const p = createSseParser();
    expect(p.push("data: a\n\ndata: b\n\ndata: c")).toEqual([
      { event: "message", data: "a" },
      { event: "message", data: "b" },
    ]);
    expect(p.push("\n\n")).toEqual([{ event: "message", data: "c" }]);
  });

  test("empty chunks are harmless", () => {
    const p = createSseParser();
    expect(p.push("")).toEqual([]);
    expect(p.push("data: x\n")).toEqual([]);
    expect(p.push("")).toEqual([]);
    expect(p.push("\n")).toEqual([{ event: "message", data: "x" }]);
  });

  test("one leading BOM is stripped", () => {
    expect(parse("﻿data: x\n\n")).toEqual([{ event: "message", data: "x" }]);
  });

  test("a BOM arriving alone in the first chunk is stripped too", () => {
    expect(parse("﻿", "data: x\n\n")).toEqual([{ event: "message", data: "x" }]);
    expect(parse("", "﻿data: x\n\n")).toEqual([{ event: "message", data: "x" }]);
  });

  test("a BOM after the start of the stream is not stripped", () => {
    // It becomes part of the field name, so the line is an unknown field.
    expect(parse("data: a\n\n﻿data: b\n\n")).toEqual([
      { event: "message", data: "a" },
    ]);
  });

  test("only the first BOM is stripped", () => {
    expect(parse("﻿﻿data: x\n\n")).toEqual([]);
  });

  test("keeps multi-byte characters in the payload intact", () => {
    expect(parse("data: héllo 🌍\n\n")).toEqual([
      { event: "message", data: "héllo 🌍" },
    ]);
  });

  test("parser instances are independent", () => {
    const a = createSseParser();
    const b = createSseParser();
    a.push("data: half");
    expect(b.push("data: whole\n\n")).toEqual([{ event: "message", data: "whole" }]);
    expect(a.push("\n\n")).toEqual([{ event: "message", data: "half" }]);
  });
});

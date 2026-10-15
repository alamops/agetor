import { describe, expect, test } from "bun:test";
import { cutUtf8, trimToolResultData, utf8Length } from "./tool-result-trim.ts";
import { parseSentFilesToolResult } from "./sent-files.ts";
import { deriveTodoProgress } from "./todo-progress.ts";
import { RETENTION_TRIM_BYTES } from "./types.ts";

const MAX = RETENTION_TRIM_BYTES;
const NOW = 1_800_000_000_000;

// TextEncoder, not Buffer.byteLength: Bun's Buffer.byteLength undercounts a lone
// surrogate (2 bytes), while the encoder substitutes U+FFFD (3 bytes) exactly
// like SQLite stores it — which is what `utf8Length` mirrors.
const encoder = new TextEncoder();
const byteLen = (s: string) => encoder.encode(s).length;

/** True when `s` contains an unpaired UTF-16 surrogate. */
function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

/** Runs the trim and asserts it produced something; returns the parsed output too. */
function trimmed(data: string, maxBytes = MAX) {
  const out = trimToolResultData(data, maxBytes, NOW);
  expect(out).not.toBeNull();
  return { ...out!, parsed: JSON.parse(out!.data) as Record<string, any> };
}

const payload = (fields: Record<string, unknown>) => JSON.stringify(fields);

describe("trimToolResultData — content shapes", () => {
  test("a long string content is cut to the budget and marked with an ellipsis", () => {
    const content = "line of output\n".repeat(2000);
    const { parsed, data } = trimmed(payload({ toolUseId: "toolu_1", content, isError: false }));
    expect(typeof parsed.content).toBe("string");
    expect(parsed.content.endsWith("…")).toBe(true);
    expect(byteLen(parsed.content)).toBeLessThanOrEqual(MAX + byteLen("…"));
    expect(content.startsWith(parsed.content.slice(0, -1))).toBe(true);
    expect(byteLen(data)).toBeLessThan(byteLen(content));
  });

  test("a text-block array keeps blocks in order within one shared budget; later blocks are dropped", () => {
    const content = [
      { type: "text", text: "first block" },
      { type: "text", text: "s".repeat(MAX * 2) },
      { type: "text", text: "never reaches the output" },
    ];
    const { parsed } = trimmed(payload({ toolUseId: "toolu_2", content }));
    expect(parsed.content).toHaveLength(2);
    expect(parsed.content[0]).toEqual({ type: "text", text: "first block" });
    expect(parsed.content[1].type).toBe("text");
    expect(parsed.content[1].text.endsWith("…")).toBe(true);
    const total = parsed.content.reduce((n: number, b: { text: string }) => n + byteLen(b.text), 0);
    expect(total).toBeLessThanOrEqual(MAX + byteLen("…"));
  });

  test("an image block's base64 is replaced by a placeholder text block", () => {
    const base64 = "QUJD".repeat(20_000);
    const content = [
      { type: "text", text: "screenshot captured" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
    ];
    const input = payload({ toolUseId: "toolu_3", content });
    const { parsed, data } = trimmed(input);
    expect(parsed.content).toEqual([
      { type: "text", text: "screenshot captured" },
      { type: "text", text: "[image block removed by retention]" },
    ]);
    expect(data).not.toContain("QUJDQUJD");
    expect(byteLen(data)).toBeLessThan(1024);
  });

  test("a document block is replaced by a placeholder naming its type", () => {
    const content = [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBER".repeat(30_000) } },
    ];
    const { parsed } = trimmed(payload({ toolUseId: "toolu_4", content }));
    expect(parsed.content).toEqual([{ type: "text", text: "[document block removed by retention]" }]);
  });

  test("an unrecognised or untyped block becomes an `unknown` placeholder", () => {
    const content = [{ weird: "x".repeat(MAX * 2) }, "bare string block"];
    const { parsed } = trimmed(payload({ toolUseId: "toolu_5", content }));
    expect(parsed.content[0]).toEqual({ type: "text", text: "[unknown block removed by retention]" });
  });

  test("fx ACP content items keep their wrapper shape while the inner text is cut", () => {
    const text = "acp output ".repeat(1500);
    const content = [{ type: "content", content: { type: "text", text } }];
    const { parsed } = trimmed(payload({ toolUseId: "call_1", content }));
    expect(parsed.content).toHaveLength(1);
    const item = parsed.content[0];
    expect(item.type).toBe("content");
    expect(item.content.type).toBe("text");
    expect(item.content.text.endsWith("…")).toBe(true);
    expect(text.startsWith(item.content.text.slice(0, -1))).toBe(true);
    expect(byteLen(item.content.text)).toBeLessThanOrEqual(MAX + byteLen("…"));
  });

  test("a plain object content is stringified and cut (string content is accepted by every renderer)", () => {
    const content = { stdout: "o".repeat(MAX * 3), exitCode: 0 };
    const { parsed } = trimmed(payload({ toolUseId: "tc_1", content }));
    expect(typeof parsed.content).toBe("string");
    expect(parsed.content.startsWith('{"stdout":"ooo')).toBe(true);
    expect(parsed.content.endsWith("…")).toBe(true);
    expect(byteLen(parsed.content)).toBeLessThanOrEqual(MAX + byteLen("…"));
  });
});

describe("trimToolResultData — declined inputs return null", () => {
  test("an already-trimmed payload is left alone (and the trimmed output is stable)", () => {
    const first = trimmed(payload({ toolUseId: "t", content: "z".repeat(MAX * 4) }));
    expect(trimToolResultData(first.data, MAX, NOW + 1)).toBeNull();
    // Even with a budget smaller than the trimmed row, the marker wins.
    expect(trimToolResultData(first.data, 16, NOW + 1)).toBeNull();
  });

  test("a payload within the budget is left alone", () => {
    expect(trimToolResultData(payload({ toolUseId: "t", content: "small" }), MAX, NOW)).toBeNull();
    // Exactly at the budget is still within it.
    const exact = "x".repeat(MAX);
    const fitting = payload({ content: exact }).slice(0, MAX);
    expect(trimToolResultData(fitting, MAX, NOW)).toBeNull();
  });

  test("a large payload whose content is already small has nothing to cut", () => {
    const data = payload({ toolUseId: "t", content: "tiny", extra: "e".repeat(MAX * 3) });
    expect(trimToolResultData(data, MAX, NOW)).toBeNull();
  });

  test("non-JSON data is left alone", () => {
    expect(trimToolResultData("not json ".repeat(2000), MAX, NOW)).toBeNull();
    expect(trimToolResultData('{"toolUseId":"t","content":"' + "x".repeat(MAX * 2), MAX, NOW)).toBeNull(); // truncated JSON
  });

  test("JSON that is not an object is left alone", () => {
    expect(trimToolResultData(JSON.stringify("x".repeat(MAX * 2)), MAX, NOW)).toBeNull();
    expect(trimToolResultData(JSON.stringify(["x".repeat(MAX * 2)]), MAX, NOW)).toBeNull();
    expect(trimToolResultData(JSON.stringify(12345), MAX, NOW)).toBeNull();
    expect(trimToolResultData("null", MAX, NOW)).toBeNull();
  });

  test("an object with no `content` key is left alone", () => {
    expect(trimToolResultData(payload({ toolUseId: "t", output: "x".repeat(MAX * 2) }), MAX, NOW)).toBeNull();
  });

  test("content of an unsupported type is left alone", () => {
    expect(trimToolResultData(payload({ toolUseId: "t", content: 12345, extra: "e".repeat(MAX * 2) }), MAX, NOW)).toBeNull();
    expect(trimToolResultData(payload({ toolUseId: "t", content: null, extra: "e".repeat(MAX * 2) }), MAX, NOW)).toBeNull();
  });
});

describe("trimToolResultData — surrogate safety", () => {
  test("an emoji straddling the cut point is never split (every offset around the boundary)", () => {
    for (let pad = MAX - 8; pad <= MAX + 2; pad++) {
      const content = "x".repeat(pad) + "😀".repeat(3000);
      const { data, parsed } = trimmed(payload({ toolUseId: "t", content }));
      const text = parsed.content as string;
      expect(hasLoneSurrogate(text)).toBe(false);
      expect(hasLoneSurrogate(data)).toBe(false);
      // Valid UTF-16 and valid UTF-8 round trip.
      expect(Buffer.from(data, "utf8").toString("utf8")).toBe(data);
      expect(byteLen(text)).toBeLessThanOrEqual(MAX + byteLen("…"));
    }
  });

  test("an emoji that does not fit in the last bytes is dropped whole, not halved", () => {
    const content = "x".repeat(MAX - 2) + "😀" + "tail".repeat(100);
    const { parsed } = trimmed(payload({ content }));
    expect(parsed.content).toBe("x".repeat(MAX - 2) + "…");
  });

  test("cutUtf8 cuts on code-point boundaries and reports exact byte lengths", () => {
    expect(cutUtf8("abc", 10)).toBe("abc");
    expect(cutUtf8("abc", 0)).toBe("");
    expect(cutUtf8("aé😀b", 1)).toBe("a");
    expect(cutUtf8("aé😀b", 2)).toBe("a"); // é needs 2 more
    expect(cutUtf8("aé😀b", 3)).toBe("aé");
    expect(cutUtf8("aé😀b", 6)).toBe("aé"); // 😀 needs 4 (3 + 4 = 7)
    expect(cutUtf8("aé😀b", 7)).toBe("aé😀");
    for (const s of ["", "ascii", "héllo", "日本語", "a😀b😀", "\uD800lone", "tail\uDC00"]) {
      expect(utf8Length(s)).toBe(byteLen(s));
    }
  });
});

describe("trimToolResultData — envelope", () => {
  test("toolUseId, isError and attachments survive; the retention marker is the first key", () => {
    const attachments = [{ path: "/abs/a.png", size: 238784, isImage: true, mediaType: "image/png" }];
    const input = payload({
      toolUseId: "toolu_keep",
      content: "c".repeat(MAX * 3),
      isError: true,
      attachments,
      extraKey: { nested: 1 },
    });
    const { data, parsed, originalBytes } = trimmed(input);
    expect(data.startsWith('{"retention":')).toBe(true);
    expect(Object.keys(parsed)).toEqual(["retention", "toolUseId", "content", "isError", "attachments", "extraKey"]);
    expect(parsed.toolUseId).toBe("toolu_keep");
    expect(parsed.isError).toBe(true);
    expect(parsed.attachments).toEqual(attachments);
    expect(parsed.extraKey).toEqual({ nested: 1 });
    expect(originalBytes).toBe(byteLen(input));
    expect(parsed.retention).toEqual({ trimmed: true, originalBytes: byteLen(input), trimmedAt: NOW });
  });

  test("originalBytes counts UTF-8 bytes, not UTF-16 units", () => {
    const input = payload({ toolUseId: "t", content: "é".repeat(5000) + "日".repeat(2000) });
    const { originalBytes, parsed } = trimmed(input);
    expect(originalBytes).toBe(byteLen(input));
    expect(originalBytes).toBeGreaterThan(input.length);
    expect(parsed.retention.originalBytes).toBe(originalBytes);
  });

  test("absent optional keys stay absent (no `isError: undefined` / `attachments: null` invented)", () => {
    const { parsed } = trimmed(payload({ content: "c".repeat(MAX * 2) }));
    expect(Object.keys(parsed)).toEqual(["retention", "content"]);
  });

  test("the output is always strictly shorter than the input and honours the supplied clock", () => {
    for (const size of [MAX + 1, MAX * 2, MAX * 50]) {
      const input = payload({ toolUseId: "t", content: "q".repeat(size) });
      const out = trimToolResultData(input, MAX, 42);
      if (out === null) continue; // a just-over-budget payload may legitimately decline
      expect(byteLen(out.data)).toBeLessThan(byteLen(input));
      expect(JSON.parse(out.data).retention.trimmedAt).toBe(42);
    }
    const big = trimToolResultData(payload({ toolUseId: "t", content: "q".repeat(MAX * 50) }), MAX, 42);
    expect(big).not.toBeNull();
  });
});

describe("trimmed rows still feed the parsers that read tool_result tails", () => {
  const padding = "\n" + "xyz ".repeat(MAX);

  test("a SendUserFile success result still parses as delivered (string content)", () => {
    const text = "2 files delivered to user.\n  /abs/a.png → file_uuid: 1097286c-4e3d-4fe5-864a-abc123def456\n  /abs/b.md → file_uuid: 2097286c-4e3d-4fe5-864a-abc123def456" + padding;
    const attachments = [{ path: "/abs/a.png", size: 1, isImage: true, mediaType: "image/png" }];
    const { parsed } = trimmed(payload({ toolUseId: "toolu_sf", content: text, isError: false, attachments }));
    const result = parseSentFilesToolResult(parsed.content, parsed.isError, parsed.attachments);
    expect(result.delivered).toBe(true);
    expect(result.deliveredCount).toBe(2);
    expect(result.attachments).toEqual(attachments);
  });

  test("a SendUserFile success result still parses as delivered (text-block content)", () => {
    const text = "1 file delivered to user.\n  /abs/a.png → file_uuid: 1097286c-4e3d-4fe5-864a-abc123def456" + padding;
    const { parsed } = trimmed(payload({ toolUseId: "toolu_sf2", content: [{ type: "text", text }] }));
    const result = parseSentFilesToolResult(parsed.content, parsed.isError, null);
    expect(result.delivered).toBe(true);
    expect(result.deliveredCount).toBe(1);
  });

  test("a Task #N created result still resolves the task number in deriveTodoProgress", () => {
    const resultText = "Task #3 created successfully: Write the retention tests" + padding;
    const events = (resultContent: string) => [
      {
        stream: "tool_use",
        data: JSON.stringify({ id: "toolu_tc", name: "TaskCreate", input: { subject: "Write the retention tests" } }),
      },
      { stream: "tool_result", data: payload({ toolUseId: "toolu_tc", content: resultContent }) },
      // Only matches when the created task was numbered 3 from the RESULT text
      // (the sequential fallback would number it 1 and ignore this update).
      { stream: "tool_use", data: JSON.stringify({ id: "toolu_tu", name: "TaskUpdate", input: { taskId: "3", status: "completed" } }) },
    ];

    const before = deriveTodoProgress(events(resultText));
    expect(before).not.toBeNull();
    expect(before!.completed).toBe(1);

    const original = payload({ toolUseId: "toolu_tc", content: resultText });
    const { data } = trimmed(original);
    const trimmedEvents = events(resultText);
    trimmedEvents[1] = { stream: "tool_result", data };
    const after = deriveTodoProgress(trimmedEvents);
    expect(after).toEqual(before);
    expect(data.length).toBeLessThan(original.length);
  });
});

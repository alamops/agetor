import { describe, expect, test } from "bun:test";
import { filesSentCopy, shouldNotifyOsFilesSent, shouldToastFilesSent } from "./files-sent-notify.ts";

describe("filesSentCopy", () => {
  test("singular title at count === 1", () => {
    expect(filesSentCopy({ count: 1, caption: null }).title).toBe("1 file sent to you");
  });

  test("plural title for any count other than 1, including 0", () => {
    expect(filesSentCopy({ count: 2, caption: null }).title).toBe("2 files sent to you");
    expect(filesSentCopy({ count: 10, caption: null }).title).toBe("10 files sent to you");
    expect(filesSentCopy({ count: 0, caption: null }).title).toBe("0 files sent to you");
  });

  test("null caption yields null body", () => {
    expect(filesSentCopy({ count: 1, caption: null }).body).toBeNull();
  });

  test("uses only the caption's first line, trimmed", () => {
    const { body } = filesSentCopy({ count: 1, caption: "  Here's the chart.  \nSecond line ignored" });
    expect(body).toBe("Here's the chart.");
  });

  test("blank first line (whitespace only) yields null body even with more lines after", () => {
    const { body } = filesSentCopy({ count: 1, caption: "   \nreal content on line two" });
    expect(body).toBeNull();
  });

  test("short caption passes through unmodified", () => {
    const { body } = filesSentCopy({ count: 3, caption: "short caption" });
    expect(body).toBe("short caption");
  });

  test("caption exactly at the 120-char cap is not truncated", () => {
    const exact = "a".repeat(120);
    const { body } = filesSentCopy({ count: 1, caption: exact });
    expect(body).toBe(exact);
    expect(body?.length).toBe(120);
  });

  test("caption over the 120-char cap is cut to 120 chars plus an ellipsis", () => {
    const long = "a".repeat(150);
    const { body } = filesSentCopy({ count: 1, caption: long });
    expect(body).toBe("a".repeat(120) + "…");
  });
});

describe("shouldToastFilesSent", () => {
  test("suppressed only when selected and focused (card already on screen)", () => {
    expect(shouldToastFilesSent({ isSelected: true, isFocused: true })).toBe(false);
  });

  test("shown when selected but the window is unfocused", () => {
    expect(shouldToastFilesSent({ isSelected: true, isFocused: false })).toBe(true);
  });

  test("shown when focused but a different task is selected", () => {
    expect(shouldToastFilesSent({ isSelected: false, isFocused: true })).toBe(true);
  });

  test("shown when neither selected nor focused", () => {
    expect(shouldToastFilesSent({ isSelected: false, isFocused: false })).toBe(true);
  });
});

describe("shouldNotifyOsFilesSent", () => {
  test("notifies when the window is unfocused, regardless of proactive", () => {
    expect(shouldNotifyOsFilesSent({ isFocused: false, proactive: false })).toBe(true);
    expect(shouldNotifyOsFilesSent({ isFocused: false, proactive: true })).toBe(true);
  });

  test("a proactive send notifies even while the window is focused", () => {
    expect(shouldNotifyOsFilesSent({ isFocused: true, proactive: true })).toBe(true);
  });

  test("a normal (non-proactive) send does not notify while focused", () => {
    expect(shouldNotifyOsFilesSent({ isFocused: true, proactive: false })).toBe(false);
  });
});

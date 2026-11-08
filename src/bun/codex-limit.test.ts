import { describe, expect, test } from "bun:test";
import { mapCodexEvent } from "./codex-tmux.ts";
import { HARNESS_LIMIT_STATUS_PREFIX } from "../shared/types.ts";

function map(evt: Record<string, unknown>): { chunks: { stream: string; data: string }[]; done?: number } {
  const chunks: { stream: string; data: string }[] = [];
  const result = mapCodexEvent(
    evt as never,
    (stream, data) => chunks.push({ stream, data }),
    { n: 0 },
  );
  return { chunks, done: result.done };
}

describe("codex limit detection", () => {
  test("usage_limit_exceeded emits one structured signal before the stderr line", () => {
    const { chunks, done } = map({ type: "turn.failed", error: { message: "usage_limit_exceeded" } });
    const signal = chunks.find((c) => c.stream === "status" && c.data.startsWith(HARNESS_LIMIT_STATUS_PREFIX));
    expect(signal).toBeTruthy();
    const payload = JSON.parse(signal!.data.slice(HARNESS_LIMIT_STATUS_PREFIX.length));
    expect(payload.reason).toBe("quota");
    expect(payload.source).toBe("codex-error");
    expect(chunks.some((c) => c.stream === "stderr" && c.data.includes("usage_limit_exceeded"))).toBe(true);
    expect(done).toBe(1);
  });

  test("rate_limit_exceeded / insufficient_quota classify", () => {
    expect(
      JSON.parse(
        map({ type: "error", error: { message: "rate_limit_exceeded" } }).chunks
          .find((c) => c.data.startsWith(HARNESS_LIMIT_STATUS_PREFIX))!
          .data.slice(HARNESS_LIMIT_STATUS_PREFIX.length),
      ).reason,
    ).toBe("rate_limit");
    expect(
      JSON.parse(
        map({ type: "turn.failed", error: { message: "insufficient_quota" } }).chunks
          .find((c) => c.data.startsWith(HARNESS_LIMIT_STATUS_PREFIX))!
          .data.slice(HARNESS_LIMIT_STATUS_PREFIX.length),
      ).reason,
    ).toBe("insufficient_credits");
  });

  test("server_overloaded / model_not_found / 5xx / auth never emit a signal", () => {
    for (const message of ["server_overloaded", "model_not_found", "HTTP 529 overloaded", "401 unauthorized", "ECONNRESET"]) {
      const { chunks } = map({ type: "turn.failed", error: { message } });
      expect(chunks.some((c) => c.data.startsWith(HARNESS_LIMIT_STATUS_PREFIX)), message).toBe(false);
    }
  });
});

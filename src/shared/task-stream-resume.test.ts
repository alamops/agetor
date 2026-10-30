import { describe, expect, test } from "bun:test";
import {
  LOGS_STREAM_GAP_NOTICE,
  TASK_STREAM_GAP_NOTICE,
  classifyReplayMeta,
  createIdHighWater,
  parseReplayMeta,
} from "./task-stream-resume.ts";

describe("classifyReplayMeta", () => {
  test("snapshotRequired wins", () => {
    expect(classifyReplayMeta({ earliestId: 5, hasMore: true, snapshotRequired: true })).toBe(
      "snapshot",
    );
    expect(
      classifyReplayMeta({ earliestId: 5, hasMore: true, snapshotRequired: true, resumedAfter: 3 }),
    ).toBe("snapshot");
  });

  test("resumedAfter means resumed, including 0", () => {
    expect(classifyReplayMeta({ earliestId: null, hasMore: false, resumedAfter: 10 })).toBe(
      "resumed",
    );
    expect(classifyReplayMeta({ earliestId: null, hasMore: false, resumedAfter: 0 })).toBe(
      "resumed",
    );
  });

  test("neither field (fresh connect or an older core) is fresh", () => {
    expect(classifyReplayMeta({ earliestId: 1, hasMore: false })).toBe("fresh");
    expect(classifyReplayMeta({ earliestId: null, hasMore: false })).toBe("fresh");
  });
});

describe("parseReplayMeta", () => {
  test("parses the three shapes", () => {
    expect(parseReplayMeta('{"earliestId":4,"hasMore":true}')).toEqual({
      earliestId: 4,
      hasMore: true,
    });
    expect(parseReplayMeta('{"earliestId":null,"hasMore":false,"resumedAfter":9}')).toEqual({
      earliestId: null,
      hasMore: false,
      resumedAfter: 9,
    });
    expect(parseReplayMeta('{"earliestId":2,"hasMore":false,"snapshotRequired":true}')).toEqual({
      earliestId: 2,
      hasMore: false,
      snapshotRequired: true,
    });
  });

  test("returns null on bad JSON or a wrong shape", () => {
    expect(parseReplayMeta("")).toBeNull();
    expect(parseReplayMeta("{nope")).toBeNull();
    expect(parseReplayMeta("null")).toBeNull();
    expect(parseReplayMeta("[1,2]")).toBeNull();
    expect(parseReplayMeta('"x"')).toBeNull();
    expect(parseReplayMeta('{"hasMore":true}')).toBeNull();
    expect(parseReplayMeta('{"earliestId":"4","hasMore":true}')).toBeNull();
    expect(parseReplayMeta('{"earliestId":4,"hasMore":"yes"}')).toBeNull();
    expect(parseReplayMeta('{"earliestId":4}')).toBeNull();
  });

  test("drops wrong-typed optional fields instead of rejecting", () => {
    expect(
      parseReplayMeta('{"earliestId":1,"hasMore":false,"resumedAfter":"7","snapshotRequired":1}'),
    ).toEqual({ earliestId: 1, hasMore: false });
    expect(parseReplayMeta('{"earliestId":1,"hasMore":false,"snapshotRequired":false}')).toEqual({
      earliestId: 1,
      hasMore: false,
    });
  });
});

describe("createIdHighWater", () => {
  test("accepts ascending ids and rejects duplicates and older ids", () => {
    const hw = createIdHighWater();
    expect(hw.highest).toBeNull();
    expect(hw.accept(5)).toBe(true);
    expect(hw.highest).toBe(5);
    expect(hw.accept(5)).toBe(false);
    expect(hw.accept(3)).toBe(false);
    expect(hw.accept(6)).toBe(true);
    expect(hw.highest).toBe(6);
  });

  test("id-less frames always pass and never move the mark", () => {
    const hw = createIdHighWater();
    expect(hw.accept(undefined)).toBe(true);
    expect(hw.accept(null)).toBe(true);
    expect(hw.accept("7")).toBe(true);
    expect(hw.highest).toBeNull();
    hw.accept(10);
    expect(hw.accept(undefined)).toBe(true);
    expect(hw.highest).toBe(10);
  });

  test("a rejected id leaves the mark alone", () => {
    const hw = createIdHighWater();
    hw.accept(10);
    hw.accept(2);
    expect(hw.highest).toBe(10);
  });

  test("reset clears the mark", () => {
    const hw = createIdHighWater();
    hw.accept(10);
    hw.reset();
    expect(hw.highest).toBeNull();
    expect(hw.accept(1)).toBe(true);
  });
});

describe("notices", () => {
  test("copy matches the plan", () => {
    expect(TASK_STREAM_GAP_NOTICE).toBe("Reconnected after a long gap — showing the latest messages");
    expect(LOGS_STREAM_GAP_NOTICE).toBe("…gap too large — skipped older events, showing the latest");
  });
});

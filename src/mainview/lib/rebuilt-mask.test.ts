import { describe, expect, test } from "bun:test";
import { invalidatesRebuiltSnapshot, type RebuiltSnapshotMeta } from "./rebuilt-mask.ts";

const snapshot = (maxLiveEventIdAtSnapshot: number): RebuiltSnapshotMeta => ({
  maxLiveEventIdAtSnapshot,
});

describe("invalidatesRebuiltSnapshot", () => {
  test("a newer main-stream event for a masked run invalidates the snapshot", () => {
    const masked = new Set(["run-1"]);
    expect(
      invalidatesRebuiltSnapshot(snapshot(10), { id: 11, runId: "run-1" }, masked),
    ).toBe(true);
  });

  test("subagent events never invalidate, regardless of id or run", () => {
    const masked = new Set(["run-1"]);
    // Newer id, masked run, but tagged as a subagent event.
    expect(
      invalidatesRebuiltSnapshot(
        snapshot(10),
        { id: 999, runId: "run-1", subagentId: "sub-1" },
        masked,
      ),
    ).toBe(false);
  });

  test("subagent events don't invalidate even for an unmasked run at a huge id", () => {
    const masked = new Set(["run-1"]);
    expect(
      invalidatesRebuiltSnapshot(
        snapshot(0),
        { id: 100000, runId: "run-unrelated", subagentId: "sub-2" },
        masked,
      ),
    ).toBe(false);
  });

  test("events at or below the snapshot's max id never invalidate (SSE replay safety)", () => {
    const masked = new Set(["run-1"]);
    expect(
      invalidatesRebuiltSnapshot(snapshot(10), { id: 10, runId: "run-1" }, masked),
    ).toBe(false);
    expect(
      invalidatesRebuiltSnapshot(snapshot(10), { id: 1, runId: "run-1" }, masked),
    ).toBe(false);
  });

  test("a replay burst of old ids for the masked run does not re-trip the clear", () => {
    const masked = new Set(["run-1", "run-2"]);
    // Simulates SSE reconnect replaying the full history, including ids well
    // below the snapshot's watermark, for every run sharing the session.
    for (let id = 0; id <= 10; id++) {
      expect(
        invalidatesRebuiltSnapshot(snapshot(10), { id, runId: "run-1" }, masked),
      ).toBe(false);
    }
  });

  test("events for non-masked runs never invalidate, even when strictly newer", () => {
    const masked = new Set(["run-1"]);
    expect(
      invalidatesRebuiltSnapshot(snapshot(10), { id: 11, runId: "run-2" }, masked),
    ).toBe(false);
  });

  test("empty maskedRunIds set never invalidates", () => {
    const masked = new Set<string>();
    expect(
      invalidatesRebuiltSnapshot(snapshot(0), { id: 1, runId: "run-1" }, masked),
    ).toBe(false);
  });

  test("a main-stream event newer than the snapshot but for a different masked run in a multi-run snapshot is ignored", () => {
    const masked = new Set(["run-1", "run-2"]);
    expect(
      invalidatesRebuiltSnapshot(snapshot(5), { id: 6, runId: "run-3" }, masked),
    ).toBe(false);
    expect(
      invalidatesRebuiltSnapshot(snapshot(5), { id: 6, runId: "run-2" }, masked),
    ).toBe(true);
  });
});

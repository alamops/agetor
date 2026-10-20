import { describe, expect, test } from "bun:test";
import { UNBLOCKED_REMOVAL_KINDS } from "../../shared/os-notification.ts";
import { TaskToastSlots, type TaskToastKind } from "./toast-slots";

const ALL_KINDS: TaskToastKind[] = [
  "waiting",
  "blocked",
  "api-error",
  "session-ended",
  "unknown-command",
  "failed",
  "succeeded",
  "files-sent",
  "pipeline-finished",
  "send-failed",
  "fx-auto-resume-fired",
  "fx-auto-resume-exhausted",
];

describe("TaskToastSlots", () => {
  test("set returns nothing for an empty slot, then the displaced entry", () => {
    const slots = new TaskToastSlots();
    expect(slots.set("t1", "a", "succeeded")).toBeUndefined();
    expect(slots.set("t1", "b", "failed")).toEqual({ id: "a", kind: "succeeded" });
    expect(slots.get("t1")).toEqual({ id: "b", kind: "failed" });
  });

  test("slots are independent per task", () => {
    const slots = new TaskToastSlots();
    slots.set("t1", 1, "waiting");
    slots.set("t2", 2, "failed");
    expect(slots.get("t1")).toEqual({ id: 1, kind: "waiting" });
    expect(slots.get("t2")).toEqual({ id: 2, kind: "failed" });
    expect(slots.get("t3")).toBeUndefined();
  });

  test("release is id-guarded", () => {
    const slots = new TaskToastSlots();
    slots.set("t1", "a", "blocked");
    slots.set("t1", "b", "waiting");
    // The displaced toast's late onDismiss must not free the new toast's slot.
    slots.release("t1", "a");
    expect(slots.get("t1")?.id).toBe("b");
    slots.release("t1", "b");
    expect(slots.get("t1")).toBeUndefined();
  });

  test("release of an unknown task is a no-op", () => {
    const slots = new TaskToastSlots();
    expect(() => slots.release("missing", "x")).not.toThrow();
    expect(slots.get("missing")).toBeUndefined();
  });

  test("take removes and returns any kind", () => {
    const slots = new TaskToastSlots();
    slots.set("t1", "a", "succeeded");
    expect(slots.take("t1")).toEqual({ id: "a", kind: "succeeded" });
    expect(slots.get("t1")).toBeUndefined();
    expect(slots.take("t1")).toBeUndefined();
  });

  test("take({ onlyReason }) takes reason kinds only", () => {
    const slots = new TaskToastSlots();
    slots.set("t1", "a", "failed");
    expect(slots.take("t1", { onlyReason: true })).toBeUndefined();
    expect(slots.get("t1")).toEqual({ id: "a", kind: "failed" });

    slots.set("t1", "b", "api-error");
    expect(slots.take("t1", { onlyReason: true })).toEqual({ id: "b", kind: "api-error" });
    expect(slots.get("t1")).toBeUndefined();
    expect(slots.take("unknown", { onlyReason: true })).toBeUndefined();
  });

  test("isReason matches UNBLOCKED_REMOVAL_KINDS for every kind", () => {
    for (const kind of ALL_KINDS) {
      const slots = new TaskToastSlots();
      expect(slots.isReason("t1")).toBe(false);
      slots.set("t1", "a", kind);
      expect(slots.isReason("t1")).toBe(UNBLOCKED_REMOVAL_KINDS.includes(kind as never));
    }
  });
});

import { describe, expect, test } from "bun:test";
import {
  ANSWERED_REMOVAL_KINDS,
  NOTIFICATION_KINDS,
  UNBLOCKED_REMOVAL_KINDS,
  isNotificationKind,
  notificationUrgency,
  soundOverUrgencies,
  taskNotificationId,
  type NotificationKind,
} from "./os-notification.ts";

describe("notificationUrgency (D4)", () => {
  const expected: Record<NotificationKind, "needs-you" | "quiet"> = {
    waiting: "needs-you",
    blocked: "needs-you",
    "api-error": "needs-you",
    "session-ended": "needs-you",
    "unknown-command": "needs-you",
    failed: "needs-you",
    succeeded: "quiet",
    "files-sent": "quiet",
    "pipeline-finished": "quiet",
  };

  for (const kind of NOTIFICATION_KINDS) {
    test(`${kind} → ${expected[kind]}`, () => {
      expect(notificationUrgency(kind)).toBe(expected[kind]);
    });
  }

  test("no kind → quiet", () => {
    expect(notificationUrgency(undefined)).toBe("quiet");
  });

  test("the table covers every kind", () => {
    expect(Object.keys(expected).sort()).toEqual([...NOTIFICATION_KINDS].sort());
  });
});

describe("soundOverUrgencies (D3)", () => {
  test("needs-you escalates quiet and unknown entries", () => {
    expect(soundOverUrgencies("needs-you")).toEqual(["quiet", "unknown"]);
  });

  test("quiet never escalates", () => {
    expect(soundOverUrgencies("quiet")).toEqual([]);
  });
});

describe("taskNotificationId (D1)", () => {
  test("prefixes the task id verbatim", () => {
    expect(taskNotificationId("abc-123")).toBe("agetor.task.abc-123");
  });
});

describe("isNotificationKind", () => {
  test("accepts every kind", () => {
    for (const kind of NOTIFICATION_KINDS) expect(isNotificationKind(kind)).toBe(true);
  });

  test("rejects unknown strings", () => {
    expect(isNotificationKind("nope")).toBe(false);
    expect(isNotificationKind("")).toBe(false);
    expect(isNotificationKind("Waiting")).toBe(false);
  });

  test("rejects non-strings", () => {
    for (const v of [undefined, null, 1, true, {}, ["waiting"]]) {
      expect(isNotificationKind(v)).toBe(false);
    }
  });
});

describe("removal kind sets (D6b)", () => {
  test("an answered question removes only the waiting entry", () => {
    expect([...ANSWERED_REMOVAL_KINDS]).toEqual(["waiting"]);
  });

  test("leaving blocked removes the reason family", () => {
    expect([...UNBLOCKED_REMOVAL_KINDS]).toEqual([
      "waiting",
      "blocked",
      "api-error",
      "session-ended",
      "unknown-command",
    ]);
  });

  test("every removal kind is a needs-you kind", () => {
    for (const k of UNBLOCKED_REMOVAL_KINDS) expect(notificationUrgency(k)).toBe("needs-you");
  });
});

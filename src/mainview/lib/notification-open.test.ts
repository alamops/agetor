import { describe, expect, test } from "bun:test";
import { findTaskById } from "./notification-open";

describe("findTaskById", () => {
  test("returns the matching task object when present", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const c = { id: "c" };
    const tasks = [a, b, c];

    const result = findTaskById(tasks, "b");

    expect(result).toBe(b);
  });

  test("returns null when the id isn't present", () => {
    const tasks = [{ id: "a" }, { id: "b" }];

    expect(findTaskById(tasks, "nonexistent")).toBeNull();
  });

  test("returns null for an empty array", () => {
    const tasks: { id: string }[] = [];

    expect(findTaskById(tasks, "anything")).toBeNull();
  });

  test("matches by exact id — trailing whitespace does not match", () => {
    const tasks = [{ id: "abc" }];

    expect(findTaskById(tasks, "abc ")).toBeNull();
  });

  test("matches by exact id — case does not match (substring/case near-miss)", () => {
    const tasks = [{ id: "ab" }];

    expect(findTaskById(tasks, "AB")).toBeNull();
  });

  test("matches by exact id — no prefix/substring matching", () => {
    const tasks = [{ id: "abcdef" }];

    expect(findTaskById(tasks, "abc")).toBeNull();
  });

  test("works with a minimal { id: string } shape", () => {
    const only = { id: "solo" };
    const tasks = [only];

    expect(findTaskById(tasks, "solo")).toBe(only);
  });

  test("works with a richer object, preserving extra fields on the returned reference", () => {
    type RichTask = {
      id: string;
      title?: string;
      column?: string;
      prompt?: string;
      agent?: string;
    };
    const richTask: RichTask = {
      id: "task-1",
      title: "Fix the bug",
      column: "backlog",
      prompt: "do the thing",
      agent: "claude-code",
    };
    // Explicit homogeneous element type: a mixed-shape literal array would be
    // inferred as a union, and `.title`/`.column` wouldn't exist on every
    // member — the fields are optional here so both entries fit one type.
    const tasks: RichTask[] = [{ id: "other" }, richTask];

    const result = findTaskById(tasks, "task-1");

    expect(result).toBe(richTask);
    expect(result).toEqual(richTask);
    expect(result?.title).toBe("Fix the bug");
    expect(result?.column).toBe("backlog");
  });
});

import { test, expect } from "bun:test";
import { USAGE, canonical, usageError } from "./usage.ts";

const COMMANDS = [
  "add", "ls", "ps", "show", "start", "send", "commit", "answer", "logs",
  "cancel", "attach", "edit", "move", "archive", "unarchive", "diff", "rm",
  "projects", "harness", "daemon", "info",
];

test("every dispatched command has a USAGE block whose first line is its usage line", () => {
  for (const cmd of COMMANDS) {
    const block = USAGE[cmd];
    expect(block, cmd).toBeDefined();
    expect(block!.split("\n", 1)[0]!.startsWith(`usage: agetor ${cmd}`), cmd).toBe(true);
  }
});

test("canonical resolves aliases and passes real names through", () => {
  expect(canonical("mv")).toBe("move");
  expect(canonical("msg")).toBe("send");
  expect(canonical("inspect")).toBe("show");
  expect(canonical("tail")).toBe("logs");
  expect(canonical("delete")).toBe("rm");
  expect(canonical("harnesses")).toBe("harness");
  expect(canonical("project")).toBe("projects");
  expect(canonical("commit")).toBe("commit");
});

test("usageError throws only the concise first line, resolving aliases", () => {
  const e = usageError("commit");
  expect(e.message).toBe("usage: agetor commit <task-id>");
  expect(e.message.includes("\n")).toBe(false);
  expect(usageError("mv").message.startsWith("usage: agetor move")).toBe(true);
  expect(usageError("frobnicate").message).toContain("unknown command");
});

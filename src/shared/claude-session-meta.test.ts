import { expect, test } from "bun:test";
import {
  agetorModeForClaudePermission,
  claudeProjectDirUnresolved,
  plainEncodedProjectPath,
  readClaudeSessionMeta,
} from "./claude-session-meta.ts";

test("agetorModeForClaudePermission maps known modes and falls back to ask", () => {
  expect(agetorModeForClaudePermission("auto")).toBe("auto");
  expect(agetorModeForClaudePermission("bypassPermissions")).toBe("bypass");
  expect(agetorModeForClaudePermission("acceptEdits")).toBe("acceptEdits");
  expect(agetorModeForClaudePermission("plan")).toBe("plan");
  expect(agetorModeForClaudePermission("default")).toBe("ask");
  expect(agetorModeForClaudePermission(null)).toBe("ask");
  expect(agetorModeForClaudePermission("nope")).toBe("ask");
});

test("claudeProjectDirUnresolved is false at 200 characters and when encode matches", () => {
  const short = "a".repeat(200);
  expect(plainEncodedProjectPath(short)).toHaveLength(200);
  expect(claudeProjectDirUnresolved(short, "something-else", () => "nope")).toBe(false);

  const long = "b".repeat(201);
  expect(claudeProjectDirUnresolved(long, "dir", () => "dir")).toBe(false);
  expect(claudeProjectDirUnresolved(long, "other", (cwd) => plainEncodedProjectPath(cwd))).toBe(true);
});

test("readClaudeSessionMeta falls back to the first human prompt", () => {
  const meta = readClaudeSessionMeta([
    JSON.stringify({
      type: "user",
      cwd: "/work/app",
      gitBranch: "main",
      timestamp: "2026-10-01T00:00:00.000Z",
      message: { role: "user", content: "Fix the login bug" },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-10-01T00:00:02.000Z",
      message: { role: "assistant", model: "claude-opus-4-6", content: "ok" },
    }),
  ].join("\n"));
  expect(meta.title).toBe("Fix the login bug");
  expect(meta.firstHumanPrompt).toBe("Fix the login bug");
  expect(meta.model).toBe("claude-opus-4-6");
  expect(meta.gitBranch).toBe("main");
  expect(meta.cwd).toBe("/work/app");
  expect(meta.messageCount).toBe(2);
  expect(meta.hasUser).toBe(true);
  expect(meta.permissionMode).toBeNull();
  expect(meta.continuedIn).toBeNull();
  expect(meta.lastTimestamp).toBe(Date.parse("2026-10-01T00:00:02.000Z"));
});

test("readClaudeSessionMeta keeps the first cwd when a later line changes directory", () => {
  const meta = readClaudeSessionMeta([
    JSON.stringify({ type: "user", cwd: "/launch", message: { content: "hi" } }),
    JSON.stringify({ type: "assistant", cwd: "/later", message: { content: "ok" } }),
  ].join("\n"));
  expect(meta.cwd).toBe("/launch");
});

test("readClaudeSessionMeta prefers the last aiTitle and the last permission mode", () => {
  const meta = readClaudeSessionMeta([
    JSON.stringify({ type: "user", message: { content: "first prompt" }, timestamp: "2026-10-01T00:00:00.000Z", permissionMode: "default" }),
    JSON.stringify({ type: "ai-title", aiTitle: "Login fix", timestamp: "2026-10-01T00:00:01.000Z" }),
    JSON.stringify({ type: "permission-mode", permissionMode: "plan", timestamp: "2026-10-01T00:00:02.000Z" }),
  ].join("\n"));
  expect(meta.title).toBe("Login fix");
  expect(meta.permissionMode).toBe("plan");
  expect(meta.firstHumanPrompt).toBe("first prompt");
});

test("readClaudeSessionMeta reads continued-in and does not throw on missing keys", () => {
  const continued = readClaudeSessionMeta([
    JSON.stringify({ type: "user", message: { content: "hi" }, "continued-in": "next-id" }),
    "{not json",
    "",
  ].join("\n"));
  expect(continued.continuedIn).toBe("next-id");

  const empty = readClaudeSessionMeta("");
  expect(empty.title).toBeNull();
  expect(empty.model).toBeNull();
  expect(empty.gitBranch).toBeNull();
  expect(empty.permissionMode).toBeNull();
  expect(empty.hasUser).toBe(false);
  expect(empty.messageCount).toBe(0);
  expect(empty.continuedIn).toBeNull();
  expect(empty.lastTimestamp).toBeNull();

  const missing = readClaudeSessionMeta(JSON.stringify({ type: "assistant" }));
  expect(missing.model).toBeNull();
  expect(missing.hasUser).toBe(false);
  expect(() => readClaudeSessionMeta("{{{")).not.toThrow();
});

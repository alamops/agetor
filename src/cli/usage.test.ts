import { test, expect } from "bun:test";
import { USAGE, canonical, usageError, helpFor } from "./usage.ts";

const COMMANDS = [
  "add", "ls", "ps", "show", "start", "send", "commit", "answer", "commands", "logs",
  "files", "cancel", "attach", "shell", "edit", "move", "archive", "unarchive", "diff", "rm",
  "projects", "harness", "profile", "daemon", "info", "config",
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
  expect(canonical("profiles")).toBe("profile");
  expect(canonical("project")).toBe("projects");
  expect(canonical("sent")).toBe("files");
  expect(canonical("commit")).toBe("commit");
});

// docs/plans/task-details-agent-row.md D4: the CLI's `agent`/`agents`
// subcommand spelling was retired in favor of `profile`/`profiles` — `agent`
// in the CLI means the harness (`--agent <harness id>`), never the agent
// profile subcommand. `agent`/`agents` must resolve to nothing (index.ts's
// dispatcher then falls through to "unknown command"), while `profile` and
// its `profiles` alias are real.
test("the retired 'agent'/'agents' profile-subcommand spelling has no USAGE block; 'profile'/'profiles' replaces it", () => {
  expect(USAGE["agent"]).toBeUndefined();
  expect(USAGE["agents"]).toBeUndefined();
  expect(canonical("agent")).toBe("agent"); // not an alias — passes through unresolved
  expect(USAGE[canonical("agent")]).toBeUndefined();
  expect(USAGE["profile"]).toBeDefined();
  expect(canonical("profiles")).toBe("profile");
  expect(USAGE["profile"]!.split("\n", 1)[0]).toBe("usage: agetor profile <ls | show <ref> | add <name> … | edit <ref> … | rm <ref>>");
});

test("usageError throws only the concise first line, resolving aliases", () => {
  const e = usageError("commit");
  expect(e.message).toBe("usage: agetor commit <task-id>");
  expect(e.message.includes("\n")).toBe(false);
  expect(usageError("mv").message.startsWith("usage: agetor move")).toBe(true);
  expect(usageError("harness add").message).toBe(USAGE["harness add"]!.split("\n", 1)[0]!);
  expect(usageError("frobnicate").message).toContain("unknown command");
});

test("helpFor resolves command, subcommand, alias, and falls back", () => {
  expect(helpFor("edit", undefined)).toBe(USAGE["edit"]);
  expect(helpFor("mv", undefined)).toBe(USAGE["move"]); // alias
  expect(helpFor("harness", "add")).toBe(USAGE["harness add"]); // subcommand
  expect(helpFor("harness", "rm")).toBe(USAGE["harness"]); // unknown sub → command block
  expect(helpFor("projects", "add")).toBe(USAGE["projects add"]);
  expect(helpFor(undefined, undefined)).toBeUndefined();
  expect(helpFor("frobnicate", undefined)).toBeUndefined();
});

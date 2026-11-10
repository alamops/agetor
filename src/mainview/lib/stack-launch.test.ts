import { describe, expect, test } from "bun:test";
import { stackBackupCanServe } from "./stack-launch.ts";
import type { AgentStatus, Harness, HarnessStack } from "../../shared/types.ts";

const harness = (id: string, enabled = true): Harness => ({
  id,
  kind: "codex",
  label: id,
  isBuiltin: false,
  home: null,
  bin: null,
  env: {},
  enabled,
});

const status = (harnessId: string, overrides: Partial<AgentStatus> = {}): AgentStatus => ({
  harnessId,
  kind: "codex",
  bin: "codex",
  available: true,
  path: "/usr/local/bin/codex",
  version: "0.166.0",
  reason: null,
  installHint: null,
  account: null,
  usage: null,
  loggedIn: null,
  authHelp: null,
  ...overrides,
});

const stack = (ids: string[]): HarnessStack => ({
  id: "s1",
  label: "Codex train",
  kind: "codex",
  mirrorMode: "full",
  members: ids.map((harnessId, position) => ({ harnessId, position, label: harnessId, kind: "codex", enabled: true })),
  createdAt: 0,
  updatedAt: 0,
  warnings: [],
});

describe("stackBackupCanServe", () => {
  const harnesses = [harness("a"), harness("b"), harness("c")];

  test("true when another member is enabled, available and not logged out", () => {
    expect(stackBackupCanServe("a", [stack(["a", "b"])], harnesses, [status("a", { available: false }), status("b")])).toBe(true);
  });

  test("an unknown login on the backup counts as usable (fail open, like the core)", () => {
    expect(stackBackupCanServe("a", [stack(["a", "b"])], harnesses, [status("b", { loggedIn: null })])).toBe(true);
  });

  test("false outside any stack, in a one-account stack, or when every other member is unusable", () => {
    expect(stackBackupCanServe("a", [], harnesses, [status("b")])).toBe(false);
    expect(stackBackupCanServe("a", [stack(["a"])], harnesses, [status("a")])).toBe(false);
    expect(
      stackBackupCanServe(
        "a",
        [stack(["a", "b", "c"])],
        [harness("a"), harness("b", false), harness("c")],
        [status("b"), status("c", { loggedIn: false })],
      ),
    ).toBe(false);
  });

  test("the account's own status never counts as its backup, and a member with no status is not usable", () => {
    expect(stackBackupCanServe("a", [stack(["a", "b"])], harnesses, [status("a")])).toBe(false);
  });
});

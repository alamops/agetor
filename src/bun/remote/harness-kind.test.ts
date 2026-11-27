// S4: a task's `agent` is a harness id; the remote rules are keyed by kind. A second account of a kind has an id of its own.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "../test-data-dir.ts";
import { PHONE_TERMINAL_KINDS } from "./harness-kind.ts";

const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-remote-harness-kind-"));
process.env.AGETOR_DATA_DIR = dataDir;

let restore: () => void = () => undefined;
let resolveHarnessKind: typeof import("./harness-kind.ts").resolveHarnessKind;
let runsWithoutAsking: typeof import("./autonomy.ts").runsWithoutAsking;

beforeAll(async () => {
  const dbm = await import("../db.ts");
  const { snapshotHarnessState } = await import("../test-harness-state.ts");
  restore = snapshotHarnessState();
  dbm.harnesses.insert({ id: "claude-second-account", kind: "claude-code", label: "Claude (second)" });
  ({ resolveHarnessKind } = await import("./harness-kind.ts"));
  ({ runsWithoutAsking } = await import("./autonomy.ts"));
});
afterAll(() => {
  restore();
  rmTestDataDir(dataDir);
});

describe("harness id → kind", () => {
  test("a second account of a kind resolves to its kind; a built-in id and an unknown id resolve to themselves", async () => {
    expect(await resolveHarnessKind("claude-second-account")).toBe("claude-code");
    expect(await resolveHarnessKind("claude-code")).toBe("claude-code");
    expect(await resolveHarnessKind("no-such-harness")).toBe("no-such-harness");
  });

  test("autonomy is decided by the kind: a second Claude account in plan mode asks, in auto mode it does not; an unknown id fails closed", async () => {
    const kind = await resolveHarnessKind("claude-second-account");
    expect(runsWithoutAsking({ agent: kind, mode: "plan" })).toBe(false);
    expect(runsWithoutAsking({ agent: kind, mode: "auto" })).toBe(true);
    // the raw id is an unknown kind, which is why the live reads resolve it first
    expect(runsWithoutAsking({ agent: "claude-second-account", mode: "plan" })).toBe(true);
  });

  test("the phone terminal covers the tmux-hosted per-task kinds and not the ACP ones", () => {
    for (const k of ["claude-code", "codex", "gemini", "antigravity", "copilot", "opencode"]) expect(PHONE_TERMINAL_KINDS.has(k)).toBe(true);
    for (const k of ["cursor", "fx"]) expect(PHONE_TERMINAL_KINDS.has(k)).toBe(false);
  });
});

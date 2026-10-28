import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppEvent, HarnessStatus, AgentKind } from "../shared/types.ts";

// db.ts opens (and migrates) on import, so the data dir must exist first.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-auto-enable-"));
process.env.AGETOR_HARNESS_AUTO_ENABLE = "1";

// Model discovery would spawn the real CLIs; only its call is asserted here.
const refreshed: string[] = [];

const { db, harnesses, harnessAutoEnabled } = await import("./db.ts");
const restoreHarnesses = (await import("./test-harness-state.ts")).snapshotHarnessState();
const {
  applyHarnessAutoEnable,
  flushPendingHarnessAutoEnableNotice,
  harnessAutoEnableActive,
  setHarnessAutoEnableBroadcaster,
  __forTest,
} = await import("./harness-auto-enable.ts");

__forTest.setRefresh(async (id) => {
  refreshed.push(id);
});

afterAll(() => {
  __forTest.setRefresh(null);
  restoreHarnesses();
});

type Notice = Extract<AppEvent, { type: "harnesses_auto_enabled" }>;

function status(harnessId: string, kind: AgentKind, available = true): HarnessStatus {
  return {
    harnessId,
    kind,
    bin: kind,
    available,
    path: available ? `/usr/local/bin/${kind}` : null,
    version: available ? "1.0.0" : null,
    reason: available ? null : "not installed",
    installHint: null,
  } as HarnessStatus;
}

const AUTO_KINDS: AgentKind[] = ["codex", "cursor", "gemini", "fx", "opencode"];

beforeEach(() => {
  db.run(`DELETE FROM harness_auto_enabled`);
  db.run(`DELETE FROM harnesses WHERE is_builtin = 0`);
  // Baseline: the auto-enable kinds ship Off, claude-code/antigravity as seeded.
  for (const k of AUTO_KINDS) harnesses.setEnabled(k, false);
  refreshed.length = 0;
  setHarnessAutoEnableBroadcaster(null);
  process.env.AGETOR_HARNESS_AUTO_ENABLE = "1";
});

afterEach(() => {
  setHarnessAutoEnableBroadcaster(null);
});

test("every auto-enable kind turns on once when available", () => {
  const enabled = applyHarnessAutoEnable(AUTO_KINDS.map((k) => status(k, k)));
  expect(enabled.sort()).toEqual([...AUTO_KINDS].sort());
  for (const k of AUTO_KINDS) {
    expect(harnesses.get(k)!.enabled).toBe(true);
    expect(harnessAutoEnabled.has(k)).toBe(true);
  }
  expect(refreshed.sort()).toEqual([...AUTO_KINDS].sort());
  // A second pass changes nothing.
  expect(applyHarnessAutoEnable(AUTO_KINDS.map((k) => status(k, k)))).toEqual([]);
});

test("an already-on row is recorded silently, with no notice owed", () => {
  harnesses.setEnabled("codex", true);
  expect(applyHarnessAutoEnable([status("codex", "codex")])).toEqual([]);
  expect(harnessAutoEnabled.has("codex")).toBe(true);
  expect(harnessAutoEnabled.pending()).toEqual([]);
  expect(refreshed).toEqual([]);
  const sent: AppEvent[] = [];
  flushPendingHarnessAutoEnableNotice((e) => sent.push(e));
  expect(sent).toEqual([]);
});

test("a manual Off after the record sticks across later calls", () => {
  applyHarnessAutoEnable([status("gemini", "gemini")]);
  harnesses.setEnabled("gemini", false);
  expect(applyHarnessAutoEnable([status("gemini", "gemini")])).toEqual([]);
  expect(harnesses.get("gemini")!.enabled).toBe(false);
});

test("an unavailable row is not recorded and turns on once it is available", () => {
  expect(applyHarnessAutoEnable([status("cursor", "cursor", false)])).toEqual([]);
  expect(harnessAutoEnabled.has("cursor")).toBe(false);
  expect(harnesses.get("cursor")!.enabled).toBe(false);
  expect(applyHarnessAutoEnable([status("cursor", "cursor", true)])).toEqual(["cursor"]);
  expect(harnesses.get("cursor")!.enabled).toBe(true);
});

test("an additional harness of an auto-enable kind is never touched", () => {
  harnesses.insert({ id: "codex-work", kind: "codex", label: "Codex (work)", home: "/tmp/agetor-test-home" });
  harnesses.setEnabled("codex-work", false);
  expect(applyHarnessAutoEnable([status("codex-work", "codex")])).toEqual([]);
  expect(harnesses.get("codex-work")!.enabled).toBe(false);
  expect(harnessAutoEnabled.has("codex-work")).toBe(false);
});

test("claude-code and antigravity rows are never touched", () => {
  harnesses.setEnabled("antigravity", false);
  harnesses.setEnabled("claude-code", false);
  expect(
    applyHarnessAutoEnable([status("claude-code", "claude-code"), status("antigravity", "antigravity")]),
  ).toEqual([]);
  expect(harnesses.get("antigravity")!.enabled).toBe(false);
  expect(harnesses.get("claude-code")!.enabled).toBe(false);
  expect(harnessAutoEnabled.all()).toEqual([]);
});

test("the pending notice goes to the next flush exactly once", () => {
  applyHarnessAutoEnable([status("fx", "fx"), status("opencode", "opencode")]);
  expect(harnessAutoEnabled.pending().sort()).toEqual(["fx", "opencode"]);
  const sent: Notice[] = [];
  flushPendingHarnessAutoEnableNotice((e) => sent.push(e as Notice));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.type).toBe("harnesses_auto_enabled");
  expect(sent[0]!.harnessIds.sort()).toEqual(["fx", "opencode"]);
  expect(sent[0]!.labels).toHaveLength(2);
  expect(sent[0]!.labels).toContain(harnesses.get("opencode")!.label);
  expect(typeof sent[0]!.ts).toBe("number");
  flushPendingHarnessAutoEnableNotice((e) => sent.push(e as Notice));
  expect(sent).toHaveLength(1);
});

test("a flush skips a row turned Off since, and still marks it notified", () => {
  applyHarnessAutoEnable([status("fx", "fx"), status("opencode", "opencode")]);
  harnesses.setEnabled("fx", false);
  const sent: Notice[] = [];
  flushPendingHarnessAutoEnableNotice((e) => sent.push(e as Notice));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.harnessIds).toEqual(["opencode"]);
  expect(harnessAutoEnabled.pending()).toEqual([]);
});

test("a flush whose rows are all Off sends nothing but clears pending", () => {
  applyHarnessAutoEnable([status("fx", "fx")]);
  harnesses.setEnabled("fx", false);
  const sent: AppEvent[] = [];
  flushPendingHarnessAutoEnableNotice((e) => sent.push(e));
  expect(sent).toEqual([]);
  expect(harnessAutoEnabled.pending()).toEqual([]);
});

test("a delivering broadcaster marks the ids notified", () => {
  const got: Notice[] = [];
  setHarnessAutoEnableBroadcaster((e) => {
    got.push(e as Notice);
    return true;
  });
  expect(applyHarnessAutoEnable([status("codex", "codex")])).toEqual(["codex"]);
  expect(got).toHaveLength(1);
  expect(got[0]!.harnessIds).toEqual(["codex"]);
  expect(harnessAutoEnabled.pending()).toEqual([]);
  const sent: AppEvent[] = [];
  flushPendingHarnessAutoEnableNotice((e) => sent.push(e));
  expect(sent).toEqual([]);
});

test("a non-delivering or throwing broadcaster leaves the ids pending", () => {
  setHarnessAutoEnableBroadcaster(() => false);
  applyHarnessAutoEnable([status("codex", "codex")]);
  expect(harnessAutoEnabled.pending()).toEqual(["codex"]);

  setHarnessAutoEnableBroadcaster(() => {
    throw new Error("socket closed");
  });
  const origError = console.error;
  console.error = () => {};
  try {
    applyHarnessAutoEnable([status("gemini", "gemini")]);
  } finally {
    console.error = origError;
  }
  expect(harnessAutoEnabled.pending().sort()).toEqual(["codex", "gemini"]);

  const sent: Notice[] = [];
  flushPendingHarnessAutoEnableNotice((e) => sent.push(e as Notice));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.harnessIds.sort()).toEqual(["codex", "gemini"]);
});

test("the NODE_ENV=test default is off; =1 turns it on, =0 turns it off", () => {
  delete process.env.AGETOR_HARNESS_AUTO_ENABLE;
  expect(process.env.NODE_ENV).toBe("test");
  expect(harnessAutoEnableActive()).toBe(false);
  expect(applyHarnessAutoEnable([status("codex", "codex")])).toEqual([]);
  expect(harnesses.get("codex")!.enabled).toBe(false);
  expect(harnessAutoEnabled.has("codex")).toBe(false);

  process.env.AGETOR_HARNESS_AUTO_ENABLE = "1";
  expect(harnessAutoEnableActive()).toBe(true);

  process.env.AGETOR_HARNESS_AUTO_ENABLE = "0";
  expect(harnessAutoEnableActive()).toBe(false);
  expect(applyHarnessAutoEnable([status("codex", "codex")])).toEqual([]);

  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    delete process.env.AGETOR_HARNESS_AUTO_ENABLE;
    expect(harnessAutoEnableActive()).toBe(true);
  } finally {
    process.env.NODE_ENV = prev;
  }
});

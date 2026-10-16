import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, CLAUDE_SESSIONS_SEEN_IDS_PREF } from "../shared/types.ts";
import { plainEncodedProjectPath } from "../shared/claude-session-meta.ts";

const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-launch-db-"));
process.env.AGETOR_DATA_DIR ??= dataDir;

const { preferences } = await import("./db.ts");
const { startClaudeSessionLaunchScan } = await import("./claude-session-launch.ts");
const { clearClaudeSessionLivenessCache } = await import("./claude-session-scan.ts");
const { subscribeAppEvents } = await import("./quit-guard.ts");

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function plant(sessionId: string): { home: string; stub: string } {
  const home = mkdtempSync(path.join(tmpdir(), "cc-launch-home-"));
  scratch.push(home);
  const cwd = path.join(home, "repo");
  expect(plainEncodedProjectPath(cwd).length).toBeLessThanOrEqual(200);
  mkdirSync(cwd, { recursive: true });
  const dir = path.join(home, ".claude", "projects", plainEncodedProjectPath(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({
    type: "user",
    uuid: `${sessionId}-u`,
    cwd,
    timestamp: "2026-10-01T00:00:00.000Z",
    message: { role: "user", content: "hello from outside" },
  }) + "\n");
  const stub = path.join(home, "agents.json");
  writeFileSync(stub, "[]");
  return { home, stub };
}

let homeGate: Promise<void> = Promise.resolve();

async function withHome<T>(home: string, stub: string, fn: () => Promise<T>): Promise<T> {
  const run = homeGate.then(async () => {
    const prevHome = process.env.HOME;
    const prevConfig = process.env.CLAUDE_CONFIG_DIR;
    const prevStub = process.env.AGETOR_CLAUDE_AGENTS_JSON;
    process.env.HOME = home;
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.AGETOR_CLAUDE_AGENTS_JSON = stub;
    clearClaudeSessionLivenessCache();
    try {
      return await fn();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevConfig;
      if (prevStub === undefined) delete process.env.AGETOR_CLAUDE_AGENTS_JSON;
      else process.env.AGETOR_CLAUDE_AGENTS_JSON = prevStub;
      clearClaudeSessionLivenessCache();
    }
  });
  homeGate = run.then(() => {}, () => {});
  return run;
}

test("a disabled launch scan does nothing", async () => {
  const { home, stub } = plant("off-one");
  preferences.set(CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, "0");
  preferences.set(CLAUDE_SESSIONS_SEEN_IDS_PREF, "[]");
  const events: unknown[] = [];
  const unsub = subscribeAppEvents((e) => events.push(e));
  try {
    await withHome(home, stub, () => startClaudeSessionLaunchScan());
    expect(events).toEqual([]);
    expect(preferences.get(CLAUDE_SESSIONS_SEEN_IDS_PREF)).toBe("[]");
  } finally {
    unsub();
    preferences.set(CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, "1");
  }
});

test("launch scan toasts only new importable ids and caps the seen set at 2000", async () => {
  const { home, stub } = plant("fresh-one");
  preferences.set(CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, "1");
  const prior = Array.from({ length: 2000 }, (_, i) => `old-${i}`);
  preferences.set(CLAUDE_SESSIONS_SEEN_IDS_PREF, JSON.stringify(prior));
  const events: { type: string; count?: number }[] = [];
  const unsub = subscribeAppEvents((e) => {
    if (e.type === "claude_sessions_found") events.push(e);
  });
  try {
    await withHome(home, stub, () => startClaudeSessionLaunchScan());
    expect(events).toEqual([expect.objectContaining({ type: "claude_sessions_found", count: 1 })]);
    const seen = JSON.parse(preferences.get(CLAUDE_SESSIONS_SEEN_IDS_PREF)!) as string[];
    expect(seen).toHaveLength(2000);
    expect(seen.at(-1)).toBe("fresh-one");
    expect(seen).not.toContain("old-0");
    events.length = 0;
    await withHome(home, stub, () => startClaudeSessionLaunchScan());
    expect(events).toEqual([]);
  } finally {
    unsub();
  }
});

test("a scan failure is logged and does not reject", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "cc-launch-fail-"));
  scratch.push(home);
  const stub = path.join(home, "agents.json");
  writeFileSync(stub, "[]");
  preferences.set(CLAUDE_SESSIONS_LAUNCH_SCAN_PREF, "1");
  const lines: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args); };
  try {
    await withHome(home, stub, async () => {
      await expect(startClaudeSessionLaunchScan({
        scan: async () => { throw new Error("boom"); },
      })).resolves.toBeUndefined();
    });
    expect(lines.some((args) => String(args[0]).includes("claude session launch scan failed"))).toBe(true);
  } finally {
    console.error = orig;
  }
});

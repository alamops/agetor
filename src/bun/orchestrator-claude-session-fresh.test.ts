import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";
import { makeScriptedClaudeTmux } from "./test-scripted-claude-tmux.ts";

/* ────────────────────────────────────────────────────────────────────────── *
 * TT6 — docs/plans/claude-enter-to-confirm-prompts.md (defect 4, owner D11).
 * `spawnAgent`'s claude branch is the single launch path for start, follow-up,
 * swap and retry. A run records its claude session id only once claude's JSONL
 * exists, and a resume of a JSONL that does not exist starts fresh under the
 * SAME id, because claude exits 1 on `--resume <unknown id>` and the pane closes
 * with it (which is how one failed boot used to poison every retry).
 * ────────────────────────────────────────────────────────────────────────── */

const testDataDir = mkdtempSync(path.join(tmpdir(), "agetor-claude-session-fresh-"));
process.env.AGETOR_DATA_DIR = testDataDir;
process.env.AGETOR_CLAUDE_BIN = "claude";

const { spawnAgent, resolveClaudeResume } = await import("./agents.ts");
const { dropSession, jsonlPathFor, setBootTimeoutMs, sessionNameFor } = await import("./claude-tmux.ts");
const { snapshotHarnessState } = await import("./test-harness-state.ts");
const restoreHarnesses = snapshotHarnessState();

const scripted = makeScriptedClaudeTmux();
const savedTmux = process.env.AGETOR_TMUX_BIN;
process.env.AGETOR_TMUX_BIN = scripted.bin;
const savedDriver = process.env.AGETOR_CLAUDE_DRIVER;
delete process.env.AGETOR_CLAUDE_DRIVER;

afterAll(() => {
  restoreHarnesses();
  if (savedTmux === undefined) delete process.env.AGETOR_TMUX_BIN;
  else process.env.AGETOR_TMUX_BIN = savedTmux;
  if (savedDriver !== undefined) process.env.AGETOR_CLAUDE_DRIVER = savedDriver;
  scripted.cleanup();
  rmTestDataDir(testDataDir);
});
afterEach(() => setBootTimeoutMs(null));

const HARNESS = { id: "claude-code", kind: "claude-code", label: "Claude Code", isBuiltin: true, home: null, bin: null, env: {}, enabled: true } as never;

interface Launch {
  taskId: string;
  argv: string[];
  chunks: Array<{ stream: string; data: string }>;
  stamped: Array<{ id: string; jsonlExistedThen: boolean }>;
  jsonl: (id: string) => string;
  cwd: string;
  stop: () => Promise<void>;
  done: Promise<number>;
}

async function launch(o: { resumeSessionId?: string | null; writeJsonlFor?: string; dialogs: Array<{ kind: "enter-only" }> | []; autoTrustDirectories?: Array<{ name: string; paths: string[] }> }): Promise<Launch> {
  const taskId = randomUUID();
  const cwd = mkdtempSync(path.join(tmpdir(), "agetor-claude-session-cwd-"));
  const configDir = mkdtempSync(path.join(tmpdir(), "agetor-claude-session-cfg-"));
  const jsonl = (id: string) => jsonlPathFor(cwd, id, configDir);
  if (o.writeJsonlFor) {
    mkdirSync(path.dirname(jsonl(o.writeJsonlFor)), { recursive: true });
    writeFileSync(jsonl(o.writeJsonlFor), "");
  }
  // The harness's config dir is where the JSONL goes, so give the harness a home.
  const harness = { ...(HARNESS as object), home: configDir } as never;
  const session = scripted.add(sessionNameFor(taskId), { dialogs: o.dialogs, jsonlPath: undefined });
  const chunks: Array<{ stream: string; data: string }> = [];
  const stamped: Array<{ id: string; jsonlExistedThen: boolean }> = [];
  const agent = await spawnAgent({
    taskId,
    runId: randomUUID(),
    harness,
    prompt: "hello",
    cwd,
    onChunk: (stream, data) => { chunks.push({ stream, data }); },
    onSessionId: (id) => stamped.push({ id, jsonlExistedThen: existsSync(jsonl(id)) }),
    opts: {
      mode: null,
      model: "sonnet",
      effort: "high",
      resumeSessionId: o.resumeSessionId ?? null,
      autoTrustDirectories: o.autoTrustDirectories,
    },
  });
  agent.done.catch(() => {});
  return {
    taskId,
    get argv() {
      const call = session.calls().find((c) => c.argv[0] === "new-session");
      const raw = call?.argv ?? [];
      const dash = raw.indexOf("--");
      return dash >= 0 ? raw.slice(dash + 1) : raw;
    },
    chunks,
    stamped,
    jsonl,
    cwd,
    stop: async () => {
      await dropSession(taskId);
      rmSync(cwd, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    },
    done: agent.done,
  };
}

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

describe("resolveClaudeResume (pure)", () => {
  const newId = () => "new-id";
  test("no prior id: a fresh session under a new id", () => {
    expect(resolveClaudeResume({ resumeSessionId: null, jsonlExists: () => true, newId })).toEqual({ sessionId: "new-id", resume: false, status: null });
  });
  test("a prior id whose file exists: resume it", () => {
    expect(resolveClaudeResume({ resumeSessionId: "abc12345-x", jsonlExists: () => true, newId })).toEqual({ sessionId: "abc12345-x", resume: true, status: null });
  });
  test("a prior id whose file is missing: fresh under the SAME id, and say so", () => {
    const r = resolveClaudeResume({ resumeSessionId: "abc12345-x", jsonlExists: () => false, newId });
    expect(r.sessionId).toBe("abc12345-x");
    expect(r.resume).toBe(false);
    expect(r.status).toBe("no saved claude conversation abc12345… — starting fresh under the same id");
  });
  test("the file check only runs when there is an id to resume", () => {
    let calls = 0;
    resolveClaudeResume({ resumeSessionId: null, jsonlExists: () => { calls++; return true; }, newId });
    expect(calls).toBe(0);
  });
});

describe("spawnAgent claude branch — session id timing and the resume check", () => {
  test("a boot that never writes the session file records NO id, and the next turn starts fresh", async () => {
    setBootTimeoutMs(1_200);
    // A screen that never lets claude start (an Enter-only screen nobody presses).
    const l = await launch({ dialogs: [{ kind: "enter-only" }] });
    try {
      await expect(l.done).rejects.toThrow("jsonl-discovery-timeout");
      expect(l.stamped).toEqual([]);
      // The first launch used `--session-id <fresh uuid>`, never `--resume`.
      expect(flag(l.argv, "--session-id")).toMatch(/^[0-9a-f-]{36}$/);
      expect(l.argv).not.toContain("--resume");
      // …and with no id recorded, the next turn has nothing to resume: fresh again, a NEW id.
      const next = await launch({ dialogs: [] });
      try {
        expect(next.argv).not.toContain("--resume");
        expect(flag(next.argv, "--session-id")).not.toBe(flag(l.argv, "--session-id"));
      } finally {
        await next.stop();
      }
    } finally {
      await l.stop();
    }
  }, 30_000);

  test("a boot that does write the file records the id exactly once, only after the file exists", async () => {
    const l = await launch({ dialogs: [] });
    try {
      const sessionId = flag(l.argv, "--session-id")!;
      // The scripted claude has no dialog, but it only writes the file when told to: do it now.
      expect(l.stamped).toEqual([]);
      mkdirSync(path.dirname(l.jsonl(sessionId)), { recursive: true });
      writeFileSync(l.jsonl(sessionId), "");
      const deadline = Date.now() + 10_000;
      while (l.stamped.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(l.stamped).toEqual([{ id: sessionId, jsonlExistedThen: true }]);
    } finally {
      await l.stop();
    }
  }, 30_000);

  test("resume of an id whose file exists → --resume <id>, stamped at once", async () => {
    const id = randomUUID();
    const l = await launch({ dialogs: [], resumeSessionId: id, writeJsonlFor: id });
    try {
      expect(flag(l.argv, "--resume")).toBe(id);
      expect(l.argv).not.toContain("--session-id");
      const deadline = Date.now() + 10_000;
      while (l.stamped.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(l.stamped).toEqual([{ id, jsonlExistedThen: true }]);
      expect(l.chunks.some((c) => c.data.includes("no saved claude conversation"))).toBe(false);
    } finally {
      await l.stop();
    }
  }, 30_000);

  test("resume of an id whose file is MISSING (a row an older build stamped) → fresh under the same id, with the status line", async () => {
    const id = randomUUID();
    const l = await launch({ dialogs: [], resumeSessionId: id });
    try {
      expect(flag(l.argv, "--session-id")).toBe(id);
      expect(l.argv).not.toContain("--resume");
      expect(l.chunks.some((c) => c.stream === "status" && c.data === `no saved claude conversation ${id.slice(0, 8)}… — starting fresh under the same id`)).toBe(true);
    } finally {
      await l.stop();
    }
  }, 30_000);

  test("a swap planned mid-boot (no file yet) finds no id to transfer: the stamp has not happened", async () => {
    setBootTimeoutMs(1_500);
    const l = await launch({ dialogs: [{ kind: "enter-only" }] });
    try {
      // While claude is still on its first screen, nothing has been recorded.
      expect(l.stamped).toEqual([]);
      await expect(l.done).rejects.toThrow("jsonl-discovery-timeout");
      expect(l.stamped).toEqual([]);
    } finally {
      await l.stop();
    }
  }, 30_000);
});

describe("spawnAgent forwards the auto-trust list to the driver and changes no argv byte", () => {
  test("the claude argv is identical with and without autoTrustDirectories", async () => {
    const id = randomUUID();
    const dirs = [{ name: "repo-e", paths: ["/Users/me/.agetor/worktrees/x/repo-e"] }];
    const plain = await launch({ dialogs: [], resumeSessionId: id, writeJsonlFor: id });
    const trusted = await launch({ dialogs: [], resumeSessionId: id, writeJsonlFor: id, autoTrustDirectories: dirs });
    try {
      expect(trusted.argv).toEqual(plain.argv);
    } finally {
      await plain.stop();
      await trusted.stop();
    }
  }, 30_000);
});

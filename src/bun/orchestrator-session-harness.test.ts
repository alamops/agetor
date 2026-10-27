import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentKind, ImportedClaudeSession, Run, Task } from "../shared/types.ts";

// Harness-scoped resume (docs/plans/add-opencode-harness.md D-15): a task
// resumes only a session its CURRENT harness recorded. A same-kind switch
// (built-in → an additional account of the same kind) starts fresh, and
// switching back resumes the original — for every kind with a session id.

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-session-harness-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
for (const k of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "ANTIGRAVITY", "FX", "OPENCODE"]) {
  process.env[`AGETOR_${k}_DRIVER`] = "fake";
}
// Probes that still run on a follow-up (codex's CLI floor, opencode's cached
// `--version`) must never reach a real CLI on the host.
const binDir = mkdtempSync(path.join(tmpdir(), "agetor-session-harness-bin-"));
function stub(name: string, body: string): string {
  const p = path.join(binDir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_OPENCODE_BIN = stub("opencode", 'if [ "$1" = "--version" ]; then echo "2.1.3"; fi\nexit 0');
// No tmux session is ever live here: every probe reads "gone".
process.env.AGETOR_TMUX_BIN = stub("tmux", "exit 1");
process.env.AGETOR_FX_AUTO_RESUME_DELAY_MS = "300";

let db: typeof import("./db.ts");
let orch: typeof import("./orchestrator.ts");

beforeAll(async () => {
  db = await import("./db.ts");
  orch = await import("./orchestrator.ts");
});

afterAll(async () => {
  const { rmTestDataDir } = await import("./test-data-dir.ts");
  rmTestDataDir(DATA_DIR);
});

async function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
}
function allSettled(taskId: string): boolean {
  return db.runs.listForTask(taskId).every((r) => r.status !== "running");
}
function statusLines(runId: string): string[] {
  return db.runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);
}

interface KindCase {
  kind: AgentKind;
  column: import("./db.ts").SessionIdColumn;
  field: keyof Run;
  resume: string;
  fresh: string;
}
const KINDS: KindCase[] = [
  { kind: "claude-code", column: "claude_session_id", field: "claudeSessionId", resume: "resuming claude session", fresh: "no prior claude session — starting fresh" },
  { kind: "codex", column: "codex_session_id", field: "codexSessionId", resume: "resuming codex thread", fresh: "no prior codex thread — starting fresh" },
  { kind: "cursor", column: "cursor_session_id", field: "cursorSessionId", resume: "resuming cursor session", fresh: "no prior cursor session — starting fresh" },
  { kind: "gemini", column: "gemini_session_id", field: "geminiSessionId", resume: "resuming gemini session", fresh: "no prior gemini session — starting fresh" },
  { kind: "antigravity", column: "antigravity_session_id", field: "antigravitySessionId", resume: "resuming antigravity conversation", fresh: "no prior antigravity conversation — starting fresh" },
  { kind: "fx", column: "fx_session_id", field: "fxSessionId", resume: "resuming fx session", fresh: "no prior fx session — starting fresh" },
  { kind: "opencode", column: "opencode_session_id", field: "opencodeSessionId", resume: "resuming OpenCode session", fresh: "no prior OpenCode session — starting fresh" },
];

function makeTask(id: string, agent: string, runId: string | null): Task {
  const now = Date.now();
  return {
    id,
    title: "harness switch",
    prompt: "p",
    column: "review",
    agent,
    workdir: mkdtempSync(path.join(tmpdir(), "agetor-session-harness-wd-")),
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    speed: "off",
    maxMode: false,
    opencodeServer: "shared",
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    runId,
    createdAt: now,
    updatedAt: now,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
  };
}

/** A settled run row recorded by `agent`, carrying `sessionId` in `field`. */
function seedRun(taskId: string, agent: string, field: keyof Run | null, sessionId: string | null, extra: Partial<Run> = {}): Run {
  const now = Date.now();
  const run: Run = {
    id: randomUUID(),
    taskId,
    agent,
    status: "succeeded",
    startedAt: now,
    endedAt: now,
    exitCode: 0,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    antigravitySessionId: null,
    opencodeSessionId: null,
    ...extra,
  };
  if (field && sessionId) (run as unknown as Record<string, unknown>)[field] = sessionId;
  return db.runs.insert(run);
}

async function sendAndSettle(taskId: string, runId: string, line: string): Promise<string> {
  const sent = await orch.sendInput(runId, line);
  if (!sent.delivered) throw new Error(`not delivered: ${sent.reason}`);
  await waitFor(() => allSettled(taskId));
  return sent.runId;
}

test("findLastSessionIdForHarness picks the newest id the given harness recorded", async () => {
  const taskId = randomUUID();
  db.tasks.insert(makeTask(taskId, "codex", null));
  db.harnesses.insert({ id: "codex-unit-alt", kind: "codex", label: "Codex (unit alt)" });
  // Oldest → newest. Distinct start times keep the order deterministic.
  seedRun(taskId, "codex", "codexSessionId", "thread-builtin-old", { startedAt: 1_000 });
  seedRun(taskId, "codex-unit-alt", "codexSessionId", "thread-alt", { startedAt: 2_000 });
  seedRun(taskId, "codex", "codexSessionId", "thread-builtin-new", { startedAt: 3_000 });
  seedRun(taskId, "codex", null, null, { startedAt: 4_000 }); // no id stamped
  seedRun(taskId, "gone-harness", "codexSessionId", "thread-dangling", { startedAt: 5_000 });

  expect(orch.findLastSessionIdForHarness(taskId, "codex_session_id", "codex")).toBe("thread-builtin-new");
  expect(orch.findLastSessionIdForHarness(taskId, "codex_session_id", "codex-unit-alt")).toBe("thread-alt");
  // A row whose harness no longer resolves matches only its raw stored id.
  expect(orch.findLastSessionIdForHarness(taskId, "codex_session_id", "gone-harness")).toBe("thread-dangling");
  expect(orch.findLastSessionIdForHarness(taskId, "codex_session_id", "codex-never-ran")).toBeNull();
  // Another column is independent.
  expect(orch.findLastSessionIdForHarness(taskId, "cursor_session_id", "codex")).toBeNull();
});

for (const c of KINDS) {
  test(`${c.kind}: a same-kind harness switch starts fresh; switching back resumes the original session`, async () => {
    const altId = `${c.kind}-switch-alt`;
    db.harnesses.insert({ id: altId, kind: c.kind, label: `${c.kind} (alt)` });
    const taskId = randomUUID();
    db.tasks.insert(makeTask(taskId, c.kind, null));
    const orig = `ORIG${c.kind.slice(0, 4).toUpperCase()}-${randomUUID()}`;
    const seed = seedRun(taskId, c.kind, c.field, orig);
    db.tasks.update(taskId, { runId: seed.id });

    expect(orch.findLastSessionIdForHarness(taskId, c.column, c.kind)).toBe(orig);
    expect(orch.findLastSessionIdForHarness(taskId, c.column, altId)).toBeNull();

    // Built-in → additional harness of the same kind: never the other account's session.
    db.tasks.update(taskId, { agent: altId });
    const altRunId = await sendAndSettle(taskId, seed.id, "on the alt harness");
    expect(statusLines(altRunId)).toContain(c.fresh);
    expect(db.runs.get(altRunId)?.[c.field]).not.toBe(orig);
    expect(db.runs.get(altRunId)?.agent).toBe(altId);
    // The built-in's own history is untouched.
    expect(orch.findLastSessionIdForHarness(taskId, c.column, c.kind)).toBe(orig);

    // Back to the built-in: the original session resumes.
    db.tasks.update(taskId, { agent: c.kind });
    const backRunId = await sendAndSettle(taskId, altRunId, "back on the built-in");
    expect(statusLines(backRunId)).toContain(`${c.resume} ${orig.slice(0, 8)}…`);
  });
}

test("an imported Claude task resumes its imported session (the seed run carries the importing harness id)", async () => {
  const altId = "claude-import-alt";
  db.harnesses.insert({ id: altId, kind: "claude-code", label: "Claude (import alt)" });
  const taskId = randomUUID();
  db.tasks.insert(makeTask(taskId, altId, null));
  const sessionId = `sess-imported-${randomUUID()}`;
  const seed = seedRun(taskId, altId, "claudeSessionId", sessionId, { origin: "imported" });
  db.tasks.update(taskId, { runId: seed.id });
  const provenance: ImportedClaudeSession = {
    sessionId,
    gitBranch: null,
    importedAt: Date.now(),
    configDir: "/tmp/claude-import-alt",
    status: "ready",
    backfillOffset: 0,
    error: null,
  };
  db.tasks.setImportedClaude(taskId, provenance);

  const runId = await sendAndSettle(taskId, seed.id, "please continue");
  expect(db.runs.get(runId)?.claudeSessionId).toBe(sessionId);
  expect(statusLines(runId)).toContain(`resuming claude session ${sessionId.slice(0, 8)}…`);
});

test("fx recovery gating respects the harness: another fx account's pause is not resumable here", async () => {
  const { FX_RECOVERY_STATUS_PREFIX } = await import("../shared/types.ts");
  const altId = "fx-recovery-alt";
  db.harnesses.insert({ id: altId, kind: "fx", label: "fx (recovery alt)" });
  const taskId = randomUUID();
  db.tasks.insert(makeTask(taskId, "fx", null));
  const paused = seedRun(taskId, "fx", "fxSessionId", "fx-session-paused", { status: "failed", exitCode: 1 });
  db.runs.appendEvent(paused.id, "status", FX_RECOVERY_STATUS_PREFIX + JSON.stringify({ state: "paused", message: "rate limited" }));
  db.tasks.update(taskId, { runId: paused.id, column: "ready" });

  db.tasks.update(taskId, { agent: altId });
  expect(await orch.resumeFxRecovery(taskId)).toEqual({
    ok: false,
    status: 400,
    error: "no paused fx response to resume",
  });
  expect(db.runs.listForTask(taskId)).toHaveLength(1);

  db.tasks.update(taskId, { agent: "fx" });
  const resumed = await orch.resumeFxRecovery(taskId);
  expect(resumed.ok).toBe(true);
  if (!resumed.ok) return;
  await waitFor(() => allSettled(taskId));
  expect(statusLines(resumed.runId)).toContain("resuming paused fx response in session fx-sessi…");
});

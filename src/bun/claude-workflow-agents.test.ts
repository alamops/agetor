/* ────────────────────────────────────────────────────────────────────────── *
 * Workflow (`/workflow`) tracking behavior in claude-subagents.ts — the
 * CONTAINER row (`parentKind: "workflow"`) that holds a task in `running` for
 * a workflow's whole lifetime, the per-agent `workflow_agent` rows tailed
 * from `<sessionId>/subagents/workflows/<wf_runId>/`, journal-receipt settle
 * (the flush-loss backstop), the notification-anchored container settle +
 * cascade, replay idempotency on reattach, the `pumpWatcherForHoldCheck`
 * synchronous hold-check path, the `AGETOR_TRACK_WORKFLOWS` kill switch, and
 * the `REPLAY_WINDOW_BYTES` attach-time clamp. Also covers W6/W7 from
 * docs/plans/fix-stuck-subagent-running-detection.md §3: the journal-cursor
 * rewind on late agent discovery (an early receipt consumed before its row
 * existed must still settle it once discovered) and settle-on-discovery under
 * an already-settled container (a straggling agent file must never read as
 * `running` for even one tick once its container is over).
 *
 * Companion to claude-subagents.test.ts — same conventions, disjoint scope
 * (that file covers classic in-session subagents; this one covers only the
 * workflow half added on top of it). See docs/plans/
 * claude-code-workflows-as-running-bg-agents.md §2/§5 (TT1) for the ground
 * truth this file encodes.
 * ────────────────────────────────────────────────────────────────────────── */

import { test, expect, describe, beforeAll, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunEvent } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-workflow-agents-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

// Whatever the orchestrator registered at its module load (or `null` if this
// file runs before it). `bun test` shares one process across every file, so
// hard-resetting these to `null` in `afterEach` would leave every later file
// with no SSE sink and no release/pull-back path. Capture by
// read-modify-restore and put the originals back — same idiom as
// claude-subagents.test.ts.
let originalEmitter: ((e: RunEvent) => void) | null = null;
let originalSettleHook: ((taskId: string) => void) | null = null;
let originalParkedDiscovery: ((taskId: string) => void) | null = null;

beforeAll(async () => {
  await import("./db.ts");
  const { setSubagentEmitter, setSubagentSettleHook, setParkedDiscoveryHandler } = await import(
    "./claude-subagents.ts"
  );
  originalEmitter = setSubagentEmitter(null);
  setSubagentEmitter(originalEmitter);
  originalSettleHook = setSubagentSettleHook(null);
  setSubagentSettleHook(originalSettleHook);
  originalParkedDiscovery = setParkedDiscoveryHandler(null);
  setParkedDiscoveryHandler(originalParkedDiscovery);
});

// Every task `seed()` creates is tracked here and torn down in the global
// `afterEach` below — see claude-subagents.test.ts's identical comment for
// why: `seed()` inserts the task `running` + the run `succeeded`, exactly the
// shape reconcileOrphans's held-task sweep looks for, and a leftover row
// (combined with a `running` subagents row several tests here create) would
// get silently swept by any later `reconcileOrphans()` call sharing this
// process's SQLite db (e.g. reconcile.test.ts).
const createdTaskIds: string[] = [];

afterEach(async () => {
  const {
    detachWatcherFor,
    setSubagentEmitter,
    setSubagentSettleHook,
    setParkedDiscoveryHandler,
  } = await import("./claude-subagents.ts");
  setSubagentEmitter(originalEmitter);
  setSubagentSettleHook(originalSettleHook);
  setParkedDiscoveryHandler(originalParkedDiscovery);
  if (createdTaskIds.length === 0) return;
  const { tasks } = await import("./db.ts");
  for (const id of createdTaskIds) {
    try {
      detachWatcherFor(id);
    } catch {
      /* best-effort */
    }
    try {
      tasks.delete(id);
    } catch {
      /* best-effort */
    }
  }
  createdTaskIds.length = 0;
});

/** Build a temp `<sessionId>/subagents/` layout + a seeded task/run, returning
 *  the jsonlPath the watcher derives the subagents dir from. Mirrors
 *  claude-subagents.test.ts's `seed()` exactly. */
async function seed() {
  const { tasks, runs } = await import("./db.ts");
  const taskId = `task-wf-${randomUUID()}`;
  const runId = `run-wf-${randomUUID()}`;
  createdTaskIds.push(taskId);
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "t", prompt: "p", column: "running", agent: "claude-code",
    workdir: "/tmp", isolation: "none", taskType: "task", branch: null, branchSource: "created", worktreePath: null,
    baseRef: null, mode: null, model: null, effort: null, references: [], backlog: [], draft: null, runId,
    prUrl: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    archivedAt: null, createdAt: now, updatedAt: now,
  });
  // Insert the run as already-terminal — see claude-subagents.test.ts's
  // identical comment: reconcileOrphans() scans every `running` run globally.
  runs.insert({
    id: runId, taskId, agent: "claude-code", status: "succeeded", startedAt: now,
    endedAt: now, exitCode: 0, tmuxSession: null, claudeSessionId: null, codexSessionId: null,
  });

  const sessionId = randomUUID();
  const proj = path.join(DATA_DIR, "projects", "encoded");
  const subagentsDir = path.join(proj, sessionId, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  const jsonlPath = path.join(proj, `${sessionId}.jsonl`);
  return { taskId, runId, jsonlPath, subagentsDir };
}

/** `<sessionId>/subagents/workflows/<wfRunId>/` — where a workflow's
 *  container `transcriptDir` and its `agent-*.jsonl` files live. */
function wfDirFor(subagentsDir: string, wfRunId: string): string {
  return path.join(subagentsDir, "workflows", wfRunId);
}

/** Main-JSONL `user` line carrying the `/workflow` tool's immediate
 *  `async_launched` stub — the launch signal `scanLineForWorkflowLaunch`
 *  parses. `transcriptDir` must be the ABSOLUTE dir the watcher will scan for
 *  agent files (use `wfDirFor`). */
function launchLine(opts: {
  wtaskId: string;
  workflowName: string;
  wfRunId: string;
  transcriptDir: string;
  toolUseId: string;
  summary?: string;
}): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: opts.toolUseId, content: "Workflow launched" }],
    },
    toolUseResult: {
      status: "async_launched",
      taskId: opts.wtaskId,
      taskType: "local_workflow",
      workflowName: opts.workflowName,
      runId: opts.wfRunId,
      summary: opts.summary ?? "s",
      transcriptDir: opts.transcriptDir,
      scriptPath: "/bin/workflow.sh",
    },
    uuid: `launch-${opts.wtaskId}`,
  }) + "\n";
}

/** Main-JSONL `queue-operation` enqueue line carrying a completion
 *  `<task-notification>` payload — the shape claude 2.1.x uses (older
 *  versions used a synthetic `user`/`origin.kind` shape instead; both are
 *  parsed identically by `scanLineForWorkflowNotification`, which just
 *  substring/regex-matches the raw line, so this one shape is sufficient to
 *  exercise that code path). */
function notificationLine(opts: { wtaskId: string; toolUseId: string; status?: string; summary?: string }): string {
  const content =
    `<task-notification>\n<task-id>${opts.wtaskId}</task-id>\n<tool-use-id>${opts.toolUseId}</tool-use-id>\n` +
    `<status>${opts.status ?? "completed"}</status>\n<summary>${opts.summary ?? "done"}</summary>\n</task-notification>`;
  return JSON.stringify({
    type: "queue-operation",
    operation: "enqueue",
    timestamp: new Date().toISOString(),
    sessionId: randomUUID(),
    content,
  }) + "\n";
}

/** A line that merely QUOTES a `<task-id>` tag without the enclosing
 *  `<task-notification>` wrapper — the shape `scanLineForWorkflowNotification`
 *  must NOT treat as a settle signal (fix 4: anchoring on the notification
 *  marker, not the bare tag). */
function quoteOnlyLine(wtaskId: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: `Referring to <task-id>${wtaskId}</task-id> earlier.` }] },
    uuid: `quote-${wtaskId}`,
  }) + "\n";
}

function sidechainUserLine(agentId: string, uuid: string): string {
  return JSON.stringify({
    type: "user", isSidechain: true, agentId, uuid,
    message: { role: "user", content: "go" },
  }) + "\n";
}

function sidechainToolUseLine(agentId: string, uuid: string): string {
  return JSON.stringify({
    type: "assistant", isSidechain: true, agentId, uuid,
    message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: `t-${uuid}`, name: "Bash", input: { command: "ls" } }] },
  }) + "\n";
}

function sidechainEndTurnLine(agentId: string, uuid: string, text = "done"): string {
  return JSON.stringify({
    type: "assistant", isSidechain: true, agentId, uuid,
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] },
  }) + "\n";
}

/** A `journal.jsonl` lifecycle receipt line — the harness's own per-agent
 *  completion record, immune to the terminal-line flush loss a workflow
 *  agent's own transcript can suffer under concurrency. */
function journalLine(type: "started" | "result", key: string, agentId: string, result?: string): string {
  const o: Record<string, unknown> = { type, key, agentId };
  if (type === "result") o.result = result ?? "ok";
  return JSON.stringify(o) + "\n";
}

/** meta.json sidecar for a workflow agent — no `description`, no `toolUseId`
 *  (empirical ground truth: workflow agents are spawned by the harness, not
 *  by a parent `Agent` tool_use). */
function wfAgentMeta(): string {
  return JSON.stringify({ agentType: "workflow-subagent", spawnDepth: 1, model: "haiku" });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 1. Container discovery from the launch line
 * ────────────────────────────────────────────────────────────────────────── */

describe("workflow container discovery (launch line)", () => {
  test("registers a running container row, fires parked-discovery once, and holds the task", async () => {
    const { subagents } = await import("./db.ts");
    const { attachSubagentWatcher, setParkedDiscoveryHandler } = await import("./claude-subagents.ts");
    const { taskId, jsonlPath, subagentsDir } = await seed();

    const wtaskId = `wtask1-${randomUUID()}`;
    const toolUseId = `toolu-${randomUUID()}`;
    const dir = wfDirFor(subagentsDir, "wf_x");
    writeFileSync(jsonlPath, launchLine({
      wtaskId, workflowName: "my-wf", wfRunId: "wf_x", transcriptDir: dir, toolUseId,
    }));

    const parked: string[] = [];
    setParkedDiscoveryHandler((tid) => parked.push(tid));

    const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
    w.pump(Date.now());

    const row = subagents.get(wtaskId);
    expect(row).not.toBeNull();
    expect(row!.parentKind).toBe("workflow");
    expect(row!.id).toBe(wtaskId);
    expect(row!.taskId).toBe(taskId);
    expect(row!.status).toBe("running");
    expect(row!.description).toBe("my-wf");
    expect(row!.sourcePath).toBe(dir);
    expect(row!.toolUseId).toBe(toolUseId);

    expect(parked).toEqual([taskId]);
    expect(subagents.hasRunning(taskId)).toBe(true);

    w.detach();
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 2. Workflow-agent discovery inside the transcript dir
 * ────────────────────────────────────────────────────────────────────────── */

describe("workflow agent discovery (agent-*.jsonl + meta.json inside the wf dir)", () => {
  test("discovers a workflow_agent row, tags tailed events with the agent id, and falls back the description to the workflow's name", async () => {
    const { subagents } = await import("./db.ts");
    const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
    const { taskId, jsonlPath, subagentsDir } = await seed();

    const wtaskId = `wtask-${randomUUID()}`;
    const toolUseId = `toolu-${randomUUID()}`;
    const wfRunId = "wf_y";
    const dir = wfDirFor(subagentsDir, wfRunId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(jsonlPath, launchLine({ wtaskId, workflowName: "my-wf", wfRunId, transcriptDir: dir, toolUseId }));

    const captured: RunEvent[] = [];
    setSubagentEmitter((e) => captured.push(e));

    const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
    // Cycle 1: registers the container. No agent files exist yet, so
    // `discoverWorkflowAgents` (which runs BEFORE `scanMainSignals` inside
    // one cycle) finds nothing this pass.
    w.pump(Date.now());
    expect(subagents.get(wtaskId)!.parentKind).toBe("workflow");

    // Now the agent file appears — after the container is already known, so
    // the description-fallback chain reaches the container's name.
    const agentId = `wfagent-${randomUUID().slice(0, 8)}`;
    writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), wfAgentMeta());
    writeFileSync(
      path.join(dir, `agent-${agentId}.jsonl`),
      sidechainUserLine(agentId, `u-${agentId}`) + sidechainToolUseLine(agentId, `t-${agentId}`),
    );

    w.pump(Date.now());

    const row = subagents.get(agentId);
    expect(row).not.toBeNull();
    expect(row!.parentKind).toBe("workflow_agent");
    expect(row!.status).toBe("running");
    expect(row!.description).toBe("my-wf"); // meta has none — falls back to the container's

    const tagged = captured.filter((e) => e.stream === "user" || e.stream === "tool_use");
    expect(tagged.length).toBe(2);
    expect(tagged.every((e) => e.subagentId === agentId)).toBe(true);
    expect(tagged.every((e) => e.taskId === taskId)).toBe(true);

    w.detach();
  });

  test("with no container ever registered, description falls back to the wf dir name", async () => {
    const { subagents } = await import("./db.ts");
    const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
    const { taskId, jsonlPath, subagentsDir } = await seed();
    setSubagentEmitter(() => { /* drain */ });

    // No launch line is ever written to jsonlPath — only the agent file
    // shows up (e.g. the launch line sat outside the replay window, or this
    // agetor build never saw it). `workflowForDir` then has nothing to match.
    const wfRunId = "wf_orphan";
    const dir = wfDirFor(subagentsDir, wfRunId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(jsonlPath, "");

    const agentId = `orphanagent-${randomUUID().slice(0, 8)}`;
    writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), wfAgentMeta());
    writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), sidechainUserLine(agentId, `u-${agentId}`));

    const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
    w.pump(Date.now());

    const row = subagents.get(agentId);
    expect(row).not.toBeNull();
    expect(row!.parentKind).toBe("workflow_agent");
    expect(row!.description).toBe(wfRunId); // falls back to the dir name itself

    w.detach();
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 3. journal.jsonl receipts — the flush-loss backstop
 * ────────────────────────────────────────────────────────────────────────── */

describe("journal.jsonl receipts settle an agent row without a terminal end_turn", () => {
  test("a journal 'result' line settles the agent even though its own jsonl never got an end_turn", async () => {
    const { subagents } = await import("./db.ts");
    const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
    const { taskId, jsonlPath, subagentsDir } = await seed();
    setSubagentEmitter(() => { /* drain */ });

    const wtaskId = `wtask-${randomUUID()}`;
    const toolUseId = `toolu-${randomUUID()}`;
    const wfRunId = "wf_j";
    const dir = wfDirFor(subagentsDir, wfRunId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(jsonlPath, launchLine({ wtaskId, workflowName: "journal-wf", wfRunId, transcriptDir: dir, toolUseId }));

    const agentId = `jagent-${randomUUID().slice(0, 8)}`;
    writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), wfAgentMeta());
    // Only a user line + an in-flight tool_use — NEVER a terminal end_turn.
    writeFileSync(
      path.join(dir, `agent-${agentId}.jsonl`),
      sidechainUserLine(agentId, `u-${agentId}`) + sidechainToolUseLine(agentId, `t-${agentId}`),
    );

    const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
    const t0 = Date.now();
    w.pump(t0);
    expect(subagents.get(agentId)!.status).toBe("running");

    // The harness's own completion receipt lands in the wf dir's journal.
    writeFileSync(path.join(dir, "journal.jsonl"), journalLine("started", "k1", agentId) + journalLine("result", "k1", agentId, "ok"));
    w.pump(t0 + 1); // no DONE_IDLE_MS wait needed — the journal settle is immediate

    const row = subagents.get(agentId)!;
    expect(row.status).toBe("completed");
    expect(row.endedAt).not.toBeNull();

    w.detach();
  });

  test("a 'started' journal line alone does not settle the agent", async () => {
    const { subagents } = await import("./db.ts");
    const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
    const { taskId, jsonlPath, subagentsDir } = await seed();
    setSubagentEmitter(() => { /* drain */ });

    const wtaskId = `wtask-${randomUUID()}`;
    const toolUseId = `toolu-${randomUUID()}`;
    const wfRunId = "wf_started-only";
    const dir = wfDirFor(subagentsDir, wfRunId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(jsonlPath, launchLine({ wtaskId, workflowName: "started-wf", wfRunId, transcriptDir: dir, toolUseId }));

    const agentId = `sagent-${randomUUID().slice(0, 8)}`;
    writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), wfAgentMeta());
    writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), sidechainUserLine(agentId, `u-${agentId}`));

    const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
    const t0 = Date.now();
    w.pump(t0);

    writeFileSync(path.join(dir, "journal.jsonl"), journalLine("started", "k1", agentId));
    w.pump(t0 + 1);

    expect(subagents.get(agentId)!.status).toBe("running");

    w.detach();
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 4. tailPastSettle — trailing transcript lines after a journal settle
 * ────────────────────────────────────────────────────────────────────────── */

describe("tailPastSettle: an agent settled early by its journal keeps tailing while the container runs", () => {
  test("lines appended after the journal settle still produce events", async () => {
    const { subagents } = await import("./db.ts");
    const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
    const { taskId, jsonlPath, subagentsDir } = await seed();

    const captured: RunEvent[] = [];
    setSubagentEmitter((e) => captured.push(e));

    const wtaskId = `wtask-${randomUUID()}`;
    const toolUseId = `toolu-${randomUUID()}`;
    const wfRunId = "wf_t";
    const dir = wfDirFor(subagentsDir, wfRunId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(jsonlPath, launchLine({ wtaskId, workflowName: "trail-wf", wfRunId, transcriptDir: dir, toolUseId }));

    const agentId = `tagent-${randomUUID().slice(0, 8)}`;
    writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), wfAgentMeta());
    writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), sidechainUserLine(agentId, `u-${agentId}`));

    const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
    const t0 = Date.now();
    w.pump(t0); // registers container + agent

    // Settle via journal receipt WITHOUT a terminal end_turn — the container
    // itself is untouched and stays running.
    writeFileSync(path.join(dir, "journal.jsonl"), journalLine("result", "k1", agentId, "ok"));
    w.pump(t0 + 1);
    expect(subagents.get(agentId)!.status).toBe("completed");
    expect(subagents.get(wtaskId)!.status).toBe("running");

    captured.length = 0; // isolate what the NEXT append produces

    // More of the agent's own transcript flushes late — must not be lost.
    appendFileSync(path.join(dir, `agent-${agentId}.jsonl`), sidechainEndTurnLine(agentId, `e-${agentId}`, "late text"));
    w.pump(t0 + 2);

    const lateEvents = captured.filter((e) => e.subagentId === agentId);
    expect(lateEvents.length).toBeGreaterThan(0);
    expect(lateEvents.some((e) => e.stream === "assistant")).toBe(true);
    // Updated for fix 4 (docs/plans/fix-stuck-subagent-running-detection.md
    // §3): a journal `result` receipt settles with `source: "receipt"`,
    // latching `FileState.receiptSettled`. Previously (see git history)
    // `tailFile`'s resume-detection treated ANY append to an already-settled
    // row as a resumed background agent, regardless of why it was settled —
    // so tailing past a journal settle didn't just recover the lost content,
    // it also flipped the row back to `running`. That was the live
    // trailing-flush race fix 4 closes: the harness's journal receipt is
    // authoritative, and a trailing `assistant` line (not a fresh `user`
    // prompt) landing after it must NOT resurrect the row. The content is
    // still recovered (`lateEvents` above) — only the status flip is gone.
    expect(subagents.get(agentId)!.status).toBe("completed");

    w.detach();
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 5. Completion notification: container settle + cascade + single settle-hook fire
 * ────────────────────────────────────────────────────────────────────────── */

describe("workflow completion notification (queue-operation enqueue)", () => {
  test("settles the container, cascade-settles a still-running agent row, and fires the settle hook exactly once", async () => {
    const { subagents } = await import("./db.ts");
    const { attachSubagentWatcher, setSubagentEmitter, setSubagentSettleHook } = await import(
      "./claude-subagents.ts"
    );
    const { taskId, jsonlPath, subagentsDir } = await seed();
    setSubagentEmitter(() => { /* drain */ });

    const wtaskId = `wtask-${randomUUID()}`;
    const toolUseId = `toolu-${randomUUID()}`;
    const wfRunId = "wf_n";
    const dir = wfDirFor(subagentsDir, wfRunId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(jsonlPath, launchLine({ wtaskId, workflowName: "notif-wf", wfRunId, transcriptDir: dir, toolUseId }));

    const agentId = `nagent-${randomUUID().slice(0, 8)}`;
    writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), wfAgentMeta());
    // No end_turn, no journal receipt — still `running` when the notification lands.
    writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), sidechainUserLine(agentId, `u-${agentId}`));

    const settleCalls: string[] = [];
    setSubagentSettleHook((tid) => settleCalls.push(tid));

    const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
    const t0 = Date.now();
    w.pump(t0);
    expect(subagents.get(wtaskId)!.status).toBe("running");
    expect(subagents.get(agentId)!.status).toBe("running");
    expect(settleCalls.length).toBe(0);

    appendFileSync(jsonlPath, notificationLine({ wtaskId, toolUseId }));
    w.pump(t0 + 1);

    expect(subagents.get(wtaskId)!.status).toBe("completed");
    expect(subagents.get(agentId)!.status).toBe("completed"); // cascade
    expect(settleCalls).toEqual([taskId]); // exactly one fire for the whole cascade
    expect(subagents.hasRunning(taskId)).toBe(false);

    w.detach();
  });

  test("a failed/killed/stopped status still settles the container (the hold releases either way)", async () => {
    const { subagents } = await import("./db.ts");
    const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
    const { taskId, jsonlPath, subagentsDir } = await seed();
    setSubagentEmitter(() => { /* drain */ });

    const wtaskId = `wtask-${randomUUID()}`;
    const toolUseId = `toolu-${randomUUID()}`;
    const wfRunId = "wf_kill";
    const dir = wfDirFor(subagentsDir, wfRunId);
    writeFileSync(jsonlPath, launchLine({ wtaskId, workflowName: "kill-wf", wfRunId, transcriptDir: dir, toolUseId }));

    const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
    const t0 = Date.now();
    w.pump(t0);
    expect(subagents.get(wtaskId)!.status).toBe("running");

    appendFileSync(jsonlPath, notificationLine({ wtaskId, toolUseId, status: "killed" }));
    w.pump(t0 + 1);

    expect(subagents.get(wtaskId)!.status).toBe("completed");

    w.detach();
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 6. Notification anchoring — a bare <task-id> mention must not settle
 * ────────────────────────────────────────────────────────────────────────── */

describe("notification anchoring: a bare <task-id> mention is not a settle signal", () => {
  test("a line quoting <task-id> WITHOUT the enclosing <task-notification> tag leaves the container running", async () => {
    const { subagents } = await import("./db.ts");
    const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
    const { taskId, jsonlPath, subagentsDir } = await seed();
    setSubagentEmitter(() => { /* drain */ });

    const wtaskId = `wtask-${randomUUID()}`;
    const toolUseId = `toolu-${randomUUID()}`;
    const wfRunId = "wf_q";
    const dir = wfDirFor(subagentsDir, wfRunId);
    writeFileSync(jsonlPath, launchLine({ wtaskId, workflowName: "quote-wf", wfRunId, transcriptDir: dir, toolUseId }));

    const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
    const t0 = Date.now();
    w.pump(t0);
    expect(subagents.get(wtaskId)!.status).toBe("running");

    appendFileSync(jsonlPath, quoteOnlyLine(wtaskId));
    w.pump(t0 + 1);

    expect(subagents.get(wtaskId)!.status).toBe("running");
    expect(subagents.hasRunning(taskId)).toBe(true);

    w.detach();
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 7. Replay idempotency on reattach
 * ────────────────────────────────────────────────────────────────────────── */

describe("replay idempotency across reattach", () => {
  test("a settled container is not resurrected, no duplicate parked-discovery, no re-emitted 'started' lifecycle", async () => {
    const { subagents } = await import("./db.ts");
    const { attachSubagentWatcher, setSubagentEmitter, setParkedDiscoveryHandler } = await import(
      "./claude-subagents.ts"
    );
    const { taskId, jsonlPath, subagentsDir } = await seed();

    const captured: RunEvent[] = [];
    setSubagentEmitter((e) => captured.push(e));
    const parked: string[] = [];
    setParkedDiscoveryHandler((tid) => parked.push(tid));

    const wtaskId = `wtask-${randomUUID()}`;
    const toolUseId = `toolu-${randomUUID()}`;
    const wfRunId = "wf_r";
    const dir = wfDirFor(subagentsDir, wfRunId);
    writeFileSync(jsonlPath, launchLine({ wtaskId, workflowName: "replay-wf", wfRunId, transcriptDir: dir, toolUseId }));

    const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
    const t0 = Date.now();
    w.pump(t0);
    expect(parked).toEqual([taskId]);

    appendFileSync(jsonlPath, notificationLine({ wtaskId, toolUseId }));
    w.pump(t0 + 1);
    expect(subagents.get(wtaskId)!.status).toBe("completed");

    w.detach();
    captured.length = 0;
    parked.length = 0;

    // Fresh manual watcher: file is well under REPLAY_WINDOW_BYTES, so no
    // clamp applies — this replays the FULL main JSONL from offset 0 and
    // re-sees BOTH the launch line and the notification line.
    const w2 = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
    w2.pump(t0 + 2);

    expect(subagents.get(wtaskId)!.status).toBe("completed"); // not resurrected to running
    expect(parked.length).toBe(0); // no duplicate parked-discovery fire

    const startedForContainer = captured.filter(
      (e) => e.stream === "subagent" && e.subagentId === wtaskId && JSON.parse(e.data).phase === "started",
    );
    expect(startedForContainer.length).toBe(0); // no re-emitted "started" lifecycle for a settled row

    w2.detach();
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 8. pumpWatcherForHoldCheck — synchronous registration ahead of the poll timer
 * ────────────────────────────────────────────────────────────────────────── */

describe("pumpWatcherForHoldCheck", () => {
  test("registers a just-written launch line synchronously", async () => {
    const { subagents } = await import("./db.ts");
    const { attachSubagentWatcher, pumpWatcherForHoldCheck } = await import("./claude-subagents.ts");
    const { taskId, jsonlPath, subagentsDir } = await seed();

    const wtaskId = `wtask-${randomUUID()}`;
    const toolUseId = `toolu-${randomUUID()}`;
    const wfRunId = "wf_h";
    const dir = wfDirFor(subagentsDir, wfRunId);

    // `manual: true` suppresses the self-scheduling poll timer entirely —
    // nothing discovers the launch line unless something pumps explicitly.
    const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
    writeFileSync(jsonlPath, launchLine({ wtaskId, workflowName: "hold-wf", wfRunId, transcriptDir: dir, toolUseId }));

    pumpWatcherForHoldCheck(taskId);

    const row = subagents.get(wtaskId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("running");
    expect(row!.parentKind).toBe("workflow");

    w.detach();
  });

  test("no-ops on an unknown taskId", async () => {
    const { pumpWatcherForHoldCheck } = await import("./claude-subagents.ts");
    expect(() => pumpWatcherForHoldCheck(`no-such-task-${randomUUID()}`)).not.toThrow();
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 9. AGETOR_TRACK_WORKFLOWS=0 kill switch
 * ────────────────────────────────────────────────────────────────────────── */

describe("AGETOR_TRACK_WORKFLOWS=0 kill switch", () => {
  test("no container or agent rows are created when the workflow flag is off", async () => {
    const prev = process.env.AGETOR_TRACK_WORKFLOWS;
    process.env.AGETOR_TRACK_WORKFLOWS = "0";
    // Re-import fresh so the module-level WORKFLOWS_ENABLED flag re-reads the
    // env — the same cache-busting idiom claude-subagents.test.ts uses for
    // AGETOR_TRACK_SUBAGENTS=0.
    const mod = await import(`./claude-subagents.ts?gate=${randomUUID()}`);
    const { subagents } = await import("./db.ts");
    const { taskId, jsonlPath, subagentsDir } = await seed();

    const wtaskId = `wtask-${randomUUID()}`;
    const toolUseId = `toolu-${randomUUID()}`;
    const wfRunId = "wf_k";
    const dir = wfDirFor(subagentsDir, wfRunId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(jsonlPath, launchLine({ wtaskId, workflowName: "kill-wf", wfRunId, transcriptDir: dir, toolUseId }));
    const agentId = `kagent-${randomUUID().slice(0, 8)}`;
    writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), wfAgentMeta());
    writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), sidechainUserLine(agentId, `u-${agentId}`));

    const w = mod.attachSubagentWatcher({ taskId, jsonlPath, manual: true });
    w.pump(Date.now());

    expect(subagents.get(wtaskId)).toBeNull();
    expect(subagents.get(agentId)).toBeNull();
    expect(subagents.listForTask(taskId).length).toBe(0);
    expect(subagents.hasRunning(taskId)).toBe(false);

    w.detach();
    if (prev === undefined) delete process.env.AGETOR_TRACK_WORKFLOWS;
    else process.env.AGETOR_TRACK_WORKFLOWS = prev;
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 10. REPLAY_WINDOW_BYTES clamp on attach
 * ────────────────────────────────────────────────────────────────────────── */

describe("REPLAY_WINDOW_BYTES clamp on attach", () => {
  test("a fresh watcher's first scan is clamped to the last ~4MB: an old launch line outside the window is never registered, one inside it is", async () => {
    const { subagents } = await import("./db.ts");
    const { attachSubagentWatcher, setSubagentEmitter, setParkedDiscoveryHandler } = await import(
      "./claude-subagents.ts"
    );
    const { taskId, jsonlPath, subagentsDir } = await seed();
    setSubagentEmitter(() => { /* drain */ });
    setParkedDiscoveryHandler(() => { /* drain */ });

    const oldWtaskId = `wtask-old-${randomUUID()}`;
    const recentWtaskId = `wtask-recent-${randomUUID()}`;
    const oldToolUseId = `toolu-old-${randomUUID()}`;
    const recentToolUseId = `toolu-recent-${randomUUID()}`;
    const oldDir = wfDirFor(subagentsDir, "wf_old");
    const recentDir = wfDirFor(subagentsDir, "wf_recent");

    const oldLine = launchLine({
      wtaskId: oldWtaskId, workflowName: "old-wf", wfRunId: "wf_old", transcriptDir: oldDir, toolUseId: oldToolUseId,
    });
    const recentLine = launchLine({
      wtaskId: recentWtaskId, workflowName: "recent-wf", wfRunId: "wf_recent", transcriptDir: recentDir, toolUseId: recentToolUseId,
    });
    // A gap strictly larger than REPLAY_WINDOW_BYTES (4 * 1024 * 1024) so the
    // old launch line unambiguously falls outside the clamp window while the
    // recent one falls inside it, regardless of the exact byte accounting.
    const gap = "F".repeat(4_300_000) + "\n";
    writeFileSync(jsonlPath, oldLine + gap + recentLine);

    const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
    w.pump(Date.now());

    expect(subagents.get(oldWtaskId)).toBeNull(); // outside the replay window — never seen
    const recentRow = subagents.get(recentWtaskId);
    expect(recentRow).not.toBeNull();
    expect(recentRow!.status).toBe("running");

    w.detach();
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 11. W6 — journal cursor rewind on late agent discovery
 * (docs/plans/fix-stuck-subagent-running-detection.md §3)
 * ────────────────────────────────────────────────────────────────────────── */

describe("W6: journal cursor rewind on late agent discovery", () => {
  test("a result receipt consumed before its agent's file existed still settles it once the file appears", async () => {
    const { subagents } = await import("./db.ts");
    const { attachSubagentWatcher, setSubagentEmitter, setParkedDiscoveryHandler } = await import(
      "./claude-subagents.ts"
    );
    const { taskId, jsonlPath, subagentsDir } = await seed();
    setSubagentEmitter(() => { /* drain */ });
    setParkedDiscoveryHandler(() => { /* drain */ });

    const wtaskId = `wtask-${randomUUID()}`;
    const toolUseId = `toolu-${randomUUID()}`;
    const wfRunId = "wf_rewind";
    const dir = wfDirFor(subagentsDir, wfRunId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(jsonlPath, launchLine({ wtaskId, workflowName: "rewind-wf", wfRunId, transcriptDir: dir, toolUseId }));

    const agentId = `rwagent-${randomUUID().slice(0, 8)}`;

    const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
    const t0 = Date.now();
    w.pump(t0); // registers the container; arms this dir's journal cursor at 0

    // The harness's own completion receipt for `agentId` lands in the journal
    // BEFORE its own `agent-<id>.jsonl` ever becomes readdir-visible — the
    // exact early-receipt race W6 closes (the analog of `discover()`'s own
    // `mainOffset = 0` rewind for the main-JSONL scan). Consumed now, the row
    // doesn't exist yet in the DB, so `settleSubagentById` is a silent no-op —
    // but the journal cursor has already moved past this line.
    writeFileSync(path.join(dir, "journal.jsonl"), journalLine("result", "k1", agentId, "ok"));
    w.pump(t0 + 1);
    expect(subagents.get(agentId)).toBeNull(); // nothing to settle yet — the row doesn't exist

    // The agent's transcript materializes late (readdir-visibility race).
    writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), wfAgentMeta());
    writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), sidechainUserLine(agentId, `u-${agentId}`));
    w.pump(t0 + 2);

    // `discoverWorkflowAgents` rewound this dir's journal cursor back to 0 the
    // moment it registered the new file, so the already-consumed receipt was
    // re-read (idempotent settle) and closed the row instead of stranding it
    // `running` forever with no signal left to consume.
    const row = subagents.get(agentId)!;
    expect(row.status).toBe("completed");
    expect(row.endedAt).not.toBeNull();
    expect(subagents.get(wtaskId)!.status).toBe("running"); // container untouched

    w.detach();
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 12. W7 — settle-on-discovery under an already-settled container
 * (docs/plans/fix-stuck-subagent-running-detection.md §3)
 * ────────────────────────────────────────────────────────────────────────── */

describe("W7: settle-on-discovery under an already-settled container", () => {
  test("a workflow agent discovered after its container already settled is inserted completed, never running — no parked-discovery, hasRunning stays false", async () => {
    const { subagents } = await import("./db.ts");
    const { attachSubagentWatcher, setSubagentEmitter, setParkedDiscoveryHandler } = await import(
      "./claude-subagents.ts"
    );
    const { taskId, jsonlPath, subagentsDir } = await seed();

    const captured: RunEvent[] = [];
    setSubagentEmitter((e) => captured.push(e));
    const parked: string[] = [];
    setParkedDiscoveryHandler((tid) => parked.push(tid));

    const wtaskId = `wtask-${randomUUID()}`;
    const toolUseId = `toolu-${randomUUID()}`;
    const wfRunId = "wf_late";
    const dir = wfDirFor(subagentsDir, wfRunId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(jsonlPath, launchLine({ wtaskId, workflowName: "late-wf", wfRunId, transcriptDir: dir, toolUseId }));

    const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
    const t0 = Date.now();
    w.pump(t0);
    expect(parked).toEqual([taskId]);
    expect(subagents.hasRunning(taskId)).toBe(true);

    // Settle the container via its completion notification, BEFORE any agent
    // file has appeared under it at all — the cascade invariant this test
    // pins is: nothing under a settled container may ever read as running,
    // including a row discovered after the fact.
    appendFileSync(jsonlPath, notificationLine({ wtaskId, toolUseId }));
    w.pump(t0 + 1);
    expect(subagents.get(wtaskId)!.status).toBe("completed");
    expect(subagents.hasRunning(taskId)).toBe(false);
    parked.length = 0;
    captured.length = 0;

    // A straggling agent file only becomes readdir-visible AFTER the
    // container already settled (a slow flush / readdir race).
    const agentId = `lateagent-${randomUUID().slice(0, 8)}`;
    writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), wfAgentMeta());
    writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), sidechainUserLine(agentId, `u-${agentId}`));
    w.pump(t0 + 2);

    const row = subagents.get(agentId)!;
    expect(row).not.toBeNull();
    expect(row.status).toBe("completed"); // born settled — never running, not even for one tick
    expect(row.endedAt).not.toBeNull();
    expect(parked.length).toBe(0); // no parked-discovery for a row born settled
    expect(subagents.hasRunning(taskId)).toBe(false);

    const lifecycleForAgent = captured.filter((e) => e.stream === "subagent" && e.subagentId === agentId);
    expect(lifecycleForAgent.length).toBe(1);
    expect(JSON.parse(lifecycleForAgent[0]!.data).phase).toBe("finished"); // not "started"

    // Fix 2 — a born-settled row's transcript must still be drained (tailed)
    // once, even though it never renders as `running`: fix 1's
    // discovery-time floor is what keeps that drain from flipping the row
    // back to running on the SAME pump, but without fix 2's `fs.offset === 0`
    // steady-state exception the content would never be read at all (a
    // non-`running` row is otherwise only re-tailed via `tailPastSettle` —
    // false here, the container is settled — or fix 3's poll backstop, which
    // only fires once there's something new to see). `sidechainUserLine`
    // writes a single plain "go" user turn, so exactly one content chunk
    // (not a lifecycle event) should have been emitted for it.
    const contentEvents = captured.filter((e) => e.subagentId === agentId && e.stream !== "subagent");
    expect(contentEvents.length).toBe(1);
    expect(contentEvents[0]!.stream).toBe("user");
    expect(contentEvents[0]!.data).toBe("go");

    // And the row must never flip back to running across further pumps —
    // the general container-settled guard in `tailFile` (fix 1's other
    // half) holds even once the drain above has advanced `fs.offset` past 0
    // (so the primary tail predicate no longer applies and fix 3's poll
    // backstop is what would otherwise re-tail it, finding nothing new).
    captured.length = 0;
    parked.length = 0;
    w.pump(t0 + 3);
    w.pump(t0 + 4);
    expect(subagents.get(agentId)!.status).toBe("completed");
    expect(subagents.hasRunning(taskId)).toBe(false);
    expect(parked.length).toBe(0);
    expect(captured.filter((e) => e.subagentId === agentId).length).toBe(0); // no re-drain, no re-flip

    w.detach();
  });
});

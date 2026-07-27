/**
 * End-to-end verification of the background-agent tracking feature against the
 * REAL Claude Code transcript layout — using genuine `subagents/agent-*.jsonl`
 * files (not synthetic fixtures) when they're present on this machine, exercised
 * through the actual HTTP server routes the webview uses.
 *
 * Flow under test (production code paths, nothing stubbed except the tmux spawn
 * — `attachSubagentWatcher` is invoked exactly as `attachTailer` does it):
 *   real agent-*.jsonl  →  watcher  →  mapJsonlEventToChunks  →  run_events
 *   (tagged subagent_id) + `subagents` registry  →  GET /tasks/:id/subagents
 *   and the GET /tasks/:id/events SSE replay (subagentId threaded through).
 *
 * Safe: its own temp DATA_DIR + dedicated port, no tmux, no claude spawn, never
 * touches a running agetor instance. Skips cleanly on a machine/CI without the
 * sample transcripts.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-subagents-itest-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4402";

// The sample transcripts produced by this repo's own session. Present on the
// dev machine; absent elsewhere → the test self-skips.
const REAL_SUBAGENTS_DIR = path.join(
  homedir(),
  ".claude/projects/-Users-alamosaravali--agetor-worktrees-e803837b-7b8b-4d34-9830-15677d9bd9df",
  "2122c7f4-4813-4eb7-9889-77793afc6a92",
  "subagents",
);
const HAVE_REAL = existsSync(REAL_SUBAGENTS_DIR)
  && readdirSync(REAL_SUBAGENTS_DIR).some((f) => /^agent-.+\.jsonl$/.test(f));

let server: { stop: () => void; port: number };
let token: string;

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void; port: number };
  token = API_TOKEN;
});

afterAll(() => { server?.stop?.(); });

const url = (p: string) => `http://127.0.0.1:4402${p}`;
const authed = (p: string) => fetch(url(p), { headers: { authorization: `Bearer ${token}` } });

/** Read an SSE endpoint for `ms`, returning the parsed `data:` frames. */
async function readSse(p: string, ms: number): Promise<any[]> {
  const ctrl = new AbortController();
  const res = await fetch(url(`${p}?token=${encodeURIComponent(token)}`), { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const out: any[] = [];
  const deadline = Date.now() + ms;
  let buf = "";
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const r = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((res2) => setTimeout(() => res2({ value: undefined, done: true }), Math.max(1, remaining))),
      ]);
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try { out.push(JSON.parse(line.slice(5).trim())); } catch { /* ping / partial */ }
      }
    }
  } finally {
    ctrl.abort();
  }
  return out;
}

test.skipIf(!HAVE_REAL)(
  "real claude subagent transcripts surface via /tasks/:id/subagents and the events SSE",
  async () => {
    const { tasks, runs, subagents } = await import("./db.ts");
    const { attachSubagentWatcher } = await import("./claude-subagents.ts");

    // Seed a task + (terminal) run — terminal so it doesn't perturb the shared
    // reconcileOrphans scan (see the bun-test shared-db note).
    const taskId = `task-itest-${randomUUID()}`;
    const runId = `run-itest-${randomUUID()}`;
    const now = Date.now();
    tasks.insert({
      id: taskId, title: "t", prompt: "p", column: "running", agent: "claude-code",
      workdir: "/tmp", isolation: "none", taskType: "task", branch: null, branchSource: "created", worktreePath: null,
      baseRef: null, mode: null, model: null, effort: null, references: [], backlog: [], draft: null, runId,
      hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
      archivedAt: null, createdAt: now, updatedAt: now,
    });
    runs.insert({
      id: runId, taskId, agent: "claude-code", status: "succeeded", startedAt: now,
      endedAt: now, exitCode: 0, tmuxSession: null, claudeSessionId: null, codexSessionId: null,
    });

    // Lay out a real `<sessionId>/subagents/` tree by copying the genuine
    // transcripts, then point the watcher at the derived main jsonlPath.
    const sessionId = randomUUID();
    const proj = path.join(DATA_DIR, "projects", "encoded");
    const subDir = path.join(proj, sessionId, "subagents");
    mkdirSync(subDir, { recursive: true });
    const copied: string[] = [];
    for (const f of readdirSync(REAL_SUBAGENTS_DIR)) {
      if (/^agent-.+\.(jsonl|meta\.json)$/.test(f)) {
        copyFileSync(path.join(REAL_SUBAGENTS_DIR, f), path.join(subDir, f));
        const m = /^agent-(.+)\.jsonl$/.exec(f);
        if (m) copied.push(m[1]!);
      }
    }
    expect(copied.length).toBeGreaterThanOrEqual(1);
    const jsonlPath = path.join(proj, `${sessionId}.jsonl`);

    // Drive the real watcher exactly as attachTailer does, then settle it.
    const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
    w.pump(Date.now());            // discover + tail real transcripts
    w.pump(Date.now() + 60_000);   // idle past the done threshold → completed

    // 1) HTTP snapshot route returns every real subagent with its meta label.
    const snap = await authed(`/tasks/${taskId}/subagents`);
    expect(snap.status).toBe(200);
    const list = (await snap.json()) as Array<{ id: string; agentType: string | null; status: string }>;
    expect(list.map((s) => s.id).sort()).toEqual([...copied].sort());
    // These genuine transcripts were spawned as Explore / claude-code-guide.
    expect(list.every((s) => typeof s.agentType === "string" && s.agentType.length > 0)).toBe(true);
    expect(list.every((s) => s.status === "completed")).toBe(true);

    // 2) The events SSE replay carries the subagents' transcript content,
    //    tagged with the right subagentId and parsed into real event kinds.
    const events = await readSse(`/tasks/${taskId}/events`, 1500);
    const tagged = events.filter((e) => e.subagentId && copied.includes(e.subagentId));
    expect(tagged.length).toBeGreaterThan(0);
    // Real subagent work includes assistant text and tool calls.
    const kinds = new Set(tagged.map((e) => e.stream));
    expect([...kinds].some((k) => k === "assistant" || k === "tool_use" || k === "user")).toBe(true);
    // Every tagged event names a real subagent and the right task.
    expect(tagged.every((e) => e.taskId === taskId)).toBe(true);

    w.detach();
  },
);

test("integration harness is wired even when sample transcripts are absent", () => {
  // Guards against the whole file silently skipping (e.g. a broken path) by
  // always asserting the server booted. The real assertions run on the dev box.
  expect(typeof token).toBe("string");
  expect(token.length).toBeGreaterThan(0);
  if (!HAVE_REAL) {
    console.log("[itest] sample claude subagent transcripts not present — real-transcript case skipped");
  }
});

import { test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import. Set both the
// data dir and an isolated API port BEFORE any sibling test in the same
// process imports server.ts / db.ts.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-approvals-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4411";

let server: { stop: () => void } | null = null;
let token: string;
const url = (p: string) => `http://127.0.0.1:4411${p}`;

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

/* ── /ask-questions scraper-sourced answering (no PreToolUse hook) ──────── */

async function seedScrapedAskQuestions(args: {
  taskId: string;
  questions: { question: string; multiSelect?: boolean; hasTypeRow?: boolean; options: { label: string }[] }[];
}): Promise<{ id: string }> {
  const cwd = mkdtempSync(path.join(tmpdir(), `agetor-askq-${args.taskId}-`));
  const { tasks } = await import("./db.ts");
  tasks.insert({
    id: args.taskId, title: args.taskId, prompt: "", column: "running",
    agent: "claude-code", workdir: cwd, isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null, mode: null,
    model: "opus-4.7", effort: null, fast: false, maxMode: false, references: [], backlog: [], plans: [], draft: null, runId: "run-askq",
    createdAt: Date.now(), updatedAt: Date.now(), hasOpenableRun: false,
    pendingInteractionCount: 0, openTerminalCount: 0, archivedAt: null,
  });
  const { registerScrapedAskQuestions } = await import("./interactions.ts");
  const req = registerScrapedAskQuestions({
    taskId: args.taskId, runId: "run-askq", questions: args.questions, fingerprint: `fp-${args.taskId}`,
  });
  return { id: req.id };
}

test("POST /ask-questions — scraper-sourced drive answer resolves the card", async () => {
  const { __testing } = await import("./interactions.ts");
  __testing.reset();
  const { id } = await seedScrapedAskQuestions({
    taskId: "t-askq-drive",
    questions: [{ question: "Pick", multiSelect: false, options: [{ label: "Red" }, { label: "Green" }] }],
  });
  const res = await fetch(url(`/ask-questions/${id}/answer`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ answers: [{ selected: ["Green"] }] }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).delivery).toBe("drive");
  // No live tmux session in the test → the keystrokes can't actually land,
  // but the route must still drop the card (it resolves unconditionally).
  const { listPendingForTask } = await import("./interactions.ts");
  expect(listPendingForTask("t-askq-drive")).toHaveLength(0);
});

test("POST /ask-questions — scraper-sourced custom-text answer resolves the card (message path — no Type row)", async () => {
  const { __testing } = await import("./interactions.ts");
  __testing.reset();
  const { id } = await seedScrapedAskQuestions({
    taskId: "t-askq-msg",
    questions: [{ question: "Pick", multiSelect: false, hasTypeRow: false, options: [{ label: "Red" }] }],
  });
  const res = await fetch(url(`/ask-questions/${id}/answer`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ answers: [{ selected: [], custom: "Magenta" }] }),
  });
  expect(res.status).toBe(200);
  // A session-less task can't reach a clean composer, so nothing is pasted:
  // ok:false, message-mode delivery, and no withheld/backlog flags.
  const payload = await res.json();
  expect(payload.delivery).toBe("message");
  expect(payload.ok).toBe(false);
  expect(payload.withheld).toBeUndefined();
  expect(payload.savedToBacklog).toBeUndefined();
  const { listPendingForTask } = await import("./interactions.ts");
  expect(listPendingForTask("t-askq-msg")).toHaveLength(0);
});

test("POST /ask-questions — a second request for a card that is still being answered sends no keys and no message", async () => {
  const { __testing, listPendingForTask } = await import("./interactions.ts");
  __testing.reset();
  const { __forTest } = await import("./claude-tmux.ts");
  const taskId = "t-askq-race";
  const { id } = await seedScrapedAskQuestions({
    taskId,
    questions: [{ question: "Pick", multiSelect: false, hasTypeRow: true, options: [{ label: "Red" }, { label: "Green" }] }],
  });

  // A fake tmux that records every call and keeps answering `capture-pane`
  // with the question modal still up, so the first request's drive stays in
  // its verify polls (~1 s) — the window the second request lands in.
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-askq-race-tmux-"));
  const logPath = path.join(dir, "calls.log");
  const panePath = path.join(dir, "pane.txt");
  const binPath = path.join(dir, "tmux");
  writeFileSync(logPath, "");
  writeFileSync(panePath, [
    " \u2610 Pick", "", "Pick", "",
    "\u276f 1. Red", "  2. Green", "  3. Type something.",
    "\u2500".repeat(40), "  4. Chat about this", "",
    "Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 Esc to cancel",
  ].join("\n"));
  writeFileSync(binPath, `#!/bin/sh\necho "$*" >> "${logPath}"\ncase "$*" in *capture-pane*) cat "${panePath}";; esac\nexit 0\n`);
  chmodSync(binPath, 0o755);

  const prevBin = process.env.AGETOR_TMUX_BIN;
  process.env.AGETOR_TMUX_BIN = binPath;
  __forTest.installSession(taskId, path.join(dir, "s.jsonl"));
  try {
    const post = () => fetch(url(`/ask-questions/${id}/answer`), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ answers: [{ selected: ["Green"] }] }),
    });
    const sendKeys = () => readFileSync(logPath, "utf8").split("\n").filter((l) => l.includes("send-keys"));

    const first = post();
    // Let the first request claim the card and send its keys (Down, Enter).
    const deadline = Date.now() + 3000;
    while (sendKeys().length < 2 && Date.now() < deadline) await Bun.sleep(20);
    expect(sendKeys().length).toBe(2);

    const second = await post();
    expect(second.status).toBe(409);
    const secondBody = await second.json();
    expect(secondBody).toEqual({ error: "this question is already being answered" });
    // The rejected request typed nothing into the modal.
    expect(sendKeys().length).toBe(2);
    // …and it did not resolve the card out from under the request that owns it.
    expect(listPendingForTask(taskId)).toHaveLength(1);

    const firstBody = await (await first).json();
    expect(firstBody.delivery).toBe("drive");
    expect(listPendingForTask(taskId)).toHaveLength(0);

    // The claim is released: a later request finds no card and attempts nothing.
    const third = await (await post()).json();
    expect(third).toEqual({ ok: false });
    expect(sendKeys().length).toBe(2);
  } finally {
    __forTest.uninstallSession(taskId);
    if (prevBin === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = prevBin;
  }
});

test("POST /ask-questions — unknown id returns ok:false (no hook-sourced cards exist)", async () => {
  // There is no PreToolUse hook any more, so the only ask cards are
  // scraper-sourced. An id that matches no pending scraper card has nothing
  // to drive — the route reports ok:false rather than blocking on a promise.
  const { __testing } = await import("./interactions.ts");
  __testing.reset();
  const res = await fetch(url(`/ask-questions/does-not-exist/answer`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ answers: [{ selected: ["B"] }] }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(false);
});

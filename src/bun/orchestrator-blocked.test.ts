import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-blk-"));
// The approval-prompt heuristic now only runs for codex — interactive
// claude's permission prompts surface inside the TUI, not in the JSONL
// stream, so the orchestrator's chunk handler skips the check for the
// claude branch. Use codex's stub binary to exercise the flip.
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_CODEX_ARGS = "Do you want me to apply this patch?";

test("orchestrator flips codex task to 'blocked' on approval-prompt output", async () => {
  const { createTask, startTask, subscribe } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");
  // Codex is shipped disabled-by-default (see migration 016); this test
  // exercises the codex branch, so flip it back on for the test database.
  harnesses.setEnabled("codex", true);

  const created = await createTask({
    title: "needs approval",
    prompt: "ignored",
    agent: "codex",
    workdir: process.cwd(),
    isolation: "none",
    // Detection only fires for non-auto modes where the agent can actually
    // prompt — otherwise narrative output would false-positive.
    mode: "ask",
  });
  if ("error" in created) throw new Error(created.error);
  const task = created.task;

  const statuses: string[] = [];
  const unsub = subscribe((e) => {
    if (e.stream === "status") statuses.push(e.data);
  });

  const res = await startTask(task.id);
  expect("runId" in res).toBe(true);

  // Echo exits quickly; the column flip happens synchronously inside the
  // stdout chunk handler, so a short wait is enough.
  await new Promise((r) => setTimeout(r, 250));
  unsub();

  const after = tasks.get(task.id);
  // The exit handler later flips column to 'review' (echo returns 0). We just
  // assert that a blocked status was emitted during the run — that's the
  // user-visible signal. If we wanted to keep the card in 'blocked' through
  // exit we'd need extra logic; the current contract is: blocked is
  // surfaced via the status event + a transient column change.
  expect(statuses.some((s) => s.startsWith("blocked"))).toBe(true);
  expect(after).not.toBeNull();
});

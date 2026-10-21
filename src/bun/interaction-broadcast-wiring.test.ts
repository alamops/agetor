import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Pins the PRODUCTION interaction-broadcast wiring from a fresh process, with
// nothing re-wired: importing orchestrator.ts must leave a resolved bridge
// installed that emits the global `interaction`/`resolved` event. In-process
// tests can't prove this on their own — any of them may re-install the bridge
// (that is exactly how a second, per-task-only bridge replacing the global one
// once went unnoticed).

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-broadcast-wiring-"));

// Only the child process ever opens agetor.sqlite in this dir (it has exited by
// the time afterAll runs), so a plain rm is safe — rmTestDataDir would refuse
// because the child's sqlite file is there, and leak the dir.
afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const SCRIPT = `
const { subscribeGlobal } = await import("./src/bun/orchestrator.ts");
const { registerTmuxPrompt, cancelPendingForTask } = await import("./src/bun/interactions.ts");
const seen = [];
subscribeGlobal((e) => {
  if (e.kind === "interaction" && e.taskId === "wiring-task") seen.push(e.state + ":" + e.interactionId);
});
const { id } = registerTmuxPrompt({
  taskId: "wiring-task",
  runId: "wiring-run",
  paneText: "Proceed?",
  choices: [{ key: "1", label: "Yes" }],
  fingerprint: "fp-wiring",
});
cancelPendingForTask("wiring-task", "test");
console.log("ID=" + id);
console.log("SEEN=" + seen.join(","));
process.exit(0);
`;

test("a fresh process emits global pending AND resolved interaction events", async () => {
  const proc = Bun.spawn([process.execPath, "-e", SCRIPT], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGETOR_DATA_DIR: dataDir,
      AGETOR_CLAUDE_DRIVER: "fake",
      AGETOR_CLAUDE_BIN: "/bin/echo",
      AGETOR_TMUX_BIN: "/bin/echo",
      AGETOR_CLAUDE_ARGS: "",
      NODE_ENV: "test",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`wiring script exited ${code}: ${err}`);

  const id = /^ID=(.+)$/m.exec(out)?.[1];
  const seen = /^SEEN=(.*)$/m.exec(out)?.[1];
  expect(id).toBeTruthy();
  expect(seen?.split(",")).toEqual([`pending:${id}`, `resolved:${id}`]);
}, 30_000);

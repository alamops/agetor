import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { CORE_EXIT_PARK, HANDOFF_LAUNCH_SETTLE_MS } from "./daemon-mode.ts";

// A headless core asked to hand the port to the app (`POST /daemon/shutdown
// {mode:"handoff"}`, headless.ts `handOffPort`) with an agent launch still in
// flight: it stops taking new work FIRST (`freezeLaunches` — a start sent
// during the wait answers 503), keeps serving meanwhile, waits for the launch
// to settle (bounded by HANDOFF_LAUNCH_SETTLE_MS), then exits — 76 (park) for a
// login-item core, so its supervisor waits behind the app. The launch is a fake
// claude spawn held open by AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS, which keeps the
// task's start claim (`launchesInFlight`) until it registers. Port 4624.

const PORT = 4624;
const BASE = `http://127.0.0.1:${PORT}`;
// The start route answers `pending` after its 1.5 s budget, so the launch
// settles ~4.5 s into the handoff wait: room for the checks below even under
// load, and well inside the 8 s bound, so a wait that ran out the clock instead
// of waking on the settle is caught by the exit-time check.
const SPAWN_DELAY_MS = 6_000;
const MASTER = "h".repeat(64);

async function waitUp(): Promise<boolean> {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(300) })).ok) return true;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(100);
  }
  return false;
}

async function api(method: string, pathname: string, body?: unknown) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${MASTER}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

function runCount(dir: string, taskId: string): number {
  const db = new Database(path.join(dir, "agetor.sqlite"), { readonly: true });
  try {
    return db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").get(taskId)?.n ?? -1;
  } finally {
    db.close();
  }
}

test("a handoff with a launch in flight freezes new work, waits for the launch, then parks (exit 76)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-handoff-settle-"));
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-handoff-settle-wd-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "test",
    AGETOR_DATA_DIR: dir,
    AGETOR_API_PORT: String(PORT),
    AGETOR_API_TOKEN: MASTER,
    AGETOR_DAEMON_IDLE_MS: "0",
    AGETOR_HEADLESS_NOTIFICATIONS: "0",
    AGETOR_HARNESS_AUTO_ENABLE: "0",
    AGETOR_TMUX_BIN: "/bin/echo",
    AGETOR_CLAUDE_DRIVER: "fake",
    AGETOR_CLAUDE_BIN: "/bin/echo",
    AGETOR_CLAUDE_ARGS: "",
    AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS: String(SPAWN_DELAY_MS),
    AGETOR_LAUNCHED_BY: "login-item",
  };
  const proc = Bun.spawn(["bun", "src/bun/headless.ts"], {
    cwd: process.cwd(),
    env: env as Record<string, string>,
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    expect(await waitUp()).toBe(true);

    const makeTask = async (title: string) => {
      const created = await api("POST", "/tasks", {
        title,
        prompt: "hello",
        agent: "claude-code",
        workdir,
        isolation: "none",
      });
      expect(created.status).toBeLessThan(300);
      return created.json.id as string;
    };
    const slow = await makeTask("slow launch");
    const late = await makeTask("late launch");

    // The spawn outlives the bounded response: the start claim is still held.
    const started = await api("POST", `/tasks/${slow}/start`);
    expect(started.status).toBe(200);
    expect(started.json.pending).toBe(true);

    const handoff = await api("POST", "/daemon/shutdown", { mode: "handoff" });
    expect(handoff.status).toBe(200);
    const handoffAt = Date.now();
    // The route answers first and hands off on the next tick; the core logs
    // this line right after it froze, before it starts waiting.
    const logPath = path.join(dir, "daemon.log");
    const waitingLine = "handoff requested — waiting for 1 agent launch(es) to settle";
    for (let i = 0; i < 100 && !(existsSync(logPath) && readFileSync(logPath, "utf8").includes(waitingLine)); i++) {
      await Bun.sleep(50);
    }
    expect(readFileSync(logPath, "utf8")).toContain(waitingLine);

    // Frozen before the wait: a new start is refused with the retry-later 503…
    const refused = await api("POST", `/tasks/${late}/start`);
    expect(refused.status).toBe(503);
    expect(refused.json.code).toBe("launches-frozen");
    // …while the core still answers, and has not exited yet.
    expect((await fetch(`${BASE}/health`)).ok).toBe(true);
    const exitedEarly = await Promise.race([proc.exited.then(() => true), Bun.sleep(300).then(() => false)]);
    expect(exitedEarly).toBe(false);

    const code = await Promise.race([
      proc.exited,
      Bun.sleep(30_000).then(() => {
        throw new Error("the core never exited after the handoff");
      }),
    ]);
    expect(code).toBe(CORE_EXIT_PARK);
    // It woke on the launch settling, before the bound would have expired.
    expect(Date.now() - handoffAt).toBeLessThan(HANDOFF_LAUNCH_SETTLE_MS);

    const log = readFileSync(logPath, "utf8");
    expect(log).not.toContain("still pending after");
    expect(log).toContain("shutting down (shutdown request (handoff))");

    // The slow launch got its run; the late one never did. Creds are gone so
    // the app can take over.
    expect(runCount(dir, slow)).toBe(1);
    expect(runCount(dir, late)).toBe(0);
    expect(existsSync(path.join(dir, "agetor-core.json"))).toBe(false);
  } finally {
    proc.kill();
    await proc.exited;
    // The child's data dir, never this process's db.ts singleton: safe to remove.
    rmSync(dir, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
}, 60_000);

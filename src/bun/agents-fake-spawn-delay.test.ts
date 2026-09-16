import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentKind, Harness } from "../shared/types.ts";

/* ────────────────────────────────────────────────────────────────────────── *
 * U4 — docs/plans/task-details-blank-while-session-restores.md §4 (T4) /
 * §5 (U4). `agents.ts`'s fake claude-code driver branch (under
 * `AGETOR_CLAUDE_DRIVER=fake`) reads `AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS` and,
 * when it parses to a finite number > 0, awaits `Bun.sleep(N)` BEFORE
 * `spawnAgent` returns — reproducing a slow `spawnClaudeViaTmux` (e.g. a slow
 * `tmux new-session`, see the T2/U3 sibling test) without touching tmux at
 * all. This is distinct from `AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS`, which
 * delays a TURN's resolution once the fake agent is already running — this
 * seam delays the caller (`startTask`/`sendInput`) from ever getting a
 * `SpawnedAgent` back in the first place.
 *
 * Contract under test: unset / "0" / "abc" (non-finite) / "-5" (finite but
 * not > 0) all resolve immediately (byte-identical to no seam at all); a
 * positive finite value resolves only after at least that many ms.
 * ────────────────────────────────────────────────────────────────────────── */

// agents.ts imports codex-tmux.ts/gemini-tmux.ts, both of which import
// dataDir from db.ts — db.ts opens its sqlite connection at module-load
// time. A plain top-level `import` is hoisted ahead of any other code in
// this file, so AGETOR_DATA_DIR must be set before a *dynamic* import
// instead (same pattern as agents-fake-md-image.test.ts /
// agents-fake-sent-files.test.ts).
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-spawn-delay-db-"));
const { spawnAgent } = await import("./agents.ts");

/** Built-in claude-code harness — same shape as the sibling fake-driver test
 *  files' local `builtinClaude()` helper (kept local: this file owns no
 *  import of another test module). */
function builtinClaude(): Harness {
  return {
    id: "claude-code",
    kind: "claude-code" as AgentKind,
    label: "claude-code",
    isBuiltin: true,
    home: null,
    bin: null,
    env: {},
    enabled: true,
  };
}

const SAVED_ENV_KEYS = ["AGETOR_CLAUDE_DRIVER", "AGETOR_CLAUDE_BIN", "AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS"] as const;
const saved: Partial<Record<(typeof SAVED_ENV_KEYS)[number], string | undefined>> = {};
let taskCounter = 0;

/** Runs `spawnAgent` against the fake claude-code driver with
 *  `AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS` set to `delayEnvValue` (or deleted
 *  when `undefined`), and returns how long the `spawnAgent` call itself took
 *  to resolve. Saves/restores the three env vars it touches so no case can
 *  leak into the next. */
async function measureSpawnDelay(delayEnvValue: string | undefined): Promise<number> {
  for (const k of SAVED_ENV_KEYS) saved[k] = process.env[k];
  process.env.AGETOR_CLAUDE_DRIVER = "fake";
  process.env.AGETOR_CLAUDE_BIN = "claude";
  if (delayEnvValue === undefined) delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  else process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS = delayEnvValue;

  const cwd = mkdtempSync(path.join(tmpdir(), "agetor-spawn-delay-cwd-"));
  const taskId = `task-spawn-delay-${taskCounter}`;
  const runId = `run-spawn-delay-${taskCounter}`;
  taskCounter += 1;

  try {
    const t0 = performance.now();
    const handle = await spawnAgent({
      taskId,
      runId,
      harness: builtinClaude(),
      prompt: "hello",
      cwd,
      onChunk: () => {},
      opts: { mode: "auto", model: "opus-4.7", effort: "high" },
    });
    const elapsed = performance.now() - t0;
    // Sanity: the call actually produced a well-formed fake agent, not a
    // silently-swallowed failure — its `done` promise settles to an exit
    // code once the fake driver's turn completes.
    expect(await handle.done).toBe(0);
    return elapsed;
  } finally {
    for (const k of SAVED_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

afterEach(() => {
  for (const k of SAVED_ENV_KEYS) delete process.env[k];
});

/** Generous upper bound proving the "resolves immediately" cases weren't
 *  accidentally delayed — well under the 300ms positive-delay case below,
 *  but not a tight bound (avoids the flake class this repo documents:
 *  never assert a near-zero wall-clock bound against a scheduler). */
const IMMEDIATE_BUDGET_MS = 200;
const SPAWN_DELAY_MS = 300;

test("AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS unset: spawnAgent resolves immediately", async () => {
  const elapsed = await measureSpawnDelay(undefined);
  expect(elapsed).toBeLessThan(IMMEDIATE_BUDGET_MS);
});

test('AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS="0": spawnAgent resolves immediately', async () => {
  const elapsed = await measureSpawnDelay("0");
  expect(elapsed).toBeLessThan(IMMEDIATE_BUDGET_MS);
});

test('AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS="abc" (non-finite): spawnAgent resolves immediately', async () => {
  const elapsed = await measureSpawnDelay("abc");
  expect(elapsed).toBeLessThan(IMMEDIATE_BUDGET_MS);
});

test('AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS="-5" (finite, not > 0): spawnAgent resolves immediately', async () => {
  const elapsed = await measureSpawnDelay("-5");
  expect(elapsed).toBeLessThan(IMMEDIATE_BUDGET_MS);
});

test(`AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS="${SPAWN_DELAY_MS}": spawnAgent resolves only after at least that many ms`, async () => {
  const elapsed = await measureSpawnDelay(String(SPAWN_DELAY_MS));
  expect(elapsed).toBeGreaterThanOrEqual(SPAWN_DELAY_MS - 5);
  // Sanity ceiling so a genuinely hung spawn still fails fast rather than
  // timing out the whole suite — generous, not a tight bound.
  expect(elapsed).toBeLessThan(SPAWN_DELAY_MS + 2000);
});

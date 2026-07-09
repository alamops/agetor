import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// tmux-resolution.ts imports db.ts, which opens (and migrates) the SQLite db
// on module load — so AGETOR_DATA_DIR must point at a throwaway dir BEFORE
// the import below runs (same idiom as reconcile.test.ts).
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-tmux-socket-"));

const { tmuxSocketName, tmuxSocketArgs } = await import("./tmux-resolution.ts");

// Snapshot + restore the env vars the resolver reads around EVERY test, so a
// case that mutates AGETOR_TMUX_SOCKET / NODE_ENV can't leak into sibling
// tests in the same bun process (same idiom as withFakeTmuxBin in
// claude-tmux-queue.test.ts, hoisted to beforeEach/afterEach since every
// test here touches the env).
const ENV_KEYS = ["AGETOR_TMUX_SOCKET", "NODE_ENV"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("under bun test (NODE_ENV=test), default socket is the isolated agetor-test", () => {
  delete process.env.AGETOR_TMUX_SOCKET;
  // bun test sets NODE_ENV=test already; pin it explicitly so the assertion
  // doesn't silently depend on runner behavior.
  process.env.NODE_ENV = "test";
  expect(tmuxSocketName()).toBe("agetor-test");
  expect(tmuxSocketArgs()).toEqual(["-L", "agetor-test"]);
});

test("AGETOR_TMUX_SOCKET env override wins over the NODE_ENV=test default", () => {
  process.env.NODE_ENV = "test";
  process.env.AGETOR_TMUX_SOCKET = "foo";
  expect(tmuxSocketName()).toBe("foo");
  expect(tmuxSocketArgs()).toEqual(["-L", "foo"]);
});

test('AGETOR_TMUX_SOCKET="default" forces tmux\'s own default socket (null / no args), even under test', () => {
  process.env.NODE_ENV = "test";
  process.env.AGETOR_TMUX_SOCKET = "default";
  expect(tmuxSocketName()).toBeNull();
  expect(tmuxSocketArgs()).toEqual([]);
});

test("outside test env with no override, socket is null (production default socket)", () => {
  delete process.env.AGETOR_TMUX_SOCKET;
  process.env.NODE_ENV = "production";
  expect(tmuxSocketName()).toBeNull();
  expect(tmuxSocketArgs()).toEqual([]);

  delete process.env.NODE_ENV;
  expect(tmuxSocketName()).toBeNull();
  expect(tmuxSocketArgs()).toEqual([]);
});

test("env is read at CALL time — flipping vars between calls changes the result (no caching)", () => {
  // The contract that lets tests reconfigure the socket without a restart:
  // tmuxSocketName() must re-read the env on every call.
  delete process.env.AGETOR_TMUX_SOCKET;
  process.env.NODE_ENV = "test";
  expect(tmuxSocketName()).toBe("agetor-test");

  process.env.AGETOR_TMUX_SOCKET = "foo";
  expect(tmuxSocketName()).toBe("foo");
  expect(tmuxSocketArgs()).toEqual(["-L", "foo"]);

  process.env.AGETOR_TMUX_SOCKET = "default";
  expect(tmuxSocketName()).toBeNull();
  expect(tmuxSocketArgs()).toEqual([]);

  delete process.env.AGETOR_TMUX_SOCKET;
  expect(tmuxSocketName()).toBe("agetor-test");

  process.env.NODE_ENV = "production";
  expect(tmuxSocketName()).toBeNull();

  process.env.NODE_ENV = "test";
  expect(tmuxSocketArgs()).toEqual(["-L", "agetor-test"]);
});

import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Real-tmux integration test for `healWindowSize` (docs/plans/fix-minimized-
// agent-tmux-attach.md §5 T1). The unit tests in claude-tmux.test.ts fake
// tmux entirely (recorded argv); this one exercises the real binary end to
// end: pin a live session's window-size to `manual` at a small fixed size —
// exactly what a crash between the OLD two-call resizePane/restorePaneSize
// used to leave stranded — call the exported heal function, and assert tmux
// itself now reports `latest`.
//
// db.ts opens (and migrates) SQLite on module load, so AGETOR_DATA_DIR must
// be a throwaway dir set BEFORE any import that reaches it (same idiom as
// every other real-tmux test file in this suite).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-window-heal-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

// Isolated tmux socket — a name of our OWN, distinct from the generic
// "agetor-test" default other files fall back to, and NEVER the user's real
// default socket. See the incident note in tmux-resolution.ts:73-85: a test
// that once ran on the shared default socket killed the user's live agent
// sessions. `tmuxSocketName()`/`tmuxSocketArgs()` read AGETOR_TMUX_SOCKET at
// CALL time (no module-level caching), so setting it here before any tmux
// call is enough — no need to touch AGETOR_TMUX_BIN, since this file
// deliberately needs the REAL tmux binary (there's nothing to heal against a
// fake one).
const TEST_SOCKET = "agetor-test-window-heal";
process.env.AGETOR_TMUX_SOCKET = TEST_SOCKET;

/** Real tmux resolvable on THIS process's PATH? An agent's non-interactive
 *  shell often lacks /opt/homebrew/bin, and `Bun.spawnSync` then throws
 *  ENOENT mid-test — a false hard failure. Skip (visibly) instead: on any
 *  machine that can actually run agetor, tmux is present and the test runs.
 *  Same idiom as claude-followup-restart.test.ts. */
const HAVE_TMUX = (() => {
  try {
    return Bun.spawnSync(["tmux", "-V"]).exitCode === 0;
  } catch {
    return false;
  }
})();
if (!HAVE_TMUX) {
  console.warn("[window-size-heal.test] tmux not on PATH — skipping real-tmux test");
}

// This file needs the REAL tmux binary — but a sibling file sharing this
// process in a combined `bun test` run can leave AGETOR_TMUX_BIN pinned to a
// stub (claude-tmux.test.ts sets it to `/bin/echo` at module top level and
// never restores it, since every test in that file wants the fast fake).
// `resolveTmuxBin()` reads the env at call time with no caching, so clearing
// the override here (and restoring whatever was there afterward) is enough
// to make sure this file always talks to real tmux regardless of run order.
let savedTmuxBin: string | undefined;
beforeAll(() => {
  savedTmuxBin = process.env.AGETOR_TMUX_BIN;
  delete process.env.AGETOR_TMUX_BIN;
});

afterAll(async () => {
  if (HAVE_TMUX) {
    // Best-effort: tear down the whole isolated socket's server so no
    // session lingers past the suite. Guarded to ONLY ever target our own
    // dedicated socket name — this must never reach the user's default
    // socket, which is exactly the incident socket isolation exists to
    // prevent.
    try {
      const { resolveTmuxBin, tmuxSocketName, tmuxSocketArgs } = await import("./tmux-resolution.ts");
      if (tmuxSocketName() === TEST_SOCKET) {
        Bun.spawnSync([resolveTmuxBin(), ...tmuxSocketArgs(), "kill-server"]);
      }
    } catch {
      // best-effort only — a missing tmux bin or already-dead server is fine.
    }
  }
  if (savedTmuxBin === undefined) delete process.env.AGETOR_TMUX_BIN;
  else process.env.AGETOR_TMUX_BIN = savedTmuxBin;
});

test.skipIf(!HAVE_TMUX)(
  "healWindowSize resets a real session stuck at window-size manual back to latest",
  async () => {
    await import("./db.ts");
    const { healWindowSize, sessionNameFor } = await import("./claude-tmux.ts");
    const { resolveTmuxBin, tmuxSocketArgs, tmuxSocketName } = await import("./tmux-resolution.ts");

    // Guard rail: if AGETOR_TMUX_SOCKET somehow didn't take (e.g. a sibling
    // file cleared it after this one's top-level ran, in a combined `bun
    // test` run sharing one process), refuse to touch a session on the
    // default socket rather than silently running against it.
    expect(tmuxSocketName()).toBe(TEST_SOCKET);

    const taskId = `task-windowheal-${randomUUID()}`;
    const sessionName = sessionNameFor(taskId);
    const tmuxBin = resolveTmuxBin();
    const sockArgs = tmuxSocketArgs();

    const create = Bun.spawnSync([
      tmuxBin, ...sockArgs, "new-session", "-d", "-s", sessionName, "--", "sleep", "30",
    ]);
    expect(create.exitCode).toBe(0);

    try {
      // Reproduce the stuck-pin bug: pin window-size manual at a small,
      // fixed size — exactly what a crash between the old two separate
      // resizePane/restorePaneSize tmux calls could leave a session in.
      const pin = Bun.spawnSync([
        tmuxBin, ...sockArgs,
        "set-window-option", "-t", sessionName, "window-size", "manual", ";",
        "resize-window", "-t", sessionName, "-x", "80", "-y", "24",
      ]);
      expect(pin.exitCode).toBe(0);

      const before = Bun.spawnSync([
        tmuxBin, ...sockArgs, "show-window-options", "-t", sessionName, "window-size",
      ]);
      expect(before.exitCode).toBe(0);
      expect(before.stdout.toString().trim()).toBe("window-size manual");

      // No in-memory SessionState is installed for this taskId — mirrors the
      // production case healWindowSize is mainly for (a session that
      // outlived the process, or a fresh boot before reattach rebuilds
      // state): `paneGrowInFlight` is only checked on a state that exists,
      // so healing must still proceed via the plain sessionExists() path.
      await healWindowSize(taskId);

      const after = Bun.spawnSync([
        tmuxBin, ...sockArgs, "show-window-options", "-t", sessionName, "window-size",
      ]);
      expect(after.exitCode).toBe(0);
      expect(after.stdout.toString().trim()).toBe("window-size latest");
    } finally {
      Bun.spawnSync([tmuxBin, ...sockArgs, "kill-session", "-t", "=" + sessionName]);
    }
  },
);

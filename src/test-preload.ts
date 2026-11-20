import { afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { createRunTmpdir, removeRunTmpdir } from "./test-run-tmpdir.ts";

/**
 * Bun test preload (registered in bunfig.toml under `[test]`).
 *
 * OpenCode writes into $HOME on EVERY invocation — even `--version` creates
 * XDG config/data/state/cache dirs and appends to a log file. Any unit test
 * that boots `server.ts` / `model-discovery.ts` or calls `checkAllHarnesses`
 * would otherwise resolve the machine's real `opencode` and pollute the
 * developer's home, so the default binary points at a path that cannot exist.
 * A test that needs OpenCode opts in explicitly by planting a stub and
 * setting `AGETOR_OPENCODE_BIN` (or a harness `bin`) itself.
 */
process.env.AGETOR_OPENCODE_BIN ??= "/nonexistent/agetor-test-opencode";

/**
 * Keep test scratch space off macOS's TCC-guarded `$TMPDIR`.
 *
 * On macOS `os.tmpdir()` resolves into `/private/var/folders/…`, and the OS
 * charges ~0.8 s for *executing* a script written there (the identical
 * script under `/tmp` starts in ~0.02 s — measured). Plenty of fixtures plant
 * `#!${process.execPath}` fake CLI binaries (`tmux`, harness CLIs, the
 * disclaim helper), spawning one per invocation; a test that makes a handful
 * of fake-`tmux` calls therefore blows its 5 s budget on that launch cost
 * alone, and background chains leaked by a timed-out test can then hang the
 * whole file. Redirecting the test process's `TMPDIR` removes the tax for
 * this process's own `os.tmpdir()` (where the fixtures are written). A child
 * sees the new value only when it is spawned with an env derived from
 * `process.env` (no `env` option, or `childEnv(...)` on its default base);
 * a spawn that passes a hand-built env without `TMPDIR` does not see this
 * override and falls back to whatever its own runtime picks, so a fixture
 * that must pin a child's temp dir sets `TMPDIR` in that env itself.
 * `AGETOR_TEST_KEEP_TMPDIR=1` opts out of both this redirect and the run
 * root below.
 *
 * One temp root per run (`src/test-run-tmpdir.ts`): `TMPDIR` points at
 * `<base>/agt-run-<pid>-XXXXXX`, removed once the whole run is done, so the
 * `mkdtemp` fixtures tests leave behind go with it instead of piling up
 * (100k+ leaked `agetor-*` directories, tens of GB, before this). A root
 * whose run died without exiting cleanly is swept by the next run.
 * The name must not contain "agetor": `claude-session-scan.ts` hides any
 * session whose cwd is under `os.tmpdir()` with "agetor" in its path, which
 * would hide every fixture session under the root.
 * `AGETOR_TEST_RETAIN_TMPDIR=1` keeps this run's root for inspection.
 */
if (process.env.AGETOR_TEST_KEEP_TMPDIR !== "1") {
  let base = tmpdir();
  if (
    process.platform === "darwin"
    && (base.startsWith("/var/folders/") || base.startsWith("/private/var/folders/"))
  ) {
    base = "/tmp";
  }
  const runRoot = createRunTmpdir(base, "agt-run-");
  process.env.TMPDIR = runRoot;
  if (process.env.AGETOR_TEST_RETAIN_TMPDIR !== "1") {
    // `bun test` fires neither `exit` nor `beforeExit` (Bun 1.3.10); an
    // `afterAll` registered in a preload runs once, after every file, even
    // when tests fail. The `exit` hook covers a runtime that does fire it.
    afterAll(() => removeRunTmpdir(runRoot));
    process.on("exit", () => removeRunTmpdir(runRoot));
  }
}

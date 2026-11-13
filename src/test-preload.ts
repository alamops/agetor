import { tmpdir } from "node:os";

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
 * Every test already creates unique `mkdtemp` directories,
 * so sharing `/tmp` is safe; `AGETOR_TEST_KEEP_TMPDIR=1` opts out.
 */
if (process.platform === "darwin" && process.env.AGETOR_TEST_KEEP_TMPDIR !== "1") {
  const resolved = tmpdir();
  if (resolved.startsWith("/var/folders/") || resolved.startsWith("/private/var/folders/")) {
    process.env.TMPDIR = "/tmp";
  }
}

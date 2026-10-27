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

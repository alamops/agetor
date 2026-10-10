/**
 * Regression: discovery probes must see the LIVE `process.env.PATH`.
 *
 * `Bun.spawn` without an `env` option hands the child Bun's startup env
 * snapshot, not the live `process.env`. On a packaged .app launched from
 * Finder / `open -a`, that snapshot is launchd's minimal PATH, and the PATH
 * built later by `rehydratePath()` only exists in the live `process.env`.
 * A `#!/usr/bin/env node` CLI such as codex then fails with
 * "env: node: No such file or directory" and discovery silently returns `[]`.
 *
 * Each case plants a stub whose shebang is `#!/usr/bin/env <interp>`, where
 * `<interp>` lives ONLY in a directory prepended to `process.env.PATH` at
 * runtime (so it is absent from Bun's startup snapshot), and asserts that
 * discovery still returns the stub's models.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { __testing, getDiscoveredModels, refreshKindModels } from "./agent-discovery.ts";
import { plantFakeCodexAppServer } from "./test-codex-app-server.ts";

/** Plant `<interp>` (forwards to /bin/sh) in a fresh dir; return [dir, name]. */
function plantLivePathInterpreter(): [string, string] {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-live-path-interp-"));
  const name = `agetor-fake-node-${path.basename(dir).slice(-6)}`;
  writeFileSync(path.join(dir, name), `#!/bin/sh\nexec /bin/sh "$@"\n`, { mode: 0o755 });
  return [dir, name];
}

/** Rewrite a `#!/bin/sh` stub so it is launched via `#!/usr/bin/env <interp>`. */
function viaEnvShebang(stub: string, interp: string): string {
  const body = readFileSync(stub, "utf8").replace(/^#!.*\n/, "");
  const out = path.join(mkdtempSync(path.join(tmpdir(), "agetor-live-path-bin-")), path.basename(stub));
  writeFileSync(out, `#!/usr/bin/env ${interp}\n${body}`, { mode: 0o755 });
  return out;
}

async function withLivePath(dir: string, vars: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const prevPath = process.env.PATH;
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  process.env.PATH = `${dir}:${prevPath ?? ""}`;
  Object.assign(process.env, vars);
  try {
    await run();
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("discoverCodex: an env-shebang codex resolves its interpreter from the live PATH", async () => {
  __testing.resetForTests();
  const [interpDir, interp] = plantLivePathInterpreter();
  const bin = viaEnvShebang(plantFakeCodexAppServer({ pages: [[{ id: "live-path-model" }]] }), interp);
  await withLivePath(interpDir, { AGETOR_CODEX_BIN: bin }, async () => {
    await refreshKindModels("codex");
  });
  expect(getDiscoveredModels("codex")).toEqual([{ id: "live-path-model", label: "live-path-model" }]);
});

test("discoverCursor (runProbe): an env-shebang cursor-agent resolves its interpreter from the live PATH", async () => {
  __testing.resetForTests();
  const [interpDir, interp] = plantLivePathInterpreter();
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-live-path-cursor-"));
  const bin = path.join(dir, "cursor-agent");
  writeFileSync(bin, `#!/usr/bin/env ${interp}\necho 'live-path-cursor'\nexit 0\n`, { mode: 0o755 });
  await withLivePath(interpDir, { AGETOR_CURSOR_BIN: bin }, async () => {
    await refreshKindModels("cursor");
  });
  expect(getDiscoveredModels("cursor")).toEqual([{ id: "live-path-cursor" }]);
});

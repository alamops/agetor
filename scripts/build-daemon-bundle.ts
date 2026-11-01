#!/usr/bin/env bun
// Builds vendor/daemon/ — the two plain-JS bundles the always-on background
// host runs OUTSIDE the Electrobun main process (docs/plans/always-on-host.md
// §3.9):
//
//   vendor/daemon/login-daemon.js   entry src/bun/login-daemon.ts — the tiny
//                                   supervisor `agetor-login-item run` execs.
//                                   Never imports db.ts, so it stays cheap.
//   vendor/daemon/headless.js       entry src/bun/headless.ts — the headless
//                                   core the supervisor spawns (SQLite, API,
//                                   orchestrator), the same code `agetor
//                                   daemon start` runs from a source checkout.
//
// WHY BUNDLES. The packaged .app has no src/ tree: Electrobun compiles only
// src/bun/index.ts into Contents/Resources/app/bun/index.js. A launchd job
// that must run before (and without) the desktop app therefore needs its own
// self-contained JS, run by the bundle's own bun binary. The packaged app
// ships these under Contents/Resources/app/daemon/ (electrobun.config.ts
// build.copy), which is where src/bun/login-daemon.ts looks for headless.js.
//
// The build options mirror how Electrobun builds the app's own main bundle
// (node_modules/electrobun/src/cli/index.ts, `Bun.build({ ...bunConfig,
// target: "bun" })` with no externals): `with { type: "text" }` migration
// imports and the package.json import are inlined, node:/bun: builtins stay
// external, and `import.meta.main` stays true for the entry file — which is
// what makes `if (import.meta.main) void runDaemon()` fire in a bundle. There
// is no `electrobun/bun` import on this path (headless.ts is built to run
// without the desktop shell), so nothing native needs externalising.
//
// Always rebuilds: Bun.build of both entries takes well under a second, and a
// stale-check would need the whole src/ import graph as inputs.
//
// SMOKE TESTS (no Electrobun build needed):
//
//   # headless core — creds file appears in the data dir; SIGTERM removes it
//   AGETOR_DATA_DIR=$(mktemp -d) AGETOR_API_PORT=4795 AGETOR_DAEMON_IDLE_MS=0 \
//     AGETOR_HEADLESS_NOTIFICATIONS=0 bun vendor/daemon/headless.js
//
//   # supervisor — spawns the bundled core named by AGETOR_LOGIN_DAEMON_CORE
//   AGETOR_DATA_DIR=$(mktemp -d) AGETOR_API_PORT=4796 AGETOR_DAEMON_IDLE_MS=0 \
//     AGETOR_HEADLESS_NOTIFICATIONS=0 \
//     AGETOR_LOGIN_DAEMON_CORE=vendor/daemon/headless.js \
//     bun vendor/daemon/login-daemon.js

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const OUT_DIR = path.join(REPO_ROOT, "vendor", "daemon");

const ENTRIES = [
  path.join(REPO_ROOT, "src", "bun", "login-daemon.ts"),
  path.join(REPO_ROOT, "src", "bun", "headless.ts"),
];

function fail(msg: string): never {
  console.error(`[build-daemon] ${msg}`);
  process.exit(1);
}

async function main() {
  // Start from an empty dir so a renamed or removed entry never leaves a stale
  // bundle behind for electrobun to copy into the app.
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const result = await Bun.build({
    entrypoints: ENTRIES,
    outdir: OUT_DIR,
    target: "bun",
    naming: "[name].js",
  });

  if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    fail("Bun.build failed");
  }

  for (const entry of ENTRIES) {
    const name = `${path.basename(entry, ".ts")}.js`;
    const out = Bun.file(path.join(OUT_DIR, name));
    if (!(await out.exists())) fail(`expected ${name} in ${OUT_DIR} but it is missing`);
    console.log(`[build-daemon] ${path.relative(REPO_ROOT, out.name!)} (${(out.size / 1024).toFixed(0)} KB)`);
  }
}

await main();

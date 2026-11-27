#!/usr/bin/env bun
// Builds vendor/daemon/ — the plain-JS bundles the always-on background host
// and the core's worker thread run OUTSIDE the Electrobun main process
// (docs/plans/always-on-host.md §3.9, docs/plans/non-blocking-core.md):
//
//   vendor/daemon/login-daemon.js   entry src/bun/login-daemon.ts — the tiny
//                                   supervisor `agetor-login-item run` execs.
//                                   Never imports db.ts, so it stays cheap.
//   vendor/daemon/headless.js       entry src/bun/headless.ts — the headless
//                                   core the supervisor spawns (SQLite, API,
//                                   orchestrator), the same code `agetor
//                                   daemon start` runs from a source checkout.
//   vendor/daemon/core-worker.js    entry src/bun/core-worker.ts — the worker
//                                   thread that owns the SQLite connection
//                                   (and the transcript parser). A Worker needs
//                                   a real file, so every host ships it next
//                                   to its own bundle: the headless core finds
//                                   it beside headless.js, the desktop app gets
//                                   a copy at Resources/app/bun/ (see
//                                   electrobun.config.ts), and src/bun/
//                                   worker-entry.ts resolves it.
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
// Always rebuilds: Bun.build of the entries takes well under a second, and a
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

import { createHash } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { buildFlagDefines } from "../src/shared/build-flags.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
// `--out <dir>` writes the bundles somewhere else (tests build into a temp dir); the build id is only written for the default dir.
const OUT_ARG = process.argv.indexOf("--out");
const CUSTOM_OUT = OUT_ARG >= 0 ? process.argv[OUT_ARG + 1] : undefined;
const OUT_DIR = CUSTOM_OUT ? path.resolve(CUSTOM_OUT) : path.join(REPO_ROOT, "vendor", "daemon");

const ENTRIES = [
  path.join(REPO_ROOT, "src", "bun", "login-daemon.ts"),
  path.join(REPO_ROOT, "src", "bun", "headless.ts"),
  path.join(REPO_ROOT, "src", "bun", "core-worker.ts"),
];

const BUILD_ID_DIR = path.join(REPO_ROOT, "vendor", "build-id");

/** Every file whose content decides what the bundles contain. */
async function hashSourceTree(): Promise<string> {
  const hash = createHash("sha256");
  async function walk(dir: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.(ts|tsx|sql|json)$/.test(e.name)) {
        hash.update(path.relative(REPO_ROOT, full));
        hash.update("\0");
        hash.update(await Bun.file(full).bytes());
      }
    }
  }
  await walk(path.join(REPO_ROOT, "src", "bun"));
  await walk(path.join(REPO_ROOT, "src", "shared"));
  hash.update(await Bun.file(path.join(REPO_ROOT, "package.json")).bytes());
  return hash.digest("hex").slice(0, 16);
}

/** Write vendor/build-id/build-id.ts (read by src/bun/build-id.ts). Left
 *  untouched when the id is unchanged, so a watcher sees no spurious write. */
async function writeBuildId(): Promise<string> {
  const id = await hashSourceTree();
  const file = path.join(BUILD_ID_DIR, "build-id.ts");
  const body = `// Generated by scripts/build-daemon-bundle.ts. Do not edit.\nexport const BUILD_ID = ${JSON.stringify(id)};\n`;
  const existing = Bun.file(file);
  if (!(await existing.exists()) || (await existing.text()) !== body) {
    await mkdir(BUILD_ID_DIR, { recursive: true });
    await Bun.write(file, body);
  }
  return id;
}

function fail(msg: string): never {
  console.error(`[build-daemon] ${msg}`);
  process.exit(1);
}

async function main() {
  // Start from an empty dir so a renamed or removed entry never leaves a stale
  // bundle behind for electrobun to copy into the app.
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const buildId = CUSTOM_OUT ? await hashSourceTree() : await writeBuildId();
  console.log(`[build-daemon] build id ${buildId}`);

  const result = await Bun.build({
    entrypoints: ENTRIES,
    outdir: OUT_DIR,
    target: "bun",
    naming: "[name].js",
    // Companion flags (src/shared/build-flags.ts): a release build removes the test seams from these bundles.
    define: buildFlagDefines(process.env),
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

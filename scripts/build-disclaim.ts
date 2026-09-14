#!/usr/bin/env bun
// Builds vendor/disclaim/disclaim — a tiny arm64 helper that execs a command
// as TCC-responsible for itself instead of inheriting Agetor's responsible-
// process identity (source: native/disclaim/disclaim.c). The packaged .app
// ships it under Contents/Resources/app/bin (see electrobun.config.ts
// build.copy) and the runtime resolver (src/bun/disclaim.ts) points at it.
// See docs/plans/stop-agetor-tcc-appdata-spam.md for the full rationale.
//
// Unlike scripts/build-notifier.ts, this is a bare compiled binary, not a
// signed .app bundle — a posix_spawn helper has no UI/notification surface
// that would require one. Electrobun's outer codesign pass (build.mac.codesign)
// re-signs everything in the bundle regardless, so we ad-hoc sign here only
// for local-run consistency with the notifier helper, mirroring its approach.
//
// Idempotent: skips when the built binary is newer than both sources.

import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SRC = path.join(REPO_ROOT, "native", "disclaim", "disclaim.c");

const OUT_DIR = path.join(REPO_ROOT, "vendor", "disclaim");
const EXE = path.join(OUT_DIR, "disclaim");

function fail(msg: string): never {
  console.error(`[build-disclaim] ${msg}`);
  process.exit(1);
}

async function run(cmd: string[], opts: { silent?: boolean } = {}): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const code = await p.exited;
  if (code !== 0) {
    if (!opts.silent) console.error(err.trim() || out.trim());
    throw new Error(`command failed (${code}): ${cmd.join(" ")}`);
  }
  return out.trim();
}

async function main() {
  if (process.platform !== "darwin") {
    // Same reasoning as build-notifier.ts: electrobun's dev watcher
    // fs.watch()es every `copy` source dir (including vendor/disclaim)
    // unconditionally, so a missing dir crashes `bun run dev` with ENOENT
    // on non-macOS.
    await mkdir(OUT_DIR, { recursive: true });
    console.log(`[build-disclaim] skipped on ${process.platform} (macOS-only step)`);
    return;
  }
  if (process.arch !== "arm64") {
    fail(`expected an arm64 build host (got ${process.arch}); Agetor only ships arm64`);
  }
  if (!existsSync(SRC)) {
    fail(`missing helper source at ${path.relative(REPO_ROOT, SRC)}`);
  }

  await mkdir(OUT_DIR, { recursive: true });

  // Idempotency: skip when the exe is newer than both the source and this
  // build script itself.
  if (existsSync(EXE)) {
    const exeMtime = statSync(EXE).mtimeMs;
    const selfPath = new URL(import.meta.url).pathname;
    const newestSource = Math.max(statSync(SRC).mtimeMs, statSync(selfPath).mtimeMs);
    if (exeMtime >= newestSource) {
      console.log(`[build-disclaim] cached at ${path.relative(REPO_ROOT, EXE)} — skipping`);
      return;
    }
  }

  console.log(`[build-disclaim] compiling ${path.relative(REPO_ROOT, SRC)} → arm64`);
  await run(["clang", "-arch", "arm64", "-O2", "-Wall", "-o", EXE, SRC]);

  // Ad-hoc sign for local-run consistency with the notifier helper.
  // Electrobun's outer sign + notarize pass re-signs the whole bundle at
  // build time regardless, so this is best-effort, not load-bearing.
  await run(["codesign", "--force", "--sign", "-", EXE]);

  const arch = await run(["lipo", "-archs", EXE]);
  if (arch.trim() !== "arm64") {
    fail(`built binary is '${arch}', expected arm64 (no Rosetta / x86_64 allowed)`);
  }
  console.log(`[build-disclaim] ✓ ${path.relative(REPO_ROOT, EXE)} (${arch})`);
}

main().catch((e) => {
  console.error(`[build-disclaim] ${(e as Error).message}`);
  process.exit(1);
});

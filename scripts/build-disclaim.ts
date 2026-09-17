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
// that would require one.
//
// SIGNING IS LOAD-BEARING HERE, not cosmetic. Electrobun's codesign pass
// (build.mac.codesign) signs Contents/Frameworks/*, every Mach-O under
// Contents/MacOS/, *.node under Contents/Resources/app/bun/, the launcher and
// finally the outer bundle — deliberately without --deep. Nothing under
// Contents/Resources/app/bin/ is ever touched, so whatever signature this
// script applies is the signature that ships. An ad-hoc one fails
// notarization with three errors against this path ("not signed with a valid
// Developer ID certificate", "signature does not include a secure timestamp",
// "does not have the hardened runtime enabled"). So: sign inside-out with
// --options runtime --timestamp under the release Developer ID when
// ELECTROBUN_DEVELOPER_ID is set, exactly like scripts/fetch-tmux.ts and
// scripts/build-notifier.ts do for their own nested binaries.
//
// Idempotent: skips when the built binary is newer than both sources AND the
// .signed-by stamp records the identity we'd sign with now — without that
// second half, a cached ad-hoc binary from a local `bun run dev` would be
// reused by a release build and ship unsigned-for-notarization.

import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SRC = path.join(REPO_ROOT, "native", "disclaim", "disclaim.c");

const OUT_DIR = path.join(REPO_ROOT, "vendor", "disclaim");
const EXE = path.join(OUT_DIR, "disclaim");
const STAMP = path.join(OUT_DIR, ".signed-by");

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

  const devId = process.env.ELECTROBUN_DEVELOPER_ID;
  const desiredIdentity = devId || "adhoc";

  // Idempotency: skip when the exe is newer than both the source and this
  // build script itself, and it was signed with the identity we'd use now.
  if (existsSync(EXE) && existsSync(STAMP)) {
    const exeMtime = statSync(EXE).mtimeMs;
    const selfPath = new URL(import.meta.url).pathname;
    const newestSource = Math.max(statSync(SRC).mtimeMs, statSync(selfPath).mtimeMs);
    const stamp = (await readFile(STAMP, "utf8")).trim();
    if (exeMtime >= newestSource && stamp === desiredIdentity) {
      console.log(`[build-disclaim] cached at ${path.relative(REPO_ROOT, EXE)} — skipping`);
      return;
    }
  }

  console.log(`[build-disclaim] compiling ${path.relative(REPO_ROOT, SRC)} → arm64`);
  await run(["clang", "-arch", "arm64", "-O2", "-Wall", "-o", EXE, SRC]);

  // Sign inside-out: hardened runtime + secure timestamp under the release
  // Developer ID (required by notarytool — see the header note), ad-hoc for
  // local runs, which is enough for macOS arm64 to load the binary at all.
  // No entitlements: the helper only posix_spawn(POSIX_SPAWN_SETEXEC)s its
  // argv, so it needs nothing beyond the default sandbox-free runtime.
  const signArgs = devId
    ? ["--force", "--options", "runtime", "--timestamp", "--sign", devId]
    : ["--force", "--sign", "-"];
  console.log(
    devId
      ? `[build-disclaim] signing with ${devId}`
      : "[build-disclaim] signing ad-hoc (set ELECTROBUN_DEVELOPER_ID for release)",
  );
  await run(["codesign", ...signArgs, EXE]);
  await run(["codesign", "--verify", "--strict", EXE]);
  await writeFile(STAMP, `${desiredIdentity}\n`);

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

#!/usr/bin/env bun
// Builds vendor/login-item/ — the "keep Agetor running in the background"
// helper and its two LaunchAgent plists:
//
//   vendor/login-item/agetor-login-item                          (arm64 Mach-O)
//   vendor/login-item/LaunchAgents/sh.alamops.agetor.daemon.plist
//   vendor/login-item/LaunchAgents/sh.alamops.agetor.canary.daemon.plist
//
// Source: native/login-item/ (main.swift + LaunchAgents/*.plist). The packaged
// .app ships the binary in Contents/MacOS and the plists in
// Contents/Library/LaunchAgents (electrobun.config.ts build.copy, wired by a
// later task); the runtime resolver is src/bun/login-item-helper.ts. See
// docs/plans/always-on-host.md §3.1, §3.3 and §3.9.
//
// Unlike scripts/build-notifier.ts this is a bare binary, not an .app: it is
// launched by launchd through the *app's* BundleProgram and calls SMAppService
// for the *app's* plist, so it needs no bundle of its own.
//
// SIGNING mirrors scripts/build-disclaim.ts: hardened runtime + secure
// timestamp under ELECTROBUN_DEVELOPER_ID when set (Electrobun re-signs
// Contents/MacOS/* in the final bundle, but a notarizable signature here keeps
// `verify:vendor` honest), ad-hoc otherwise. The helper's `info` command
// reports an ad-hoc build as unsigned, which is what disables the feature for
// local dev builds.
//
// Plists are `plutil -lint`ed before they are copied, so a broken plist fails
// the build instead of surfacing as a launchd EX_CONFIG (78) at run time.
//
// Idempotent: skips when the binary is newer than every input (Swift source,
// plists, this script), the copied plists exist, and the .signed-by stamp
// records the identity we'd sign with now — without the last check a cached
// ad-hoc binary from a local `bun run dev` would be reused by a release build.

import { existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SRC = path.join(REPO_ROOT, "native", "login-item", "main.swift");
const PLIST_SRC_DIR = path.join(REPO_ROOT, "native", "login-item", "LaunchAgents");

const OUT_DIR = path.join(REPO_ROOT, "vendor", "login-item");
const EXE = path.join(OUT_DIR, "agetor-login-item");
const PLIST_OUT_DIR = path.join(OUT_DIR, "LaunchAgents");
const STAMP = path.join(OUT_DIR, ".signed-by");

// Stable identifier so the signature (and any TCC/launchd record keyed on it)
// does not depend on the output file name.
const CODESIGN_IDENTIFIER = "sh.alamops.agetor.login-item";

function fail(msg: string): never {
  console.error(`[build-login-item] ${msg}`);
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

function plistSources(): string[] {
  if (!existsSync(PLIST_SRC_DIR)) return [];
  return readdirSync(PLIST_SRC_DIR)
    .filter((f) => f.endsWith(".plist"))
    .sort();
}

async function main() {
  if (process.platform !== "darwin") {
    // Same reasoning as build-disclaim.ts: electrobun's dev watcher fs.watch()es
    // every `copy` source dir (including vendor/login-item) unconditionally, so
    // a missing dir crashes `bun run dev` with ENOENT on non-macOS.
    await mkdir(OUT_DIR, { recursive: true });
    console.log(`[build-login-item] skipped on ${process.platform} (macOS-only step)`);
    return;
  }
  if (process.arch !== "arm64") {
    fail(`expected an arm64 build host (got ${process.arch}); Agetor only ships arm64`);
  }
  if (!existsSync(SRC)) {
    fail(`missing helper source at ${path.relative(REPO_ROOT, SRC)}`);
  }
  const plists = plistSources();
  if (plists.length === 0) {
    fail(`no LaunchAgent plists in ${path.relative(REPO_ROOT, PLIST_SRC_DIR)}`);
  }

  await mkdir(OUT_DIR, { recursive: true });

  const devId = process.env.ELECTROBUN_DEVELOPER_ID;
  const desiredIdentity = devId || "adhoc";

  // Idempotency: skip when the exe is newer than every input and was signed
  // with the identity we'd use now, and the copied plists are all in place.
  if (existsSync(EXE) && existsSync(STAMP) && plists.every((p) => existsSync(path.join(PLIST_OUT_DIR, p)))) {
    const exeMtime = statSync(EXE).mtimeMs;
    const selfPath = new URL(import.meta.url).pathname;
    const inputs = [SRC, selfPath, ...plists.map((p) => path.join(PLIST_SRC_DIR, p))];
    const newestInput = Math.max(...inputs.map((s) => statSync(s).mtimeMs));
    const stamp = (await readFile(STAMP, "utf8")).trim();
    if (exeMtime >= newestInput && stamp === desiredIdentity) {
      console.log(`[build-login-item] cached at ${path.relative(REPO_ROOT, OUT_DIR)} — skipping`);
      return;
    }
  }

  // 1. Lint the plists first: a bad one should fail before we spend a compile.
  for (const p of plists) {
    const src = path.join(PLIST_SRC_DIR, p);
    try {
      await run(["plutil", "-lint", src], { silent: true });
    } catch (e) {
      fail(`${path.relative(REPO_ROOT, src)} failed plutil -lint: ${(e as Error).message}`);
    }
  }

  // 2. Compile arm64. macOS 14 floor; SMAppService needs 13, the code uses
  //    nothing newer. ServiceManagement for SMAppService, Security for the
  //    signature check behind `info`.
  console.log(`[build-login-item] compiling ${path.relative(REPO_ROOT, SRC)} → arm64`);
  await rm(EXE, { force: true });
  await run([
    "xcrun", "swiftc", "-O",
    "-target", "arm64-apple-macos14",
    "-framework", "Foundation",
    "-framework", "ServiceManagement",
    "-framework", "Security",
    SRC, "-o", EXE,
  ]);

  // 3. Sign inside-out: hardened runtime + secure timestamp under the release
  //    Developer ID, ad-hoc for local runs. No entitlements needed.
  const signArgs = devId
    ? ["--force", "--options", "runtime", "--timestamp", "--identifier", CODESIGN_IDENTIFIER, "--sign", devId]
    : ["--force", "--identifier", CODESIGN_IDENTIFIER, "--sign", "-"];
  console.log(
    devId
      ? `[build-login-item] signing with ${devId}`
      : "[build-login-item] signing ad-hoc (set ELECTROBUN_DEVELOPER_ID for release)",
  );
  await run(["codesign", ...signArgs, EXE]);
  await run(["codesign", "--verify", "--strict", EXE]);

  // 4. Verify arch.
  const arch = await run(["lipo", "-archs", EXE]);
  if (arch.trim() !== "arm64") {
    fail(`built binary is '${arch}', expected arm64 (no Rosetta / x86_64 allowed)`);
  }

  // 5. Copy the (already linted) plists; fresh dir so a removed plist can't linger.
  await rm(PLIST_OUT_DIR, { recursive: true, force: true });
  await mkdir(PLIST_OUT_DIR, { recursive: true });
  for (const p of plists) {
    await copyFile(path.join(PLIST_SRC_DIR, p), path.join(PLIST_OUT_DIR, p));
  }

  // Stamp last: a build that died halfway must not look cached.
  await writeFile(STAMP, `${desiredIdentity}\n`);
  console.log(`[build-login-item] ✓ ${path.relative(REPO_ROOT, EXE)} (${arch}) + ${plists.length} plists`);
}

main().catch((e) => {
  console.error(`[build-login-item] ${(e as Error).message}`);
  process.exit(1);
});

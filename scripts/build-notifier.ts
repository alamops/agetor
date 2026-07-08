#!/usr/bin/env bun
// Builds vendor/notifier/AgetorNotifier.app — a tiny arm64 agent app that posts
// deep-linkable macOS notifications via UNUserNotificationCenter and opens the
// agetor://task/<id> URL on click (source: native/notifier/notifier.swift). The
// packaged .app ships it under Contents/Resources/app/bin (see
// electrobun.config.ts build.copy) and the runtime resolver
// (src/bun/notifier.ts) points at it.
//
// Why a whole .app and not a bare binary: UNUserNotificationCenter refuses to
// run outside a signed .app bundle with a bundle id. So we hand-assemble the
// minimal bundle here (no Xcode project needed — swiftc from the Command Line
// Tools is enough) and sign it inside-out so Electrobun's outer notarization
// pass accepts it.
//
// Idempotent: skips when the built exe is newer than both sources AND was
// signed with the identity we'd use now (mirrors fetch-tmux.ts).

import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile, readFile, copyFile, rm } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SRC = path.join(REPO_ROOT, "native", "notifier", "notifier.swift");
const PLIST = path.join(REPO_ROOT, "native", "notifier", "Info.plist");
const ICONSET = path.join(REPO_ROOT, "src", "assets", "agetor.iconset");

const OUT_DIR = path.join(REPO_ROOT, "vendor", "notifier");
const APP = path.join(OUT_DIR, "AgetorNotifier.app");
const CONTENTS = path.join(APP, "Contents");
const EXE = path.join(CONTENTS, "MacOS", "notifier");
const STAMP = path.join(OUT_DIR, ".signed-by");

function fail(msg: string): never {
  console.error(`[build-notifier] ${msg}`);
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
    console.log(`[build-notifier] skipped on ${process.platform} (macOS-only step)`);
    return;
  }
  if (process.arch !== "arm64") {
    fail(`expected an arm64 build host (got ${process.arch}); Agetor only ships arm64`);
  }
  if (!existsSync(SRC) || !existsSync(PLIST)) {
    fail(`missing helper sources at ${path.relative(REPO_ROOT, path.dirname(SRC))}/`);
  }

  const desiredIdentity = process.env.ELECTROBUN_DEVELOPER_ID || "adhoc";

  // Idempotency: skip when the exe is newer than both sources and the stamp
  // matches. The identity check prevents a local ad-hoc build from shipping
  // into a release (with ELECTROBUN_DEVELOPER_ID set) unsigned-for-notarization.
  if (existsSync(EXE) && existsSync(STAMP)) {
    const exeMtime = statSync(EXE).mtimeMs;
    // Rebuild when any input changed: the Swift source, the Info.plist, the
    // iconset dir (catches icon add/remove), or this build script itself.
    const selfPath = new URL(import.meta.url).pathname;
    const sources = [SRC, PLIST, selfPath, ...(existsSync(ICONSET) ? [ICONSET] : [])];
    const newestSource = Math.max(...sources.map((s) => statSync(s).mtimeMs));
    const stamp = (await readFile(STAMP, "utf8")).trim();
    if (exeMtime >= newestSource && stamp === desiredIdentity) {
      console.log(`[build-notifier] cached at ${path.relative(REPO_ROOT, APP)} — skipping`);
      return;
    }
  }

  // Fresh bundle each time so stale artifacts can't linger.
  await rm(APP, { recursive: true, force: true });
  await mkdir(path.join(CONTENTS, "MacOS"), { recursive: true });
  await mkdir(path.join(CONTENTS, "Resources"), { recursive: true });

  // 1. Compile arm64 against AppKit + UserNotifications.
  console.log(`[build-notifier] compiling ${path.relative(REPO_ROOT, SRC)} → arm64`);
  await run([
    "xcrun", "swiftc", "-O",
    "-target", "arm64-apple-macos13",
    "-framework", "AppKit",
    "-framework", "UserNotifications",
    SRC, "-o", EXE,
  ]);

  // 2. Info.plist + PkgInfo.
  await copyFile(PLIST, path.join(CONTENTS, "Info.plist"));
  await writeFile(path.join(CONTENTS, "PkgInfo"), "APPL????");

  // 3. Icon (best-effort): compile the app's iconset so the notification +
  //    permission prompt show Agetor's icon. A missing/failed icon is
  //    non-fatal — macOS falls back to a generic app icon.
  if (existsSync(ICONSET)) {
    try {
      await run(["iconutil", "-c", "icns", ICONSET, "-o", path.join(CONTENTS, "Resources", "icon.icns")]);
    } catch {
      console.warn("[build-notifier] icon build failed — shipping without a custom icon");
    }
  }

  // 4. Sign inside-out with hardened runtime (release) or ad-hoc (local). No
  //    entitlement needed for local notifications. Signing the .app bundle
  //    seals the single Mach-O inside it; Electrobun's outer sign + notarize
  //    then wraps the whole agetor.app.
  const devId = process.env.ELECTROBUN_DEVELOPER_ID;
  const signArgs = devId
    ? ["--force", "--options", "runtime", "--timestamp", "--sign", devId]
    : ["--force", "--sign", "-"];
  console.log(
    devId
      ? `[build-notifier] signing with ${devId}`
      : "[build-notifier] signing ad-hoc (set ELECTROBUN_DEVELOPER_ID for release)",
  );
  await run(["codesign", ...signArgs, APP]);
  await run(["codesign", "--verify", "--strict", APP]);
  await writeFile(STAMP, `${desiredIdentity}\n`);

  // 5. Verify arch.
  const arch = await run(["lipo", "-archs", EXE]);
  if (arch.trim() !== "arm64") {
    fail(`built binary is '${arch}', expected arm64 (no Rosetta / x86_64 allowed)`);
  }
  console.log(`[build-notifier] ✓ ${path.relative(REPO_ROOT, APP)} (${arch})`);
}

main().catch((e) => {
  console.error(`[build-notifier] ${(e as Error).message}`);
  process.exit(1);
});

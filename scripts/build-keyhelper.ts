#!/usr/bin/env bun
// Builds vendor/keyhelper/AgetorKeyHelper.app, the Companion's key helper (source: native/keyhelper/). It holds the core
// session key and the Secure Enclave registry key, draws the native pairing window, and is the only process that can use
// either key (docs/specs/remote-readiness-spec.md "Keys and cryptography", grill D2 and D3).
//
// Hand-assembled with swiftc like build-notifier.ts (no Xcode project). Signing:
//
//   AGETOR_KEYHELPER_PROFILE=<path to the Developer ID .provisionprofile, OUTSIDE the repo>
//   ELECTROBUN_DEVELOPER_ID=<"Developer ID Application: … (TEAMID)">
//     -> embeds the profile as Contents/embedded.provisionprofile, fills the entitlements template from the profile's team
//        id (never committed) and signs with the hardened runtime and a timestamp.
//   --adhoc, or no profile
//     -> ad-hoc signature, no entitlements: enough for `selftest-vectors`, but every keychain operation fails with
//        `keychain-unavailable` (there is no login-keychain fallback, grill D3). Needs no secrets, so CI can run it.
//
// Flags: --adhoc, --out <dir> (default vendor/keyhelper; tests build into a temp dir).

import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SRC_DIR = path.join(REPO_ROOT, "native", "keyhelper");
const SWIFT_FILES = ["main.swift", "Protocol.swift", "Keys.swift", "Revocation.swift", "PairingWindow.swift", "Canonical.swift", "SelfTest.swift"];
const PLIST = path.join(SRC_DIR, "Info.plist");
const ENTITLEMENTS_TEMPLATE = path.join(SRC_DIR, "entitlements.plist.template");

export const KEYHELPER_BUNDLE_ID = "sh.alamops.agetor.keyhelper";

/** The team id from a decoded provisioning profile plist (`security cms -D -i <profile>`). */
export function parseTeamId(profilePlist: string): string | null {
  const m = /<key>TeamIdentifier<\/key>\s*<array>\s*<string>([A-Z0-9]{10})<\/string>/.exec(profilePlist);
  return m ? (m[1] as string) : null;
}

/** The team id a Developer ID identity name ends with, `Developer ID Application: Name (TEAMID)`, if it has one. */
export function teamIdFromIdentity(identity: string): string | null {
  const m = /\(([A-Z0-9]{10})\)\s*$/.exec(identity);
  return m ? (m[1] as string) : null;
}

export function fillEntitlements(template: string, teamId: string): string {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("team id must be 10 characters");
  return template.replaceAll("__TEAM_ID__", teamId);
}

function fail(msg: string): never {
  console.error(`[build-keyhelper] ${msg}`);
  process.exit(1);
}

async function run(cmd: string[], opts: { silent?: boolean } = {}): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (code !== 0) {
    if (!opts.silent) console.error(err.trim() || out.trim());
    throw new Error(`command failed (${code}): ${cmd.join(" ")}`);
  }
  return out.trim();
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 && args[outIdx + 1] ? path.resolve(args[outIdx + 1] as string) : path.join(REPO_ROOT, "vendor", "keyhelper");
  const forceAdhoc = args.includes("--adhoc");

  const app = path.join(outDir, "AgetorKeyHelper.app");
  const contents = path.join(app, "Contents");
  const exe = path.join(contents, "MacOS", "keyhelper");
  const stampFile = path.join(outDir, ".signed-by");

  if (process.platform !== "darwin") {
    // electrobun's dev watcher fs.watch()es every `copy` source dir, so the directory must exist (same as build-notifier.ts).
    await mkdir(outDir, { recursive: true });
    console.log(`[build-keyhelper] skipped on ${process.platform} (macOS-only step)`);
    return;
  }
  if (process.arch !== "arm64") fail(`expected an arm64 build host (got ${process.arch}); Agetor only ships arm64`);
  const sources = [...SWIFT_FILES.map((f) => path.join(SRC_DIR, f)), PLIST, ENTITLEMENTS_TEMPLATE];
  for (const s of sources) if (!existsSync(s)) fail(`missing helper source ${path.relative(REPO_ROOT, s)}`);

  const profilePath = process.env.AGETOR_KEYHELPER_PROFILE;
  const devId = process.env.ELECTROBUN_DEVELOPER_ID;
  let mode: "signed" | "adhoc" = "adhoc";
  let teamId: string | null = null;
  if (!forceAdhoc && profilePath && devId) {
    if (!existsSync(profilePath)) fail(`AGETOR_KEYHELPER_PROFILE does not exist: ${profilePath}`);
    const decoded = await run(["security", "cms", "-D", "-i", profilePath]);
    teamId = parseTeamId(decoded);
    if (!teamId) fail("could not read the team id from the provisioning profile");
    const idTeam = teamIdFromIdentity(devId);
    if (idTeam && idTeam !== teamId) fail(`the profile's team (${teamId}) is not the signing identity's team (${idTeam})`);
    mode = "signed";
  } else if (!forceAdhoc && (profilePath || devId)) {
    console.warn("[build-keyhelper] AGETOR_KEYHELPER_PROFILE and ELECTROBUN_DEVELOPER_ID must both be set to sign for real; building ad hoc.");
  }

  const stamp = mode === "signed" ? `${devId}|${profilePath}|${statSync(profilePath as string).mtimeMs}` : "adhoc";
  if (existsSync(exe) && existsSync(stampFile)) {
    const newest = Math.max(...sources.map((s) => statSync(s).mtimeMs), statSync(new URL(import.meta.url).pathname).mtimeMs);
    if (statSync(exe).mtimeMs >= newest && (await readFile(stampFile, "utf8")).trim() === stamp) {
      console.log(`[build-keyhelper] cached at ${path.relative(REPO_ROOT, app)}: skipping`);
      return;
    }
  }

  await rm(app, { recursive: true, force: true });
  await mkdir(path.join(contents, "MacOS"), { recursive: true });
  await mkdir(path.join(contents, "Resources"), { recursive: true });

  console.log("[build-keyhelper] compiling native/keyhelper → arm64");
  await run([
    "xcrun", "swiftc", "-O",
    "-target", "arm64-apple-macos13",
    "-framework", "AppKit",
    "-framework", "CoreImage",
    "-framework", "CryptoKit",
    "-framework", "LocalAuthentication",
    "-framework", "Security",
    ...SWIFT_FILES.map((f) => path.join(SRC_DIR, f)),
    "-o", exe,
  ]);

  await copyFile(PLIST, path.join(contents, "Info.plist"));
  await writeFile(path.join(contents, "PkgInfo"), "APPL????");

  if (mode === "signed") {
    await copyFile(profilePath as string, path.join(contents, "embedded.provisionprofile"));
    const entitlements = path.join(outDir, "entitlements.generated.plist");
    await writeFile(entitlements, fillEntitlements(await readFile(ENTITLEMENTS_TEMPLATE, "utf8"), teamId as string));
    console.log(`[build-keyhelper] signing with ${devId} (hardened runtime, embedded profile)`);
    await run(["codesign", "--force", "--options", "runtime", "--timestamp", "--entitlements", entitlements, "--sign", devId as string, app]);
    await rm(entitlements, { force: true });
  } else {
    console.warn("[build-keyhelper] signing ad hoc with no entitlements: `selftest-vectors` works, keychain operations will fail.");
    console.warn("[build-keyhelper] set AGETOR_KEYHELPER_PROFILE and ELECTROBUN_DEVELOPER_ID for a helper that can pair.");
    await run(["codesign", "--force", "--sign", "-", app]);
  }
  await run(["codesign", "--verify", "--strict", app]);
  await writeFile(stampFile, `${stamp}\n`);

  const arch = await run(["lipo", "-archs", exe]);
  if (arch.trim() !== "arm64") fail(`built binary is '${arch}', expected arm64`);
  console.log(`[build-keyhelper] ✓ ${path.relative(REPO_ROOT, app)} (${arch}, ${mode})`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`[build-keyhelper] ${(e as Error).message}`);
    process.exit(1);
  });
}

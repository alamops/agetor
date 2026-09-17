#!/usr/bin/env bun
// Post-release verification: confirms every DMG in artifacts/ is properly
// signed, notarized, and stapled, then prints a summary with path + SHA-256
// for each.

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { verifyVendorSigning } from "./verify-vendor-signing.ts";

const APP_NAME = "Agetor";

function fail(msg: string): never {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

async function run(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const code = await p.exited;
  const out = (stdout + stderr).trim();
  if (code !== 0) {
    console.error(out);
    fail(`command failed: ${cmd.join(" ")}`);
  }
  return out;
}

const entries = await readdir("artifacts").catch(() => null);
if (!entries) fail("artifacts/ folder is missing — did the build run?");
const dmgs = entries!.filter((n) => n.endsWith(".dmg")).sort();
if (dmgs.length === 0) fail("no .dmg files found in artifacts/");

const buildDir = "build";
const buildEntries = await readdir(buildDir).catch(() => [] as string[]);

const version = (await Bun.file("package.json").json()).version as string;

console.log("verifying signed release artifacts…\n");

const summary: { dmg: string; arch: string; size: number; sha: string }[] = [];

for (const dmgName of dmgs) {
  const dmg = join("artifacts", dmgName);
  // Try to locate matching .app for codesign + spctl checks. Filename pattern:
  // Agetor-<arch>.dmg ↔ build/<env>-macos-<arch>/Agetor.app
  const archMatch = dmgName.match(/-(arm64|x64)\.dmg$/);
  if (!archMatch) fail(`cannot parse arch from ${dmgName}`);
  const arch = archMatch[1];
  const buildSubdir = buildEntries.find((d) => d.endsWith(`-macos-${arch}`));
  if (!buildSubdir) fail(`no build/<env>-macos-${arch} directory for ${dmgName}`);
  const app = join(buildDir, buildSubdir, `${APP_NAME}.app`);
  if (!existsSync(app)) fail(`expected ${app} but it's missing`);

  console.log(`  ${dmgName}`);

  const codesign = await run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", app]);
  if (!codesign.includes("satisfies its Designated Requirement")) {
    fail(`codesign check did not pass:\n${codesign}`);
  }
  console.log("    codesign:  app satisfies its Designated Requirement");

  // The nested binaries we ship under Contents/Resources/app/bin/ (tmux + its
  // dylibs, AgetorNotifier.app, disclaim) are NOT signed by electrobun — its
  // codesign pass covers Frameworks, Contents/MacOS/**, Resources/app/bun/
  // *.node, the launcher and the outer bundle, without --deep. They must
  // therefore be Developer ID + hardened runtime + secure timestamp before the
  // build, or notarization fails against those paths.
  //
  // This used to walk Contents/Resources/app/bin/ in the built .app, which
  // could never fire: by this point electrobun has packed the whole
  // Resources/app tree into a .tar.zst (read at runtime via libasar), so the
  // directory doesn't exist and existsSync() skipped the check silently —
  // which is exactly how an ad-hoc-signed disclaim reached Apple. Verify
  // vendor/ instead: the same bytes, still on disk, shared with the pre-build
  // gate (`bun run verify:vendor`) so the two can't drift.
  const vendor = await verifyVendorSigning({ requireDeveloperId: true });
  if (vendor.problems.length) {
    fail(`vendored binaries are not notarization-ready:\n   • ${vendor.problems.join("\n   • ")}`);
  }
  console.log(
    `    nested:    ${vendor.checked} vendored binar(y/ies) signed by Developer ID (runtime + timestamp)`,
  );

  const spctl = await run(["spctl", "--assess", "--type", "execute", "-vv", app]);
  if (!spctl.includes("accepted") || !spctl.includes("Notarized Developer ID")) {
    fail(`Gatekeeper did not accept the app:\n${spctl}`);
  }
  console.log("    spctl:     accepted (Notarized Developer ID)");

  const stapler = await run(["xcrun", "stapler", "validate", dmg]);
  if (!stapler.includes("The validate action worked")) {
    fail(`stapler validation failed:\n${stapler}`);
  }
  console.log("    stapler:   ticket valid on DMG");

  const sha = (await run(["shasum", "-a", "256", dmg])).split(/\s+/)[0];
  const size = (await stat(dmg)).size;
  summary.push({ dmg, arch, size, sha });
}

console.log(`\n✓ release artifacts ready (version ${version})`);
for (const s of summary) {
  const mb = (s.size / (1024 * 1024)).toFixed(1);
  console.log(`  ${s.dmg}`);
  console.log(`    arch:   ${s.arch}`);
  console.log(`    size:   ${mb} MB`);
  console.log(`    sha256: ${s.sha}`);
}

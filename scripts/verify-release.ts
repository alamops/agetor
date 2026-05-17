#!/usr/bin/env bun
// Post-release verification: confirms every DMG in artifacts/ is properly
// signed, notarized, and stapled, then prints a summary with path + SHA-256
// for each.

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

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

  // Walk every binary we ship under Contents/Resources/app/bin/ and confirm
  // each one is signed by our Developer ID — not ad-hoc, not unsigned. This
  // catches the failure mode where fetch-tmux runs without
  // ELECTROBUN_DEVELOPER_ID and ships ad-hoc-signed nested binaries that
  // notarytool accepted (because --deep checks the bundle as a whole) but
  // Gatekeeper might reject case-by-case on first launch.
  const binDir = join(app, "Contents", "Resources", "app", "bin");
  if (existsSync(binDir)) {
    const binFiles = await readdir(binDir);
    for (const f of binFiles) {
      const target = join(binDir, f);
      const dvv = await run(["codesign", "-dvv", target]);
      const authority = dvv.match(/Authority=(.+)/)?.[1] ?? "(none)";
      if (!authority.startsWith("Developer ID Application")) {
        fail(`bundled ${f} is signed by "${authority}", expected Developer ID Application`);
      }
    }
    console.log(`    nested:    ${binFiles.length} binar(y/ies) under bin/ signed by Developer ID`);
  }

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

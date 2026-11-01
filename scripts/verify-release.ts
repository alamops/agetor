#!/usr/bin/env bun
// Post-release verification: confirms every DMG in artifacts/ is properly
// signed, notarized, and stapled, then prints a summary with path + SHA-256
// for each.
//
// It also checks the always-on background host's packaging
// (docs/plans/always-on-host.md §3.9, A14): the login-item helper in
// Contents/MacOS, the two LaunchAgent plists in Contents/Library/LaunchAgents
// and the daemon JS bundles in Contents/Resources/app/daemon. Those live in
// the INNER bundle, which electrobun packs into the wrapper's
// Resources/<hash>.tar.zst, so the check extracts it first. The layout check
// is a plain function of an .app path (`verifyBackgroundLayout`), exercisable
// on a hand-assembled bundle:
//
//   bun scripts/verify-release.ts --layout path/to/Some.app

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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


// --- background host layout ------------------------------------------------

/** Team that owns the Developer ID certificate every release is signed with. */
const TEAM_ID = "ZQG3522LY7";
const BUNDLE_ID = "sh.alamops.agetor";
/** Relative to the .app root. */
const HELPER_REL = "Contents/MacOS/agetor-login-item";
/**
 * One plist per channel, Label == file stem. Kept in step with
 * LOGIN_ITEM_LABELS in src/bun/daemon-mode.ts by hand (this script imports
 * nothing from src/).
 */
const PLIST_LABELS = ["sh.alamops.agetor.daemon", "sh.alamops.agetor.canary.daemon"];
const DAEMON_JS = ["login-daemon.js", "headless.js"];

export interface LayoutCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

async function runCode(cmd: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, out: (stdout + stderr).trim() };
}

/**
 * Checks the background host's files inside one built .app (the inner bundle,
 * i.e. the one holding Contents/MacOS/<launcher>). Never throws and never
 * exits: every problem is a failed LayoutCheck, so the caller prints one line
 * per check and decides.
 */
export async function verifyBackgroundLayout(app: string): Promise<LayoutCheck[]> {
  const checks: LayoutCheck[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

  // 1. The helper: present, and signed the way notarization and SMAppService
  //    both need. Electrobun signs everything under Contents/MacOS; this
  //    proves it actually did for a file added through build.copy (A14).
  const helper = join(app, HELPER_REL);
  if (!existsSync(helper)) {
    add("helper exists", false, `${HELPER_REL} is missing`);
  } else {
    add("helper exists", true, HELPER_REL);
    const sig = await runCode(["codesign", "-dvv", helper]);
    if (sig.code !== 0) {
      add("helper signed", false, "codesign -dvv failed — the helper is not signed");
    } else {
      const authority = sig.out.match(/Authority=(.+)/)?.[1] ?? "(none)";
      add(
        "helper Developer ID",
        authority.startsWith("Developer ID Application"),
        `Authority=${authority}`,
      );
      add(
        "helper hardened runtime",
        /flags=[^\s]*runtime/.test(sig.out),
        sig.out.match(/flags=\S+/)?.[0] ?? "no flags",
      );
      const team = sig.out.match(/TeamIdentifier=(.+)/)?.[1] ?? "(none)";
      add("helper team", team === TEAM_ID, `TeamIdentifier=${team}, expected ${TEAM_ID}`);
    }
  }

  // 2. The plists: lint + every key SMAppService/launchd depend on. `status`
  //    can't tell us a plist is wrong (a bad one registers fine and then dies
  //    with EX_CONFIG 78 at load), so we read the files.
  const agents = join(app, "Contents", "Library", "LaunchAgents");
  for (const label of PLIST_LABELS) {
    const rel = `Contents/Library/LaunchAgents/${label}.plist`;
    const file = join(agents, `${label}.plist`);
    if (!existsSync(file)) {
      add(`plist ${label}`, false, `${rel} is missing`);
      continue;
    }
    const lint = await runCode(["plutil", "-lint", file]);
    add(`plist ${label} lint`, lint.code === 0, lint.code === 0 ? "plutil -lint OK" : lint.out);
    if (lint.code !== 0) continue;

    const conv = await runCode(["plutil", "-convert", "json", "-o", "-", file]);
    let plist: Record<string, unknown>;
    try {
      plist = JSON.parse(conv.out) as Record<string, unknown>;
    } catch {
      add(`plist ${label} keys`, false, `plutil could not convert it to JSON: ${conv.out}`);
      continue;
    }
    const problems: string[] = [];
    if (plist.Label !== label) problems.push(`Label is ${JSON.stringify(plist.Label)}`);
    if (plist.BundleProgram !== HELPER_REL) {
      problems.push(`BundleProgram is ${JSON.stringify(plist.BundleProgram)}`);
    }
    const args = plist.ProgramArguments;
    if (!Array.isArray(args) || args.join(" ") !== "agetor-login-item run") {
      problems.push(`ProgramArguments is ${JSON.stringify(args)}`);
    }
    if (plist.ProcessType !== "Interactive") {
      problems.push(`ProcessType is ${JSON.stringify(plist.ProcessType)}`);
    }
    if (plist.RunAtLoad !== true) problems.push(`RunAtLoad is ${JSON.stringify(plist.RunAtLoad)}`);
    const keepAlive = plist.KeepAlive as { SuccessfulExit?: unknown } | undefined;
    if (!keepAlive || typeof keepAlive !== "object" || keepAlive.SuccessfulExit !== false) {
      problems.push(`KeepAlive is ${JSON.stringify(plist.KeepAlive)}, want SuccessfulExit=false`);
    }
    const assoc = plist.AssociatedBundleIdentifiers;
    if (!Array.isArray(assoc) || !assoc.includes(BUNDLE_ID)) {
      problems.push(`AssociatedBundleIdentifiers is ${JSON.stringify(assoc)}`);
    }
    add(
      `plist ${label} keys`,
      problems.length === 0,
      problems.length
        ? problems.join("; ")
        : "Label, BundleProgram, ProgramArguments, ProcessType, RunAtLoad, KeepAlive, AssociatedBundleIdentifiers",
    );
    // launchd resolves BundleProgram against the bundle; a path that doesn't
    // exist there is the classic EX_CONFIG (78) after a "successful" register.
    const program = typeof plist.BundleProgram === "string" ? plist.BundleProgram : "";
    const found = !!program && existsSync(join(app, program));
    add(
      `plist ${label} BundleProgram resolves`,
      found,
      program ? `${program} → ${found ? "exists" : "NOT FOUND in the bundle"}` : "no BundleProgram",
    );
  }

  // 3. The daemon JS the helper's `run` command execs.
  for (const name of DAEMON_JS) {
    const rel = `Contents/Resources/app/daemon/${name}`;
    const ok = existsSync(join(app, rel));
    add(`daemon ${name}`, ok, ok ? rel : `${rel} is missing`);
  }
  return checks;
}

function printChecks(checks: LayoutCheck[], indent: string): boolean {
  let allOk = true;
  for (const c of checks) {
    if (!c.ok) allOk = false;
    console.log(`${indent}${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  return allOk;
}

/**
 * Unpacks the inner bundle from the wrapper app's Resources/<hash>.tar.zst
 * into a fresh temp dir and returns the .app inside it. Caller removes `root`.
 */
export async function extractInnerApp(wrapper: string): Promise<{ root: string; app: string }> {
  const resources = join(wrapper, "Contents", "Resources");
  const archives = (await readdir(resources)).filter((n) => n.endsWith(".tar.zst"));
  if (archives.length !== 1) {
    fail(`expected exactly one .tar.zst in ${resources}, found ${archives.length}`);
  }
  const root = await mkdtemp(join(tmpdir(), "agetor-verify-release-"));
  const tarPath = join(root, "inner.tar");
  const compressed = new Uint8Array(await Bun.file(join(resources, archives[0]!)).arrayBuffer());
  await writeFile(tarPath, Bun.zstdDecompressSync(compressed));
  const extractDir = join(root, "inner");
  await mkdir(extractDir);
  const tar = await runCode(["tar", "-xf", tarPath, "-C", extractDir]);
  if (tar.code !== 0) fail(`tar -x of ${archives[0]} failed:\n${tar.out}`);
  await rm(tarPath, { force: true });
  const apps = (await readdir(extractDir)).filter((n) => n.endsWith(".app"));
  if (apps.length !== 1) fail(`expected one .app inside ${archives[0]}, found ${apps.length}`);
  return { root, app: join(extractDir, apps[0]!) };
}

async function verifyArtifacts() {
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

    // Background host packaging lives in the inner bundle, packed inside the
    // wrapper's tar.zst — extract it, check, and always clean up.
    const inner = await extractInnerApp(app);
    try {
      console.log("    background host (inner bundle):");
      const checks = await verifyBackgroundLayout(inner.app);
      if (!printChecks(checks, "      ")) {
        const bad = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail ?? ""}`);
        fail(`background host packaging is wrong:\n   • ${bad.join("\n   • ")}`);
      }
    } finally {
      await rm(inner.root, { recursive: true, force: true });
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
}

if (import.meta.main) {
  const layoutIdx = process.argv.indexOf("--layout");
  if (layoutIdx !== -1) {
    const target = process.argv[layoutIdx + 1];
    if (!target || !existsSync(target)) fail("usage: bun scripts/verify-release.ts --layout <path to .app>");
    console.log(`background host layout of ${target}:`);
    process.exit(printChecks(await verifyBackgroundLayout(target), "  ") ? 0 : 1);
  }
  await verifyArtifacts();
}

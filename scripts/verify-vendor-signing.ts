#!/usr/bin/env bun
// Asserts every nested binary we vendor into the .app is signed the way
// notarytool requires: Developer ID Application authority, hardened runtime
// (--options runtime) and a secure timestamp (--timestamp).
//
// WHY THIS EXISTS AS ITS OWN PRE-BUILD STEP. Electrobun's codesign pass signs
// Contents/Frameworks/*, every Mach-O under Contents/MacOS/, *.node under
// Contents/Resources/app/bun/, the launcher and then the outer bundle —
// deliberately without --deep. It never touches Contents/Resources/app/bin/,
// so whatever signature scripts/fetch-tmux.ts, scripts/build-notifier.ts and
// scripts/build-disclaim.ts apply is the signature that ships. When
// build-disclaim.ts ad-hoc signed, notarization failed on three errors against
// that one path — after a full build and an upload to Apple.
//
// verify-release.ts nominally guarded this by walking
// Contents/Resources/app/bin/ in the built .app, but that guard could never
// fire: by the time it runs, electrobun has packed the whole Resources/app
// tree into a .tar.zst (read at runtime via libasar), so the directory doesn't
// exist and existsSync() skipped the block silently. Checking vendor/ instead
// — the exact bytes electrobun copies in — lets this run BEFORE the build, so
// a bad signature costs seconds instead of a notarization round-trip.

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const VENDOR_DIR = path.join(REPO_ROOT, "vendor");

// Which script owns each vendor subtree, so a failure names the fix site.
const OWNERS: Record<string, string> = {
  tmux: "scripts/fetch-tmux.ts",
  notifier: "scripts/build-notifier.ts",
  disclaim: "scripts/build-disclaim.ts",
};

async function run(cmd: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, out: (stdout + stderr).trim() };
}

/** Every code object under vendor/: Mach-O files, plus nested .app bundles. */
async function collectCodeObjects(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir)) {
    const target = path.join(dir, entry);
    // A nested .app is one code object; its inner Mach-O is sealed by the
    // bundle signature, so check the bundle and don't descend.
    if (entry.endsWith(".app")) {
      found.push(target);
      continue;
    }
    if ((await stat(target)).isDirectory()) {
      found.push(...(await collectCodeObjects(target)));
      continue;
    }
    // Skip the .signed-by identity stamps the vendor scripts write and any
    // other side-car file — `codesign -dvv` on a text file exits non-zero.
    const { out: kind } = await run(["file", "-b", target]);
    if (kind.includes("Mach-O")) found.push(target);
  }
  return found;
}

export interface VerifyVendorSigningOptions {
  /**
   * When true, a missing ELECTROBUN_DEVELOPER_ID is a failure rather than a
   * skip. Release gates pass true; the build chain passes false so a local
   * ad-hoc `bun run build` still works.
   */
  requireDeveloperId?: boolean;
  /** Log prefix, so the caller's output reads consistently. */
  tag?: string;
}

export interface VerifyVendorSigningResult {
  checked: number;
  skipped: boolean;
  problems: string[];
}

export async function verifyVendorSigning(
  opts: VerifyVendorSigningOptions = {},
): Promise<VerifyVendorSigningResult> {
  const tag = opts.tag ?? "[verify-vendor]";
  const devId = process.env.ELECTROBUN_DEVELOPER_ID;

  if (process.platform !== "darwin") {
    return { checked: 0, skipped: true, problems: [] };
  }
  if (!devId) {
    if (opts.requireDeveloperId) {
      return {
        checked: 0,
        skipped: false,
        problems: [
          "ELECTROBUN_DEVELOPER_ID is not set — the vendored binaries can only be ad-hoc signed, which fails notarization. Set it in .env.local.",
        ],
      };
    }
    console.log(`${tag} ELECTROBUN_DEVELOPER_ID not set — skipping (local ad-hoc build)`);
    return { checked: 0, skipped: true, problems: [] };
  }
  if (!existsSync(VENDOR_DIR)) {
    return {
      checked: 0,
      skipped: false,
      problems: [`vendor/ is missing — run the vendor:* steps before building.`],
    };
  }

  const targets = await collectCodeObjects(VENDOR_DIR);
  const problems: string[] = [];

  for (const target of targets) {
    const rel = path.relative(REPO_ROOT, target);
    const owner = OWNERS[rel.split(path.sep)[1] ?? ""];
    const suffix = owner ? ` (owned by ${owner})` : "";

    const { code, out } = await run(["codesign", "-dvv", target]);
    if (code !== 0) {
      problems.push(`${rel} is not signed at all${suffix}`);
      continue;
    }
    const authority = out.match(/Authority=(.+)/)?.[1] ?? "(none)";
    if (!authority.startsWith("Developer ID Application")) {
      problems.push(`${rel} is signed by "${authority}", expected Developer ID Application${suffix}`);
    }
    if (!/flags=[^\s]*runtime/.test(out)) {
      problems.push(`${rel} lacks the hardened runtime (--options runtime)${suffix}`);
    }
    if (!/^Timestamp=/m.test(out)) {
      problems.push(`${rel} lacks a secure timestamp (--timestamp)${suffix}`);
    }
  }

  return { checked: targets.length, skipped: false, problems };
}

if (import.meta.main) {
  const { checked, skipped, problems } = await verifyVendorSigning();
  if (problems.length) {
    console.error(`\n❌ vendored binaries are not notarization-ready:\n`);
    for (const p of problems) console.error(`   • ${p}`);
    console.error(
      `\n   Notarization would fail on these paths under ` +
        `Contents/Resources/app/bin/ — electrobun never re-signs them.\n`,
    );
    process.exit(1);
  }
  if (!skipped) {
    console.log(
      `[verify-vendor] ✓ ${checked} vendored binar(y/ies) signed by Developer ID (runtime + timestamp)`,
    );
  }
}

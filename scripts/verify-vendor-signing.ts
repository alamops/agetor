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
  // Shipped in Contents/MacOS (electrobun re-signs it there), but a Developer
  // ID + runtime + timestamp signature here keeps this gate honest about the
  // bytes electrobun starts from.
  "login-item": "scripts/build-login-item.ts",
  // The Companion's key helper. Nested under Resources/app/bin like the notifier, so it ships exactly as signed here.
  keyhelper: "scripts/build-keyhelper.ts",
};

/** What `checkKeyHelperSigning` needs to know about the built helper and the notifier it must be signed alongside. */
export interface KeyHelperSigningFacts {
  /** `Authority=` of the helper (the first line, the leaf certificate). */
  authority: string;
  /** The same for AgetorNotifier.app, or null when there is none to compare with. */
  notifierAuthority: string | null;
  /** Whether Contents/embedded.provisionprofile exists in the helper bundle. */
  hasProfile: boolean;
  /** The helper's entitlements plist, as `codesign -d --entitlements :-` prints it. */
  entitlements: string;
}

/**
 * The Companion key helper's extra signing rules, beyond "Developer ID, hardened runtime, timestamp" (checked for every vendored object):
 * the SAME identity as the notifier (one team, one certificate), the embedded provisioning profile the data-protection keychain needs, and
 * a `keychain-access-groups` entitlement. Pure, so the release gate's tests can run it on facts instead of a signed bundle.
 */
export function checkKeyHelperSigning(f: KeyHelperSigningFacts): string[] {
  const problems: string[] = [];
  if (f.notifierAuthority !== null && f.authority !== f.notifierAuthority) {
    problems.push(`AgetorKeyHelper.app is signed by "${f.authority}" but AgetorNotifier.app by "${f.notifierAuthority}": one identity must sign both`);
  }
  if (!f.hasProfile) problems.push("AgetorKeyHelper.app has no Contents/embedded.provisionprofile: the keychain access group needs it (set AGETOR_KEYHELPER_PROFILE)");
  if (!f.entitlements.includes("keychain-access-groups")) problems.push("AgetorKeyHelper.app has no keychain-access-groups entitlement");
  return problems;
}

async function keyHelperFacts(app: string, notifier: string | null): Promise<KeyHelperSigningFacts> {
  const authorityOf = async (target: string): Promise<string> => (await run(["codesign", "-dvv", target])).out.match(/Authority=(.+)/)?.[1] ?? "(none)";
  const ent = await run(["codesign", "-d", "--entitlements", ":-", app]);
  return {
    authority: await authorityOf(app),
    notifierAuthority: notifier ? await authorityOf(notifier) : null,
    hasProfile: existsSync(path.join(app, "Contents", "embedded.provisionprofile")),
    entitlements: ent.out,
  };
}

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

/**
 * Whether the key helper's signing checks are skipped: a local build whose helper carries no embedded profile was built ad hoc by design
 * (build-keyhelper.ts needs ELECTROBUN_DEVELOPER_ID and AGETOR_KEYHELPER_PROFILE together). A release always checks it.
 */
export function shouldSkipKeyHelper(f: { requireDeveloperId: boolean; helperHasProfile: boolean }): boolean {
  return !f.requireDeveloperId && !f.helperHasProfile;
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

  const keyHelper = path.join(VENDOR_DIR, "keyhelper", "AgetorKeyHelper.app");
  // The key helper is built signed only when BOTH ELECTROBUN_DEVELOPER_ID and AGETOR_KEYHELPER_PROFILE are set (build-keyhelper.ts falls
  // back to an ad-hoc helper otherwise). A local build with a Developer ID but no profile therefore has an ad-hoc helper by design: it is
  // not checked, exactly as an ad-hoc build is not. A release (requireDeveloperId) always checks it.
  const skipKeyHelper = shouldSkipKeyHelper({
    requireDeveloperId: opts.requireDeveloperId === true,
    helperHasProfile: existsSync(path.join(keyHelper, "Contents", "embedded.provisionprofile")),
  });
  if (skipKeyHelper && existsSync(keyHelper)) {
    console.log(`${tag} key helper was built ad hoc (no AGETOR_KEYHELPER_PROFILE) — skipping its signing checks (local build)`);
  }
  const keyHelperRoot = path.join(VENDOR_DIR, "keyhelper") + path.sep;

  const allTargets = await collectCodeObjects(VENDOR_DIR);
  const targets = skipKeyHelper ? allTargets.filter((t) => !t.startsWith(keyHelperRoot)) : allTargets;
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

  // The Companion's key helper: its own rules on top (same identity as the notifier, the profile, the keychain entitlement). A release
  // (requireDeveloperId) refuses to go on without it.
  if (existsSync(keyHelper) && !skipKeyHelper) {
    const notifier = path.join(VENDOR_DIR, "notifier", "AgetorNotifier.app");
    problems.push(...checkKeyHelperSigning(await keyHelperFacts(keyHelper, existsSync(notifier) ? notifier : null)));
  } else if (opts.requireDeveloperId && !existsSync(keyHelper)) {
    problems.push("vendor/keyhelper/AgetorKeyHelper.app is missing — run `bun run vendor:keyhelper` (with AGETOR_KEYHELPER_PROFILE) before building.");
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

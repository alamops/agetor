#!/usr/bin/env bun
/**
 * Build the standalone `agetor` CLI binary (arm64 macOS), codesign it with the
 * same Developer ID the DMG uses, and emit a SHA256 the installer verifies.
 *
 * Runs standalone (`bun run build:cli`) and as a step inside `scripts/release.ts`.
 */
import { mkdirSync } from "node:fs";

/**
 * Target resolution: `AGETOR_CLI_TARGET` (a bun `--target` value, e.g.
 * `bun-linux-x64`) wins if set; otherwise infer from the host running the
 * build. Defaulting to the host means the maintainer's mac laptop keeps
 * producing exactly `artifacts/agetor-arm64` (the filename upload-release.ts
 * and install.sh hardcode) with no env var needed, while `bun run build:cli`
 * on a Linux box now produces a Linux binary instead of failing/mis-targeting.
 */
const HOST_TARGETS: Record<string, string> = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
};
const hostKey = `${process.platform}-${process.arch}`;
const TARGET = process.env.AGETOR_CLI_TARGET ?? HOST_TARGETS[hostKey];
if (!TARGET) {
  console.error(`[build:cli] no default target for host ${hostKey} — set AGETOR_CLI_TARGET explicitly.`);
  process.exit(1);
}
// Asset name mirrors the bun target, e.g. "agetor-arm64" (mac, unchanged —
// existing release tooling hardcodes this name) or "agetor-linux-x64".
const ASSET_NAME = TARGET === "bun-darwin-arm64" ? "agetor-arm64" : `agetor-${TARGET.replace(/^bun-/, "")}`;
const OUT = `artifacts/${ASSET_NAME}`;
const IS_DARWIN = TARGET.startsWith("bun-darwin");

async function run(cmd: string[], opts: { allowFail?: boolean } = {}): Promise<number> {
  console.log(`$ ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0 && !opts.allowFail) {
    console.error(`[build:cli] failed (${code}): ${cmd.join(" ")}`);
    process.exit(code);
  }
  return code;
}

/**
 * Notarize the codesigned binary. `notarytool` only accepts a zip/dmg/pkg, so
 * we zip the Mach-O, submit it with the App Store Connect API key, and wait.
 * A bare binary can't be stapled (stapler targets bundles/dmg/pkg) — the
 * notarization ticket lives on Apple's servers and Gatekeeper checks it online.
 * We ship the signed binary, not the zip. Skipped when the API creds are absent
 * or AGETOR_SKIP_NOTARIZE is set (e.g. fast local builds).
 */
async function notarize(): Promise<void> {
  if (process.env.AGETOR_SKIP_NOTARIZE) {
    console.warn("[build:cli] AGETOR_SKIP_NOTARIZE set — skipping notarization.");
    return;
  }
  const keyPath = process.env.ELECTROBUN_APPLEAPIKEYPATH;
  const keyId = process.env.ELECTROBUN_APPLEAPIKEY;
  const issuer = process.env.ELECTROBUN_APPLEAPIISSUER;
  if (!keyPath || !keyId || !issuer) {
    console.warn(
      "[build:cli] Apple API creds not set (ELECTROBUN_APPLEAPIKEYPATH/KEY/ISSUER) — " +
        "skipping notarization. The codesigned binary still runs via curl|sh, which " +
        "doesn't quarantine downloads.",
    );
    return;
  }
  const zip = `${OUT}.zip`;
  console.log("[build:cli] notarizing (notarytool submit --wait; takes minutes)…");
  await run(["ditto", "-c", "-k", "--keepParent", OUT, zip]);
  const apiKeyArgs = ["--key", keyPath, "--key-id", keyId, "--issuer", issuer];
  // Capture the output so we can fetch the notarization log on failure
  // (status: Invalid) instead of leaving the maintainer to re-run `notarytool
  // log` by hand from a submission id they have to scrape out of the console.
  const submit = Bun.spawn(["xcrun", "notarytool", "submit", zip, ...apiKeyArgs, "--wait"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const submitOut = await new Response(submit.stdout).text();
  const submitErr = await new Response(submit.stderr).text();
  const submitCode = await submit.exited;
  process.stdout.write(submitOut);
  if (submitErr) process.stderr.write(submitErr);
  if (submitCode !== 0) {
    const id = submitOut.match(/\bid:\s*([0-9a-f-]{36})/i)?.[1];
    if (id) {
      console.error(`[build:cli] notarization failed — fetching log for ${id}…`);
      await run(["xcrun", "notarytool", "log", id, ...apiKeyArgs], { allowFail: true });
    }
    await run(["rm", "-f", zip], { allowFail: true });
    process.exit(submitCode);
  }
  await run(["rm", "-f", zip]);
  console.log("[build:cli] notarization accepted.");
}

mkdirSync("artifacts", { recursive: true });

console.log(`[build:cli] compiling standalone binary (${TARGET})…`);
await run([
  "bun",
  "build",
  "--compile",
  `--target=${TARGET}`,
  "src/cli/index.ts",
  "--outfile",
  OUT,
]);

const devId = process.env.ELECTROBUN_DEVELOPER_ID;
if (devId && IS_DARWIN) {
  console.log("[build:cli] codesigning (Developer ID, hardened runtime)…");
  await run([
    "codesign",
    "--force",
    "--options",
    "runtime",
    "--timestamp",
    "--sign",
    devId,
    OUT,
  ]);
  await notarize();
} else if (IS_DARWIN) {
  console.warn(
    "[build:cli] ELECTROBUN_DEVELOPER_ID not set — shipping the ad-hoc signature " +
      "(fine for local builds; set it for releases).",
  );
} else {
  console.log("[build:cli] non-darwin target — codesigning/notarization skipped.");
}

console.log("[build:cli] writing SHA256…");
const sha = Bun.spawn(["shasum", "-a", "256", OUT], { stdout: "pipe" });
const shaText = await new Response(sha.stdout).text();
await sha.exited;
// Normalize the path in the checksum file to just the basename so `shasum -c`
// works from the download dir.
const digest = shaText.trim().split(/\s+/)[0] ?? "";
await Bun.write(`${OUT}.sha256`, `${digest}  ${ASSET_NAME}\n`);

// Stage the installer next to the binary so the release uploader ships it as a
// stable asset: …/releases/latest/download/install.sh
console.log("[build:cli] staging install.sh…");
await Bun.write("artifacts/install.sh", Bun.file("scripts/install.sh"));

console.log(`[build:cli] done → ${OUT}`);
console.log(`[build:cli] sha256 ${digest}`);

#!/usr/bin/env bun
// Prepares vendor/terminal-notifier/terminal-notifier.app — a bundled
// terminal-notifier the packaged .app ships so it can post deep-link
// notifications without depending on a Homebrew install. Mirrors
// scripts/fetch-tmux.ts's vendoring pattern (idempotent, downloads a
// relocatable artifact into vendor/, re-signs it for notarization).
//
// The runtime resolver (src/bun/notifier.ts:bundledNotifierCandidates())
// expects the bundled binary at either:
//   <bin>/terminal-notifier.app/Contents/MacOS/terminal-notifier
//   <bin>/terminal-notifier
// so electrobun.config.ts's build.copy maps this script's output directory
// (vendor/terminal-notifier/) straight onto bin/, landing the app bundle at
// Contents/Resources/app/bin/terminal-notifier.app/... inside the .app.
//
// Source strategy: unlike tmux (a Homebrew binary dylib-linked against the
// Cellar that needs install_name_tool rewriting), terminal-notifier ships
// upstream as a prebuilt, self-contained .app bundle — we just download the
// official GitHub release zip and extract it. We still strip any quarantine
// attribute and re-sign so the bundle launches cleanly under Gatekeeper /
// notarization the same way the vendored tmux binary does.
//
// Idempotent: if the app bundle's executable already exists, this is a
// fast no-op. Best-effort: if the network is unavailable, fails loudly but
// doesn't corrupt any partial state (extraction happens in a scratch dir
// that's only swapped into place on success).

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const VERSION = "2.0.0";
const DOWNLOAD_URL = `https://github.com/julienXX/terminal-notifier/releases/download/${VERSION}/terminal-notifier-${VERSION}.zip`;

const VENDOR_DIR = path.join(REPO_ROOT, "vendor", "terminal-notifier");
const TARGET_APP = path.join(VENDOR_DIR, "terminal-notifier.app");
const TARGET_BIN = path.join(TARGET_APP, "Contents", "MacOS", "terminal-notifier");

function fail(msg: string): never {
  console.error(`[fetch-terminal-notifier] ${msg}`);
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

/** Recursively finds `terminal-notifier.app` under `dir` (the zip layout isn't guaranteed to be flat). */
async function findAppBundle(dir: string, depth = 0): Promise<string | null> {
  if (depth > 3) return null;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === "terminal-notifier.app") return full;
    const nested = await findAppBundle(full, depth + 1);
    if (nested) return nested;
  }
  return null;
}

async function main() {
  if (process.platform !== "darwin") {
    console.log(`[fetch-terminal-notifier] skipped on ${process.platform} (macOS-only step)`);
    return;
  }
  if (process.arch !== "arm64") {
    fail(`expected an arm64 build host (got ${process.arch}); Agetor only ships arm64`);
  }

  if (existsSync(TARGET_BIN)) {
    console.log(
      `[fetch-terminal-notifier] cached at ${path.relative(REPO_ROOT, TARGET_APP)}/ — skipping`,
    );
    return;
  }

  console.log(`[fetch-terminal-notifier] downloading v${VERSION} from ${DOWNLOAD_URL}`);
  const scratch = await mkdtemp(path.join(tmpdir(), "agetor-terminal-notifier-"));
  try {
    const zipPath = path.join(scratch, "terminal-notifier.zip");
    let res: Response;
    try {
      res = await fetch(DOWNLOAD_URL);
    } catch (e) {
      fail(`download failed (network unavailable?): ${(e as Error).message}`);
    }
    if (!res.ok) {
      fail(`download failed: HTTP ${res.status} ${res.statusText}`);
    }
    await Bun.write(zipPath, res);

    const extractDir = path.join(scratch, "extracted");
    await mkdir(extractDir, { recursive: true });
    await run(["unzip", "-q", zipPath, "-d", extractDir]);

    const appBundle = await findAppBundle(extractDir);
    if (!appBundle) {
      fail(`terminal-notifier.app not found inside ${DOWNLOAD_URL} — layout may have changed`);
    }

    // Downloaded content sometimes carries a quarantine attribute (blocks
    // Gatekeeper launch until cleared or re-signed); strip it defensively.
    await run(["xattr", "-cr", appBundle], { silent: true }).catch(() => {});

    await mkdir(VENDOR_DIR, { recursive: true });
    await rm(TARGET_APP, { recursive: true, force: true });
    await cp(appBundle, TARGET_APP, { recursive: true });
    await run(["chmod", "755", TARGET_BIN]);

    // Re-sign so the bundle is consistent with our identity before
    // Electrobun's outer bundle sign + notarization runs (sign inside-out —
    // Apple's recommended pattern), same as fetch-tmux.ts does for tmux.
    const devId = process.env.ELECTROBUN_DEVELOPER_ID;
    const signArgs = devId
      ? ["--force", "--deep", "--options", "runtime", "--timestamp", "--sign", devId]
      : ["--force", "--deep", "--sign", "-"];
    if (devId) {
      console.log(`[fetch-terminal-notifier] signing with ${devId}`);
    } else {
      console.log(`[fetch-terminal-notifier] signing ad-hoc (set ELECTROBUN_DEVELOPER_ID for release)`);
    }
    await run(["codesign", ...signArgs, TARGET_APP]);

    // Sanity-run the vendored binary. Non-fatal: some sandboxes block
    // spawning freshly re-signed binaries even when the codesign step
    // above succeeded, and that shouldn't fail the whole vendoring step.
    try {
      await run([TARGET_BIN, "-help"], { silent: true });
      console.log(
        `[fetch-terminal-notifier] ✓ vendored at ${path.relative(REPO_ROOT, TARGET_APP)}/`,
      );
    } catch (e) {
      console.warn(
        `[fetch-terminal-notifier] vendored but sanity-run failed (non-fatal): ${(e as Error).message}`,
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`[fetch-terminal-notifier] ${(e as Error).message}`);
  process.exit(1);
});

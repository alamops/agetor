#!/usr/bin/env bun
// Electrobun's Info.plist template only writes CFBundleVersion, so macOS shows
// the user-visible "Version" field (System Settings, Get Info) as "?". Inject
// CFBundleShortVersionString into every Info.plist under build/, then rebuild
// any DMG artifact so its bundled .app reflects the patched plist.

import { readdir, rm, mkdtemp, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

async function run(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) {
    const stderr = await new Response(p.stderr).text();
    throw new Error(`${cmd.join(" ")} → exit ${code}\n${stderr}`);
  }
}

const VERSION = (await Bun.file("package.json").json()).version as string;
const SHORT_VERSION_BLOCK = `    <key>CFBundleShortVersionString</key>\n    <string>${VERSION}</string>\n`;

async function* walk(dir: string, match: (name: string) => boolean): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path, match);
    else if (entry.isFile() && match(entry.name)) yield path;
  }
}

let patched = 0;
for await (const plist of walk("build", (n) => n === "Info.plist")) {
  const original = await Bun.file(plist).text();
  if (original.includes("<key>CFBundleShortVersionString</key>")) continue;
  const next = original.replace(
    /(\s*)<key>CFBundleVersion<\/key>\s*\n\s*<string>[^<]*<\/string>\s*\n/,
    (match) => match + SHORT_VERSION_BLOCK,
  );
  if (next === original) {
    console.warn(`[patch-info-plist] skipped (no CFBundleVersion anchor): ${plist}`);
    continue;
  }
  await Bun.write(plist, next);
  console.log(`[patch-info-plist] plist: ${plist}`);
  patched++;
}

// Rebuild any DMG from the patched .app. Electrobun's DMGs are simple:
// <App>.app + an /Applications symlink, no custom background.
for await (const dmg of walk("artifacts", (n) => n.endsWith(".dmg"))) {
  // Filename convention: <env>-<platform>-<arch>-<AppName>.dmg matches
  // build/<env>-<platform>-<arch>/<AppName>.app
  const file = basename(dmg, ".dmg");
  const m = file.match(/^(.+?-(?:macos|darwin)-(?:arm64|x64|x86_64))-(.+)$/);
  if (!m) {
    console.warn(`[patch-info-plist] dmg: cannot map ${dmg} to an app bundle, skipping`);
    continue;
  }
  const [, buildDirName, appName] = m;
  const appPath = join("build", buildDirName, `${appName}.app`);
  if (!existsSync(appPath)) {
    console.warn(`[patch-info-plist] dmg: ${appPath} not found for ${dmg}, skipping`);
    continue;
  }

  const staging = await mkdtemp(join(tmpdir(), "agetor-dmg-"));
  try {
    await run(["cp", "-R", appPath, staging + "/"]);
    await run(["ln", "-s", "/Applications", join(staging, "Applications")]);
    const tmpDmg = dmg.replace(/\.dmg$/, ".tmp.dmg");
    if (existsSync(tmpDmg)) await rm(tmpDmg);
    await run([
      "hdiutil", "create",
      "-fs", "HFS+",
      "-volname", appName,
      "-srcfolder", staging,
      "-ov",
      "-format", "UDZO",
      tmpDmg,
    ]);
    await rm(dmg);
    await rename(tmpDmg, dmg);
    console.log(`[patch-info-plist] dmg:   ${dmg}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (patched === 0) console.log("[patch-info-plist] nothing to patch");

#!/usr/bin/env bun
// Increment the patch portion of `package.json#version` and update the
// matching `app.version` literal in `electrobun.config.ts`. Both files have
// to move in lockstep — Electrobun bakes the config value into
// `Resources/version.json`, and the upload script tags the release using
// `package.json` — so a drift between them silently ships an installer that
// reports the wrong version.
//
// Prints the new version to stdout so CI can capture it for the bump commit
// message + the release tag. Exits non-zero on any failure: we read + parse +
// validate the regex match against `electrobun.config.ts` BEFORE writing
// anything, so the common failure modes (missing field, unexpected
// formatting) surface before either file is touched. The two writes are
// still sequential, so a hard error between them (signal, disk full) could
// leave the repo half-edited — pre-validation reduces that risk to disk
// failures alone, which are unrecoverable anyway.

import { readFile, writeFile } from "node:fs/promises";

const PKG = "package.json";
const CFG = "electrobun.config.ts";

const pkgRaw = await readFile(PKG, "utf8");
const pkg = JSON.parse(pkgRaw) as { version?: unknown };
if (typeof pkg.version !== "string") {
  console.error(`[bump-patch] ${PKG} is missing a string "version" field`);
  process.exit(1);
}

const m = pkg.version.match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!m) {
  console.error(`[bump-patch] ${PKG} version "${pkg.version}" is not semver major.minor.patch`);
  process.exit(1);
}
const [, major, minor, patch] = m;
const current = pkg.version;
const next = `${major}.${minor}.${Number(patch) + 1}`;

// Pre-validate the config edit before writing the json — the config file
// is hand-edited, so any unexpected formatting (e.g. `version : "0.0.1"`
// with stray whitespace) needs to surface here, not as a silent no-op.
const cfgRaw = await readFile(CFG, "utf8");
const cfgRe = new RegExp(`version:\\s*"${current.replace(/\./g, "\\.")}"`);
if (!cfgRe.test(cfgRaw)) {
  console.error(`[bump-patch] could not find \`version: "${current}"\` in ${CFG}`);
  process.exit(1);
}

// Write both — package.json first because its serializer is stricter, so a
// failure here aborts before we touch the config.
pkg.version = next;
await writeFile(PKG, JSON.stringify(pkg, null, 2) + "\n");
await writeFile(CFG, cfgRaw.replace(cfgRe, `version: "${next}"`));

// Stdout-only output so `NEW=$(bun scripts/bump-patch.ts)` works in CI. All
// progress logs go to stderr.
console.error(`[bump-patch] ${current} → ${next}`);
process.stdout.write(next);

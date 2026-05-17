#!/usr/bin/env bun
// Electrobun emits artifacts as <env>-<platform>-<arch>-<AppName>.dmg.
// Rename to <AppName>-<arch>.dmg for end-user downloads — the unversioned
// name lets the marketing site link at
// github.com/<repo>/releases/latest/download/Agetor-arm64.dmg without
// rewriting it on every release.
// The .app.tar.zst and update.json keep their structured names — they're
// consumed by the auto-update flow, which expects the platform/arch suffix.

import { readdir, rename } from "node:fs/promises";
import { join } from "node:path";

const APP_NAME = "Agetor";

let entries;
try {
  entries = await readdir("artifacts");
} catch {
  process.exit(0);
}

// Match e.g. "stable-macos-arm64-Agetor.dmg" → captures arch ("arm64").
const re = new RegExp(`^[^-]+-(?:macos|darwin)-(arm64|x64)-${APP_NAME}\\.dmg$`);

for (const name of entries) {
  const m = name.match(re);
  if (!m) continue;
  const arch = m[1];
  const from = join("artifacts", name);
  const to = join("artifacts", `${APP_NAME}-${arch}.dmg`);
  if (from === to) continue;
  await rename(from, to);
  console.log(`[rename-dmg] ${name} → ${APP_NAME}-${arch}.dmg`);
}

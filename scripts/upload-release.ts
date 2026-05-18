#!/usr/bin/env bun
// Publishes the artifacts/ folder to a GitHub Release on alamops/agetor:
//
//   1. Creates a release tagged v<package.json#version>, or replaces all
//      assets if the tag already exists. The release row itself is never
//      deleted — the auto-updater's `releases/latest/download/...` URL keys
//      off it, so destroying it briefly would 404 anyone polling at the
//      wrong moment.
//   2. Uploads:
//        - artifacts/Agetor-arm64.dmg                    (first-install DMG)
//        - artifacts/<channel>-macos-arm64-Agetor.app.tar.zst  (updater bundle)
//        - artifacts/<channel>-macos-arm64-update.json   (updater manifest)
//      The DMG is intentionally unversioned so agetor.dev can link at
//      releases/latest/download/Agetor-arm64.dmg without per-release edits.
//   3. Each filename is preserved verbatim — Electrobun's updater fetches
//      <baseUrl>/<channel>-macos-arm64-update.json and expects an exact match.
//
// Auth: requires GITHUB_TOKEN with `contents:write` on the target repo (a
// fine-grained PAT scoped to alamops/agetor is enough). Read from env or
// from .env.local via bun's auto-loader.

import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const REPO = "alamops/agetor";
const API = "https://api.github.com";
const VERSION = (await Bun.file("package.json").json()).version as string;
const TAG = `v${VERSION}`;
const TOKEN = process.env.GITHUB_TOKEN;

function fail(msg: string): never {
  console.error(`[upload-release] ${msg}`);
  process.exit(1);
}

if (!TOKEN) fail("GITHUB_TOKEN not set — add it to .env.local (fine-grained PAT with contents:write).");

interface ReleaseRecord {
  id: number;
  html_url: string;
  upload_url: string;
  body: string | null;
  assets: { id: number; name: string }[];
}

async function gh(path: string, init: RequestInit = {}, opts: { silent?: boolean } = {}): Promise<Response> {
  const url = path.startsWith("http") ? path : `${API}${path}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${TOKEN}`,
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  const res = await fetch(url, { ...init, headers });
  if (res.ok) return res;
  if (opts.silent) return res; // caller will inspect status (e.g. 404 on tag lookup).
  const body = await res.text().catch(() => "");
  fail(`GitHub API ${init.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 400)}`);
}

async function findExistingRelease(tag: string): Promise<ReleaseRecord | null> {
  const res = await gh(`/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, {}, { silent: true });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    fail(`unexpected status looking up tag ${tag}: ${res.status} ${body.slice(0, 300)}`);
  }
  return (await res.json()) as ReleaseRecord;
}

async function createRelease(tag: string, body: string | undefined): Promise<ReleaseRecord> {
  // `target_commitish: "main"` is belt-and-suspenders: release.ts now
  // pushes the annotated tag *before* this script runs, so GitHub sees
  // the tag already exists and associates with it (target_commitish is
  // ignored on that path). If a future caller invokes this script
  // standalone — without a pushed tag — `target_commitish` makes GitHub
  // auto-create the tag at the current main HEAD instead of falling
  // through to the API's implicit default. Doesn't fix the v0.0.3-style
  // race on its own (you'd still want the bump pushed first) but
  // documents the intent for the next reader.
  const res = await gh(`/repos/${REPO}/releases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: "main",
      name: tag,
      body: body ?? "",
      draft: false,
      prerelease: false,
      generate_release_notes: false,
    }),
  });
  return (await res.json()) as ReleaseRecord;
}

async function updateReleaseBody(releaseId: number, body: string): Promise<void> {
  await gh(`/repos/${REPO}/releases/${releaseId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
}

async function deleteAsset(assetId: number): Promise<void> {
  await gh(`/repos/${REPO}/releases/assets/${assetId}`, { method: "DELETE" });
}

async function uploadAsset(release: ReleaseRecord, filePath: string): Promise<void> {
  const name = filePath.split("/").pop()!;
  const size = statSync(filePath).size;
  // upload_url is templated: ".../assets{?name,label}" — strip the template
  // before appending our own query string.
  const baseUpload = release.upload_url.replace(/\{[^}]*\}$/, "");
  const url = `${baseUpload}?name=${encodeURIComponent(name)}`;
  // GitHub's upload endpoint occasionally returns 502/503 on multi-MB
  // bodies, which is wasteful to redo on top of a ~3-min notarization. We
  // retry 5xx with exponential backoff but NOT 4xx — a 422 ("asset already
  // exists") would not get better on retry, and a 401/403 means the token
  // is wrong and we want to surface that fast.
  const body = await readFile(filePath);
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(size),
      },
      body,
    });
    if (res.ok) {
      const mb = (size / (1024 * 1024)).toFixed(1);
      console.log(`  ✓ ${name} (${mb} MB)`);
      return;
    }
    const detail = await res.text().catch(() => "");
    if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
      const backoffMs = 1000 * attempt;
      console.error(
        `[upload-release] ${name} attempt ${attempt}/${MAX_ATTEMPTS} got ${res.status} — retrying in ${backoffMs}ms`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
      continue;
    }
    fail(`asset upload failed for ${name}: ${res.status} ${detail.slice(0, 300)}`);
  }
}

async function main() {
  const artifactsDir = "artifacts";
  if (!existsSync(artifactsDir)) fail(`${artifactsDir}/ does not exist — run 'bun run build:stable' first.`);
  const files = await readdir(artifactsDir);

  // Pick the three files the release ships. Filenames are pinned by
  // electrobun build / rename-dmg, so a hardcoded shape is fine here.
  const dmg = files.find((f) => f === "Agetor-arm64.dmg");
  const tarZst = files.find((f) => f === "stable-macos-arm64-Agetor.app.tar.zst");
  const updateJson = files.find((f) => f === "stable-macos-arm64-update.json");
  const missing = (
    !dmg ? ["DMG"] : []
  ).concat(
    !tarZst ? ["update bundle (.app.tar.zst)"] : [],
    !updateJson ? ["update.json"] : [],
  );
  if (missing.length) fail(`missing ${missing.join(", ")} in ${artifactsDir}/.`);

  const toUpload = [dmg!, tarZst!, updateJson!].map((n) => join(artifactsDir, n));

  const notes = process.env.AGETOR_RELEASE_NOTES;

  console.log(`[upload-release] target: ${REPO} @ ${TAG}`);
  let release = await findExistingRelease(TAG);
  if (release) {
    // Releasing a hotfix on the same tag would otherwise 422 with
    // "already_exists" per-asset. Delete the existing assets first so the
    // re-upload is idempotent — but never delete the release itself, since
    // the auto-updater's URL keys off the tag.
    if (release.assets.length) {
      console.log(`[upload-release] replacing ${release.assets.length} existing asset(s)`);
      for (const a of release.assets) await deleteAsset(a.id);
    } else {
      console.log("[upload-release] reusing existing empty release");
    }
    // Only seed the body on re-cut if the existing release has no manually
    // edited notes — clobbering hand-written highlights on a hotfix re-upload
    // would be a nasty surprise. Set AGETOR_RELEASE_NOTES_FORCE=1 to override.
    if (notes) {
      const hasManualBody = !!release.body?.trim();
      if (!hasManualBody) {
        console.log("[upload-release] seeding release notes (existing body empty)");
        await updateReleaseBody(release.id, notes);
      } else if (process.env.AGETOR_RELEASE_NOTES_FORCE) {
        console.log("[upload-release] overwriting release notes (FORCE=1)");
        await updateReleaseBody(release.id, notes);
      } else {
        console.log("[upload-release] keeping existing release notes (set AGETOR_RELEASE_NOTES_FORCE=1 to overwrite)");
      }
    }
  } else {
    console.log(`[upload-release] creating release ${TAG}`);
    release = await createRelease(TAG, notes);
  }

  for (const f of toUpload) await uploadAsset(release, f);
  console.log(`\n✓ release published: ${release.html_url}`);
}

await main();

#!/usr/bin/env bun
// Manual release orchestrator. Run from the maintainer's laptop:
//
//   bun run release           # patch bump (default)
//   bun run release minor     # minor bump
//   bun run release major     # major bump
//   bun run release 1.2.3     # explicit version
//
// Pipeline:
//   1. Preflight   — clean working tree, on main, signing + GitHub creds present.
//   2. Bump        — package.json + electrobun.config.ts move in lockstep.
//   3. Build       — vendor:tmux → vite build → electrobun build (signed + notarized).
//   4. Verify      — codesign / spctl / stapler checks on the produced artifacts.
//   5. Upload      — create or refresh the GitHub Release at v<version>.
//   6. Commit/tag  — only on full success: commit the bump, tag v<version>, push both.
//
// Order rationale (same as the old GH workflow): bump first so the build sees
// the new version, but commit/tag/push only after notarize+upload succeed —
// a failed build then never leaves a "hole" (bumped tag in main with no
// matching GitHub Release). If the build fails mid-way, revert the working
// tree with:
//
//   git checkout -- package.json electrobun.config.ts
//
// and rerun.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

const PKG = "package.json";
const CFG = "electrobun.config.ts";

type BumpKind = "patch" | "minor" | "major";

function fail(msg: string): never {
  console.error(`\n[release] ${msg}\n`);
  process.exit(1);
}

async function run(cmd: string[], opts: { capture?: boolean } = {}): Promise<string> {
  const p = Bun.spawn(cmd, {
    stdout: opts.capture ? "pipe" : "inherit",
    stderr: opts.capture ? "pipe" : "inherit",
    env: process.env,
  });
  const out = opts.capture ? await new Response(p.stdout).text() : "";
  const err = opts.capture ? await new Response(p.stderr).text() : "";
  const code = await p.exited;
  if (code !== 0) {
    if (opts.capture) console.error((out + err).trim());
    fail(`command failed (${code}): ${cmd.join(" ")}`);
  }
  return out.trim();
}

function parseArg(arg: string | undefined): { kind: BumpKind } | { explicit: string } {
  if (!arg || arg === "patch") return { kind: "patch" };
  if (arg === "minor" || arg === "major") return { kind: arg };
  if (/^\d+\.\d+\.\d+$/.test(arg)) return { explicit: arg };
  fail(`unknown version arg "${arg}" — expected patch|minor|major|X.Y.Z`);
}

async function preflight(): Promise<void> {
  // Clean working tree — we modify package.json + electrobun.config.ts and
  // commit them later; any stray uncommitted edit would ride along.
  const status = await run(["git", "status", "--porcelain"], { capture: true });
  if (status) {
    fail(`working tree is dirty — commit or stash first:\n${status}`);
  }

  // Default branch check is a guard rail, not a hard rule — override with
  // AGETOR_RELEASE_ALLOW_ANY_BRANCH=1 for hotfix branches if you really mean it.
  const branch = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { capture: true });
  if (branch !== "main" && !process.env.AGETOR_RELEASE_ALLOW_ANY_BRANCH) {
    fail(`not on main (current: ${branch}). Set AGETOR_RELEASE_ALLOW_ANY_BRANCH=1 to override.`);
  }

  // GitHub upload needs a token. Same env var the upload script reads — pre-check
  // here so we fail before the ~3-min build/notarize, not after.
  if (!process.env.GITHUB_TOKEN) {
    fail("GITHUB_TOKEN not set — add to .env.local (fine-grained PAT with contents:write on alamops/agetor).");
  }

  // Signing creds — electrobun build will fail without these, but a friendly
  // message up front saves a few minutes of confusion.
  const requiredSigning = [
    "ELECTROBUN_DEVELOPER_ID",
    "ELECTROBUN_APPLEAPIKEY",
    "ELECTROBUN_APPLEAPIISSUER",
    "ELECTROBUN_APPLEAPIKEYPATH",
  ];
  const missing = requiredSigning.filter((k) => !process.env[k]);
  if (missing.length) {
    fail(`missing signing env vars: ${missing.join(", ")} — set in .env.local (see .env.example).`);
  }
}

async function applyVersion(target: { kind: BumpKind } | { explicit: string }): Promise<{ from: string; to: string; bumped: boolean }> {
  const pkgRaw = await readFile(PKG, "utf8");
  const pkg = JSON.parse(pkgRaw) as { version?: unknown };
  if (typeof pkg.version !== "string") fail(`${PKG} is missing a string "version" field`);
  const m = (pkg.version as string).match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) fail(`${PKG} version "${pkg.version}" is not semver major.minor.patch`);
  const [, maj, min, pat] = m;
  const current = pkg.version as string;

  let next: string;
  if ("explicit" in target) {
    next = target.explicit;
  } else if (target.kind === "patch") {
    next = `${maj}.${min}.${Number(pat) + 1}`;
  } else if (target.kind === "minor") {
    next = `${maj}.${Number(min) + 1}.0`;
  } else {
    next = `${Number(maj) + 1}.0.0`;
  }

  // No-bump path: explicit version that already matches package.json. Used
  // for the first release of a newly-initialized version, or to re-cut a
  // build at the current version. We skip writing files (and therefore the
  // bump commit later) so the repo stays clean.
  if (next === current) {
    return { from: current, to: next, bumped: false };
  }

  // Pre-validate the config edit before writing the json (same shape as the
  // old bump-patch.ts) so a stray hand-edit in electrobun.config.ts surfaces
  // before we touch either file.
  const cfgRaw = await readFile(CFG, "utf8");
  const cfgRe = new RegExp(`version:\\s*"${current.replace(/\./g, "\\.")}"`);
  if (!cfgRe.test(cfgRaw)) fail(`could not find \`version: "${current}"\` in ${CFG}`);

  pkg.version = next;
  await writeFile(PKG, JSON.stringify(pkg, null, 2) + "\n");
  await writeFile(CFG, cfgRaw.replace(cfgRe, `version: "${next}"`));

  return { from: current, to: next, bumped: true };
}

async function tagExists(tag: string): Promise<{ local: boolean; remote: boolean }> {
  const local = (await run(["git", "tag", "--list", tag], { capture: true })).trim() === tag;
  const remoteOut = await run(["git", "ls-remote", "--tags", "origin", tag], { capture: true });
  const remote = remoteOut.includes(`refs/tags/${tag}`);
  return { local, remote };
}

// Previous release tag, sorted semver-descending, ignoring the tag we're about
// to publish (handles the no-bump re-cut where vX.Y.Z already exists). The
// semver-strict filter keeps stray tags (`v-internal`, `viewer`, `v0.1-beta`)
// from sorting to the top and producing a nonsense `git log` range.
async function previousTag(currentTag: string): Promise<string | null> {
  const out = await run(["git", "tag", "--list", "v*", "--sort=-version:refname"], { capture: true });
  const tags = out
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .filter((t) => t !== currentTag);
  return tags[0] ?? null;
}

// Auto-generated release notes: commits since the previous tag, one bullet per
// subject line, dropping merge commits and the script's own `release vX.Y.Z`
// bump commits. If there's no previous tag (first ever release) we list every
// commit on the current branch.
async function generateNotes(currentTag: string): Promise<string> {
  const prev = await previousTag(currentTag);
  const range = prev ? `${prev}..HEAD` : "HEAD";
  const log = await run(
    ["git", "log", range, "--no-merges", "--pretty=format:- %s"],
    { capture: true },
  );
  const lines = log
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^- release v\d+\.\d+\.\d+/i.test(l));
  // When prev is null, range = HEAD covers every commit in the repo, so
  // `lines` is only ever empty on the no-bump re-cut path where prev..HEAD has
  // nothing new — hence the message references `prev` directly.
  if (!lines.length) return `No changes since ${prev ?? "previous release"}.`;
  const header = prev ? `Changes since ${prev}:` : "Changes:";
  return `${header}\n\n${lines.join("\n")}`;
}

async function main() {
  const target = parseArg(process.argv[2]);
  console.log("[release] preflight…");
  await preflight();

  const { from, to, bumped } = await applyVersion(target);
  if (bumped) {
    console.log(`[release] version ${from} → ${to}`);
  } else {
    console.log(`[release] releasing current version ${to} (no bump)`);
  }

  // Generate notes up front so a git-state issue (corrupt tag, bad range)
  // surfaces before the ~3-min build/notarize — same fail-fast philosophy as
  // preflight(). The bump commit hasn't landed yet, so the prev..HEAD range
  // captures real changes, not the bump itself.
  const notes = await generateNotes(`v${to}`);
  console.log(`[release] notes:\n${notes.split("\n").map((l) => `  ${l}`).join("\n")}`);

  console.log("[release] build:stable…");
  await run(["bun", "run", "build:stable"]);

  console.log("[release] verify…");
  await run(["bun", "scripts/verify-release.ts"]);

  process.env.AGETOR_RELEASE_NOTES = notes;
  console.log("[release] upload to GitHub…");
  await run(["bun", "scripts/upload-release.ts"]);

  const tag = `v${to}`;
  if (bumped) {
    console.log(`[release] commit + tag ${tag}`);
    await run(["git", "add", PKG, CFG]);
    await run(["git", "commit", "-m", `release ${tag}`]);
    await run(["git", "tag", "-a", tag, "-m", `release ${tag}`]);
    console.log("[release] push commit + tag…");
    await run(["git", "push", "origin", "HEAD"]);
    await run(["git", "push", "origin", tag]);
  } else {
    const existing = await tagExists(tag);
    if (existing.local || existing.remote) {
      console.log(`[release] tag ${tag} already exists (local=${existing.local}, remote=${existing.remote}) — skipping tag creation`);
    } else {
      console.log(`[release] tag ${tag} on HEAD…`);
      await run(["git", "tag", "-a", tag, "-m", `release ${tag}`]);
      await run(["git", "push", "origin", tag]);
    }
  }

  // Sanity check: the artifacts the auto-updater serves must end up where it
  // looks for them. We don't fetch them back — just point the user at the
  // release URL so they can eyeball it.
  if (!existsSync("artifacts/Agetor-arm64.dmg")) {
    console.warn("[release] note: artifacts/Agetor-arm64.dmg missing post-build — check rename-dmg output");
  }
  console.log(`\n✓ release v${to} published`);
  console.log(`  https://github.com/alamops/agetor/releases/tag/v${to}`);
}

await main();

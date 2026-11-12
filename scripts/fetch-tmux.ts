#!/usr/bin/env bun
// Prepares vendor/tmux/<arch>/ with a relocatable tmux binary that the
// packaged .app can ship. The runtime resolver (src/bun/tmux-resolution.ts)
// expects: vendor/tmux/<arch>/tmux plus any sibling dylibs.
//
// Source strategy on macOS arm64: copy the local Homebrew tmux + its required
// dylibs (libevent_core, libncursesw, libutf8proc) into our vendor/ tree, then
// use `install_name_tool` to rewrite each load command so the binary loads
// the bundled dylibs via @executable_path/<libname> instead of the absolute
// Homebrew cellar path. This produces a self-contained bundle that runs on
// machines without Homebrew, without depending on any single fixed URL.
//
// It also vendors a terminfo database beside the binary. The bundled
// libncursesw carries the BUILD MACHINE's compiled-in Cellar path
// (/opt/homebrew/Cellar/ncurses/<version>/share/terminfo); without a sibling
// DB, a tty attach (`tmux attach` from Terminal.app) prints "can't find
// terminfo database" and exits (issue #298). Five entries copied from the
// macOS system DB cover Terminal.app's default profile plus the tmux/screen
// clients; the runtime search path is <bundle>/bin/terminfo first and
// /usr/share/terminfo second. See scripts/terminfo/README.md.
//
// Idempotent: if the vendored files already exist and aren't older than the
// system tmux, the script is a fast no-op.

import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, chmod, writeFile, readFile, rm, rename } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
// arm64-only by deliberate choice (see project-arm64-only memory). The
// runtime resolver in src/bun/tmux-resolution.ts hardcodes the same arch
// path, so this assert keeps both ends in lockstep — if we ever revisit
// the decision, both must move together.
const ARCH = "arm64";
const VENDOR_DIR = path.join(REPO_ROOT, "vendor", "tmux", ARCH);

/** macOS system terminfo database — present on every supported macOS. */
const TERMINFO_SOURCE = "/usr/share/terminfo";
/** Destination for the vendored DB: a SIBLING of the tmux binary, which is
 *  exactly the first entry of the runtime `TERMINFO_DIRS` (see
 *  `terminfoDirsFor` in src/bun/tmux-resolution.ts). */
const TERMINFO_DIR = path.join(VENDOR_DIR, "terminfo");
/** The entries `terminfoDirsFor` relies on: Terminal.app's default profile
 *  (xterm-256color), its fallbacks, and the tmux/screen client names. Pinned
 *  so a future run can't silently shrink the set. */
const TERMINFO_ENTRIES = [
  "xterm-256color",
  "xterm",
  "screen",
  "screen-256color",
  "tmux-256color",
] as const;
/** Tracked inputs (license + provenance note) copied beside the DB. */
const TERMINFO_NOTICE_DIR = path.join(REPO_ROOT, "scripts", "terminfo");
const TERMINFO_LICENSE = path.join(TERMINFO_NOTICE_DIR, "LICENSE-ncurses.txt");
const TERMINFO_README = path.join(TERMINFO_NOTICE_DIR, "README.md");
/** Written on every vendor run; its presence is part of the cache check. */
const TERMINFO_PROVENANCE = path.join(TERMINFO_DIR, "PROVENANCE.txt");

function fail(msg: string): never {
  console.error(`[fetch-tmux] ${msg}`);
  process.exit(1);
}

async function run(
  cmd: string[],
  opts: { silent?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<string> {
  const p = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.env ? { env: opts.env } : {}),
  });
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

async function which(bin: string): Promise<string | null> {
  try {
    return await run(["/usr/bin/which", bin]);
  } catch {
    return null;
  }
}

/**
 * Parse `otool -L <bin>` into a list of dylib load-command paths (skipping
 * the first line, which echoes the binary itself).
 */
async function loadCommands(bin: string): Promise<string[]> {
  const out = await run(["otool", "-L", bin]);
  return out
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+\(/)[0]!.trim())
    .filter(Boolean);
}

/** True when the path comes from Homebrew's cellar/opt tree. */
function isBrewPath(p: string): boolean {
  return p.startsWith("/opt/homebrew/") || p.startsWith("/usr/local/Cellar/") || p.startsWith("/usr/local/opt/");
}

/**
 * Resolve every Homebrew-loaded dylib reachable from `bin`. The dylibs
 * themselves can load other dylibs (libevent_core sometimes references
 * libssl etc), so we walk the graph. Deduplication is keyed on the path
 * we *enqueue* — to avoid an infinite loop on LC_ID_DYLIB entries (a dylib
 * lists itself as its first load command).
 */
async function resolveAllBrewDeps(bin: string): Promise<Set<string>> {
  const seen = new Set<string>([bin]);
  const queue = [bin];
  while (queue.length) {
    const next = queue.shift()!;
    const deps = await loadCommands(next);
    for (const d of deps) {
      if (!isBrewPath(d)) continue;
      if (seen.has(d)) continue;
      seen.add(d);
      queue.push(d);
    }
  }
  seen.delete(bin);
  return seen;
}

/**
 * Rewrite every Homebrew dylib reference in `target` to load from
 * `@executable_path/<basename>` instead of the absolute brew path. Applied to
 * both the main tmux binary and to each shipped dylib (dylibs reference each
 * other — libncursesw loads libtinfo, etc.).
 */
async function rewriteLoadCommands(target: string): Promise<void> {
  const deps = await loadCommands(target);
  for (const d of deps) {
    if (!isBrewPath(d)) continue;
    const base = path.basename(d);
    await run(["install_name_tool", "-change", d, `@executable_path/${base}`, target]);
  }
  // For dylibs, also update the LC_ID_DYLIB so the file knows its own
  // @executable_path identity (otherwise tmux loading libfoo with id =
  // /opt/homebrew/.../libfoo.dylib will still fail under SIP-tightened
  // resolution on some macOS versions).
  if (target.endsWith(".dylib")) {
    const base = path.basename(target);
    await run(["install_name_tool", "-id", `@executable_path/${base}`, target]);
  }
}

/**
 * Locate `entry` inside the system terminfo database, whose layout is
 * hashed (two hex chars per subdirectory, e.g. `78/xterm-256color`), without
 * assuming which hash the host uses. Returns the path RELATIVE to
 * `TERMINFO_SOURCE` (so the destination mirrors the source layout exactly),
 * or null.
 */
async function findTerminfoEntry(entry: string): Promise<string | null> {
  let dirs: string[];
  try {
    dirs = await readdir(TERMINFO_SOURCE);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const rel = path.join(dir, entry);
    if (existsSync(path.join(TERMINFO_SOURCE, rel))) return rel;
  }
  return null;
}

/**
 * Copy the pinned terminfo entries (plus the tracked ncurses license and
 * provenance note) into `<vendor>/terminfo`, mirroring the source's hashed
 * layout. Every entry and both notice files are resolved BEFORE anything is
 * written, so a host missing one leaves no partial tree behind — the packaged
 * app must either ship a complete DB or fail the build loudly.
 *
 * The write itself is staged: the tree is built under a sibling
 * `<terminfo>.staging-<pid>` directory and only swapped into place once every
 * file is on disk. A mid-copy failure (disk full, an unreadable entry) would
 * otherwise leave a partial `terminfo/` behind, and the cache check only tests
 * for the directory + `PROVENANCE.txt` — so the next build would happily ship
 * the truncated DB. On failure the staging tree is removed and the previous
 * DB (if any) is left untouched.
 */
async function vendorTerminfo(): Promise<void> {
  const resolved: Array<{ entry: string; rel: string }> = [];
  const missing: string[] = [];
  for (const entry of TERMINFO_ENTRIES) {
    const rel = await findTerminfoEntry(entry);
    if (rel === null) missing.push(entry);
    else resolved.push({ entry, rel });
  }
  if (missing.length) {
    fail(
      `terminfo ${missing.length === 1 ? "entry" : "entries"} missing from ${TERMINFO_SOURCE}: ${missing.join(", ")}\n` +
        `  The bundled tmux would fail to attach from a terminal ("can't find terminfo database"). ` +
        `Fix the build host's terminfo database, or change TERMINFO_ENTRIES deliberately.`,
    );
  }
  for (const notice of [TERMINFO_LICENSE, TERMINFO_README]) {
    if (!existsSync(notice)) {
      fail(
        `missing tracked notice ${path.relative(REPO_ROOT, notice)} — refusing to vendor the terminfo database without its license/provenance note`,
      );
    }
  }

  const staging = `${TERMINFO_DIR}.staging-${process.pid}`;
  const backup = `${TERMINFO_DIR}.old-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  try {
    for (const { rel } of resolved) {
      const dst = path.join(staging, rel);
      await mkdir(path.dirname(dst), { recursive: true });
      await copyFile(path.join(TERMINFO_SOURCE, rel), dst);
      await chmod(dst, 0o644);
    }
    await copyFile(TERMINFO_LICENSE, path.join(staging, "LICENSE-ncurses.txt"));
    await copyFile(TERMINFO_README, path.join(staging, "README.md"));
    const provenance = [
      "Agetor bundled tmux — terminfo database",
      `source: ${TERMINFO_SOURCE}`,
      `generated: ${new Date().toISOString()}`,
      "entries:",
      ...resolved.map(({ entry, rel }) => `  ${entry}  (${rel})`),
      "license: LICENSE-ncurses.txt (ncurses, verbatim from the ncurses distribution)",
      "",
    ].join("\n");
    await writeFile(path.join(staging, "PROVENANCE.txt"), provenance);

    // Publish atomically-ish: move the previous tree aside, rename the complete
    // staging tree into place, then drop the backup. If the publish rename
    // fails the old DB is restored, so a failed run never leaves a half tree
    // at the path the cache check trusts.
    const hadPrevious = existsSync(TERMINFO_DIR);
    if (hadPrevious) await rename(TERMINFO_DIR, backup);
    try {
      await rename(staging, TERMINFO_DIR);
    } catch (e) {
      if (hadPrevious) await rename(backup, TERMINFO_DIR);
      throw e;
    }
    if (hadPrevious) await rm(backup, { recursive: true, force: true });
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    throw e;
  }
  console.log(
    `[fetch-tmux] vendored ${resolved.length} terminfo entries → ${path.relative(REPO_ROOT, TERMINFO_DIR)}/`,
  );
}

/**
 * Prove the freshly copied DB actually resolves: every pinned entry must be
 * found under `TERMINFO_DIRS=<vendor>/terminfo` in the hashed layout, so a
 * missing, misplaced or corrupt copy fails the build here instead of in a
 * user's Terminal window.
 *
 * Scope of this check: `/usr/bin/infocmp` links the SYSTEM ncurses, not the
 * bundled `libncursesw`, so it proves the files are complete, well-formed and
 * found by a `TERMINFO_DIRS` lookup — not that the bundled library reads them.
 * That half rests on the files being byte copies of `/usr/share/terminfo`,
 * which the bundled tmux was shown to read through `TERMINFO_DIRS`
 * (docs/plans/issue-298-chrome-prompt-investigation.md, spike J), and on the
 * manual attach smoke in docs/plans/issue-298-chrome-prompt.md §8.3.
 */
async function verifyTerminfo(): Promise<void> {
  // A minimal, hermetic env: `infocmp` is invoked by absolute path, so no PATH
  // is needed, and dropping TERMINFO (a single directory, which wins over
  // TERMINFO_DIRS by ncurses semantics) makes this measure THIS database.
  const env: Record<string, string | undefined> = { TERMINFO_DIRS: TERMINFO_DIR };
  for (const entry of TERMINFO_ENTRIES) {
    try {
      await run(["/usr/bin/infocmp", entry], { env, silent: true });
    } catch {
      fail(
        `vendored terminfo entry "${entry}" does not resolve from ${path.relative(REPO_ROOT, TERMINFO_DIR)} (TERMINFO_DIRS) — the bundle would ship a broken database`,
      );
    }
  }
  console.log(`[fetch-tmux] ✓ TERMINFO_DIRS resolves all ${TERMINFO_ENTRIES.length} entries`);
}

async function main() {
  if (process.platform !== "darwin") {
    // electrobun's dev watcher fs.watch()es every `copy` source dir in
    // electrobun.config.ts unconditionally, including vendor/tmux/arm64 —
    // if it doesn't exist on disk, `bun run dev` crashes with ENOENT before
    // the app even launches. Create the (empty) dir so non-macOS dev works;
    // resolveTmuxBin() falls back to the system tmux on PATH regardless.
    await mkdir(VENDOR_DIR, { recursive: true });
    console.log(`[fetch-tmux] skipped on ${process.platform} (macOS-only step)`);
    return;
  }
  if (process.arch !== "arm64") {
    fail(`expected an arm64 build host (got ${process.arch}); Agetor only ships arm64`);
  }

  const tmuxBin = await which("tmux");
  if (!tmuxBin) {
    fail(
      "no system tmux found. install one (e.g. `brew install tmux`) so it can be vendored into the .app.",
    );
  }

  const targetTmux = path.join(VENDOR_DIR, "tmux");
  const stampPath = path.join(VENDOR_DIR, ".signed-by");
  const desiredIdentity = process.env.ELECTROBUN_DEVELOPER_ID || "adhoc";
  if (existsSync(targetTmux) && existsSync(stampPath)) {
    // Skip when (a) vendored copy is newer than the system one AND (b) it
    // was signed with the same identity we'd use now. Without the identity
    // check, switching from a local ad-hoc dev run to a release build (with
    // ELECTROBUN_DEVELOPER_ID exported) would silently ship ad-hoc-signed
    // binaries that fail notarization.
    const vendoredMtime = statSync(targetTmux).mtimeMs;
    const sourceMtime = statSync(tmuxBin).mtimeMs;
    const stamp = (await readFile(stampPath, "utf8")).trim();
    if (vendoredMtime >= sourceMtime && stamp === desiredIdentity) {
      // A tree vendored by an older build has the binary but no DB. Add just
      // the DB rather than re-copying/re-signing the binary — but never
      // report a cache hit for a tree that is missing it, or the packaged app
      // would keep shipping the broken attach this change exists to fix.
      if (existsSync(TERMINFO_DIR) && existsSync(TERMINFO_PROVENANCE)) {
        console.log(`[fetch-tmux] cached at ${path.relative(REPO_ROOT, VENDOR_DIR)}/ — skipping`);
        await verifyTerminfo();
        return;
      }
      console.log("[fetch-tmux] vendored tmux is cached but its terminfo database is missing — adding it");
      await vendorTerminfo();
      await verifyTerminfo();
      return;
    }
  }

  console.log(`[fetch-tmux] vendoring ${tmuxBin} → ${path.relative(REPO_ROOT, VENDOR_DIR)}/`);
  await mkdir(VENDOR_DIR, { recursive: true });

  // 1. Copy the tmux binary itself.
  await copyFile(tmuxBin, targetTmux);
  await chmod(targetTmux, 0o755);

  // 2. Walk the dylib graph from tmux, copy every brew-rooted .dylib.
  const deps = await resolveAllBrewDeps(tmuxBin);
  for (const src of deps) {
    const dst = path.join(VENDOR_DIR, path.basename(src));
    await copyFile(src, dst);
    await chmod(dst, 0o644);
  }
  console.log(`[fetch-tmux] copied ${deps.size} dylib(s)`);

  // 3. Patch load commands so everything resolves via @executable_path.
  await rewriteLoadCommands(targetTmux);
  const entries = await readdir(VENDOR_DIR);
  for (const f of entries) {
    if (f.endsWith(".dylib")) {
      await rewriteLoadCommands(path.join(VENDOR_DIR, f));
    }
  }

  // install_name_tool invalidates the codesign seal on the file it modifies.
  // macOS arm64 refuses to load unsigned binaries at all (the OS sends
  // SIGKILL — exit 137 — before even printing a message). Re-sign here so
  // (a) `tmux -V` works for the smoke test below and (b) the files going
  // into the .app are already signed correctly before Electrobun's outer
  // bundle sign + notarization runs (sign inside-out — Apple's recommended
  // pattern). When ELECTROBUN_DEVELOPER_ID is set (release builds), use it
  // with --options runtime + --timestamp so notarytool accepts the nested
  // binaries; otherwise ad-hoc, which is enough for local runs but won't
  // pass notarization.
  const devId = process.env.ELECTROBUN_DEVELOPER_ID;
  const signArgs = devId
    ? ["--force", "--options", "runtime", "--timestamp", "--sign", devId]
    : ["--force", "--sign", "-"];
  if (devId) {
    console.log(`[fetch-tmux] signing with ${devId}`);
  } else {
    console.log(`[fetch-tmux] signing ad-hoc (set ELECTROBUN_DEVELOPER_ID for release)`);
  }
  for (const f of [path.basename(targetTmux), ...entries.filter((e) => e.endsWith(".dylib"))]) {
    await run(["codesign", ...signArgs, path.join(VENDOR_DIR, f)]);
  }
  await writeFile(stampPath, `${desiredIdentity}\n`);

  // 4. Verify: every load command on tmux should resolve to either a system
  //    path or @executable_path/. A leftover /opt/homebrew/ entry means
  //    rewriteLoadCommands missed something.
  const finalDeps = await loadCommands(targetTmux);
  const leaked = finalDeps.filter((d) => isBrewPath(d));
  if (leaked.length) {
    fail(`load commands still reference Homebrew paths after rewrite:\n  ${leaked.join("\n  ")}`);
  }

  // 5. Vendor the terminfo database beside the binary, then prove it resolves.
  await vendorTerminfo();
  await verifyTerminfo();

  // 6. Sanity-run the vendored binary.
  const version = await run([targetTmux, "-V"]);
  const finalEntries = await readdir(VENDOR_DIR);
  console.log(`[fetch-tmux] ✓ ${version} (${finalEntries.length} files in ${path.relative(REPO_ROOT, VENDOR_DIR)}/)`);
}

main().catch((e) => {
  console.error(`[fetch-tmux] ${(e as Error).message}`);
  process.exit(1);
});

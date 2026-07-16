import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * When agetor is launched as a packaged .app (Finder, Spotlight, Dock,
 * `open -a Agetor.app`), macOS launchd hands the process a minimal PATH —
 * usually `/usr/bin:/bin:/usr/sbin:/sbin`. None of the places users actually
 * install dev CLIs (`/opt/homebrew/bin`, `~/.nvm/versions/node/<v>/bin`,
 * `~/.npm-global/bin`, `~/.local/bin`, asdf shims, volta, mise, fnm…) are in
 * there, so `Bun.which("claude")` returns null even though `claude` is on the
 * user's interactive PATH.
 *
 * This rehydrates `process.env.PATH` by sourcing the user's login shell once
 * at boot and reading whatever PATH it computes. Same approach used by the
 * `fix-path` npm package and most well-behaved Electron apps. Inlined (vs.
 * adding a dep) to keep the bundler's job simple — electrobun-build inlines
 * everything in src/bun into one index.js.
 *
 * Safe to call when PATH is already healthy (dev runs via `bun run dev`):
 * the merge dedupes, so a no-op turns into a no-op.
 */

// Sentinels wrapping each value the probe prints, so MOTDs / version-manager
// banners / anything else the rc files echo can't be mistaken for it. Exported
// for the probe-parser unit tests. */
export const MARKER_START = "__AGETOR_PATH_START__";
export const MARKER_END = "__AGETOR_PATH_END__";
export const FNM_START = "__AGETOR_FNM_START__";
export const FNM_END = "__AGETOR_FNM_END__";

export interface LoginShellProbe {
  /** The login shell's `$PATH`, or null if the markers didn't survive. */
  path: string | null;
  /** The login shell's `$FNM_DIR`, or null when unset (non-fnm user). */
  fnmDir: string | null;
}

/** Pull one sentinel-delimited value out of the probe's stdout. Empty or
 *  missing → null. */
function extractMarked(stdout: string, start: string, end: string): string | null {
  const s = stdout.indexOf(start);
  const e = stdout.indexOf(end);
  if (s === -1 || e === -1 || e <= s) return null;
  const value = stdout.slice(s + start.length, e).trim();
  return value || null;
}

/** Parse the login-shell probe's stdout into its captured values. Pure —
 *  exported so the parsing can be unit-tested without spawning a shell. */
export function parseLoginShellProbe(stdout: string): LoginShellProbe {
  return {
    path: extractMarked(stdout, MARKER_START, MARKER_END),
    fnmDir: extractMarked(stdout, FNM_START, FNM_END),
  };
}

function readLoginShellPath(): LoginShellProbe {
  const empty: LoginShellProbe = { path: null, fnmDir: null };
  const shell = process.env.SHELL;
  if (!shell) return empty;

  // -i (interactive) + -l (login) so both ~/.zprofile and ~/.zshrc style files
  // run — zsh and bash both honor this combo.
  //
  // We also capture $FNM_DIR: launched from Finder the process env is minimal
  // and FNM_DIR is absent, but the user's rc exports it. Reading it here lets
  // defaultDevPaths() enumerate fnm's node versions without agetor ever
  // blind-statting ~/Library/Application Support/fnm at boot (see the TCC note
  // in defaultDevPaths). $FNM_DIR expands to empty for non-fnm users → null.
  //
  // AGETOR_PATH_PROBE is a re-entrancy guard: if a user's rc file calls back
  // into agetor (unusual but possible), it can read this var and skip work.
  const script =
    `printf '%s' '${MARKER_START}'; printf '%s' "$PATH"; printf '%s' '${MARKER_END}'; ` +
    `printf '%s' '${FNM_START}'; printf '%s' "$FNM_DIR"; printf '%s' '${FNM_END}'`;

  let result;
  try {
    result = spawnSync(shell, ["-ilc", script], {
      env: { ...process.env, AGETOR_PATH_PROBE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 2000,
    });
  } catch {
    return empty;
  }

  // Don't gate on `result.status` — interactive shells routinely exit nonzero
  // when stdin isn't a TTY (zsh -i complains, nvm.sh's `complete` builtin
  // bails, oh-my-zsh's update check ENOENTs, etc). As long as the markers
  // made it to stdout, the values between them are what we want.
  if (!result || typeof result.stdout !== "string") return empty;
  return parseLoginShellProbe(result.stdout);
}

/** Strict command-name allowlist: only the CLIs we ship support for. Prevents
 *  shell-injection if a future caller wires `probeCommandDir` to a DB- or
 *  user-supplied value (a harness alias `bin`, say). The hardcoded list is
 *  cheaper than runtime validation and self-documents intent. */
const PROBEABLE_COMMANDS = ["claude", "codex", "grok", "tmux"] as const;
type ProbeableCommand = (typeof PROBEABLE_COMMANDS)[number];

/**
 * Last-ditch resort when the marker probe failed: ask the user's shell where
 * `claude` lives and add that directory. Smaller blast radius than the full
 * PATH probe — works even when only `type -p` survives a broken rc.
 *
 * Uses `type -p` instead of `command -v` because `command -v` returns alias
 * definitions ("claude: aliased to …") and function bodies for shell aliases
 * and functions, which we'd then have to detect and reject. `type -p` (zsh
 * and bash both support `-p`) prints *only* the file path for an external
 * command, and prints nothing for aliases/functions. Returns `{ dir, aliased }`
 * so the caller can log a useful hint when the user's `claude` is actually an
 * alias the binary check can't follow.
 */
function probeCommandDir(cmd: ProbeableCommand): { dir: string | null; aliased: boolean } {
  const shell = process.env.SHELL;
  if (!shell) return { dir: null, aliased: false };

  // Quote the command name defensively even though the allowlist already
  // rules out metacharacters — belt-and-braces against an allowlist edit
  // that adds something exotic.
  const safe = JSON.stringify(cmd);
  let result;
  try {
    result = spawnSync(
      shell,
      ["-ilc", `type -p ${safe} 2>/dev/null; echo "---"; type ${safe} 2>/dev/null || true`],
      {
        env: { ...process.env, AGETOR_PATH_PROBE: "1" },
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
        timeout: 2000,
      },
    );
  } catch {
    return { dir: null, aliased: false };
  }

  const stdout = (result?.stdout ?? "").trim();
  const [pathSection, typeSection = ""] = stdout.split("---").map((s) => s.trim());
  // `type -p` prints the absolute path on success; nothing on alias/function/miss.
  const filePath = pathSection?.split("\n").pop()?.trim() ?? "";
  // `type` (no -p) describes aliases and functions; we use it only to surface
  // the "you have a `claude` alias" hint when -p found nothing.
  const aliased = !filePath && /\b(aliased|alias for|is a (shell )?function)\b/i.test(typeSection);

  if (!filePath || !filePath.startsWith("/")) return { dir: null, aliased };
  try {
    if (!statSync(filePath).isFile()) return { dir: null, aliased };
  } catch {
    return { dir: null, aliased };
  }
  return { dir: path.dirname(filePath), aliased: false };
}

/** Common dev-tool locations that should be in PATH on macOS/Linux even when
 *  the login-shell probe fails (e.g. user's rc is broken, or $SHELL is set to
 *  /sbin/nologin). Cheap to add; absent entries are simply ignored by lookups.
 *  Exported for unit tests. */
export function defaultDevPaths(): string[] {
  const home = process.env.HOME ?? "";
  if (!home) return [];
  const candidates = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    `${home}/.local/bin`,
    `${home}/.npm-global/bin`,
    `${home}/.yarn/bin`,
    `${home}/.bun/bin`,
    `${home}/.deno/bin`,
    `${home}/.cargo/bin`,
    `${home}/.volta/bin`,
    `${home}/.asdf/shims`,
    `${home}/.local/share/mise/shims`,
    `${home}/bin`,
  ];

  // Per-node-version bin dirs. Each version manager has its own layout — we
  // enumerate the versions present at boot rather than relying on the user's
  // rc file to expose them. Cheap (one readdir per manager).
  const versionRoots = [
    // NVM: ~/.nvm/versions/node/<v>/bin
    { root: `${home}/.nvm/versions/node`, suffix: "bin" },
    // fnm (Linux/XDG): ~/.local/share/fnm/node-versions/<v>/installation/bin
    {
      root: `${home}/.local/share/fnm/node-versions`,
      suffix: path.join("installation", "bin"),
    },
  ];

  // fnm's default macOS store is ~/Library/Application Support/fnm — and
  // macOS Sequoia gates *any* access to another app's Application Support
  // subdir behind the "Agetor would like to access data from other apps"
  // (kTCCServiceSystemPolicyAppData) prompt. Statting/readdir-ing it
  // unconditionally at boot pops that dialog for *every* user, including the
  // majority who don't use fnm at all, and re-pops it on dev builds whose
  // signature can't persist the decision. So we only scan fnm's store when
  // fnm is actually configured — signalled by FNM_DIR, which fnm's shell init
  // (`eval "$(fnm env)"`) exports — and we honor FNM_DIR's own value so a
  // non-default location works too. When agetor is launched from Finder with
  // a minimal env, FNM_DIR is absent; the login-shell PATH probe and the
  // `type -p claude` fallback still resolve fnm-installed binaries via the
  // user's own rc, so the only thing given up is enumerating *inactive* node
  // versions — a fair trade for never tripping the TCC prompt.
  const fnmDir = process.env.FNM_DIR;
  if (fnmDir) {
    // FNM_DIR frequently points at the XDG store already listed above; skip the
    // duplicate so defaultDevPaths() never returns the same bin dir twice.
    const derived = path.join(fnmDir, "node-versions");
    if (!versionRoots.some((r) => r.root === derived)) {
      versionRoots.push({ root: derived, suffix: path.join("installation", "bin") });
    }
  }
  for (const { root, suffix } of versionRoots) {
    try {
      if (!existsSync(root)) continue;
      for (const v of readdirSync(root)) {
        candidates.push(path.join(root, v, suffix));
      }
    } catch {
      /* version manager not installed or unreadable — fine */
    }
  }
  return candidates;
}

/**
 * Rehydrate `process.env.PATH` with the user's login-shell PATH plus common
 * dev locations. Idempotent — safe to call multiple times. Returns the new
 * PATH so callers can log it during debugging.
 */
export function rehydratePath(): string {
  const current = (process.env.PATH ?? "").split(":").filter(Boolean);
  const login = readLoginShellPath();
  // Adopt the login shell's FNM_DIR when our (possibly Finder-minimal) env
  // lacks it, so defaultDevPaths() can enumerate fnm's node versions. Only fnm
  // users reach this — non-fnm shells report an empty FNM_DIR — so it never
  // reintroduces the TCC prompt for users who don't use fnm. Set before
  // defaultDevPaths() reads it below.
  if (login.fnmDir && !process.env.FNM_DIR) {
    process.env.FNM_DIR = login.fnmDir;
  }
  const extras = [
    ...(login.path ? login.path.split(":").filter(Boolean) : []),
    ...defaultDevPaths(),
  ];

  // Login-shell PATH wins (it includes the user's intentional additions in
  // the order they want them). Current PATH appended after dedupe so we never
  // *drop* something that was already there.
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const p of [...extras, ...current]) {
    if (!seen.has(p)) {
      seen.add(p);
      merged.push(p);
    }
  }

  let next = merged.join(":");
  process.env.PATH = next;

  // Last-ditch: if `claude` still isn't resolvable after the merge, ask the
  // user's shell `type -p claude` and splice that directory in. Catches
  // setups where the rc file totally fails to print PATH but `claude` is on
  // a non-standard location the user added themselves.
  //
  // **Bun.which gotcha**: `Bun.which(name)` uses the PATH snapshot Bun
  // captured at process startup — mutating `process.env.PATH` does NOT
  // invalidate that cache. Pass the explicit `{ PATH }` option to force a
  // fresh lookup against our just-rehydrated value. Same applies to every
  // `Bun.which` call in this module (and elsewhere in the bun runtime that
  // runs after rehydratePath).
  let aliasHint = false;
  if (!Bun.which("claude", { PATH: next })) {
    const probe = probeCommandDir("claude");
    if (probe.dir && !seen.has(probe.dir)) {
      seen.add(probe.dir);
      merged.unshift(probe.dir);
      next = merged.join(":");
      process.env.PATH = next;
    }
    aliasHint = probe.aliased;
  }

  // Log the resolved bins once at boot so the packaged-app stderr (visible in
  // Console.app) reveals why the harness probe decided what it did. Keep one
  // line, no PII beyond the absolute path the user installed `claude` at —
  // which is what the bug report needs.
  const resolved = {
    claude: Bun.which("claude", { PATH: next }) ?? "not found",
    codex: Bun.which("codex", { PATH: next }) ?? "not found",
    tmux: Bun.which("tmux", { PATH: next }) ?? "not found",
  };
  console.log(
    `[agetor] PATH rehydrated (login-probe=${login.path ? "ok" : "miss"}): ` +
      `claude=${resolved.claude} codex=${resolved.codex} tmux=${resolved.tmux}`,
  );
  if (aliasHint) {
    console.log(
      "[agetor] note: `claude` appears to be a shell alias/function in your rc, " +
        "not an external binary. Install it with `npm i -g @anthropic-ai/claude-code` " +
        "(or point the harness at an absolute path in Settings → Harnesses).",
    );
  }

  return next;
}

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { EnvSnapshot } from "../shared/types.ts";

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

const MARKER_START = "__AGETOR_PATH_START__";
const MARKER_END = "__AGETOR_PATH_END__";

/** Preference key for the user-supplied extra-PATH list. Value is one
 *  directory per line; blank lines and surrounding whitespace are
 *  ignored at parse time. Defined here so the boot path
 *  (`index.ts:rehydratePath`) and the API setter (`server.ts:/env/extra-paths`)
 *  share the same key. */
export const EXTRA_PATH_DIRS_PREF_KEY = "extra_path_dirs";

/** Parse the textarea-style preference value (one dir per line) into a
 *  clean list. Empty result for null/empty strings. */
export function parseExtraPathDirs(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function readLoginShellPath(): string | null {
  const shell = process.env.SHELL;
  if (!shell) return null;

  // -i (interactive) + -l (login) so both ~/.zprofile and ~/.zshrc style files
  // run — zsh and bash both honor this combo. We mark the PATH with sentinels
  // so MOTDs, version-manager init banners, or anything else the rc files
  // print to stdout doesn't get mistaken for it.
  //
  // AGETOR_PATH_PROBE is a re-entrancy guard: if a user's rc file calls back
  // into agetor (unusual but possible), it can read this var and skip work.
  const script = `printf '%s' '${MARKER_START}'; printf '%s' "$PATH"; printf '%s' '${MARKER_END}'`;

  let result;
  try {
    result = spawnSync(shell, ["-ilc", script], {
      env: { ...process.env, AGETOR_PATH_PROBE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 2000,
    });
  } catch {
    return null;
  }

  // Don't gate on `result.status` — interactive shells routinely exit nonzero
  // when stdin isn't a TTY (zsh -i complains, nvm.sh's `complete` builtin
  // bails, oh-my-zsh's update check ENOENTs, etc). As long as the markers
  // made it to stdout, the PATH between them is what we want.
  if (!result || typeof result.stdout !== "string") return null;

  const start = result.stdout.indexOf(MARKER_START);
  const end = result.stdout.indexOf(MARKER_END);
  if (start === -1 || end === -1 || end <= start) return null;

  const value = result.stdout.slice(start + MARKER_START.length, end).trim();
  return value || null;
}

/** Strict command-name allowlist: only the CLIs we ship support for. Prevents
 *  shell-injection if a future caller wires `probeCommandDir` to a DB- or
 *  user-supplied value (a harness alias `bin`, say). The hardcoded list is
 *  cheaper than runtime validation and self-documents intent. */
const PROBEABLE_COMMANDS = ["claude", "codex", "tmux"] as const;
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
    // fnm (macOS): ~/Library/Application Support/fnm/node-versions/<v>/installation/bin
    {
      root: `${home}/Library/Application Support/fnm/node-versions`,
      suffix: path.join("installation", "bin"),
    },
    // fnm (Linux/XDG): ~/.local/share/fnm/node-versions/<v>/installation/bin
    {
      root: `${home}/.local/share/fnm/node-versions`,
      suffix: path.join("installation", "bin"),
    },
  ];
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

let lastSnapshot: EnvSnapshot | null = null;

/** Return the most recent rehydratePath() result, or null if it hasn't run
 *  yet (only relevant in tests — boot always calls rehydratePath first).
 *  Shape lives in `shared/types.ts:EnvSnapshot` so the webview can import
 *  it without duplicating the structure. */
export function getLastRehydration(): EnvSnapshot | null {
  return lastSnapshot;
}

/**
 * Rehydrate `process.env.PATH` with the user's login-shell PATH plus common
 * dev locations. Idempotent — safe to call multiple times. Returns the new
 * PATH so callers can log it during debugging.
 *
 * `extraDirs` is the user's escape hatch (Settings → Environment): every
 * non-empty entry is prepended ahead of the login-shell PATH and the
 * default candidates, so it wins over both. Re-runnable at runtime — when
 * the user saves a new list, the server calls this again and the next
 * `Bun.which({ PATH: process.env.PATH })` lookup in `agent-status.ts` picks
 * up the fresh value on the next `/agents` poll.
 */
export function rehydratePath(opts: { extraDirs?: string[] } = {}): string {
  const current = (process.env.PATH ?? "").split(":").filter(Boolean);
  const loginPath = readLoginShellPath();
  // De-dupe + trim the user's extras up front so the snapshot reports
  // exactly what we used (textarea input often has trailing whitespace
  // or blank lines).
  const extraDirs = (opts.extraDirs ?? [])
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
  const defaultDirs = defaultDevPaths();
  const extras = [
    ...extraDirs,
    ...(loginPath ? loginPath.split(":").filter(Boolean) : []),
    ...defaultDirs,
  ];

  // Login-shell PATH wins (it includes the user's intentional additions in
  // the order they want them). Current PATH appended after dedupe so we never
  // *drop* something that was already there. User-supplied extraDirs are
  // first in `extras`, so they win over both.
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
    claude: Bun.which("claude", { PATH: next }),
    codex: Bun.which("codex", { PATH: next }),
    tmux: Bun.which("tmux", { PATH: next }),
  };
  console.log(
    `[agetor] PATH rehydrated (login-probe=${loginPath ? "ok" : "miss"}, ` +
      `extra-dirs=${extraDirs.length}): ` +
      `claude=${resolved.claude ?? "not found"} ` +
      `codex=${resolved.codex ?? "not found"} ` +
      `tmux=${resolved.tmux ?? "not found"}`,
  );
  if (aliasHint) {
    console.log(
      "[agetor] note: `claude` appears to be a shell alias/function in your rc, " +
        "not an external binary. Install it with `npm i -g @anthropic-ai/claude-code` " +
        "(or point the harness at an absolute path in Settings → Harnesses).",
    );
  }

  lastSnapshot = {
    path: next,
    loginProbeOk: loginPath !== null,
    extraDirs,
    defaultDirs,
    resolved,
    claudeAliasHint: aliasHint,
    at: Date.now(),
  };

  return next;
}

import { spawnSync } from "node:child_process";

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
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 2000,
    });
  } catch {
    return null;
  }

  if (!result || result.status !== 0 || typeof result.stdout !== "string") return null;

  const start = result.stdout.indexOf(MARKER_START);
  const end = result.stdout.indexOf(MARKER_END);
  if (start === -1 || end === -1 || end <= start) return null;

  const value = result.stdout.slice(start + MARKER_START.length, end).trim();
  return value || null;
}

/** Common dev-tool locations that should be in PATH on macOS/Linux even when
 *  the login-shell probe fails (e.g. user's rc is broken, or $SHELL is set to
 *  /sbin/nologin). Cheap to add; absent entries are simply ignored by lookups. */
function defaultDevPaths(): string[] {
  const home = process.env.HOME ?? "";
  const candidates = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    `${home}/.local/bin`,
    `${home}/.npm-global/bin`,
    `${home}/bin`,
  ];
  return home ? candidates : candidates.filter((p) => !p.startsWith("/")) /* never */;
}

/**
 * Rehydrate `process.env.PATH` with the user's login-shell PATH plus common
 * dev locations. Idempotent — safe to call multiple times. Returns the new
 * PATH so callers can log it during debugging.
 */
export function rehydratePath(): string {
  const current = (process.env.PATH ?? "").split(":").filter(Boolean);
  const loginPath = readLoginShellPath();
  const extras = [
    ...(loginPath ? loginPath.split(":").filter(Boolean) : []),
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

  const next = merged.join(":");
  process.env.PATH = next;
  return next;
}

import { homedir } from "node:os";
import path from "node:path";
import { readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";

/**
 * Per-host GitHub personal-access-token store. This exists because a single
 * machine can have several GitHub identities reachable only through distinct
 * ssh host aliases (`git@github-work.com:owner/repo.git`), and one env var
 * (`GITHUB_TOKEN`) or `gh auth token` can never cover more than one of them.
 * Tokens here are keyed by the raw (pre-canonicalization) remote host, which
 * *is* the identity — see docs/plans/github-multi-identity-tokens.md.
 *
 * This module deliberately imports nothing from `db.ts` (which opens SQLite
 * on import) or `github.ts` (which calls `tokenForHost` from here as one step
 * of its own resolution order) — keeping it a leaf module makes it trivial to
 * unit test and avoids any import cycle with github.ts.
 */
export type GitHubTokenEntry = {
  host: string;
  token: string;
  label: string | null;
};

interface GitHubTokensFile {
  tokens: GitHubTokenEntry[];
}

export const GITHUB_TOKENS_FILENAME = "github-tokens.json";

/**
 * Resolve the data dir the same way `db.ts` / `core-creds.ts` do, but lazily
 * (at call time) rather than once at module load. Reading `AGETOR_DATA_DIR`
 * at call time keeps this in agreement with `db.ts` even under the test
 * auto-allocate path (which sets the env var before any store call runs).
 */
export function resolveDataDir(): string {
  return process.env.AGETOR_DATA_DIR ?? path.join(homedir(), ".agetor");
}

export function githubTokensPath(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, GITHUB_TOKENS_FILENAME);
}

/** Lowercase + trim so lookups and storage never diverge on case/whitespace. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

/**
 * Read + validate the store file. Missing file, corrupt JSON, or a
 * malformed shape all degrade to an empty list rather than throwing — a
 * broken token file must never block the rest of the app from starting.
 * Entries with an empty or non-string `host`/`token` are dropped rather than
 * surfaced, since they can never be resolved against by `tokenForHost`.
 */
function readTokensFile(): GitHubTokenEntry[] {
  let raw: string;
  try {
    raw = readFileSync(githubTokensPath(), "utf8");
  } catch {
    return []; // missing file → no tokens
  }
  try {
    const v = JSON.parse(raw) as Partial<GitHubTokensFile>;
    if (!v || !Array.isArray(v.tokens)) return [];
    const out: GitHubTokenEntry[] = [];
    for (const entry of v.tokens) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Partial<GitHubTokenEntry>;
      if (typeof e.host !== "string" || e.host.trim() === "") continue;
      if (typeof e.token !== "string" || e.token === "") continue;
      const label =
        typeof e.label === "string" ? e.label : e.label === null ? null : null;
      out.push({ host: normalizeHost(e.host), token: e.token, label });
    }
    return out;
  } catch {
    return []; // corrupt JSON → treat as no tokens
  }
}

/**
 * Write the store atomically at mode 0600 (write a tmp sibling, then rename
 * over the target) so a reader never sees a half-written or world-readable
 * file. Best-effort chmod afterwards in case the umask or an existing file
 * left looser bits. Mirrors `writeCoreCreds` in core-creds.ts.
 */
function writeTokensFile(tokens: GitHubTokenEntry[]): void {
  const file = githubTokensPath();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ tokens }), { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
}

/** List all stored tokens. Never throws; malformed/missing file → `[]`. */
export function listGitHubTokens(): GitHubTokenEntry[] {
  return readTokensFile();
}

/**
 * Upsert a token by (normalized) host. Throws on empty host/token so a
 * caller-side validation bug fails loudly instead of silently writing a
 * dead entry that `tokenForHost` can never match.
 */
export function setGitHubToken(
  host: string,
  token: string,
  label?: string | null,
): void {
  const normalized = normalizeHost(host);
  if (normalized === "") throw new Error("host must not be empty");
  if (token === "") throw new Error("token must not be empty");

  const tokens = readTokensFile();
  const entry: GitHubTokenEntry = {
    host: normalized,
    token,
    label: label ?? null,
  };
  const idx = tokens.findIndex((t) => t.host === normalized);
  if (idx === -1) {
    tokens.push(entry);
  } else {
    tokens[idx] = entry;
  }
  writeTokensFile(tokens);
}

/** Remove the entry for `host`. Returns true iff an entry was removed. */
export function deleteGitHubToken(host: string): boolean {
  const normalized = normalizeHost(host);
  const tokens = readTokensFile();
  const next = tokens.filter((t) => t.host !== normalized);
  if (next.length === tokens.length) return false;
  writeTokensFile(next);
  return true;
}

/**
 * Resolve a stored token for `host`, implementing only steps 1–2 of the
 * full resolution order (exact host match, then the `github.com` entry as
 * default) — env var and `gh auth token` fallback live in github.ts, which
 * calls this as its first step. `host` is expected pre-lowercased by the
 * caller's parsing, but is normalized again here defensively.
 */
export function tokenForHost(host: string | null): string | null {
  const tokens = readTokensFile();
  if (host !== null) {
    const normalized = normalizeHost(host);
    const exact = tokens.find((t) => t.host === normalized);
    if (exact) return exact.token;
  }
  const fallback = tokens.find((t) => t.host === "github.com");
  return fallback ? fallback.token : null;
}

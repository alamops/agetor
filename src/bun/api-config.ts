import { randomBytes } from "node:crypto";

/**
 * Localhost HTTP API config, factored out of `server.ts` so submodules can
 * read it without importing the full server (which would create a cycle:
 * server → orchestrator → claude-tmux → server).
 *
 *   • `getApiPort()` reads from `AGETOR_API_PORT` (defaults to 4317) on each
 *     call — important because tests set the env var lazily and the module
 *     graph caches imports across files; freezing the port at module load
 *     would lock in whichever test file imported claude-tmux first.
 *   • `resolveApiHost()` reads the HEADLESS core's bind address from
 *     `AGETOR_API_HOST` (defaults to `127.0.0.1`) on each call, for the same
 *     reason. Loopback is the default and the intended setup; a wildcard bind
 *     (`0.0.0.0` / `::`) exists for running the headless core inside a
 *     container, where a published port can't reach a loopback-only listener.
 *     The desktop app ignores it and always binds `127.0.0.1` (index.ts). This
 *     is the SERVER bind only — every client (webview, CLI, creds probe,
 *     daemon handoff) keeps connecting to `127.0.0.1`, which is why only IPv4
 *     loopback or a wildcard is accepted (see `resolveApiHost`).
 *   • `API_TOKEN` (the MASTER token) is a fresh 32-byte hex string per process
 *     launch. It reaches the app's own webview through preload and the window
 *     URL's hash fragment (local, never sent on the wire) and is never written
 *     to disk, never accepted in a request URL, and never handed to a child
 *     process. `AGETOR_API_TOKEN` overrides it for e2e and local debugging
 *     (e.g. hitting the API with curl); the variable is deleted from
 *     `process.env` right after it is read so no child inherits it. Unset in
 *     normal use, where the random per-launch value is what protects the API
 *     (loopback-bound by default) from other localhost processes — and, under a
 *     non-loopback `AGETOR_API_HOST`, from anything that can reach the
 *     published port.
 *   • `CLI_TOKEN` is the second, weaker credential: a fresh random value per
 *     launch with NO env override, and the only one written to
 *     `agetor-core.json` (`core-creds.ts`) — the file the `agetor` CLI reads.
 *     Any program running as the user (agents included) can read that file, so
 *     what this token may reach is decided per route by `route-policy.ts`: it
 *     does what the CLI does and nothing that needs the app itself.
 */
export function getApiPort(): number {
  return Number(process.env.AGETOR_API_PORT ?? 4317);
}

export const DEFAULT_API_HOST = "127.0.0.1";

/** Wildcard binds — they accept every interface, `127.0.0.1` included. */
const WILDCARD_API_HOSTS = new Set(["0.0.0.0", "::"]);

export type ApiHostResolution =
  | { ok: true; host: string }
  | { ok: false; error: string };

/**
 * Resolve `AGETOR_API_HOST` to a bind address, or explain why it can't be
 * used. Accepted: unset/blank, `127.0.0.1` or `localhost` (all → `127.0.0.1`)
 * and the wildcards `0.0.0.0`, `::` / `[::]` (case and surrounding whitespace
 * ignored). Everything else is refused, because every Agetor client connects
 * over `http://127.0.0.1:<port>`: `::1` — and `localhost`, which Bun resolves
 * to `::1` on macOS — binds IPv6-only, and a specific interface address (a
 * container IP, `127.0.0.2`…) never accepts `127.0.0.1`. Bun also reports an
 * unbindable host as "Is port N in use?", so refusing up front is what keeps a
 * typo from being misdiagnosed as a port conflict.
 */
export function resolveApiHost(
  raw: string | undefined = process.env.AGETOR_API_HOST,
): ApiHostResolution {
  const value = raw?.trim() ?? "";
  const host = value.toLowerCase();
  if (host === "" || host === "localhost" || host === DEFAULT_API_HOST) {
    return { ok: true, host: DEFAULT_API_HOST };
  }
  if (host === "[::]") return { ok: true, host: "::" };
  if (WILDCARD_API_HOSTS.has(host)) return { ok: true, host };
  return {
    ok: false,
    error: `AGETOR_API_HOST=${JSON.stringify(value)} is not supported — use 127.0.0.1 (the default), 0.0.0.0 or ::. Agetor's own clients (webview, CLI, daemon handoff) connect over 127.0.0.1, which any other bind address would break.`,
  };
}

/** Bracket a bare IPv6 literal so it can sit in front of `:port` in a URL. */
export function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** One-line startup warning for a non-loopback bind, or `null` on loopback. */
export function nonLoopbackBindWarning(host: string, port: number | string): string | null {
  if (host === DEFAULT_API_HOST) return null;
  return `[agetor] WARNING: API bound to ${formatHostForUrl(host)}:${port} (AGETOR_API_HOST) is reachable beyond loopback over plain HTTP — the bearer token is its only protection and travels in cleartext. Publish the port only to the host's loopback (e.g. -p 127.0.0.1:${port}:${port}); for remote access use an SSH tunnel or a TLS-terminating proxy.`;
}

/**
 * Read the master-token override and take it out of the environment in one
 * step: every child process the core starts inherits `process.env` unless a
 * caller passes its own, and the master must never travel that way (D16).
 * A blank value counts as unset — an empty token would authorize everyone who
 * sends an empty bearer.
 */
function takeMasterToken(): string {
  const override = process.env.AGETOR_API_TOKEN;
  delete process.env.AGETOR_API_TOKEN;
  return override !== undefined && override.trim() !== ""
    ? override
    : randomBytes(32).toString("hex");
}

/** Master token: the app's webview (and e2e/dev via `AGETOR_API_TOKEN`). */
export const API_TOKEN = takeMasterToken();

/**
 * CLI token: what `agetor-core.json` carries. Random per launch, same shape as
 * the master, deliberately without an env override so it can't be pinned to a
 * value that outlives a launch.
 */
export const CLI_TOKEN = randomBytes(32).toString("hex");

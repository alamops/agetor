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
 *   • `getApiHost()` reads the server's bind address from `AGETOR_API_HOST`
 *     (defaults to `127.0.0.1`) on each call, for the same reason. Loopback is
 *     the default and the intended setup; a wider bind (e.g. `0.0.0.0`) exists
 *     for headless use inside a container, where a published port can't reach
 *     a loopback-only listener. This is the SERVER bind only — in-process and
 *     same-machine clients (hooks, MCP, CLI, creds probe) keep connecting to
 *     `127.0.0.1`, which a wildcard bind still accepts.
 *   • `API_TOKEN` is a fresh 32-byte hex string per process launch — passed
 *     to the webview via the window URL, and to claude subprocesses via tmux
 *     env so the hook script + MCP server can reach back. Generated once at
 *     module load (a stable per-launch identity is part of the contract).
 *     `AGETOR_API_TOKEN` overrides it for local debugging (e.g. hitting the
 *     API directly with curl instead of through the injected webview) — unset
 *     in normal use, where the random per-launch value is what protects the
 *     API (loopback-bound by default) from other localhost processes — and,
 *     under a non-loopback `AGETOR_API_HOST`, from anything that can reach
 *     the published port.
 */
export function getApiPort(): number {
  return Number(process.env.AGETOR_API_PORT ?? 4317);
}

export const DEFAULT_API_HOST = "127.0.0.1";

export function getApiHost(): string {
  const host = process.env.AGETOR_API_HOST?.trim();
  return host ? host : DEFAULT_API_HOST;
}

/**
 * True when `host` only accepts connections from this machine: `localhost`,
 * any IPv4 address in 127.0.0.0/8, or IPv6 `::1` (bracketed or not, plus its
 * IPv4-mapped `::ffff:127.x.y.z` form). Wildcards (`0.0.0.0`, `::`) and every
 * other address or hostname count as non-loopback.
 */
export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (h.startsWith("::ffff:")) h = h.slice("::ffff:".length);
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) && octets[0] === 127;
}

/** Bracket a bare IPv6 literal so it can sit in front of `:port` in a URL. */
export function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** One-line startup warning for a non-loopback bind, or `null` on loopback. */
export function nonLoopbackBindWarning(host: string, port: number | string): string | null {
  if (isLoopbackHost(host)) return null;
  return `[agetor] WARNING: API bound to ${formatHostForUrl(host)}:${port} (AGETOR_API_HOST) is reachable beyond loopback and protected only by the bearer token — meant for containers where the published port is restricted (e.g. -p 127.0.0.1:${port}:${port}).`;
}

export const API_TOKEN = process.env.AGETOR_API_TOKEN ?? randomBytes(32).toString("hex");

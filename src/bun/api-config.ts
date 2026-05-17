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
 *   • `API_TOKEN` is a fresh 32-byte hex string per process launch — passed
 *     to the webview via the window URL, and to claude subprocesses via tmux
 *     env so the hook script + MCP server can reach back. Generated once at
 *     module load (a stable per-launch identity is part of the contract).
 */
export function getApiPort(): number {
  return Number(process.env.AGETOR_API_PORT ?? 4317);
}
export const API_TOKEN = randomBytes(32).toString("hex");

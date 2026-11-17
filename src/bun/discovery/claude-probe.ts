/**
 * Claude Code model discovery: the SDK `initialize` control request.
 *
 * `claude -p --input-format stream-json --output-format stream-json` answers
 * one `{"type":"control_request","request":{"subtype":"initialize"}}` line
 * with a `control_response` whose `response.models[]` lists every model the
 * CLI offers, with per-model effort levels and fast-mode support (CLI ≥
 * 2.1.49; older CLIs answer ids and labels only). No prompt is sent, so it
 * costs no quota, and no session is created (`--no-session-persistence`).
 *
 * Isolation (wave-0 spike G3, `docs/plans/dynamic-model-catalog-spikes.md`):
 * `--settings '{"disableAllHooks":true}'` keeps the user's and project's
 * hooks from running and `--strict-mcp-config` keeps their MCP servers from
 * starting; the probe runs in an empty directory the caller supplies. The
 * argv never includes `AGETOR_CLAUDE_ARGS`.
 *
 * The response ALSO carries the signed-in account (email, organization,
 * subscription). The parser reads `models[]` and nothing else, and the raw
 * response is never logged, stored or returned.
 *
 * Stays a leaf: imports only `shared/*`, `core-spawn` (via `spawn-probe`).
 */

import { claudeIdFromCliModel } from "../../shared/claude-model-id.ts";
import { sanitizeCliDescription, sanitizeCliLabel } from "../../shared/model-display.ts";
import type { DiscoveredModel } from "../../shared/model-options.ts";
import { runJsonLineSession } from "./spawn-probe.ts";

/** The `initialize` answer arrives in ~2 s; the budget covers a cold start. */
export const CLAUDE_PROBE_TIMEOUT_MS = 10_000;

const INIT_REQUEST_ID = "init-1";

/** The probe's argv. Deliberately free of `AGETOR_CLAUDE_ARGS`. */
export function claudeProbeArgv(bin: string): string[] {
  return [
    bin,
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--settings", '{"disableAllHooks":true}',
    "--no-session-persistence",
    "--strict-mcp-config",
  ];
}

/**
 * Parse the `initialize` response's `models[]` (pass the response object, or
 * anything with a `models` array). Whitelists the fields it reads; never
 * throws; anything unusable yields `[]`.
 *
 * - the `default` row is dropped and marks the row its `resolvedModel` names
 *   `cliDefault`;
 * - an id is derived by rule from the CLI id (`claude-opus-5-5` → `opus-5.5`);
 *   a row whose id cannot be derived is skipped, duplicates collapse (first
 *   wins; an alias row beats the full-id row it points at);
 * - `efforts` only when `supportsEffort !== false` and the level list is
 *   non-empty, in the CLI's order;
 * - `fast` only when `supportsFastMode === true`.
 */
export function parseClaudeInitModels(initResponse: unknown): DiscoveredModel[] {
  if (!initResponse || typeof initResponse !== "object") return [];
  const models = (initResponse as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];

  let defaultResolved: string | null = null;
  const out: DiscoveredModel[] = [];
  const byId = new Map<string, DiscoveredModel>();
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const value = typeof e.value === "string" ? e.value : "";
    const resolved = typeof e.resolvedModel === "string" && e.resolvedModel ? e.resolvedModel : "";
    if (value === "default") {
      if (resolved) defaultResolved = resolved;
      continue;
    }
    // A CLI that predates `resolvedModel` lists full ids as the value.
    const cliId = resolved || (value.startsWith("claude-") ? value : "");
    if (!cliId) continue;
    const id = claudeIdFromCliModel(cliId);
    if (!id || byId.has(id)) continue;

    const row: DiscoveredModel = { id, cliId };
    if (value && !value.startsWith("claude-")) row.alias = value;
    if (typeof e.displayName === "string") {
      const label = sanitizeCliLabel(e.displayName);
      if (label) row.label = label;
    }
    if (typeof e.description === "string") {
      const description = sanitizeCliDescription(e.description);
      if (description) row.description = description;
    }
    if (e.supportsEffort !== false && Array.isArray(e.supportedEffortLevels)) {
      const efforts: string[] = [];
      for (const lvl of e.supportedEffortLevels) {
        if (typeof lvl === "string" && lvl && !efforts.includes(lvl)) efforts.push(lvl);
      }
      if (efforts.length > 0) row.efforts = efforts;
    }
    if (e.supportsFastMode === true) row.fast = true;
    byId.set(id, row);
    out.push(row);
  }
  if (defaultResolved) {
    const defaultId = claudeIdFromCliModel(defaultResolved);
    const row = defaultId ? byId.get(defaultId) : undefined;
    if (row) row.cliDefault = true;
  }
  return out;
}

/** Pull the `initialize` result out of one stream-json line, or null. */
function initResult(msg: unknown): { ok: boolean; response?: unknown } | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as { type?: unknown; response?: unknown };
  if (m.type !== "control_response" || !m.response || typeof m.response !== "object") return null;
  const r = m.response as { subtype?: unknown; request_id?: unknown; response?: unknown };
  if (r.request_id !== INIT_REQUEST_ID) return null;
  return r.subtype === "success" ? { ok: true, response: r.response } : { ok: false };
}

/**
 * Ask `bin` for its model list. Resolves `[]` on any failure: a missing
 * binary, a timeout, a non-JSON or error reply, an empty list. Never throws.
 * `cwd` must be an empty directory the caller owns.
 */
export async function probeClaudeModels(opts: {
  bin: string;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}): Promise<DiscoveredModel[]> {
  let models: DiscoveredModel[] = [];
  await runJsonLineSession({
    cmd: claudeProbeArgv(opts.bin),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    timeoutMs: opts.timeoutMs ?? CLAUDE_PROBE_TIMEOUT_MS,
    start: (write) => write({ type: "control_request", request_id: INIT_REQUEST_ID, request: { subtype: "initialize" } }),
    onMessage: (msg) => {
      const res = initResult(msg);
      if (!res) return;
      if (res.ok) models = parseClaudeInitModels(res.response);
      return "done";
    },
  });
  return models;
}

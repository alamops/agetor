/**
 * GitHub Copilot model discovery over ACP (Agent Client Protocol, public
 * preview): `copilot --acp --stdio`, then `initialize` and `session/new`.
 * `session/new`'s result carries `configOptions` — an option in the `model`
 * category lists the models, one in `thought_level` lists the reasoning
 * efforts of the CURRENT model — and, on older servers, `models.availableModels`.
 *
 * Read-only by construction: the probe sends `initialize` and `session/new`
 * and nothing else — never `session/prompt`, `session/set_config_option`,
 * `session/set_model` or `session/set_mode` — then kills the child. A
 * `session/new` may leave a session record under `COPILOT_HOME` (owner-
 * accepted, plan §8.1). `AGETOR_COPILOT_ACP_PROBE=0` turns the probe off and
 * discovery falls back to `copilot help config`.
 *
 * The ACP shape follows the spec, unverified against a real Copilot build
 * (not installed where this was written): a failed or odd reply is `[]`.
 *
 * Stays a leaf: only `shared/*` and `spawn-probe`.
 */

import { sanitizeCliDescription, sanitizeCliLabel } from "../../shared/model-display.ts";
import type { DiscoveredModel } from "../../shared/model-options.ts";
import { runJsonLineSession } from "./spawn-probe.ts";

export const COPILOT_ACP_PROBE_ENV = "AGETOR_COPILOT_ACP_PROBE";
export const COPILOT_ACP_PROBE_TIMEOUT_MS = 6_000;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/;
const OFF_VALUES = new Set(["0", "false", "off", "no"]);

/** False when `AGETOR_COPILOT_ACP_PROBE` is `0`/`false`/`off`/`no`. */
export function copilotAcpProbeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[COPILOT_ACP_PROBE_ENV];
  return !(typeof v === "string" && OFF_VALUES.has(v.trim().toLowerCase()));
}

interface AcpOption { value: string; name?: string; description?: string }

/** Flatten an ACP select's `options` (a flat list or `{group, options}` groups). */
function flattenOptions(options: unknown): AcpOption[] {
  if (!Array.isArray(options)) return [];
  const out: AcpOption[] = [];
  for (const o of options) {
    if (!o || typeof o !== "object") continue;
    const r = o as Record<string, unknown>;
    if (Array.isArray(r.options)) {
      out.push(...flattenOptions(r.options));
      continue;
    }
    const value = typeof r.value === "string" ? r.value : typeof r.id === "string" ? r.id : "";
    if (!value) continue;
    out.push({
      value,
      ...(typeof r.name === "string" ? { name: r.name } : {}),
      ...(typeof r.description === "string" ? { description: r.description } : {}),
    });
  }
  return out;
}

/**
 * Parse a `session/new` result into model rows. Models come from the
 * `configOptions` entry whose `category` is `model` (else
 * `models.availableModels`); efforts from the `thought_level` option attach
 * only to the model that is current in this response (the others fall back
 * to the curated tables), with the option names as `effortLabels`.
 */
export function parseCopilotSessionNew(result: unknown): DiscoveredModel[] {
  if (!result || typeof result !== "object") return [];
  const r = result as Record<string, unknown>;
  const configOptions = Array.isArray(r.configOptions) ? (r.configOptions as unknown[]) : [];
  const byCategory = (category: string): Record<string, unknown> | undefined =>
    configOptions.find((o): o is Record<string, unknown> =>
      !!o && typeof o === "object" && (o as Record<string, unknown>).category === category);

  const modelOption = byCategory("model");
  let models: AcpOption[] = flattenOptions(modelOption?.options);
  let currentId = typeof modelOption?.currentValue === "string" ? modelOption.currentValue : "";
  const legacy = r.models && typeof r.models === "object" ? (r.models as Record<string, unknown>) : null;
  if (models.length === 0 && legacy && Array.isArray(legacy.availableModels)) {
    models = [];
    for (const m of legacy.availableModels) {
      if (!m || typeof m !== "object") continue;
      const e = m as Record<string, unknown>;
      const value = typeof e.modelId === "string" ? e.modelId : typeof e.id === "string" ? e.id : "";
      if (!value) continue;
      models.push({
        value,
        ...(typeof e.name === "string" ? { name: e.name } : {}),
        ...(typeof e.description === "string" ? { description: e.description } : {}),
      });
    }
  }
  if (!currentId && legacy && typeof legacy.currentModelId === "string") currentId = legacy.currentModelId;
  if (models.length === 0) return [];

  const effortOption = byCategory("thought_level");
  const effortOptions = flattenOptions(effortOption?.options).filter((o) => /^[a-z0-9_-]{1,32}$/.test(o.value));
  const efforts: string[] = [];
  const effortLabels: Record<string, string> = {};
  for (const o of effortOptions) {
    if (efforts.includes(o.value)) continue;
    efforts.push(o.value);
    if (o.name) {
      const label = sanitizeCliLabel(o.name);
      if (label) effortLabels[o.value] = label;
    }
  }

  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    if (!ID_RE.test(m.value) || seen.has(m.value)) continue;
    seen.add(m.value);
    const row: DiscoveredModel = { id: m.value };
    if (m.name) {
      const label = sanitizeCliLabel(m.name);
      if (label) row.label = label;
    }
    if (m.description) {
      const description = sanitizeCliDescription(m.description);
      if (description) row.description = description;
    }
    if (m.value === currentId && efforts.length > 0) {
      row.efforts = efforts;
      if (Object.keys(effortLabels).length > 0) row.effortLabels = effortLabels;
    }
    out.push(row);
  }
  return out;
}

/**
 * Ask `copilot --acp --stdio` for its models. `[]` when the probe is
 * disabled (nothing is spawned), the binary is missing, the server errors,
 * the budget runs out or the reply is unusable. Never throws; `cwd` must be
 * an empty directory the caller owns.
 */
export async function probeCopilotAcp(opts: {
  bin: string;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}): Promise<DiscoveredModel[]> {
  if (!copilotAcpProbeEnabled()) return [];
  let models: DiscoveredModel[] = [];
  const cwd = opts.cwd ?? process.cwd();
  await runJsonLineSession({
    cmd: [opts.bin, "--acp", "--stdio"],
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    timeoutMs: opts.timeoutMs ?? COPILOT_ACP_PROBE_TIMEOUT_MS,
    start: (write) =>
      write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }),
    onMessage: (msg, write) => {
      if (!msg || typeof msg !== "object") return;
      const m = msg as { id?: unknown; method?: unknown; result?: unknown; error?: unknown };
      // The server asking us something: we implement no client method.
      if (typeof m.method === "string" && m.id !== undefined) {
        write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unsupported" } });
        return;
      }
      if (m.id === 1) {
        if (m.error !== undefined) return "done";
        write({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } });
        return;
      }
      if (m.id === 2) {
        if (m.error === undefined) models = parseCopilotSessionNew(m.result);
        return "done";
      }
    },
  });
  return models;
}

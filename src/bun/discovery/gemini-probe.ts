/**
 * Gemini CLI model discovery: `gemini models -o json`.
 *
 * The `models` subcommand exists from Gemini CLI 0.67.0 on (its JSON rows
 * carry `modelId`, `id`, `name`, `displayName`, `description`; no thinking
 * levels). An older CLI has no list, and — worse — would read `models` as a
 * prompt, so the subcommand is only run after `--version` proves ≥ 0.67.0; an
 * old or unparseable version answers `[]` without ever running it, and the
 * curated table stays in charge.
 *
 * Stays a leaf: only `shared/*` and `spawn-probe`.
 */

import { cliVersionSatisfies } from "../../shared/cli-version.ts";
import { sanitizeCliDescription, sanitizeCliLabel } from "../../shared/model-display.ts";
import type { DiscoveredModel } from "../../shared/model-options.ts";
import { runCapture } from "./spawn-probe.ts";

export const GEMINI_MODELS_MIN_VERSION = "0.67.0";

const VERSION_TIMEOUT_MS = 2_000;
const MODELS_TIMEOUT_MS = 5_000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/;

/** Parse `gemini models -o json` stdout (a bare array or `{models:[…]}`).
 *  id = `modelId ?? id ?? name`; never throws; garbage yields `[]`. */
export function parseGeminiModelsJson(stdout: string): DiscoveredModel[] {
  let parsed: unknown;
  try {
    // A leading banner line must not poison the JSON: start at the first bracket.
    const start = stdout.search(/[[{]/);
    if (start < 0) return [];
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { models?: unknown }).models)
      ? (parsed as { models: unknown[] }).models
      : null;
  if (!list) return [];
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const raw = [e.modelId, e.id, e.name].find((v): v is string => typeof v === "string" && v.length > 0);
    if (!raw || !ID_RE.test(raw) || seen.has(raw)) continue;
    seen.add(raw);
    const row: DiscoveredModel = { id: raw };
    if (typeof e.displayName === "string") {
      const label = sanitizeCliLabel(e.displayName);
      if (label) row.label = label;
    }
    if (typeof e.description === "string") {
      const description = sanitizeCliDescription(e.description);
      if (description) row.description = description;
    }
    out.push(row);
  }
  return out;
}

/** The gemini model list, or `[]` when the CLI is older than 0.67.0, absent
 *  or answers garbage. Never throws. */
export async function probeGeminiModels(opts: { bin: string; env?: Record<string, string> }): Promise<DiscoveredModel[]> {
  const version = await runCapture([opts.bin, "--version"], {
    ...(opts.env ? { env: opts.env } : {}),
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  if (!version.ok || cliVersionSatisfies(version.stdout, GEMINI_MODELS_MIN_VERSION) !== true) return [];
  const models = await runCapture([opts.bin, "models", "-o", "json"], {
    ...(opts.env ? { env: opts.env } : {}),
    timeoutMs: MODELS_TIMEOUT_MS,
  });
  if (!models.ok || !models.stdout) return [];
  return parseGeminiModelsJson(models.stdout);
}

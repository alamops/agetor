/**
 * Turns `agy models` output (one `<id>  <Label>` line per flat variant,
 * grammar `<base>-<effort>`, e.g. `gemini-4-neon-high  Gemini 4 Neon (High)`)
 * into the picker's model rows: one row per base model with its effort ladder
 * and variant id map (`DiscoveredModel.antigravity`), instead of 27+ flat
 * suffixed rows whose "(High)"/"(Medium)"/"(Low)"/"(XHigh)" suffixes were
 * truncated in the Model picker while the Effort picker showed `n/a`.
 *
 * Pure and process-agnostic (the bun probe feeds it stdout; persistence
 * hydration and `buildModelOptions` also call `normalizeAntigravityDiscovered`
 * so any already-persisted flat `modelCatalog:kind:antigravity` cache groups
 * immediately on restart without requiring a manual refresh).
 */

import type { DiscoveredModel } from "./model-options.ts";
import { sanitizeCliLabel } from "./model-display.ts";
import { ANTIGRAVITY_MODEL_SPECS } from "./types.ts";

/** Effort tokens a flat id may end with, mapped to agetor's effort ids.
 *  Ordered longest-first so `extra-high` and `xhigh` match before `high`. */
const EFFORT_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ["extra-high", "xhigh"],
  ["xhigh", "xhigh"],
  ["medium", "medium"],
  ["minimal", "minimal"],
  ["high", "high"],
  ["low", "low"],
  ["max", "max"],
  ["none", "none"],
];

/** Parenthesized effort labels `agy models` prints, e.g. `(XHigh)`, `(High)`. */
const EFFORT_PAREN_LABEL: Readonly<Record<string, RegExp>> = {
  xhigh: /\(\s*(?:extra[ -]high|x-?high)\s*\)/i,
  high: /\(\s*high\s*\)/i,
  medium: /\(\s*medium\s*\)/i,
  low: /\(\s*low\s*\)/i,
  max: /\(\s*max\s*\)/i,
  none: /\(\s*none\s*\)/i,
  minimal: /\(\s*minimal\s*\)/i,
};

/** Bare effort words if a label omits parentheses. */
const EFFORT_WORD_LABEL: Readonly<Record<string, RegExp>> = {
  xhigh: /\b(?:extra[ -]high|x-?high)\b/i,
  high: /\bhigh\b/i,
  medium: /\bmedium\b/i,
  low: /\blow\b/i,
  max: /\bmax\b/i,
  none: /\bnone\b/i,
  minimal: /\bminimal\b/i,
};

const ID_RE = /^[a-z0-9][a-z0-9.\-_]*[a-z0-9]$/i;

let specIndex: Map<string, string> | null = null;

/** flat id → `ANTIGRAVITY_MODEL_SPECS` key, for every id a curated spec covers
 *  (its base key and each effort variant id). */
function specKeyIndex(): Map<string, string> {
  if (specIndex) return specIndex;
  const idx = new Map<string, string>();
  const add = (flat: string, key: string) => {
    if (!idx.has(flat)) idx.set(flat, key);
  };
  for (const [key] of Object.entries(ANTIGRAVITY_MODEL_SPECS)) add(key, key);
  for (const [key, spec] of Object.entries(ANTIGRAVITY_MODEL_SPECS)) {
    for (const variant of Object.values(spec.effortIds ?? {})) {
      if (variant) add(variant, key);
    }
  }
  specIndex = idx;
  return idx;
}

/** The `ANTIGRAVITY_MODEL_SPECS` base key that covers `flatId`, or null. */
export function antigravitySpecKeyFor(flatId: string): string | null {
  return specKeyIndex().get(flatId) ?? null;
}

interface ParsedEntry {
  id: string;
  label: string;
  base: string;
  effort: string | null;
}

function parseEntry(id: string, label: string): ParsedEntry {
  const lower = id.toLowerCase();
  for (const [token, effortId] of EFFORT_TOKENS) {
    if (lower.endsWith(`-${token}`) && id.length > token.length + 1) {
      return {
        id,
        label,
        base: id.slice(0, -(token.length + 1)),
        effort: effortId,
      };
    }
  }
  return { id, label, base: id, effort: null };
}

function baseLabel(label: string, effort: string | null): string {
  if (!label) return "";
  let out = label;
  if (effort) {
    const paren = EFFORT_PAREN_LABEL[effort];
    if (paren && paren.test(out)) {
      out = out.replace(paren, " ");
    } else {
      const word = EFFORT_WORD_LABEL[effort];
      if (word) out = out.replace(word, " ");
    }
  }
  return sanitizeCliLabel(out);
}

/**
 * Group flat `<base>-<effort>` `DiscoveredModel` rows into one base row per
 * model family with `efforts` + `antigravity.effortIds`, while leaving
 * already-grouped rows and effort-less rows (e.g. `gemini-pro-orchestrator*`)
 * intact. Preserves first-seen order and ensures unique ids and labels.
 *
 * Idempotent: calling this on already-grouped rows returns equivalent rows.
 */
export function normalizeAntigravityDiscovered(rows: readonly DiscoveredModel[]): DiscoveredModel[] {
  if (rows.length === 0) return [];

  // Partition already-grouped rows (carry `antigravity.effortIds` or `efforts`)
  // from flat rows that may need grouping.
  const entries: Array<{ kind: "grouped"; row: DiscoveredModel } | { kind: "flat"; parsed: ParsedEntry; row: DiscoveredModel }> = [];
  const flatGroups = new Map<string, Array<{ parsed: ParsedEntry; row: DiscoveredModel }>>();

  for (const row of rows) {
    const hasGroupedData =
      (row.antigravity?.effortIds && Object.keys(row.antigravity.effortIds).length > 0) ||
      (row.efforts !== undefined && row.efforts.length > 0);
    if (hasGroupedData) {
      entries.push({ kind: "grouped", row });
      continue;
    }
    const parsed = parseEntry(row.id, row.label ? sanitizeCliLabel(row.label) : "");
    entries.push({ kind: "flat", parsed, row });
    const g = flatGroups.get(parsed.base);
    if (g) g.push({ parsed, row });
    else flatGroups.set(parsed.base, [{ parsed, row }]);
  }

  const out: DiscoveredModel[] = [];
  const usedIds = new Set<string>();
  const usedLabels = new Set<string>();
  const push = (row: DiscoveredModel) => {
    if (usedIds.has(row.id)) return;
    usedIds.add(row.id);
    if (row.label) {
      if (usedLabels.has(row.label.toLowerCase())) {
        row = { ...row, label: `${row.label} (${row.id})` };
      }
      usedLabels.add(row.label!.toLowerCase());
    }
    out.push(row);
  };

  const emittedBases = new Set<string>();

  for (const item of entries) {
    if (item.kind === "grouped") {
      emittedBases.add(item.row.id);
      push(item.row);
      continue;
    }
    const key = item.parsed.base;
    if (emittedBases.has(key)) continue;
    emittedBases.add(key);

    const group = flatGroups.get(key) ?? [{ parsed: item.parsed, row: item.row }];
    const withEffort = group.filter((g) => g.parsed.effort !== null);
    if (withEffort.length === 0) {
      for (const g of group) {
        const label = g.parsed.label || undefined;
        push({
          ...g.row,
          ...(label !== undefined ? { label } : {}),
        });
      }
      continue;
    }

    const effortIds: Record<string, string> = {};
    const efforts: string[] = [];
    for (const g of withEffort) {
      const effort = g.parsed.effort as string;
      if (!effortIds[effort]) {
        effortIds[effort] = g.parsed.id;
        efforts.push(effort);
      }
    }
    const bareRow = group.find((g) => g.parsed.effort === null && g.parsed.id === key);
    const source = bareRow ?? withEffort[0]!;
    const stripped = bareRow
      ? bareRow.parsed.label
      : baseLabel(source.parsed.label, source.parsed.effort);
    const curatedLabel = ANTIGRAVITY_MODEL_SPECS[key]?.label;
    const label = stripped || curatedLabel || undefined;

    const grouped: DiscoveredModel = {
      id: key,
      ...(label !== undefined ? { label } : {}),
      ...(source.row.description ? { description: source.row.description } : {}),
      efforts,
      antigravity: { effortIds },
    };
    push(grouped);
  }

  return out;
}

/**
 * Parse `agy models` stdout into grouped base models with effort ladders.
 * Never throws; spinner lines (`Fetching available models...`), ANSI escapes,
 * carriage-return frames and unparseable lines are safely stripped or skipped.
 */
export function parseAntigravityModelList(stdout: string): DiscoveredModel[] {
  const flat: DiscoveredModel[] = [];
  const seen = new Set<string>();
  // eslint-disable-next-line no-control-regex
  const clean = stdout.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
  for (const rawLine of clean.split("\n")) {
    // Handle TTY spinner frames separated by `\r` on the first line (e.g.
    // `\r⠋ Fetching available models...\rgemini-4-neon-high  Gemini 4 Neon (High)`).
    const segments = rawLine.split("\r").map((s) => s.trim()).filter(Boolean);
    const line = segments[segments.length - 1] ?? "";
    if (!line) continue;
    if (line.includes("Fetching available models")) continue;
    const parts = line.split(/\s+/);
    const id = parts[0]!;
    if (!ID_RE.test(id)) continue;
    if (!id.includes("-")) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const rawLabel = parts.slice(1).join(" ").trim();
    const label = rawLabel.length > 0 ? sanitizeCliLabel(rawLabel) : "";
    flat.push({
      id,
      ...(label.length > 0 ? { label } : {}),
    });
  }
  return normalizeAntigravityDiscovered(flat);
}

/**
 * Which base/effort a stored flat Antigravity variant id means. Checks the
 * discovered rows' variant maps first (normalizing flat rows if needed), then
 * the curated `ANTIGRAVITY_MODEL_SPECS`. Null for an id neither knows.
 */
export function antigravityVariantOf(
  flatId: string,
  rows: readonly DiscoveredModel[],
): { base: string; effort: string; label?: string } | null {
  const normalized = normalizeAntigravityDiscovered(rows);
  for (const row of normalized) {
    const effortIds = row.antigravity?.effortIds;
    if (!effortIds) continue;
    for (const [effort, variant] of Object.entries(effortIds)) {
      if (variant === flatId) {
        return { base: row.id, effort, ...(row.label ? { label: row.label } : {}) };
      }
    }
  }
  const key = antigravitySpecKeyFor(flatId);
  if (key && key !== flatId) {
    const spec = ANTIGRAVITY_MODEL_SPECS[key];
    for (const [effort, variant] of Object.entries(spec?.effortIds ?? {})) {
      if (variant === flatId) {
        return { base: key, effort, label: spec?.label ?? key };
      }
    }
  }
  return null;
}

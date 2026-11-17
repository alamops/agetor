/**
 * Turns `cursor-agent --list-models` / `models` output (one `id - Label` line
 * per flat variant, grammar `<base>[-thinking][-<effort>][-fast]`) into the
 * picker's model rows: one row per base model with its effort ladder and
 * Fast twin, instead of 280 flat ids (dynamic-model-catalog #18).
 *
 * Pure and process-agnostic (the bun probe feeds it stdout; the picker's
 * read-time normalization asks `cursorVariantOf`). The curated
 * `CURSOR_MODEL_SPECS` stay authoritative: an id a spec covers collapses to
 * the spec's own key with no discovered fields, so the spec's variant map,
 * label and hint keep winning. Only families no spec covers are grouped
 * from the flat ids, and an id the grammar cannot place stays a plain row.
 */

import type { DiscoveredModel } from "./model-options.ts";
import { sanitizeCliLabel } from "./model-display.ts";
import { CURSOR_MODEL_SPECS } from "./types.ts";

/** Effort tokens a flat id may end with, mapped to agetor's effort ids. */
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

/** Label words each effort shows as; stripped from the base label. */
const EFFORT_LABEL_WORDS: Readonly<Record<string, RegExp>> = {
  xhigh: /\b(?:extra[ -]high|x-?high)\b/i,
  high: /\bhigh\b/i,
  medium: /\bmedium\b/i,
  low: /\blow\b/i,
  max: /\bmax\b/i,
  none: /\bnone\b/i,
  minimal: /\bminimal\b/i,
};

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

let specIndex: Map<string, string> | null = null;

/** flat id → `CURSOR_MODEL_SPECS` key, for every id a spec covers (its key,
 *  `fastId`, each effort variant and the variant's `-fast` twin). */
function specKeyIndex(): Map<string, string> {
  if (specIndex) return specIndex;
  const idx = new Map<string, string>();
  const add = (flat: string, key: string) => {
    if (!idx.has(flat)) idx.set(flat, key);
  };
  for (const [key, spec] of Object.entries(CURSOR_MODEL_SPECS)) add(key, key);
  for (const [key, spec] of Object.entries(CURSOR_MODEL_SPECS)) {
    if (spec.fastId) add(spec.fastId, key);
    for (const variant of Object.values(spec.effortIds ?? {})) {
      if (!variant) continue;
      add(variant, key);
      add(`${variant}-fast`, key);
    }
  }
  specIndex = idx;
  return idx;
}

/** The `CURSOR_MODEL_SPECS` key that covers `flatId`, or null. */
export function cursorSpecKeyFor(flatId: string): string | null {
  return specKeyIndex().get(flatId) ?? null;
}

interface ParsedVariant {
  id: string;
  label: string;
  base: string;
  effort: string | null;
  fast: boolean;
}

function parseVariant(id: string, label: string): ParsedVariant {
  let rest = id;
  let fast = false;
  if (rest.endsWith("-fast") && rest.length > "-fast".length) {
    fast = true;
    rest = rest.slice(0, -"-fast".length);
  }
  let effort: string | null = null;
  for (const [token, effortId] of EFFORT_TOKENS) {
    if (rest.endsWith(`-${token}`) && rest.length > token.length + 1) {
      effort = effortId;
      rest = rest.slice(0, -(token.length + 1));
      break;
    }
  }
  return { id, label, base: rest, effort, fast };
}

function baseLabel(label: string, effort: string | null, fast: boolean): string {
  let out = label;
  if (fast) out = out.replace(/\bfast\b/i, " ");
  if (effort) {
    const re = EFFORT_LABEL_WORDS[effort];
    if (re) out = out.replace(re, " ");
  }
  return sanitizeCliLabel(out);
}

/** Parse the CLI's model listing. Never throws; an unparseable line is
 *  skipped, an id the grammar cannot group stays a plain row. */
export function parseCursorModelList(stdout: string): DiscoveredModel[] {
  const variants: ParsedVariant[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const sep = line.indexOf(" - ");
    const id = (sep === -1 ? line : line.slice(0, sep)).trim();
    const label = sep === -1 ? "" : sanitizeCliLabel(line.slice(sep + 3));
    // Header ("Available models") and the trailing "Tip: …" line have no
    // `id - label` shape or fail the id grammar.
    if (sep === -1 || !ID_RE.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    variants.push(parseVariant(id, label));
  }

  // Group the ids no spec covers by parsed base (first-seen order).
  const groups = new Map<string, ParsedVariant[]>();
  for (const v of variants) {
    if (cursorSpecKeyFor(v.id)) continue;
    // A new variant of a spec'd base (e.g. a fresh `grok-4.7-max`) is not in
    // the spec's variant map, so grouping it would fight the spec: it stays a
    // plain row of its own (emitted in the main loop below).
    if (CURSOR_MODEL_SPECS[v.base]) continue;
    const g = groups.get(v.base);
    if (g) g.push(v);
    else groups.set(v.base, [v]);
  }

  const out: DiscoveredModel[] = [];
  const usedIds = new Set<string>();
  const usedLabels = new Set<string>();
  const push = (row: DiscoveredModel) => {
    if (usedIds.has(row.id)) return;
    usedIds.add(row.id);
    if (row.label) {
      // Two rows never share a label: disambiguate by id.
      if (usedLabels.has(row.label.toLowerCase())) row.label = `${row.label} (${row.id})`;
      usedLabels.add(row.label.toLowerCase());
    }
    out.push(row);
  };
  const emitted = new Set<string>();

  for (const v of variants) {
    const specKey = cursorSpecKeyFor(v.id);
    if (specKey) {
      push({ id: specKey });
      continue;
    }
    if (CURSOR_MODEL_SPECS[v.base]) {
      // A variant of a spec'd base the spec does not list stays a plain row.
      push({ id: v.id, label: v.label || v.id });
      continue;
    }
    const key = v.base;
    if (emitted.has(key)) continue;
    emitted.add(key);
    const group = groups.get(key) ?? [v];
    const withEffort = group.filter((g) => g.effort !== null);
    if (withEffort.length === 0) {
      // No effort ladder: a plain row, plus a Fast twin when one exists.
      const bare = group.find((g) => !g.fast && g.id === key);
      const fastTwin = group.find((g) => g.fast);
      if (bare && fastTwin) {
        push({ id: key, label: bare.label || key, fast: true, cursor: { fastId: fastTwin.id } });
      } else {
        // A single plain id, or a lone `-fast` id with no bare twin: plain
        // rows keyed by the real ids so nothing is lost.
        for (const g of group) push({ id: g.id, label: g.label || g.id });
      }
      continue;
    }
    const effortIds: Record<string, string> = {};
    const fastEfforts: string[] = [];
    const efforts: string[] = [];
    for (const g of withEffort) {
      const effort = g.effort as string;
      if (!g.fast) {
        if (!effortIds[effort]) {
          effortIds[effort] = g.id;
          efforts.push(effort);
        }
      } else if (!fastEfforts.includes(effort)) {
        fastEfforts.push(effort);
      }
    }
    // A fast-only effort (no non-fast twin) still belongs to the ladder.
    for (const g of withEffort) {
      const effort = g.effort as string;
      if (!efforts.includes(effort)) efforts.push(effort);
    }
    const source = withEffort[0] as ParsedVariant;
    const label = baseLabel(source.label, source.effort, source.fast) || key;
    const row: DiscoveredModel = { id: key, label, efforts };
    const cursor: NonNullable<DiscoveredModel["cursor"]> = {
      effortIds,
      ...(fastEfforts.length > 0 ? { fastEfforts } : {}),
    };
    row.cursor = cursor;
    if (fastEfforts.length > 0) row.fast = true;
    push(row);
    // The bare id of the family (a default variant) is the base itself; any
    // other id of the group the grammar did not place was already a row.
    for (const g of group) {
      if (g.effort === null && !g.fast && g.id !== key) push({ id: g.id, label: g.label || g.id });
    }
  }
  return out;
}

/**
 * Which base/effort/Fast a stored flat variant id means. Looks in the
 * discovered rows' variant maps first, then in the curated specs. Null for an
 * id neither knows.
 */
export function cursorVariantOf(
  flatId: string,
  rows: readonly DiscoveredModel[],
): { base: string; effort: string | null; fast: boolean; label?: string } | null {
  for (const row of rows) {
    const c = row.cursor;
    if (!c) continue;
    if (c.fastId === flatId) return { base: row.id, effort: null, fast: true, ...(row.label ? { label: row.label } : {}) };
    for (const [effort, variant] of Object.entries(c.effortIds ?? {})) {
      if (!variant) continue;
      if (variant === flatId) return { base: row.id, effort, fast: false, ...(row.label ? { label: row.label } : {}) };
      if (`${variant}-fast` === flatId) return { base: row.id, effort, fast: true, ...(row.label ? { label: row.label } : {}) };
    }
  }
  const key = cursorSpecKeyFor(flatId);
  if (key && key !== flatId) {
    const spec = CURSOR_MODEL_SPECS[key];
    if (spec?.fastId === flatId) return { base: key, effort: null, fast: true, label: spec.label };
    for (const [effort, variant] of Object.entries(spec?.effortIds ?? {})) {
      if (!variant) continue;
      if (variant === flatId) return { base: key, effort, fast: false, label: spec?.label ?? key };
      if (`${variant}-fast` === flatId) return { base: key, effort, fast: true, label: spec?.label ?? key };
    }
  }
  return null;
}

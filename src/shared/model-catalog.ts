/**
 * The one composition layer between a harness CLI's own model catalog and
 * everything that shows or checks a model: the New Task form, the task
 * editor, launch pickers, `agetor add`, bundles, pre-flight and harness-stack
 * failover. Before this module five call sites each re-implemented "merge
 * curated with discovered, then filter cursor's flat variants"; they all
 * call these helpers now (dynamic-model-catalog §7 invariants).
 *
 * Pure and process-agnostic: the caller passes in the discovered rows it
 * has (the webview and CLI from `GET /agent-models*`, the core from its
 * discovery cache) plus the harness's login state.
 */

import { antigravityVariantOf, normalizeAntigravityDiscovered } from "./antigravity-catalog.ts";
import { cursorSpecKeyFor, cursorVariantOf } from "./cursor-catalog.ts";
import { sanitizeCliLabel } from "./model-display.ts";
import {
  discoveredEffortsFor,
  mergeModelOptions,
  type DiscoveredModel,
  type ModelOption,
} from "./model-options.ts";
import { supportedSpeeds } from "./speed.ts";
import {
  AGENT_OPTIONS,
  ANTIGRAVITY_MODEL_SPECS,
  CATALOG_SCOPED_KINDS,
  CURSOR_MODEL_SPECS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORT_OPTIONS,
  retainableEfforts,
  supportedEfforts,
  type AgentKind,
  type AgentOption,
  type Speed,
} from "./types.ts";

/** Kinds whose CLI catalog is authoritative for what the installed build can
 *  run, so a model it does not list is refused up front (`modelCatalogVerdict`).
 *  Claude is excluded on purpose: its list is account-independent but the CLI
 *  also accepts ids it does not list. */
export const CLI_AUTHORITATIVE_CATALOG_KINDS: ReadonlySet<AgentKind> = new Set<AgentKind>(["codex", "copilot"]);

const CURSOR_VARIANT_HINT = "Saved as a specific variant — pick the base model to change its effort";
/** The hint on a stored model id the installed CLI's own list no longer carries. */
const NOT_IN_CLI_LIST_HINT = "Not in this CLI's model list — pick another model, or update the CLI if it is newer";

/** A discovered catalog is trusted unless the harness is known logged out. */
function trusted(discovered: readonly DiscoveredModel[], loggedIn: boolean | null | undefined): boolean {
  return loggedIn !== false && discovered.length > 0;
}

/** Drop cursor rows that are a flat variant a curated spec already covers
 *  (an older catalog, or a custom caller, may still carry them). */
function withoutSpecCoveredVariants(discovered: readonly DiscoveredModel[]): DiscoveredModel[] {
  return discovered.filter((m) => {
    const key = cursorSpecKeyFor(m.id);
    return key === null || key === m.id;
  });
}

/**
 * For a kind whose CLI catalog is authoritative (codex, copilot) and a trusted,
 * non-empty catalog, drop every row the catalog lacks: the merge appends the
 * curated rows the CLI did not list (rule 4), but pre-flight and failover
 * refuse exactly those models (`modelCatalogVerdict`), so offering them would
 * list rows guaranteed to fail. A pinned row stays, and so does the `selected`
 * id (a stored task's model), as an unlisted row with an honest hint. Every
 * other kind and every untrusted catalog passes through unchanged.
 * Invariant (pinned by a test): no non-unlisted row of such a kind has verdict
 * `missing`.
 */
function withoutRefusedCuratedRows(
  kind: AgentKind,
  rows: ModelOption[],
  discovered: readonly DiscoveredModel[],
  loggedIn: boolean | null | undefined,
  selected: string | null,
): ModelOption[] {
  if (!CLI_AUTHORITATIVE_CATALOG_KINDS.has(kind) || !trusted(discovered, loggedIn)) return rows;
  const pinned = new Set(AGENT_OPTIONS[kind].models.filter((m) => m.pinned).map((m) => m.id));
  const out: ModelOption[] = [];
  for (const row of rows) {
    if (row.unlisted || pinned.has(row.id) || modelCatalogVerdict(kind, row.id, discovered, loggedIn) !== "missing") {
      out.push(row);
    } else if (row.id === selected) {
      out.push({ id: row.id, label: row.label, hint: NOT_IN_CLI_LIST_HINT, unlisted: true });
    }
  }
  return out;
}

/**
 * The picker rows for `kind`: curated rows merged with the discovered
 * catalog by `mergeModelOptions` (CLI order for unscoped kinds, curated
 * label/hint as overlay). For cursor, a `selected` flat variant id (an older
 * task, or one set through the CLI) is shown as one unlisted row carrying
 * its base model's label and a "pick the base model to change its effort"
 * hint — a read-time normalization, never a stored-data migration.
 */
export function buildModelOptions(
  kind: AgentKind,
  input: {
    discovered: readonly DiscoveredModel[];
    selected?: string | null;
    loggedIn?: boolean | null;
  },
): ModelOption[] {
  const discovered =
    kind === "cursor"
      ? withoutSpecCoveredVariants(input.discovered)
      : kind === "antigravity"
        ? normalizeAntigravityDiscovered(input.discovered)
        : input.discovered;
  const merged = mergeModelOptions({
    curated: AGENT_OPTIONS[kind].models,
    discovered,
    scoped: CATALOG_SCOPED_KINDS.has(kind),
    selected: input.selected ?? null,
    ...(input.loggedIn !== undefined ? { loggedIn: input.loggedIn } : {}),
  });
  const rows = withoutRefusedCuratedRows(kind, merged, discovered, input.loggedIn, input.selected ?? null);
  if ((kind !== "cursor" && kind !== "antigravity") || !input.selected) return rows;
  const idx = rows.findIndex((r) => r.id === input.selected && r.unlisted);
  if (idx < 0) return rows;
  if (kind === "antigravity") {
    const variant = antigravityVariantOf(input.selected, discovered);
    if (!variant) return rows;
    const effort = EFFORT_OPTIONS.find((o) => o.id === variant.effort)?.label ?? variant.effort;
    const label = sanitizeCliLabel([variant.label ?? variant.base, effort].filter(Boolean).join(" "));
    const row = rows[idx] as ModelOption;
    rows[idx] = { ...row, label: label || row.label, hint: CURSOR_VARIANT_HINT };
    return rows;
  }
  const variant = cursorVariantOf(input.selected, input.discovered);
  if (!variant) return rows;
  const effort = variant.effort ? (EFFORT_OPTIONS.find((o) => o.id === variant.effort)?.label ?? variant.effort) : null;
  const label = sanitizeCliLabel([variant.label ?? variant.base, effort, variant.fast ? "Fast" : null].filter(Boolean).join(" "));
  const row = rows[idx] as ModelOption;
  rows[idx] = { ...row, label: label || row.label, hint: CURSOR_VARIANT_HINT };
  return rows;
}

function rowFor(rows: readonly ModelOption[], model: string | null | undefined): ModelOption | undefined {
  return model ? rows.find((r) => r.id === model) : undefined;
}

/** The effort rows a model offers, from its merged picker row. */
export function effortOptionsFor(kind: AgentKind, model: string | null, rows: readonly ModelOption[]): AgentOption[] {
  const row = rowFor(rows, model);
  return supportedEfforts(kind, model, discoveredEffortsFor(rows, model), row?.effortLabels ? { labels: row.effortLabels } : undefined);
}

/** Effort ids a task's current effort may keep when it moves to `model`
 *  (`retainableEfforts` over the merged rows). */
export function retainableEffortsFor(
  kind: AgentKind,
  model: string | null,
  rows: readonly ModelOption[],
  current?: string | null,
): ReadonlySet<string> {
  return retainableEfforts(kind, model, discoveredEffortsFor(rows, model), current);
}

/** The Speed tiers `model` offers, from its merged picker row. */
export function speedOptionsFor(
  kind: AgentKind,
  model: string | null,
  effort: string | null,
  rows: readonly ModelOption[],
): Speed[] {
  const row = rowFor(rows, model);
  return supportedSpeeds(
    kind,
    model,
    effort,
    row
      ? {
          ...(row.fast ? { fast: true } : {}),
          ...(row.ultrafast ? { ultrafast: true } : {}),
          ...(row.cursor ? { cursor: row.cursor } : {}),
        }
      : undefined,
  );
}

/**
 * The explanatory text a Speed control shows under itself: the CLI's own cost
 * description for Fast where it reports one (codex service tier), agetor's
 * own line where it does not (claude), and a note on a model whose own
 * default tier is already a fast one (Off then passes nothing, so that
 * default applies). Empty for every other case.
 */
export function speedNoticeFor(
  kind: AgentKind,
  model: string | null,
  speed: Speed,
  rows: readonly ModelOption[],
): { fastHint?: string; note?: string } {
  const row = rowFor(rows, model);
  if (speed === "fast") {
    if (kind === "codex") return { fastHint: row?.fastHint ?? "Faster service tier — uses more of your usage." };
    if (kind === "claude-code") return { fastHint: "Claude's Fast mode — faster output at a higher usage rate." };
    return {};
  }
  if (kind === "codex" && row?.defaultFast === true) return { note: "This model's default tier applies." };
  return {};
}

/**
 * Whether the Speed tiers on offer are known yet. Cursor derives them from
 * its own variant specs, so always; fx, codex and claude learn them from
 * discovery, so only once a trusted catalog has loaded. Until then a form
 * must not reset a remembered Fast to Off.
 */
export function speedTiersKnown(
  kind: AgentKind,
  discovered: readonly DiscoveredModel[],
  loggedIn: boolean | null | undefined,
): boolean {
  if (kind === "cursor") return true;
  if (kind === "fx" || kind === "codex" || kind === "claude-code") return trusted(discovered, loggedIn);
  return false;
}

/**
 * The model a new task starts on: the owner's pick (`DEFAULT_MODEL`) unless
 * a trusted catalog is loaded and does not list it, in which case the CLI's
 * own default model (`cliDefault`) when it has one.
 */
export function resolveDefaultModel(
  kind: AgentKind,
  discovered: readonly DiscoveredModel[],
  loggedIn: boolean | null | undefined,
): string {
  const pick = DEFAULT_MODEL[kind];
  if (!trusted(discovered, loggedIn)) return pick;
  if (discovered.some((m) => m.id === pick)) return pick;
  return discovered.find((m) => m.cliDefault === true)?.id ?? pick;
}

/**
 * The effort a model starts on: the owner's pick when offered, else the CLI's
 * own default effort for the model, else the first offered effort, else null
 * (the model takes no effort).
 */
export function resolveDefaultEffort(kind: AgentKind, model: string | null, rows: readonly ModelOption[]): string | null {
  const offered = effortOptionsFor(kind, model, rows).map((o) => o.id);
  if (offered.length === 0) return null;
  const pick = DEFAULT_EFFORT[kind];
  if (pick && offered.includes(pick)) return pick;
  const cliDefault = rowFor(rows, model)?.defaultEffort;
  if (cliDefault && offered.includes(cliDefault)) return cliDefault;
  return offered[0] ?? null;
}

/** A remembered model id is a usable seed when the curated list or the loaded
 *  catalog (not just an unlisted placeholder) carries it; else null. */
export function resolveSeedModel(
  kind: AgentKind,
  stored: string | null | undefined,
  rows: readonly ModelOption[],
): string | null {
  if (!stored) return null;
  // For a CLI-authoritative kind the loaded rows alone decide: a curated row
  // the CLI's catalog lacks is dropped from them, and must not seed.
  if (!CLI_AUTHORITATIVE_CATALOG_KINDS.has(kind) && AGENT_OPTIONS[kind].models.some((m) => m.id === stored)) return stored;
  return rows.some((r) => r.id === stored && !r.unlisted) ? stored : null;
}

/** What a form does with a remembered model it has not applied yet. */
export type SeedModelStep =
  /** Nothing decisive yet (no catalog, or a logged-out harness): keep waiting. */
  | { action: "wait" }
  /** Start on `model`. `confirmed` is false while only the frozen curated rows
   *  vouch for it (a CLI-authoritative kind before its trusted catalog lands):
   *  the caller applies it now but keeps the seed until the catalog confirms. */
  | { action: "apply"; model: string; confirmed: boolean }
  /** A trusted catalog is loaded and lacks it (a retired or too-new id): start
   *  on the default model instead of one that cannot run. */
  | { action: "default" };

/**
 * Decide what to do with a remembered `lastModel:<kind>` as the catalog
 * loads. For a CLI-authoritative kind (codex, copilot) a curated row proves
 * nothing until a trusted catalog lists the model, so the seed is applied
 * early but stays `confirmed: false`, and is re-judged when the catalog lands.
 */
export function seedModelStep(
  kind: AgentKind,
  stored: string,
  rows: readonly ModelOption[],
  discovered: readonly DiscoveredModel[],
  loggedIn: boolean | null | undefined,
): SeedModelStep {
  const catalogTrusted = trusted(discovered, loggedIn);
  const ok = resolveSeedModel(kind, stored, rows);
  if (ok) return { action: "apply", model: ok, confirmed: !CLI_AUTHORITATIVE_CATALOG_KINDS.has(kind) || catalogTrusted };
  return catalogTrusted ? { action: "default" } : { action: "wait" };
}

/** Every model id a bundle, import or pre-check should treat as real for the
 *  harness: the merged picker ids plus, for cursor, every flat variant id. */
export function knownModelIds(
  kind: AgentKind,
  discovered: readonly DiscoveredModel[],
  loggedIn: boolean | null | undefined,
): string[] {
  const ids = new Set(buildModelOptions(kind, { discovered, loggedIn }).map((r) => r.id));
  if (kind === "cursor") {
    for (const spec of Object.values(CURSOR_MODEL_SPECS)) {
      if (spec.fastId) ids.add(spec.fastId);
      for (const variant of Object.values(spec.effortIds ?? {})) {
        if (!variant) continue;
        ids.add(variant);
        ids.add(`${variant}-fast`);
      }
    }
    if (loggedIn !== false) {
      for (const m of discovered) {
        if (m.cursor?.fastId) ids.add(m.cursor.fastId);
        for (const variant of Object.values(m.cursor?.effortIds ?? {})) {
          if (!variant) continue;
          ids.add(variant);
          ids.add(`${variant}-fast`);
        }
      }
    }
  } else if (kind === "antigravity") {
    for (const spec of Object.values(ANTIGRAVITY_MODEL_SPECS)) {
      for (const variant of Object.values(spec.effortIds ?? {})) {
        if (variant) ids.add(variant);
      }
    }
    if (loggedIn !== false) {
      for (const m of normalizeAntigravityDiscovered(discovered)) {
        for (const variant of Object.values(m.antigravity?.effortIds ?? {})) {
          if (variant) ids.add(variant);
        }
      }
    }
  }
  return [...ids];
}

/**
 * What the CLI's own catalog says about `model`, for the kinds whose catalog
 * is authoritative: `offered`, `missing` (a non-empty, trusted catalog that
 * lacks it) or `unknown` (nothing to judge by: another kind, logged out,
 * empty discovery). Copilot's `auto` router is never in a catalog and is
 * always offered. `unknown` is the caller's cue to fall back to the frozen
 * `MODEL_MIN_CLI_VERSION` table.
 */
export function modelCatalogVerdict(
  kind: AgentKind,
  model: string,
  discovered: readonly DiscoveredModel[],
  loggedIn: boolean | null | undefined,
): "offered" | "missing" | "unknown" {
  if (!CLI_AUTHORITATIVE_CATALOG_KINDS.has(kind)) return "unknown";
  if (kind === "copilot" && model === "auto") return "offered";
  if (!trusted(discovered, loggedIn)) return "unknown";
  return discovered.some((m) => m.id === model) ? "offered" : "missing";
}

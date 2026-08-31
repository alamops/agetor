/**
 * Pure merge of a kind's curated model list with whatever its CLI's own
 * catalog discovery surfaced, producing the single list every model picker
 * (New Task form, task-details editor, CLI `agetor add`) renders. Kept free
 * of any runtime import from either process side, per the shared-module
 * convention (see `src/shared/types.ts`) — this is the same "leaf" contract
 * `src/shared/todo-progress.ts` follows, and for the same reason: the CLI
 * only imports from `src/shared`, so a helper placed here serves all three
 * callers without duplicating the merge logic three times.
 *
 * Deliberately structural rather than importing `AgentOption`/`AgentKind`
 * from `./types.ts`: this module is implemented alongside a concurrent
 * change to `types.ts` (adding `AgentOption.catalogOnly` and
 * `CATALOG_SCOPED_KINDS`), so depending on those symbols would couple this
 * file's compile success to that file's landing order. Callers pass
 * `scoped` as a plain boolean (computed from `CATALOG_SCOPED_KINDS` on
 * their side) instead of this module reaching for the kind itself.
 *
 * The merge rules (see `docs/plans/fx-model-catalog-refresh.md` §3 D3):
 *
 * 1. A curated row marked `catalogOnly` is included **iff** `discovered`
 *    positively contains its id — never on the discovery-empty fallback
 *    (rule 2), regardless of `scoped`. This is what lets a premium-tier
 *    curated row hide itself for an account whose catalog doesn't carry it.
 * 2. `discovered.length === 0` (CLI not installed / probe failed / catalog
 *    not fetched yet) → every non-`catalogOnly` curated row, in curated
 *    order. This reproduces today's (pre-discovery) picker behavior.
 * 3. `scoped === true` (the kind's catalog is account-scoped, e.g. fx) and
 *    `discovered` is non-empty → curated rows filtered down to those whose
 *    id is also in `discovered` (curated order, labels/hints kept — this
 *    already satisfies rule 1 for `catalogOnly` rows, since a filtered-in
 *    row is by definition in `discovered`), followed by the discovered ids
 *    that had no curated row, in discovered order, labeled `m.label ?? m.id`.
 * 4. `scoped === false` and `discovered` is non-empty → every curated row
 *    (rule 1 still gates `catalogOnly` ones), followed by discovered-only
 *    ids the same way as rule 3. This is the unchanged behavior the
 *    NewTaskForm/RunPanel merge sites had before per-kind scoping existed.
 * 5. The result is always deduped by id, first occurrence wins (curated
 *    rows are considered before discovered ones, so a curated label/hint
 *    always beats a bare discovered id for the same model).
 * 6. If `selected` is a non-empty string absent from the result, it is
 *    appended last as an `unlisted` row — a `<select>` whose current value
 *    has no matching `<option>` renders blank, so the selected id must
 *    always be representable even when it fell out of both lists (a stale
 *    task.model no longer in this account's catalog, for instance).
 * 7. `loggedIn === false` distrusts `discovered` entirely — it is treated as
 *    empty (rule 2's fallback) regardless of how many ids it actually
 *    carries. This exists because a harness's catalog discovery can be
 *    *passive* (no fresh auth round-trip): an expired fx login's discovery
 *    still reads back the last-known catalog, which for fx specifically is
 *    the unauthenticated one (premium ids included, see `HarnessStatus`) —
 *    a logged-out account has no business being offered rows it can't
 *    actually run. Rule 6's selected-unlisted append still applies on top
 *    of this fallback, same as any other discovery-empty case.
 *
 * Inputs are never mutated; a new array is always returned.
 */

/** A row from a kind's curated `AGENT_OPTIONS[kind].models` list — mirrors
 *  the shape of `AgentOption` in `./types.ts` structurally rather than by
 *  import (see module doc comment). */
export interface CuratedModel {
  id: string;
  label: string;
  hint?: string;
  /** True for a row that should only be offered when the harness's
   *  discovered catalog positively contains it (see rule 1). */
  catalogOnly?: boolean;
}

/** A row from a harness's live CLI-discovered model catalog. */
export interface DiscoveredModel {
  id: string;
  label?: string;
}

/** One row in the merged, render-ready model list. */
export interface ModelOption {
  id: string;
  label: string;
  hint?: string;
  /** True when `selected` wasn't in curated ∪ discovered and was appended
   *  so the `<select>` keeps a valid value (rule 6). */
  unlisted?: boolean;
}

export interface MergeModelOptionsInput {
  curated: readonly CuratedModel[];
  discovered: readonly DiscoveredModel[];
  /** Currently selected id (`task.model` / form state); kept visible even
   *  if it isn't in curated ∪ discovered (rule 6). */
  selected?: string | null;
  /** True for kinds whose CLI catalog is account-scoped
   *  (`CATALOG_SCOPED_KINDS`, i.e. fx today): curated rows are filtered
   *  down to the discovered set (rule 3) instead of being shown wholesale
   *  (rule 4). */
  scoped: boolean;
  /** Login state of the harness whose account produced `discovered`
   *  (`HarnessStatus.loggedIn`). `false` ⇒ the discovered catalog is
   *  untrustworthy — e.g. an expired fx login's passive discovery reads
   *  back the UNAUTHENTICATED catalog (premium ids included) — so it is
   *  treated exactly as discovery-empty: non-`catalogOnly` curated rows
   *  only, discovered-only rows dropped, the selected-unlisted rule still
   *  applies (rule 7). `true`/`null`/`undefined` ⇒ behavior unchanged
   *  (`null` = no login probe for this kind — stubs, non-fx kinds). */
  loggedIn?: boolean | null;
}

/** True when the harness's CLI surfaced a non-empty discovered catalog —
 *  the gate between the discovery-empty fallback (rule 2) and the
 *  scoped/unscoped merge branches (rules 3–4). */
export function hasDiscoveredCatalog(discovered: readonly DiscoveredModel[]): boolean {
  return discovered.length > 0;
}

function toCuratedOption(m: CuratedModel): ModelOption {
  const opt: ModelOption = { id: m.id, label: m.label };
  if (m.hint !== undefined) opt.hint = m.hint;
  return opt;
}

function toDiscoveredOnlyOption(m: DiscoveredModel): ModelOption {
  return { id: m.id, label: m.label ?? m.id };
}

/** Merges a kind's curated model list with its CLI-discovered catalog per
 *  the rules documented above. See `docs/plans/fx-model-catalog-refresh.md`
 *  §3 D3 for the design rationale. */
export function mergeModelOptions(input: MergeModelOptionsInput): ModelOption[] {
  const { curated, selected, scoped } = input;
  // Rule 7: a logged-out harness's discovered catalog is untrustworthy —
  // distrust it wholesale by falling through to the discovery-empty path,
  // same as if the CLI had surfaced nothing at all.
  const discovered = input.loggedIn === false ? [] : input.discovered;

  const result: ModelOption[] = [];
  const seen = new Set<string>();

  const pushCurated = (m: CuratedModel) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    result.push(toCuratedOption(m));
  };

  const pushDiscoveredOnly = (m: DiscoveredModel) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    result.push(toDiscoveredOnlyOption(m));
  };

  if (!hasDiscoveredCatalog(discovered)) {
    // Rule 2: discovery-empty fallback — non-catalogOnly curated rows only,
    // curated order. Rule 1 excludes catalogOnly rows unconditionally here.
    for (const m of curated) {
      if (m.catalogOnly) continue;
      pushCurated(m);
    }
  } else if (scoped) {
    // Rule 3: curated ∩ discovered (curated order), then discovered-only
    // ids (discovered order). Filtering to "id in discovered" already
    // satisfies rule 1 for catalogOnly rows.
    const discoveredIds = new Set(discovered.map((m) => m.id));
    for (const m of curated) {
      if (discoveredIds.has(m.id)) pushCurated(m);
    }
    for (const m of discovered) {
      pushDiscoveredOnly(m);
    }
  } else {
    // Rule 4: all curated rows (rule 1 still gates catalogOnly ones),
    // then discovered-only ids (discovered order).
    const discoveredIds = new Set(discovered.map((m) => m.id));
    for (const m of curated) {
      if (m.catalogOnly && !discoveredIds.has(m.id)) continue;
      pushCurated(m);
    }
    for (const m of discovered) {
      pushDiscoveredOnly(m);
    }
  }

  // Rule 6: keep the selected id representable even if it fell out of
  // both lists.
  if (selected) {
    if (!seen.has(selected)) {
      result.push({
        id: selected,
        label: selected,
        hint: "Not in this account's model catalog",
        unlisted: true,
      });
    }
  }

  return result;
}

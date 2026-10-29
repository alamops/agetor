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
 *    Every new `mergeModelOptions` caller must thread `HarnessStatus.loggedIn`
 *    through — the field is optional only for back-compat ("omitted ⇒
 *    unchanged behavior", same as `true`/`null`); omitting it at a real
 *    picker site silently reproduces the over-show bug this rule exists to
 *    prevent. Note also that rule 7 itself is kind-agnostic — it applies to
 *    any caller that passes `loggedIn`, `scoped` or not — while its
 *    rationale above is fx-specific: a future kind whose logged-out
 *    discovery happened to return a correct catalog would have it discarded
 *    too. That's acceptable: this rule intentionally fails closed on trust
 *    rather than carving out per-kind exceptions.
 *
 * 8. When a row's id has a matching entry in the (rule-7-trusted) `discovered`
 *    list and that entry's `efforts` is a non-empty array, the merged row
 *    carries a fresh copy of it as `ModelOption.efforts`. This applies to
 *    both curated∩discovered rows and discovered-only rows — it is the one
 *    field discovery contributes to an otherwise-curated row; rule 5's
 *    label/hint precedence (curated wins on a shared id) is unchanged. No
 *    row carries `efforts` when rule 7 distrusts `discovered`
 *    (`loggedIn === false`) or `discovered` is empty. The `unlisted` row
 *    appended by rule 6 carries `efforts` too, under the same lookup, when
 *    the trusted `discovered` list has a matching entry. Pickers/CLI read a
 *    row's `efforts` via the `discoveredEffortsFor` helper below, fed this
 *    function's own MERGED output (the `ModelOption[]` returned here) rather
 *    than the raw `discovered` input — `discoveredEffortsFor` has no
 *    visibility into `loggedIn`, so only the merged rows (which already
 *    reflect rule 7's distrust) make rule 8 the single source of truth for
 *    per-model efforts. The looked-up result is handed to `supportedEfforts`
 *    (`./types.ts`) as its third argument, so a CLI-discovered per-model
 *    effort set wins over the curated `MODEL_EFFORT_SUPPORT` table.
 *    The same lookup copies the speed flags (`fast` / `ultrafast`, fx
 *    `models --json` ≥0.0.14) onto every row kind above, but only when the
 *    entry reports them `true` — a `false` or absent flag attaches no key.
 *    Pickers pass a row's flags to `supportedSpeeds` (`./speed.ts`).
 *
 *    One carve-out for `scoped === true`: an entry whose `efforts` is an
 *    explicitly EMPTY array attaches `efforts: []` — "the CLI reported this
 *    model and it has no efforts", which OpenCode's `supportedEfforts`
 *    branch reads differently from "no discovery entry" (`[]` vs `[auto]`,
 *    `docs/plans/add-opencode-harness.md` D-6). fx's discovery never emits
 *    an empty array, and every other kind's `supportedEfforts` treats `[]`
 *    exactly like `null`, so nothing changes outside OpenCode. With
 *    `scoped === false` an empty array still attaches no key.
 *
 * 9. A curated row marked `pinned` is always included, FIRST (in curated
 *    order among pinned rows), whatever rules 1–4 and 7 would say:
 *    discovery empty or non-empty, scoped or not, `loggedIn === false`, and
 *    even with `catalogOnly` set. It is never duplicated — a discovered
 *    entry with the same id only contributes rule 8's fields to it. Used for
 *    OpenCode's "OpenCode default" sentinel (`OPENCODE_DEFAULT_MODEL`, D-5),
 *    which no catalog lists because it means "pass no `-m`".
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
  /** True for a row that is always offered, first (see rule 9). */
  pinned?: boolean;
}

/** A row from a harness's live CLI-discovered model catalog. */
export interface DiscoveredModel {
  id: string;
  label?: string;
  /** Bare reasoning-effort ids the harness's CLI reported for this model
   *  (codex via `codex app-server model/list`; fx ≥0.0.14 via
   *  `models --json` `models[].efforts`, plus `auto`). Absent when the
   *  CLI reported none. See rule 8. */
  efforts?: readonly string[];
  /** fx only (`models --json` ≥0.0.14 `models[].fast`): the model offers the
   *  ACP `fast` session option. Copied by rule 8 like `efforts`. */
  fast?: boolean;
  /** fx only (`models[].ultrafast`): the model offers the ACP `ultrafast`
   *  session option. Copied by rule 8 like `efforts`. */
  ultrafast?: boolean;
}

/** One row in the merged, render-ready model list. */
export interface ModelOption {
  id: string;
  label: string;
  hint?: string;
  /** True when `selected` wasn't in curated ∪ discovered and was appended
   *  so the `<select>` keeps a valid value (rule 6). */
  unlisted?: boolean;
  /** Copied from the discovered entry by rule 8, when present. Pickers pass
   *  this as the third argument of `supportedEfforts` (`./types.ts`) so the
   *  discovered set wins over the curated `MODEL_EFFORT_SUPPORT` table. */
  efforts?: readonly string[];
  /** Copied from the discovered entry by rule 8, when `true`. Fed to
   *  `supportedSpeeds` (`./speed.ts`) as the speed option flags. */
  fast?: boolean;
  /** Copied from the discovered entry by rule 8, when `true`. */
  ultrafast?: boolean;
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

/** Rule 8: a fresh copy of `entry.efforts` when it's a non-empty array,
 *  else `undefined` (so callers can spread it in without ever attaching an
 *  empty/undefined `efforts` key). */
function effortsFor(entry: DiscoveredModel | undefined, keepEmpty = false): readonly string[] | undefined {
  if (entry?.efforts && entry.efforts.length > 0) return [...entry.efforts];
  // Rule 8's scoped carve-out: an explicit "no efforts" survives as `[]`.
  if (keepEmpty && entry?.efforts && entry.efforts.length === 0) return [];
  return undefined;
}

/** Rule 8, speed flags: copy `fast`/`ultrafast` onto `opt` when the
 *  discovered entry reports them `true` (never attaches a `false` key). */
function copySpeedFlags(opt: ModelOption, entry: DiscoveredModel | undefined): void {
  if (entry?.fast === true) opt.fast = true;
  if (entry?.ultrafast === true) opt.ultrafast = true;
}

function toCuratedOption(
  m: CuratedModel,
  discoveredById: Map<string, DiscoveredModel>,
  keepEmptyEfforts: boolean,
): ModelOption {
  const opt: ModelOption = { id: m.id, label: m.label };
  if (m.hint !== undefined) opt.hint = m.hint;
  const entry = discoveredById.get(m.id);
  const efforts = effortsFor(entry, keepEmptyEfforts);
  if (efforts !== undefined) opt.efforts = efforts;
  copySpeedFlags(opt, entry);
  return opt;
}

function toDiscoveredOnlyOption(m: DiscoveredModel, keepEmptyEfforts: boolean): ModelOption {
  const opt: ModelOption = { id: m.id, label: m.label ?? m.id };
  const efforts = effortsFor(m, keepEmptyEfforts);
  if (efforts !== undefined) opt.efforts = efforts;
  copySpeedFlags(opt, m);
  return opt;
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
  // Rule 8: id -> discovered entry, for attaching `efforts` to curated rows
  // (first occurrence wins, matching the merge's own de-dupe policy — not
  // that a well-formed discovered list would carry duplicate ids anyway).
  const discoveredById = new Map<string, DiscoveredModel>();
  for (const m of discovered) {
    if (!discoveredById.has(m.id)) discoveredById.set(m.id, m);
  }

  const result: ModelOption[] = [];
  const seen = new Set<string>();

  const pushCurated = (m: CuratedModel) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    result.push(toCuratedOption(m, discoveredById, scoped));
  };

  const pushDiscoveredOnly = (m: DiscoveredModel) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    result.push(toDiscoveredOnlyOption(m, scoped));
  };

  // Rule 9: pinned rows lead, unconditionally (see the module doc).
  for (const m of curated) {
    if (m.pinned) pushCurated(m);
  }

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
      // On the rule-7 distrust path the catalog was discarded, not
      // consulted, so "not in this account's catalog" would be a claim we
      // never actually checked — use the honest logged-out hint instead.
      const hint = input.loggedIn === false
        ? "Not logged in — this account's catalog is unavailable"
        : "Not in this account's model catalog";
      const unlistedOpt: ModelOption = {
        id: selected,
        label: selected,
        hint,
        unlisted: true,
      };
      const efforts = effortsFor(discoveredById.get(selected), scoped);
      if (efforts !== undefined) unlistedOpt.efforts = efforts;
      copySpeedFlags(unlistedOpt, discoveredById.get(selected));
      result.push(unlistedOpt);
    }
  }

  return result;
}

/** The webview/CLI twin of the bun-side `getDiscoveredEfforts`
 *  (`src/bun/agent-discovery.ts`, which reads the in-process discovery
 *  caches). Callers MUST pass the MERGED rows — `mergeModelOptions`'s own
 *  `ModelOption[]` result — not the raw `discovered` list that was fed into
 *  it: `mergeModelOptions` has already applied rule 7's `loggedIn` distrust
 *  (and rule 6's unlisted-row handling) by the time a row reaches here, so
 *  this lookup doesn't re-derive any of that — it's a plain id lookup over
 *  rule 8's already-attached `efforts`, making rule 8 the single source of
 *  the per-model effort set. Passing the raw discovered list instead would
 *  silently bypass rule 7 (this function has no `loggedIn` of its own to
 *  check). Given those merged rows and an id, returns the matching row's
 *  `efforts` when it's an array — including an explicitly empty one, which
 *  only rule 8's scoped carve-out produces and which only OpenCode's
 *  `supportedEfforts` branch reads differently from `null` — else `null`.
 *  Pass the result straight through as `supportedEfforts`'s third argument
 *  (`./types.ts`).
 *  Structural over `models`/`id` for the same reason the rest of this module
 *  is structural — see the module doc comment. */
export function discoveredEffortsFor(
  models: readonly { id: string; efforts?: readonly string[] }[] | null | undefined,
  id: string | null | undefined,
): readonly string[] | null {
  if (!models || !id) return null;
  const entry = models.find((m) => m.id === id);
  if (entry?.efforts) return entry.efforts;
  return null;
}

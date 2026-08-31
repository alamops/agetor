import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { AgentKind } from "../shared/types.ts";

/**
 * A model id (and optional human label) surfaced by the agent CLI itself.
 * Discovery is best-effort — a missing or unparseable CLI just returns an
 * empty list and the UI falls back to the hardcoded AGENT_OPTIONS.
 */
export interface DiscoveredModel {
  id: string;
  label?: string;
}

/**
 * Run an external command with a 3-second timeout. Designed for cheap CLI
 * probes where blocking the API boot is unacceptable — if the CLI hangs (e.g.
 * waiting for an auth flow) we give up rather than freezing app startup.
 *
 * `env`, when given, is merged over `process.env` for this one spawn — it
 * exists solely so `discoverFx` can probe an additional-account fx harness
 * (one with a `HOME` override) under *that* harness's own env instead of
 * agetor's process env, since fx's catalog is account-scoped (see
 * `discoverFx`'s comment below). Every other discoverer in this module
 * probes a built-in CLI's model-listing subcommand and never passes `env` —
 * none of those catalogs vary by account. Keeping the override optional and
 * purely additive is what lets this module stay free of the database and
 * process-spawning helper modules (which would otherwise drag DB-open and
 * process-signal-handler side effects into a plain best-effort prober) — see
 * the module-level note on `discoverFx` below for the full "stay a leaf"
 * constraint.
 */
async function runProbe(
  cmd: string[],
  env?: Record<string, string>,
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = Bun.spawn(cmd, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* already exited */ } }, 3_000);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
    return { ok: proc.exitCode === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * Parse `codex prompt --models` output. We don't know the exact format codex
 * uses (it has changed across releases and isn't formally specified), so we
 * lean on a loose heuristic: any line whose first whitespace-separated token
 * looks like a model id (`<word>-<word>...` with at least one dash) is taken
 * as a model. Header rows and `Available models:` chatter are dropped.
 */
function parseCodexModels(stdout: string): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // Skip obvious banner / header lines.
    if (/^(available|models|model\s+id|---|=+)/i.test(line)) continue;
    const first = line.split(/\s+/)[0]!;
    // A loose "looks like a model id" check: lowercase, alphanumeric + dashes,
    // contains at least one dash. Tight enough to skip prose but lenient
    // enough to keep "gpt-5", "gpt-5-codex", "o4-mini" etc.
    if (!/^[a-z0-9][a-z0-9.\-_]*[a-z0-9]$/i.test(first)) continue;
    if (!first.includes("-")) continue;
    if (seen.has(first)) continue;
    seen.add(first);
    out.push({ id: first });
  }
  return out;
}

/**
 * Parse `cursor-agent --list-models` output. Like codex, the exact format
 * isn't formally specified (and the binary isn't installed on this
 * machine to verify against), so we lean on the same loose heuristic:
 * any line whose first whitespace-separated token looks like a model id
 * (`<word>-<word>...`, lowercase, alphanumeric + dashes/dots, at least one
 * dash) is taken as a model. Header rows / banner chatter are dropped.
 */
function parseCursorModels(stdout: string): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(available|models|model\s+id|---|=+)/i.test(line)) continue;
    const first = line.split(/\s+/)[0]!;
    if (!/^[a-z0-9][a-z0-9.\-_]*[a-z0-9]$/i.test(first)) continue;
    if (!first.includes("-")) continue;
    if (seen.has(first)) continue;
    seen.add(first);
    out.push({ id: first });
  }
  return out;
}

async function discoverCursor(): Promise<DiscoveredModel[]> {
  // Resolve against the rehydrated PATH explicitly — see discoverCodex's
  // comment above (and agent-status.ts) for why Bun.spawn's implicit lookup
  // can't be trusted on a packaged .app.
  const fallback = process.env.AGETOR_CURSOR_BIN ?? "cursor-agent";
  const bin = Bun.which(fallback, { PATH: process.env.PATH }) ?? fallback;
  // Best-effort only: cursor-agent may not support --list-models at all, or
  // may not be installed. Either way we fall back to the hardcoded
  // AGENT_OPTIONS list — never throw, never block app boot.
  const probe = await runProbe([bin, "--list-models"]);
  if (!probe.ok || !probe.stdout) return [];
  return parseCursorModels(probe.stdout);
}

async function discoverCodex(): Promise<DiscoveredModel[]> {
  // Resolve against the rehydrated PATH explicitly — Bun.spawn (and the
  // implicit lookup inside it) uses Bun's startup PATH cache, which on a
  // packaged .app is launchd's minimal set. See agent-status.ts for the
  // full story.
  const fallback = process.env.AGETOR_CODEX_BIN ?? "codex";
  const bin = Bun.which(fallback, { PATH: process.env.PATH }) ?? fallback;
  // Newer codex builds expose `codex prompt --models`; older builds may not.
  // We try the documented form first; if it fails we return empty rather than
  // probing harder — the hardcoded list is the fallback.
  const probe = await runProbe([bin, "prompt", "--models"]);
  if (!probe.ok || !probe.stdout) return [];
  return parseCodexModels(probe.stdout);
}

/**
 * claude-code intentionally has no programmatic model-list command (open
 * feature request at the time of writing). Returning an empty list keeps the
 * UI on the hardcoded AGENT_OPTIONS, which is the only source of truth that
 * works today.
 */
async function discoverClaude(): Promise<DiscoveredModel[]> {
  return [];
}

/**
 * Gemini CLI has no documented programmatic model-list command either
 * (checked `gemini --help` on CLI 0.54.0 — no such flag/subcommand exists).
 * Same treatment as claude: empty list, UI stays on the hardcoded
 * AGENT_OPTIONS.gemini.
 */
async function discoverGemini(): Promise<DiscoveredModel[]> {
  return [];
}

/**
 * Parse `fx models --json` output. Unlike codex/cursor (whose CLI output
 * format isn't formally specified, hence the loose line-heuristic parsers
 * above), fx's shape here IS known precisely — spike-verified against the
 * real 0.0.6 binary: exactly one JSON object on stdout,
 * `{kind:"models", count, shown_count, more_count, private_models_hidden,
 * ids: string[]}`. `ids` is the complete catalog *for whatever account the
 * probe's env resolves to* (`shown_count === count`; no pagination flag
 * exists, `--all` is rejected) — the count itself is account-scoped, not a
 * fixed Gateway-wide number: an empty `HOME` sees 230 ids
 * (`private_models_hidden: true`, every flagship present); a reference
 * `fx login` account sees 158 ids (`private_models_hidden: false`), a strict
 * subset missing exactly the premium tiers — measured against fx 0.0.6,
 * 2026-08-27. We only trust `ids`; any other shape (non-JSON,
 * missing/malformed `ids`, non-string entries) yields an empty list rather
 * than throwing — discovery is best-effort, never a hard dependency for the
 * picker. Ids are deduped (same `seen`-Set convention as
 * `parseCodexModels`/`parseCursorModels` above) — a repeated id in the
 * catalog would otherwise surface as a duplicate React key in the model
 * picker.
 *
 * Re-measured against fx 0.0.7 (build cef08aa0f178, full 0.0.6→0.0.7 source
 * diff, 2026-08-31): the `models --json` shape is unchanged. The
 * unauthenticated (empty-`HOME`) catalog grew from 230 to 234 ids, still
 * `private_models_hidden: true`; the reference signed-in (158-id) account's
 * view could not be re-measured this pass — the local `fx login` token had
 * expired, so there was no live authenticated account to probe.
 */
function parseFxModels(stdout: string): DiscoveredModel[] {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { ids?: unknown }).ids)) {
      return [];
    }
    const out: DiscoveredModel[] = [];
    const seen = new Set<string>();
    for (const id of (parsed as { ids: unknown[] }).ids) {
      if (typeof id !== "string" || id.length === 0) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * `fx models --json` is spike-verified (binary v0.0.6, measured 2026-08-27)
 * to run with zero filesystem writes regardless of auth state — an empty
 * `HOME` stays empty after the probe, so discovery itself never needs
 * `fx login` and never writes anything, unauth or auth. But it DOES *read*
 * `$HOME`'s credentials, and the catalog it returns back is account-scoped,
 * not Gateway-wide: an empty `HOME` sees 230 ids (every flagship, including
 * the premium tiers); a reference logged-in account sees 158 — a strict
 * subset missing exactly the premium tiers. Latency is 0.3–0.9 s either way,
 * well inside `runProbe`'s 3 s timeout.
 *
 * Re-measured against fx 0.0.7 (build cef08aa0f178, 2026-08-31): still zero
 * filesystem writes either way, and the unauth catalog grew to 234 ids
 * (still every flagship present); the 158-id signed-in reference could not
 * be re-checked this pass (expired local login token). New in 0.0.7 and
 * load-bearing for this account-scoping story: on an account whose login has
 * expired (`auth_expired: true`), a passive probe like this one does NOT
 * refresh the token — it silently falls back to the UNAUTHENTICATED catalog
 * rather than erroring or blocking, so a discovered list can quietly
 * over-show premium `catalogOnly` ids for a user whose session lapsed, until
 * they re-run `fx login`. There is no probe-side way to distinguish that
 * from a genuinely unauthenticated account; both read identically.
 *
 * That account-scoping is exactly why `env` exists as a parameter here (and
 * threads through to `runProbe`): a harness with its own `HOME` override —
 * an additional-account fx harness — must be probed under *its own* env to
 * get *its own* account's catalog, not agetor's process env / the built-in
 * harness's account. Callers that omit `env` (the built-in fx harness, and
 * any caller that predates per-harness discovery) get exactly the prior
 * behavior: probed under agetor's own process env.
 *
 * The hardcoded `AGENT_OPTIONS.fx.models` stays the labeled/hinted curated
 * subset shown first in the picker; this discovered list merges with it the
 * same way the codex/cursor discovered lists merge with their own curated
 * arrays (nothing fx-specific to change on the UI side). No labels come back
 * from fx's CLI, so every discovered entry is `{id}` only — the picker falls
 * back to rendering the bare id, same as codex.
 */
/**
 * The default fx binary resolution — `AGETOR_FX_BIN ?? "fx"`, rehydrated
 * against `process.env.PATH` — used whenever a caller doesn't hand in an
 * explicit `bin` (see `discoverFx` below). Factored out so the "is this
 * target indistinguishable from the built-in/kind-level probe" checks in
 * `runRefresh`/`runRefreshFxHarnessModels` can compare a target's `bin`
 * against this same computation instead of re-deriving it inline.
 */
function defaultFxBin(): string {
  const fallback = process.env.AGETOR_FX_BIN ?? "fx";
  return Bun.which(fallback, { PATH: process.env.PATH }) ?? fallback;
}

async function discoverFx(env?: Record<string, string>, bin?: string): Promise<DiscoveredModel[]> {
  // Resolve exactly the way discoverCodex/discoverCursor do above:
  // rehydrated-PATH lookup only — no import of the sqlite-backed database
  // module (which opens+migrates the DB as an import-time side effect) and
  // no import of the process-spawning agents/harness-env module (whose
  // module chain registers fx's process signal handlers) — neither belongs
  // in a module whose whole contract is "best-effort, never a hard
  // dependency, never throws". The optional `env`/`bin` parameters are not
  // an exception to that: they're plain values the *caller* builds one
  // layer up (`env` from `harnessEnv(harness)`, `bin` from
  // `resolveBin(harness)` — both in `agents.ts`) and hands in, never a
  // harness object or a DB read performed here — this module stays a leaf,
  // callers pass resolved values in.
  //
  // `bin`, when given, is preferred outright over the `AGETOR_FX_BIN ?? "fx"`
  // fallback below — a harness's own configured `bin` (set by the user when
  // adding an alias, e.g. a second fx install) must win over agetor's
  // process-wide default, the same way every other harness kind's spawn
  // already resolves `harness.bin` first (see `resolveBin` in `agents.ts`).
  // Before this parameter existed, discovery silently ignored a harness's
  // `bin` and always probed the process-wide default binary regardless of
  // which harness was actually being refreshed.
  //
  // The whole body is wrapped below (try/catch → []) as a backstop: even a
  // future change here that starts throwing synchronously must still
  // degrade to an empty list, since `refreshDiscoveredModels` fans this out
  // alongside the other four discoverers and one throw must never strand
  // them all.
  try {
    const resolved = bin ?? defaultFxBin();
    // Confirm the binary actually resolves before spending a probe on it —
    // an unresolvable name (fx not installed) would otherwise just make
    // Bun.spawn throw inside runProbe, which is caught there too, but
    // bailing here skips the spawn attempt entirely and reads clearer as
    // "skipped". Same absolute-path/bare-name split for an explicit `bin` as
    // for the fallback: an absolute path (the only shape `harness.bin` can
    // ever hold — server.ts validates it) is checked with `existsSync`; a
    // bare name is resolved against PATH.
    const resolvable = isAbsolute(resolved)
      ? existsSync(resolved)
      : Bun.which(resolved, { PATH: process.env.PATH }) !== null;
    if (!resolvable) return [];
    const probe = await runProbe([resolved, "models", "--json"], env);
    if (!probe.ok || !probe.stdout) return [];
    return parseFxModels(probe.stdout);
  } catch {
    return [];
  }
}

/**
 * True when `target` is indistinguishable from the kind-level built-in probe
 * (`discoverFx()` with no args) — no env override AND either no `bin` at all
 * or a `bin` that resolves to exactly the same binary the no-args call would
 * pick. Used to decide whether a per-harness fx probe can (a) reuse the
 * kind-level result instead of spawning fx a second time for an identical
 * probe, and (b) drift-correct the kind-level "fx" cache. A target with a
 * *different* `bin` — even with an empty `env` — is a different binary (and
 * possibly a different account), so it must never share either shortcut.
 */
function isBuiltinLikeFxTarget(target: FxHarnessTarget): boolean {
  if (Object.keys(target.env).length !== 0) return false;
  return target.bin === undefined || target.bin === defaultFxBin();
}

/**
 * One fx harness to probe for its own account-scoped catalog. `env` is the
 * harness's spawn-env overrides (typically a `HOME` override for an
 * additional-account harness, mirroring `harnessEnv(harness)` one layer up
 * in `agents.ts`) — an empty object means "the built-in fx harness, probe
 * under agetor's own process env, same account as the kind-level cache".
 * `bin`, when given, is the harness's own resolved binary path (mirroring
 * `resolveBin(harness)` in `agents.ts` — the same resolver every real fx
 * spawn uses) — omitted, discovery falls back to `AGETOR_FX_BIN ?? "fx"`,
 * same as before this field existed.
 */
export interface FxHarnessTarget {
  harnessId: string;
  env: Record<string, string>;
  bin?: string;
}

const cache = new Map<AgentKind, DiscoveredModel[]>();
const harnessCache = new Map<string, DiscoveredModel[]>();
let ready = false;

/**
 * Serializes every `refreshDiscoveredModels` / `refreshFxHarnessModels` call
 * into a single FIFO queue. This replaces a previous `inflight` short-circuit
 * that handed a second concurrent caller the *first* call's already-in-flight
 * promise — silently dropping that second call's (possibly different)
 * `fxHarnesses` target list on the floor instead of ever probing it.
 *
 * `chain.then(run, run)` passes the same `run` function as both the
 * fulfilled- and rejected-path handler: a rejected prior run doesn't poison
 * the chain (the next enqueued run still fires — `run` ignores whatever
 * value/reason it's invoked with, since it takes no arguments), and each
 * caller's own returned promise is exactly `chain` at the moment of that
 * call, so it still resolves/rejects with *its own* run's outcome.
 */
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const next = chain.then(run, run);
  chain = next;
  return next;
}

/**
 * Snapshot of discovered models per agent *kind*. Cached in-memory so
 * repeated API calls don't re-probe the CLI on every request. For fx
 * specifically this is the built-in harness's catalog only — an
 * additional-account fx harness (its own `HOME` override) has its own entry
 * in the harness-keyed cache instead, see `getHarnessDiscoveredModels`.
 */
export function getDiscoveredModels(agent: AgentKind): DiscoveredModel[] {
  return cache.get(agent) ?? [];
}

/**
 * Discovered models for one fx harness, keyed by harness id rather than
 * kind. `[]` for a harness that hasn't been probed yet — this includes every
 * non-fx harness, since this cache is fx-only (the only kind whose catalog
 * varies per-harness).
 */
export function getHarnessDiscoveredModels(harnessId: string): DiscoveredModel[] {
  return harnessCache.get(harnessId) ?? [];
}

/**
 * A fresh snapshot object of every known harness's discovered models.
 * Callers get their own plain object each call, *and* their own copy of
 * each harness's array — `Object.fromEntries(harnessCache)` alone would
 * still hand out the same array *references* stored in the Map, so a caller
 * mutating a returned array would silently corrupt the live cache. Test-only
 * in practice (production reads go through `getHarnessDiscoveredModels`/
 * `getHarnessModelMap`), but the "never a live view" contract should hold
 * regardless of caller.
 */
export function getAllHarnessDiscoveredModels(): Record<string, DiscoveredModel[]> {
  const out: Record<string, DiscoveredModel[]> = {};
  for (const [harnessId, models] of harnessCache) {
    out[harnessId] = [...models];
  }
  return out;
}

/**
 * False until the first `refreshDiscoveredModels` call has fully settled
 * (success or failure), true forever after. Callers — e.g. a webview
 * boot-race retry — use this to tell "discovery hasn't run yet" apart from
 * "discovery ran and genuinely found nothing".
 */
export function isDiscoveryReady(): boolean {
  return ready;
}

/**
 * `opts.fxHarnesses` may be given as a plain array, or as a thunk returning
 * one — see `refreshDiscoveredModels`'s doc comment for why the thunk form
 * exists.
 */
export type FxHarnessTargetsOption = FxHarnessTarget[] | (() => FxHarnessTarget[]);

async function runRefresh(opts?: { fxHarnesses?: FxHarnessTargetsOption }): Promise<void> {
  try {
    // Promise.allSettled, not Promise.all: every discoverer above is already
    // internally best-effort (probe failures resolve to []), but this is the
    // backstop against one of them throwing anyway (a stray import-time or
    // synchronous bug) — index.ts/headless.ts call `refreshAllModels()`
    // (model-discovery.ts, which wraps this function) as a bare
    // `void refreshAllModels()` at boot, so an unhandled rejection here
    // surfaces as an unhandled-rejection crash risk, and with Promise.all a
    // single rejection would strand every OTHER kind's cache (they'd never
    // get set, staying whatever they were before — empty on first boot)
    // even though only one kind actually failed.
    const results = await Promise.allSettled([
      discoverCodex(),
      discoverClaude(),
      discoverCursor(),
      discoverGemini(),
      discoverFx(),
    ]);
    const kinds: AgentKind[] = ["codex", "claude-code", "cursor", "gemini", "fx"];
    results.forEach((result, i) => {
      cache.set(kinds[i]!, result.status === "fulfilled" ? result.value : []);
    });

    // Resolve a thunk *here*, inside the enqueued run, not back at the
    // `refreshDiscoveredModels` call site — a caller (e.g. `refreshAllModels`,
    // which passes its `discoveryTargets` function directly) may enumerate a
    // harness list that changes between "this call was enqueued" and "this
    // call actually runs" (a concurrent create/delete while a sweep is
    // queued behind another in-flight run). Resolving late is what keeps a
    // queued sweep from pruning a harness that was created after the sweep
    // was enqueued but before it started running.
    const targetsOpt = opts?.fxHarnesses;
    const targets = typeof targetsOpt === "function" ? targetsOpt() : targetsOpt;
    if (targets) {
      // Reuse the kind-level fx result computed just above for any target
      // that's indistinguishable from that probe (no env override, and
      // either no `bin` or a `bin` matching the default resolution) instead
      // of spawning fx a second time for what would be an identical probe.
      const builtIn = cache.get("fx") ?? [];
      const targetResults = await Promise.allSettled(
        targets.map((target) =>
          isBuiltinLikeFxTarget(target) ? Promise.resolve(builtIn) : discoverFx(target.env, target.bin),
        ),
      );
      const seen = new Set<string>();
      targets.forEach((target, i) => {
        const result = targetResults[i]!;
        harnessCache.set(target.harnessId, result.status === "fulfilled" ? result.value : []);
        seen.add(target.harnessId);
      });
      // Prune any harness that isn't in this call's target list — a deleted
      // harness must not linger forever. A call made with no `opts.fxHarnesses`
      // at all never reaches this branch, so it never touches — let alone
      // prunes — harnessCache.
      for (const harnessId of [...harnessCache.keys()]) {
        if (!seen.has(harnessId)) harnessCache.delete(harnessId);
      }
    }
  } finally {
    ready = true;
  }
}

/**
 * Refreshes the kind-level cache (all five agent kinds, as before) and, when
 * `opts.fxHarnesses` is given, the harness-level fx cache too. Calls are
 * serialized through `enqueue` (see its comment) so two overlapping calls
 * with different `fxHarnesses` target lists can't drop either one's targets.
 *
 * `opts.fxHarnesses` accepts a thunk (`() => FxHarnessTarget[]`) as well as
 * a plain array — `runRefresh` resolves it only once its turn in the queue
 * actually starts, so a target list built from a live DB read (as
 * `refreshAllModels`'s `discoveryTargets` is) reflects the harness set at
 * *run* time, not at the moment this function was called and possibly left
 * waiting behind another in-flight refresh.
 */
export function refreshDiscoveredModels(opts?: { fxHarnesses?: FxHarnessTargetsOption }): Promise<void> {
  return enqueue(() => runRefresh(opts));
}

async function runRefreshFxHarnessModels(target: FxHarnessTarget): Promise<DiscoveredModel[]> {
  let models: DiscoveredModel[];
  try {
    models = isBuiltinLikeFxTarget(target) ? await discoverFx() : await discoverFx(target.env, target.bin);
  } catch {
    models = [];
  }
  harnessCache.set(target.harnessId, models);
  // A target indistinguishable from the built-in kind-level probe (empty
  // env, no distinguishing bin — see `isBuiltinLikeFxTarget`) drift-corrects
  // the kind-level cache too — otherwise a manual refresh of just the
  // built-in harness would update harnessCache but leave
  // `getDiscoveredModels("fx")` (still read by every non-harness-aware
  // caller) stale until the next full sweep. A target with its own `bin`
  // (a distinct binary/account even with an empty env) must NOT drift-
  // correct the shared kind-level cache — that would blend a harness
  // alias's catalog into the built-in's.
  if (isBuiltinLikeFxTarget(target)) {
    cache.set("fx", models);
  }
  return models;
}

/**
 * Probes exactly one fx harness — through the same serialized queue as
 * `refreshDiscoveredModels` — and returns its discovered models. Never
 * throws: a probe failure resolves to `[]`, the same contract every other
 * discoverer in this module already follows.
 */
export function refreshFxHarnessModels(target: FxHarnessTarget): Promise<DiscoveredModel[]> {
  return enqueue(() => runRefreshFxHarnessModels(target));
}

async function runRefreshKind(kind: AgentKind): Promise<void> {
  let models: DiscoveredModel[];
  try {
    switch (kind) {
      case "codex":
        models = await discoverCodex();
        break;
      case "claude-code":
        models = await discoverClaude();
        break;
      case "cursor":
        models = await discoverCursor();
        break;
      case "gemini":
        models = await discoverGemini();
        break;
      case "fx":
        models = await discoverFx();
        break;
    }
  } catch {
    models = [];
  }
  cache.set(kind, models);
}

/**
 * Refreshes exactly one agent kind's kind-level cache — cheaper than the
 * five-kind `refreshDiscoveredModels` sweep when only one harness's
 * availability/config changed (see model-discovery.ts's
 * `refreshHarnessModels`, which routes every non-fx harness edit here
 * instead of a full sweep). Runs through the same serialized queue as
 * `refreshDiscoveredModels`/`refreshFxHarnessModels` so it can't race a
 * concurrent full sweep or per-harness fx probe.
 *
 * `kind: "fx"` only refreshes the kind-level "fx" entry (the built-in
 * account's catalog, as exposed by `getDiscoveredModels("fx")` and the
 * byte-compatible `GET /agent-models` endpoint) — it never touches any
 * per-harness cache entry. fx's own harness-scoped catalogs are always
 * refreshed through `refreshFxHarnessModels` instead (model-discovery.ts's
 * `refreshHarnessModels` routes every fx harness, built-in or alias, there
 * rather than here), since fx's catalog varies per harness while every
 * other kind's is shared.
 */
export function refreshKindModels(kind: AgentKind): Promise<void> {
  return enqueue(() => runRefreshKind(kind));
}

/**
 * Drops one harness's entry from the per-harness discovered-models cache.
 * No probe, no queue hop — cheap and synchronous. Used when a harness is
 * deleted: there's nothing left to refresh, only stale cache state to clear
 * so it doesn't linger in `getAllHarnessDiscoveredModels()`/
 * `getHarnessDiscoveredModels()` forever (the alternative, a full
 * `refreshDiscoveredModels` sweep just to exercise its own pruning-by-
 * absence logic, would re-probe every other kind and every other fx harness
 * for no reason).
 */
export function pruneHarnessDiscovery(harnessId: string): void {
  harnessCache.delete(harnessId);
}

/**
 * Clears both caches, the serialization chain, and the `ready` flag. Tests
 * that assert on cache contents or `isDiscoveryReady()` call this first so
 * module-level state from an earlier test in the same file can't leak in.
 */
function resetForTests(): void {
  cache.clear();
  harnessCache.clear();
  chain = Promise.resolve();
  ready = false;
}

// Exposed for tests that want to feed in synthetic CLI output, and to reset
// module-level state between tests.
export const __testing = { parseCodexModels, parseCursorModels, parseFxModels, resetForTests };

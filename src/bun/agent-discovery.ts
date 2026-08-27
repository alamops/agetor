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
async function discoverFx(env?: Record<string, string>): Promise<DiscoveredModel[]> {
  // Resolve exactly the way discoverCodex/discoverCursor do above:
  // rehydrated-PATH lookup only — no import of the sqlite-backed database
  // module (which opens+migrates the DB as an import-time side effect) and
  // no import of the process-spawning agents/harness-env module (whose
  // module chain registers fx's process signal handlers) — neither belongs
  // in a module whose whole contract is "best-effort, never a hard
  // dependency, never throws". The optional `env` parameter is not an
  // exception to that: it's a plain key-value bag the *caller* builds one
  // layer up (from `harnessEnv(harness)`) and hands in, never a harness
  // object or a DB read performed here — this module stays a leaf, callers
  // pass envs in.
  //
  // The whole body is wrapped below (try/catch → []) as a backstop: even a
  // future change here that starts throwing synchronously must still
  // degrade to an empty list, since `refreshDiscoveredModels` fans this out
  // alongside the other four discoverers and one throw must never strand
  // them all.
  try {
    const fallback = process.env.AGETOR_FX_BIN ?? "fx";
    const bin = Bun.which(fallback, { PATH: process.env.PATH }) ?? fallback;
    // Confirm the binary actually resolves before spending a probe on it —
    // an unresolvable name (fx not installed) would otherwise just make
    // Bun.spawn throw inside runProbe, which is caught there too, but
    // bailing here skips the spawn attempt entirely and reads clearer as
    // "skipped".
    const resolvable = isAbsolute(bin) ? existsSync(bin) : Bun.which(bin, { PATH: process.env.PATH }) !== null;
    if (!resolvable) return [];
    const probe = await runProbe([bin, "models", "--json"], env);
    if (!probe.ok || !probe.stdout) return [];
    return parseFxModels(probe.stdout);
  } catch {
    return [];
  }
}

/**
 * One fx harness to probe for its own account-scoped catalog. `env` is the
 * harness's spawn-env overrides (typically a `HOME` override for an
 * additional-account harness, mirroring `harnessEnv(harness)` one layer up
 * in `agents.ts`) — an empty object means "the built-in fx harness, probe
 * under agetor's own process env, same account as the kind-level cache".
 */
export interface FxHarnessTarget {
  harnessId: string;
  env: Record<string, string>;
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
 * Callers get their own plain object each call, never a live view into the
 * internal `Map`.
 */
export function getAllHarnessDiscoveredModels(): Record<string, DiscoveredModel[]> {
  return Object.fromEntries(harnessCache);
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

async function runRefresh(opts?: { fxHarnesses?: FxHarnessTarget[] }): Promise<void> {
  try {
    // Promise.allSettled, not Promise.all: every discoverer above is already
    // internally best-effort (probe failures resolve to []), but this is the
    // backstop against one of them throwing anyway (a stray import-time or
    // synchronous bug) — index.ts/headless.ts call this as a bare
    // `void refreshDiscoveredModels()` at boot, so an unhandled rejection
    // here surfaces as an unhandled-rejection crash risk, and with
    // Promise.all a single rejection would strand every OTHER kind's cache
    // (they'd never get set, staying whatever they were before — empty on
    // first boot) even though only one kind actually failed.
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

    const targets = opts?.fxHarnesses;
    if (targets) {
      // Reuse the kind-level fx result computed just above for any
      // built-in-account target (empty env) instead of spawning fx a second
      // time for what would be an identical probe.
      const builtIn = cache.get("fx") ?? [];
      const targetResults = await Promise.allSettled(
        targets.map((target) =>
          Object.keys(target.env).length === 0 ? Promise.resolve(builtIn) : discoverFx(target.env),
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
 */
export function refreshDiscoveredModels(opts?: { fxHarnesses?: FxHarnessTarget[] }): Promise<void> {
  return enqueue(() => runRefresh(opts));
}

async function runRefreshFxHarnessModels(target: FxHarnessTarget): Promise<DiscoveredModel[]> {
  let models: DiscoveredModel[];
  try {
    models = Object.keys(target.env).length === 0 ? await discoverFx() : await discoverFx(target.env);
  } catch {
    models = [];
  }
  harnessCache.set(target.harnessId, models);
  // An empty env *is* the built-in fx harness's account, so drift-correct
  // the kind-level cache too — otherwise a manual refresh of just the
  // built-in harness would update harnessCache but leave
  // `getDiscoveredModels("fx")` (still read by every non-harness-aware
  // caller) stale until the next full sweep.
  if (Object.keys(target.env).length === 0) {
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

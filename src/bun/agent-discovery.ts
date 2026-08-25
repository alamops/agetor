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
 * No `env` override parameter: every discoverer here probes a built-in CLI's
 * model-listing subcommand, none of which need a harness alias's HOME/config-
 * dir override to answer (see discoverFx's comment for why that's true of fx
 * specifically). Keeping this module free of per-harness env plumbing is what
 * lets it stay free of the database and process-spawning helper modules too
 * (which would otherwise drag DB-open and process-signal-handler side effects
 * into a plain best-effort prober) — see the module-level note below on
 * `discoverFx`.
 */
async function runProbe(cmd: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = Bun.spawn(cmd, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
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
 * ids: string[]}`. `ids` is the complete Gateway catalog (`shown_count ===
 * count`; no pagination flag exists, `--all` is rejected) — 228 ids at spike
 * time. We only trust `ids`; any other shape (non-JSON, missing/malformed
 * `ids`, non-string entries) yields an empty list rather than throwing —
 * discovery is best-effort, never a hard dependency for the picker. Ids are
 * deduped (same `seen`-Set convention as `parseCodexModels`/
 * `parseCursorModels` above) — a repeated id in the Gateway catalog would
 * otherwise surface as a duplicate React key in the model picker.
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
 * `fx models --json` is spike-verified (against binary v0.0.6) to run
 * unauthenticated with zero filesystem writes — no `fx login` needed for
 * discovery to work, unlike the pre-flight auth check gating task starts.
 * The catalog is Gateway-wide (228 ids at spike time) and deliberately not
 * curated: the hardcoded `AGENT_OPTIONS.fx.models` stays the labeled/hinted
 * subset shown first in the picker, and merges with this list the same way
 * the codex/cursor discovered lists merge with their own curated arrays
 * (nothing fx-specific to change on the UI side).
 *
 * No labels come back from fx's CLI, so every discovered entry is `{id}`
 * only — the picker falls back to rendering the bare id, same as codex.
 */
async function discoverFx(): Promise<DiscoveredModel[]> {
  // Resolve exactly the way discoverCodex/discoverCursor do above:
  // rehydrated-PATH lookup only — no import of the sqlite-backed database
  // module (which opens+migrates the DB as an import-time side effect) and
  // no import of the process-spawning agents/harness-env module (whose
  // module chain registers fx's process signal handlers) — neither belongs
  // in a module whose whole contract is "best-effort, never a hard
  // dependency, never throws". `fx models --json` is unauthenticated and
  // doesn't read/write HOME or a config dir, so the per-harness HOME
  // override that gates a spawned fx *run* (multi-account isolation) has
  // nothing to do here — plain PATH resolution against AGETOR_FX_BIN is
  // enough.
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
    const probe = await runProbe([bin, "models", "--json"]);
    if (!probe.ok || !probe.stdout) return [];
    return parseFxModels(probe.stdout);
  } catch {
    return [];
  }
}

const cache = new Map<AgentKind, DiscoveredModel[]>();
let inflight: Promise<void> | null = null;

/**
 * Snapshot of discovered models per agent. Cached in-memory so repeated API
 * calls don't re-probe the CLI on every request. `refreshDiscoveredModels`
 * is called once at app boot and can be re-invoked later if we ever expose a
 * manual "refresh models" action.
 */
export function getDiscoveredModels(agent: AgentKind): DiscoveredModel[] {
  return cache.get(agent) ?? [];
}

export async function refreshDiscoveredModels(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
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
  })().finally(() => { inflight = null; });
  return inflight;
}

// Exposed for tests that want to feed in synthetic CLI output.
export const __testing = { parseCodexModels, parseCursorModels, parseFxModels };

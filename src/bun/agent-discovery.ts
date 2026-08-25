import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { AgentKind } from "../shared/types.ts";
import { harnessEnv, resolveBin } from "./agents.ts";
import { harnesses } from "./db.ts";

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
 * `env`, when given, is merged on top of `process.env` (never replaces it) —
 * same pattern as `probeVersion` in agent-status.ts, so a harness alias's
 * HOME override (fx's isolation story — see agents.ts:harnessEnv) is
 * respected during discovery too.
 */
async function runProbe(cmd: string[], env?: Record<string, string>): Promise<{ ok: boolean; stdout: string }> {
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
 * ids: string[]}`. `ids` is the complete Gateway catalog (`shown_count ===
 * count`; no pagination flag exists, `--all` is rejected) — 228 ids at spike
 * time. We only trust `ids`; any other shape (non-JSON, missing/malformed
 * `ids`, non-string entries) yields an empty list rather than throwing —
 * discovery is best-effort, never a hard dependency for the picker.
 */
function parseFxModels(stdout: string): DiscoveredModel[] {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { ids?: unknown }).ids)) {
      return [];
    }
    const out: DiscoveredModel[] = [];
    for (const id of (parsed as { ids: unknown[] }).ids) {
      if (typeof id === "string" && id.length > 0) out.push({ id });
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
  // Resolve through the same building blocks agent-status.ts uses to spawn
  // fx: `resolveBin` against the built-in fx harness row (per-harness `bin`
  // override → AGETOR_FX_BIN → PATH lookup) and `harnessEnv` for the HOME
  // override an isolated fx alias would carry. `getByIdOrKind` falls back to
  // a synthetic built-in harness when no row exists yet (fresh DB), so this
  // never depends on the harnesses table having been seeded.
  const harness = harnesses.getByIdOrKind("fx");
  if (!harness) return [];
  const bin = resolveBin(harness);
  // Confirm the binary actually resolves before spending a probe on it —
  // an unresolvable name (fx not installed) would otherwise just make
  // Bun.spawn throw inside runProbe, which is caught there too, but bailing
  // here skips the spawn attempt entirely and reads clearer as "skipped".
  const resolvable = isAbsolute(bin) ? existsSync(bin) : Bun.which(bin, { PATH: process.env.PATH }) !== null;
  if (!resolvable) return [];
  const probe = await runProbe([bin, "models", "--json"], harnessEnv(harness));
  if (!probe.ok || !probe.stdout) return [];
  return parseFxModels(probe.stdout);
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
    const [codex, claude, cursor, gemini, fx] = await Promise.all([
      discoverCodex(),
      discoverClaude(),
      discoverCursor(),
      discoverGemini(),
      discoverFx(),
    ]);
    cache.set("codex", codex);
    cache.set("claude-code", claude);
    cache.set("cursor", cursor);
    cache.set("gemini", gemini);
    cache.set("fx", fx);
  })().finally(() => { inflight = null; });
  return inflight;
}

// Exposed for tests that want to feed in synthetic CLI output.
export const __testing = { parseCodexModels, parseCursorModels, parseFxModels };

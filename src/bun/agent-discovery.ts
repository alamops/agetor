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
    const [codex, claude] = await Promise.all([discoverCodex(), discoverClaude()]);
    cache.set("codex", codex);
    cache.set("claude-code", claude);
  })().finally(() => { inflight = null; });
  return inflight;
}

// Exposed for tests that want to feed in synthetic CLI output.
export const __testing = { parseCodexModels };

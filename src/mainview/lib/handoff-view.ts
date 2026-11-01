/**
 * View-model helpers for the formatted handoff card and its modal
 * (`docs/plans/formatted-handoff.md` K4/K8/K9, D10/D13/D14/D21). Pure — no
 * React, no DOM — so the rules the components code against are unit-testable
 * in this repo (which has no jsdom).
 */
import type { AgentKind, Handoff, PipelineGraph, PipelineStepRecord } from "../../shared/types.ts";
import {
  handoffScanIsCodeAware,
  resolveNextSteps,
  splitHandoffMessage,
  stepNameKey,
  type HandoffMessageSplit,
} from "../../shared/pipeline.ts";
import { mayContainHandoffOpenTag } from "../../shared/handoff-locator.ts";
import {
  cardArtifacts,
  classifyHandoffArtifact,
  HANDOFF_CARD_ARTIFACT_LIMIT,
  type HandoffArtifact,
} from "./handoff-artifacts.ts";

/** The status chip a card shows. An absent `status` is `done` (D13) — the
 *  runner advances on it too. */
export function handoffStatusChip(h: Handoff): {
  status: "done" | "blocked";
  label: "Done" | "Blocked";
  tone: "success" | "warning";
} {
  return h.status === "blocked"
    ? { status: "blocked", label: "Blocked", tone: "warning" }
    : { status: "done", label: "Done", tone: "success" };
}

export interface HandoffNextLabel {
  text: string;
  tone: "default" | "warning";
  /** `unresolved`: the graph isn't loaded or the source step isn't in it, so
   *  nothing was resolved — `text` is `next` verbatim (`→ <next>`) or `Last
   *  step` when `next` is null. */
  kind: "steps" | "last" | "unknown" | "ambiguous" | "unresolved";
}

/**
 * Where the handoff's `next` leads (K9). With the graph and the source step
 * available this is what the runner's own {@link resolveNextSteps} resolves —
 * a single outgoing edge ignores `next`, so a `next: null` step with one edge
 * reads `→ B`. Otherwise `next` shows verbatim (D14).
 */
export function handoffNextLabel(
  h: Handoff,
  graph: PipelineGraph | null,
  fromStepId: string | null,
): HandoffNextLabel {
  const next = h.next?.trim() ?? "";
  const source = graph !== null && fromStepId !== null ? graph.steps.find((s) => s.id === fromStepId) : undefined;
  if (graph === null || source === undefined) {
    return { text: next === "" ? "Last step" : `→ ${next}`, tone: "default", kind: "unresolved" };
  }
  const r = resolveNextSteps(graph, source.id, h);
  switch (r.kind) {
    case "terminal":
      return { text: "Last step", tone: "default", kind: "last" };
    case "steps": {
      const names = r.stepIds.map((id) => graph.steps.find((s) => s.id === id)?.name ?? id);
      return { text: `→ ${names.join(", ")}`, tone: "default", kind: "steps" };
    }
    case "unknown":
      return { text: `→ ${r.next} · unknown step`, tone: "warning", kind: "unknown" };
    case "ambiguous":
      return { text: "→ ? · no next step chosen", tone: "warning", kind: "ambiguous" };
  }
}

/**
 * Whether the pipeline used the handoff this event carries (D21, A8). Only
 * provable from data the panel can fetch, so every other case is `null` (no
 * chip):
 *   - no history record, or its `handoffRunId` is null/absent (legacy or
 *     none supplied) → `null`
 *   - the event's run has not settled → `null`
 *   - `record.handoffRunId` names a different run → `"not-used"`
 *   - same run: `"used"` when this event holds the run's last real block,
 *     `"not-used"` when a later event of the run holds one
 */
export function handoffUsage(input: {
  record: PipelineStepRecord | null;
  eventRunId: string;
  isLastBlockOfRun: boolean;
  runSettled: boolean;
}): "used" | "not-used" | null {
  const { record, eventRunId, isLastBlockOfRun, runSettled } = input;
  if (record === null) return null;
  const supplier = record.handoffRunId;
  if (supplier === null || supplier === undefined || supplier === "") return null;
  if (!runSettled) return null;
  if (supplier !== eventRunId) return "not-used";
  return isLastBlockOfRun ? "used" : "not-used";
}

/** Lower-cased `haystack` contains the (already lower-cased) `needle`. */
function has(haystack: string | null | undefined, needle: string): boolean {
  return typeof haystack === "string" && haystack.toLowerCase().includes(needle);
}

/** The label a card chip shows for one artifact (`null` for free text, which
 *  is modal-only). Path: the display path plus its `line` anchor; URL: the
 *  URL. Notes are tooltips, not visible text, so they are not part of it. */
function chipLabel(a: HandoffArtifact): string | null {
  if (a.kind === "path") return a.line ? `${a.display}:${a.line}` : a.display;
  if (a.kind === "url") return a.url;
  return null;
}

/**
 * Where a search `query` lands for this handoff: `"card"` when it hits
 * something the transcript card shows — the status label, `next`, the
 * summary, or the label of one of the first `chipLimit` (default 6) non-text
 * artifacts — else `"modal"` when it hits any other handoff value (purpose,
 * reason, further/free-text artifacts and their notes, open questions), else
 * `null`. Case-insensitive substring; the query is trimmed, a blank one is
 * `null`. The card shows `next` as the resolved step name, which the helper
 * can't know — the raw `next` is matched, which is what search indexes (D10).
 */
export function handoffMatchLocation(
  h: Handoff,
  query: string,
  opts?: { chipLimit?: number; roots?: readonly (string | null | undefined)[]; homeDir?: string | null },
): "card" | "modal" | null {
  const needle = query.trim().toLowerCase();
  if (needle === "") return null;

  if (has(handoffStatusChip(h).label, needle) || has(h.next, needle) || has(h.summary, needle)) return "card";

  const ctx = { roots: opts?.roots ?? [], homeDir: opts?.homeDir ?? null };
  const classified = h.artifacts.map((entry) => classifyHandoffArtifact(entry, ctx));
  const { chips } = cardArtifacts(classified, opts?.chipLimit ?? HANDOFF_CARD_ARTIFACT_LIMIT);
  for (const chip of chips) if (has(chipLabel(chip), needle)) return "card";

  if (searchableHandoffText(h).toLowerCase().includes(needle)) return "modal";
  return null;
}

/** The handoff's field VALUES as search text — purpose, summary, reason,
 *  next, artifacts, open questions — newline-joined. No JSON keys (so
 *  `schemaVersion` never matches) and no markup (D10). */
export function searchableHandoffText(h: Handoff): string {
  const parts: string[] = [h.purpose, h.summary, h.reason];
  if (h.next) parts.push(h.next);
  parts.push(...h.artifacts, ...h.openQuestions);
  return parts.filter((p) => p !== "").join("\n");
}

const SPLIT_CACHE_MAX = 512;
const splitCache = new Map<string, HandoffMessageSplit>();

/** {@link splitHandoffMessage} behind a 512-entry LRU keyed by the message
 *  text (K8): the same text returns the SAME object, so a streamed event
 *  costs one new scan while the card, the per-run index and search reuse it.
 *  Callers must treat the result as read-only. */
export function splitHandoffMessageCached(text: string): HandoffMessageSplit {
  const hit = splitCache.get(text);
  if (hit !== undefined) {
    // Refresh recency: Map iterates in insertion order.
    splitCache.delete(text);
    splitCache.set(text, hit);
    return hit;
  }
  const result = splitHandoffMessage(text);
  splitCache.set(text, result);
  if (splitCache.size > SPLIT_CACHE_MAX) {
    const oldest = splitCache.keys().next();
    if (!oldest.done) splitCache.delete(oldest.value);
  }
  return result;
}

/**
 * Per run id, the index (into `events`) of the LAST main-stream `assistant`
 * event that holds a real handoff block — the one the pipeline reads (D21).
 * A subagent event (`subagentId` set) and a block inside code never count.
 */
export function indexLastHandoffEventByRun(
  events: readonly { runId: string; stream: string; data: string; subagentId?: string | null }[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.stream !== "assistant") continue;
    if (e.subagentId !== null && e.subagentId !== undefined) continue;
    // Cheap prefilter shared with every surface (case-insensitive, like the locator).
    if (!mayContainHandoffOpenTag(e.data)) continue;
    if (splitHandoffMessageCached(e.data).block !== null) out.set(e.runId, i);
  }
  return out;
}

/** Cards render only in a pipeline step task's main stream, and only for a
 *  harness whose assistant events carry whole messages (not delta streams —
 *  D9, D11, A1). */
export function handoffCardsEnabled(input: {
  isStepTask: boolean;
  kind: AgentKind | null | undefined;
  mainStream: boolean;
}): boolean {
  return input.isStepTask && input.mainStream && handoffScanIsCodeAware(input.kind);
}

/** The id of the step named `name` in `graph` (compared with {@link
 *  stepNameKey}), or `null` when there's no graph or no such step. */
export function stepIdForName(graph: PipelineGraph | null, name: string): string | null {
  if (graph === null) return null;
  const key = stepNameKey(name);
  return graph.steps.find((s) => stepNameKey(s.name) === key)?.id ?? null;
}

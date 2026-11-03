/**
 * OpenCode v2 server events and message snapshots → agetor run-event chunks.
 *
 * Pure: no I/O, no db access (it imports only `opencode-map-helpers.ts` and `src/shared`), no clock. The
 * driver (`opencode-driver.ts`) is the only writer of a run's events (invariant I5): it feeds live SSE
 * envelopes through `createOpencodeEventMapper(...)` and, on a catch-up (agetor restart, hub
 * reconnect), a message snapshot through `mapper.seedFromSnapshot(...)` / `mapper.beginSeed(...)`. Both
 * paths produce the SAME `lineUuid` for the same content, built only from ids present in both shapes,
 * so a resync never duplicates a line.
 *
 * Chunk shapes are the tmux driver's (`mapOpencodePart`): `assistant` / `thinking` carry the plain
 * text, `tool_use` carries `{id, name, input, serverSide:false, title}` (OpenCode's `todowrite`
 * surfaces as `TodoWrite`), `tool_result` carries `{toolUseId, content, isError}`, usage is a
 * `FX_USAGE_STATUS_PREFIX` status line, errors are `opencode: <message>[ — <quota hint>]` status lines.
 *
 * Line uuids (S = session id, M = assistant message id):
 *   text       opencode:S:text:M:<text ordinal>        (the live event carries the ordinal; a snapshot
 *                                                       derives it by counting `type:"text"` items)
 *   reasoning  opencode:S:reasoning:M:<ordinal>        (same, counting reasoning items only)
 *   tool       opencode:S:tool:<callId>:use | :result  (call id is `content[].id` in a snapshot)
 *   usage      opencode:S:usage:M                      (one line per COMPLETED assistant message)
 *   error      opencode:S:error:M                      (step.failed / the assistant message's `error`)
 *              opencode:S:error:execution:<M'>         (execution.failed; M' = the last assistant
 *                                                       message id seen in that execution, live or
 *                                                       snapshot, else "none")
 *   retry      opencode:S:retry:M:<attempt>            (live only)
 *
 * ── Required call order (a catch-up is racy otherwise) ──────────────────────────────────────────
 *   subscribe to the event stream → BUFFER live events → fetch the messages and seed → drain the
 *   buffer through `feed`. Feeding live events before the seed is tolerated (it never duplicates and
 *   fixes itself, below) but is a degraded mode.
 *
 * ── Snapshot blocks are final; `replace` exists only for a tool name learned late ─────────────
 *   Verified on OpenCode 2.1.3: a text/reasoning item in `GET …/message` is `text: ""` until its
 *   `.ended` event and then holds the FULL text at once (no delta is projected), and an in-progress
 *   assistant message carries no tokens / cost / finish / `time.completed` until `step.ended`. So:
 *     - a NON-empty text/reasoning item is final and is emitted like any live block;
 *     - an EMPTY item is "not arrived yet": no chunk and no recorded uuid, so its live `.ended` is a
 *       plain insert;
 *     - usage is counted only for completed messages, so a half-written message never swallows the
 *       live `step.ended`.
 *   A lost `.ended` (reconnect gap) needs no special call: seed again (`seedFromSnapshot` is idempotent,
 *   it emits only what was not emitted yet).
 *   The one case where already-emitted content must change: a live `session.tool.called` that arrives
 *   before the tool's name is known (no `input.started` seen, not seeded yet) is emitted as `tool_use`
 *   with the generic name `tool` and `provisional: true`. When a seed learns the real name it re-emits
 *   that uuid with `replace: true` (and no `provisional`); the driver applies it with
 *   `runs.replaceMainEventDataByLineUuid` and re-broadcasts instead of inserting. `provisionalUuids()`
 *   lists the uuids still waiting for that. A chunk without `replace` is always a plain insert.
 *
 * ── Events deliberately ignored ─────────────────────────────────────────────────────────────────
 *   Events carrying another session's id (children, other tasks) map to nothing. Everything not
 *   mapped is ignored on purpose: server.connected, session.created / renamed / moved /
 *   metadata.updated / permissions / viewed / archived / unarchived / deleted / forked (the driver and
 *   hub handle sessions), session.agent.selected, session.model.selected, session.inbox.* (the user's
 *   message is already persisted by agetor; a steered message belongs to the same execution),
 *   session.instructions.updated, session.synthetic, session.skill.activated, skill.updated,
 *   session.shell.* and shell.* (a model shell call is a tool), session.step.started and
 *   session.step.streamed (no content), session.text.started / .delta, session.reasoning.started /
 *   .delta, session.tool.input.started (only its tool name is kept) / .delta / .ended (the complete
 *   input arrives on `session.tool.called`), session.tool.progress (live-only metadata),
 *   session.usage.updated (the session's lifetime total, not this turn's: the turn total is accumulated
 *   from step events), session.compaction.*, session.revert.*, permission.* and form.* (the driver
 *   turns these into cards). Malformed envelopes never throw: they map to nothing.
 */
import {
  addOpencodeTokens,
  isRec,
  normalizeOpencodeTool,
  opencodeErrorMessage,
  opencodeUsagePayload,
  str,
  type Rec,
  type OpencodeUsageTotals,
} from "./opencode-map-helpers.ts";
import { opencodeQuotaHint } from "../shared/opencode.ts";
import { FX_USAGE_STATUS_PREFIX, type RunEventStream } from "../shared/types.ts";

/** A decoded SSE envelope. Only `type` and `data` are read; ids, `location`, `durable` are ignored. */
export type OpencodeEventLike = { type: string; data?: unknown };

export interface OpencodeMappedChunk {
  stream: RunEventStream;
  data: string;
  lineUuid: string;
  /** Overwrite the data of the already-persisted event with this `lineUuid` (see the header). */
  replace?: boolean;
  /** The content may still change (a generic-name tool_use): a later chunk for this uuid may carry `replace: true`. */
  provisional?: boolean;
}

export interface OpencodeTerminal {
  outcome: "succeeded" | "failed" | "interrupted";
  /** `interrupted`: OpenCode's reason (`user`, `shutdown`, `superseded`, `inactivity`). */
  reason?: string;
  /** `failed`: the plain error message (no hint, no `opencode:` prefix). */
  error?: string;
}

/** Resumable catch-up over a paged message listing. */
export interface OpencodeSeed {
  /** Push one page (pages oldest → newest). Returns the chunks to emit. A page that ends before the
   *  anchor produces nothing; the anchor may sit on any page. */
  push(page: unknown[]): OpencodeMappedChunk[];
  /** True once the anchor user message (or no anchor at all) has been seen. */
  anchorFound(): boolean;
  /** Close the seed; later pushes are ignored. */
  end(): void;
}

export interface OpencodeEventMapper {
  /** Map one SSE envelope. Only events whose `data.sessionID` is this mapper's session map to chunks. */
  feed(e: OpencodeEventLike): OpencodeMappedChunk[];
  /** Set by `session.execution.succeeded | failed | interrupted`; cleared by `session.execution.started`. */
  terminal(): OpencodeTerminal | null;
  /** Cumulative token/cost totals for this mapper's lifetime (a turn), a copy. */
  usage(): OpencodeUsageTotals;
  /** Forget everything (terminal, usage, produced uuids, tool names, error state): a new execution
   *  begins in the same session, e.g. a server wake with a fresh run. */
  reset(): void;
  /** Begin a (possibly multi-page) catch-up from `GET …/message`. Usage merges across pages and
   *  repeated seeds without double counting. See the header for the required order. */
  beginSeed(opts?: { afterUserMessageId?: string }): OpencodeSeed;
  /** One-page convenience over `beginSeed`. The anchor must be on `messages` (else nothing maps). */
  seedFromSnapshot(messages: unknown[], opts?: { afterUserMessageId?: string }): OpencodeMappedChunk[];
  /** Line uuids whose content may still change (generic-name tool_use waiting for its name). */
  provisionalUuids(): string[];
}

function ordinalOf(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

function emptyUsage(): OpencodeUsageTotals {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/* ── chunk builders (shared by the live and snapshot paths) ───────────────── */

type TextKind = "text" | "reasoning";

/** An empty block is "not arrived yet" (a snapshot of a streaming message holds `""`): no chunk. */
function textChunk(sid: string, kind: TextKind, msgId: string, ordinal: number, text: string): OpencodeMappedChunk[] {
  if (text === "") return [];
  return [{
    stream: kind === "text" ? "assistant" : "thinking",
    data: text,
    lineUuid: `opencode:${sid}:${kind}:${msgId}:${ordinal}`,
  }];
}

function toolUseChunk(sid: string, callId: string, tool: string, input: unknown): OpencodeMappedChunk {
  const mapped = normalizeOpencodeTool(tool, input);
  return {
    stream: "tool_use",
    // Same key order and values as `mapOpencodePart`; v2 tool states carry no `title`.
    data: JSON.stringify({ id: callId, name: mapped.name, input: mapped.input, serverSide: false, title: undefined }),
    lineUuid: `opencode:${sid}:tool:${callId}:use`,
  };
}

function toolResultChunk(sid: string, callId: string, content: string, isError: boolean): OpencodeMappedChunk {
  return {
    stream: "tool_result",
    data: JSON.stringify({ toolUseId: callId, content, isError }),
    lineUuid: `opencode:${sid}:tool:${callId}:result`,
  };
}

/** The text of a tool `content` array (`Content` = text | file items). Text pieces are concatenated
 *  (a newline is inserted only where the previous piece does not already end in one); a file item
 *  reads as its name or uri. `null` when `content` is not an array. */
function contentText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  let out = "";
  for (const item of content) {
    if (!isRec(item)) continue;
    let piece: string | null = null;
    if (item.type === "text" && typeof item.text === "string") piece = item.text;
    else if (item.type === "file") piece = str(item.name) ?? str(item.uri) ?? str(item.mime);
    if (piece === null || piece === "") continue;
    if (out !== "" && !out.endsWith("\n")) out += "\n";
    out += piece;
  }
  return out;
}

function errorMessageOf(err: unknown): string | null {
  return isRec(err) ? str(err.message) : null;
}

/** Result text: the tool's content when it has any, else the error's message (tmux: `output ?? error`). */
function resultContent(content: unknown, err: unknown): string {
  const text = contentText(content);
  if (text !== null && text !== "") return text;
  return errorMessageOf(err) ?? "";
}

function errorStatusData(err: unknown): string {
  const msg = opencodeErrorMessage(err);
  const hint = opencodeQuotaHint(err, msg);
  return `opencode: ${msg}${hint ? ` — ${hint}` : ""}`;
}

function usageChunk(sid: string, msgId: string, totals: OpencodeUsageTotals): OpencodeMappedChunk {
  return {
    stream: "status",
    data: FX_USAGE_STATUS_PREFIX + JSON.stringify(opencodeUsagePayload(totals)),
    lineUuid: `opencode:${sid}:usage:${msgId}`,
  };
}

/** A user abort is not an error worth a status line (the run settles as interrupted). */
function isAborted(err: unknown): boolean {
  return isRec(err) && err.type === "aborted";
}

/* ── message snapshot ─────────────────────────────────────────────────────── */

/** An assistant message OpenCode has finished writing: stamped complete, finished, or failed. */
function isCompleteMessage(msg: Record<string, unknown>): boolean {
  const time = isRec(msg.time) ? msg.time : null;
  return (time !== null && time.completed != null) || msg.finish != null || msg.error !== undefined;
}

interface WalkState {
  anchor: string | undefined;
  found: boolean;
}
interface UsageAcc {
  totals: OpencodeUsageTotals;
  seen: Set<string>;
}
interface WalkOut {
  chunks: OpencodeMappedChunk[];
  toolNames: Map<string, string>;
  /** Id of the last assistant message in the mapped window. */
  lastAssistantId: string | null;
  /** Status text of that message's (non-abort) error, when it has one. */
  lastErrorData: string | null;
}

/** Map one page of messages. `usage` null: no token accounting (no usage chunks). Mutates `st` (the
 *  anchor search) and `usage` (completed messages only, each counted once). */
function walkMessages(messages: unknown, sid: string, st: WalkState, usage: UsageAcc | null): WalkOut {
  const out: WalkOut = { chunks: [], toolNames: new Map(), lastAssistantId: null, lastErrorData: null };
  if (!Array.isArray(messages)) return out;
  let start = 0;
  if (!st.found) {
    const idx = messages.findIndex((m) => isRec(m) && m.id === st.anchor);
    // The anchor is not on this page: nothing on it belongs to the run (pages come oldest → newest).
    if (idx < 0) return out;
    st.found = true;
    start = idx + 1;
  }
  for (let i = start; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRec(msg) || msg.type !== "assistant") continue; // user / idle / shell / compaction: nothing
    const msgId = str(msg.id);
    if (!msgId) continue;
    const complete = isCompleteMessage(msg);
    out.lastAssistantId = msgId;
    out.lastErrorData = null;
    let textOrdinal = 0;
    let reasoningOrdinal = 0;
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const item of content) {
      if (!isRec(item)) continue;
      if (item.type === "text") {
        const ord = textOrdinal++;
        if (typeof item.text === "string") out.chunks.push(...textChunk(sid, "text", msgId, ord, item.text));
      } else if (item.type === "reasoning") {
        const ord = reasoningOrdinal++;
        if (typeof item.text === "string") out.chunks.push(...textChunk(sid, "reasoning", msgId, ord, item.text));
      } else if (item.type === "tool") {
        const callId = str(item.id);
        const name = str(item.name) ?? "tool";
        const state = isRec(item.state) ? item.state : null;
        if (!callId || !state) continue;
        out.toolNames.set(callId, name);
        const status = state.status;
        if (status === "running" || status === "completed" || status === "error") {
          out.chunks.push(toolUseChunk(sid, callId, name, state.input));
        }
        if (status === "completed") out.chunks.push(toolResultChunk(sid, callId, resultContent(state.content, null), false));
        else if (status === "error") out.chunks.push(toolResultChunk(sid, callId, resultContent(state.content, state.error), true));
        // "streaming" / "pending": the input is incomplete; `session.tool.called` emits the tool_use live.
      }
    }
    if (msg.error !== undefined && !isAborted(msg.error)) {
      const data = errorStatusData(msg.error);
      out.lastErrorData = data;
      out.chunks.push({ stream: "status", data, lineUuid: `opencode:${sid}:error:${msgId}` });
    }
    // Only a completed message has final tokens: counting an in-progress one (zeros) would make the
    // live `step.ended` look like a duplicate and lose the real totals.
    if (usage && complete && isRec(msg.tokens) && !usage.seen.has(msgId)) {
      usage.seen.add(msgId);
      addOpencodeTokens(usage.totals, msg.tokens, msg.cost);
      out.chunks.push(usageChunk(sid, msgId, usage.totals));
    }
  }
  return out;
}

/**
 * The chunks a single message listing (`GET /api/session/{id}/message`, ascending) stands for: every
 * assistant message after the user message `afterUserMessageId` (all of them when omitted). User
 * messages and the trailing `idle` marker produce nothing. A tool still `running` yields only its
 * `tool_use`; a `streaming` one nothing. Empty text/reasoning items (not yet arrived) map to nothing.
 * Usage is cumulative over the mapped window. When `afterUserMessageId` is given but not on
 * `messages`, the result is empty. Pure and stateless; the mapper's `seedFromSnapshot` is the same
 * mapping plus state.
 */
function snapshotToChunks(
  messages: unknown[],
  opts: { sessionId: string; afterUserMessageId?: string },
): OpencodeMappedChunk[] {
  try {
    const st: WalkState = { anchor: opts.afterUserMessageId, found: !opts.afterUserMessageId };
    return walkMessages(messages, opts.sessionId, st, { totals: emptyUsage(), seen: new Set() }).chunks;
  } catch {
    return [];
  }
}

/* ── live mapper ──────────────────────────────────────────────────────────── */

interface Emitted {
  data: string;
  /** A later chunk with different data replaces this one. */
  replaceable: boolean;
}

export function createOpencodeEventMapper(opts: { sessionId: string }): OpencodeEventMapper {
  const sid = opts.sessionId;
  let emitted = new Map<string, Emitted>();
  let toolNames = new Map<string, string>();
  /** Raw input of tool_use chunks emitted with the generic name, to re-emit once the name is known. */
  let fallbackInputs = new Map<string, unknown>();
  let usage = emptyUsage();
  let usageSeen = new Set<string>();
  let terminal: OpencodeTerminal | null = null;
  let lastErrorData: string | null = null;
  let lastAssistantId: string | null = null;
  let executions = 0;

  /** The single gate every chunk passes: first write inserts, a replaceable uuid with changed data
   *  replaces, anything else is dropped. */
  function admit(chunk: OpencodeMappedChunk): OpencodeMappedChunk[] {
    const prev = emitted.get(chunk.lineUuid);
    if (!prev) {
      emitted.set(chunk.lineUuid, { data: chunk.data, replaceable: chunk.provisional === true });
      return [chunk];
    }
    if (!prev.replaceable) return [];
    const changed = prev.data !== chunk.data;
    prev.data = chunk.data;
    prev.replaceable = chunk.provisional === true;
    return changed ? [{ ...chunk, replace: true }] : [];
  }
  function admitAll(chunks: OpencodeMappedChunk[]): OpencodeMappedChunk[] {
    const out: OpencodeMappedChunk[] = [];
    for (const c of chunks) out.push(...admit(c));
    return out;
  }

  /** Names learned from a snapshot: re-emit any tool_use that went out with the generic name. */
  function adoptToolNames(names: Map<string, string>): OpencodeMappedChunk[] {
    const out: OpencodeMappedChunk[] = [];
    for (const [callId, name] of names) {
      toolNames.set(callId, name);
      if (!fallbackInputs.has(callId)) continue;
      out.push(...admit(toolUseChunk(sid, callId, name, fallbackInputs.get(callId))));
      fallbackInputs.delete(callId);
    }
    return out;
  }

  function mapEvent(type: string, d: Rec): OpencodeMappedChunk[] {
    const msgOfEvent = str(d.assistantMessageID);
    if (msgOfEvent) lastAssistantId = msgOfEvent;
    switch (type) {
      case "session.execution.started":
        terminal = null;
        lastErrorData = null;
        executions++;
        return [];
      case "session.execution.succeeded":
        terminal = { outcome: "succeeded" };
        return [];
      case "session.execution.interrupted": {
        const reason = str(d.reason);
        terminal = reason ? { outcome: "interrupted", reason } : { outcome: "interrupted" };
        return [];
      }
      case "session.execution.failed": {
        terminal = { outcome: "failed", error: opencodeErrorMessage(d.error) };
        const data = errorStatusData(d.error);
        // A failing step (live, or found in a seeded snapshot) already printed the same line.
        if (data === lastErrorData) return [];
        lastErrorData = data;
        return [{ stream: "status", data, lineUuid: `opencode:${sid}:error:execution:${lastAssistantId ?? "none"}` }];
      }
      case "session.text.ended": {
        const msgId = str(d.assistantMessageID);
        const ord = ordinalOf(d.ordinal);
        if (!msgId || ord === null || typeof d.text !== "string") return [];
        return textChunk(sid, "text", msgId, ord, d.text);
      }
      case "session.reasoning.ended": {
        const msgId = str(d.assistantMessageID);
        const ord = ordinalOf(d.ordinal);
        if (!msgId || ord === null || typeof d.text !== "string") return [];
        return textChunk(sid, "reasoning", msgId, ord, d.text);
      }
      case "session.tool.input.started": {
        const callId = str(d.id);
        const name = str(d.name);
        if (callId && name) toolNames.set(callId, name);
        return [];
      }
      case "session.tool.called": {
        const callId = str(d.id);
        if (!callId) return [];
        const input = isRec(d.input) ? d.input : {};
        const name = toolNames.get(callId);
        const chunk = toolUseChunk(sid, callId, name ?? "tool", input);
        if (name === undefined) {
          // Subscribed after `input.started` and not seeded yet: the name is unknown. Provisional; the
          // seed re-emits it with the real name.
          chunk.provisional = true;
          fallbackInputs.set(callId, input);
        }
        return [chunk];
      }
      case "session.tool.success": {
        const callId = str(d.id);
        if (!callId) return [];
        return [toolResultChunk(sid, callId, resultContent(d.content, null), false)];
      }
      case "session.tool.failed": {
        const callId = str(d.id);
        if (!callId) return [];
        return [toolResultChunk(sid, callId, resultContent(d.content, d.error), true)];
      }
      case "session.step.ended":
      case "session.step.failed": {
        const msgId = str(d.assistantMessageID);
        if (!msgId) return [];
        const out: OpencodeMappedChunk[] = [];
        if (type === "session.step.failed" && !isAborted(d.error)) {
          const data = errorStatusData(d.error);
          lastErrorData = data;
          out.push({ stream: "status", data, lineUuid: `opencode:${sid}:error:${msgId}` });
        }
        // A failed step reports tokens only when the provider streamed some; an ended step always does.
        if ((type === "session.step.ended" || isRec(d.tokens)) && !usageSeen.has(msgId)) {
          usageSeen.add(msgId);
          addOpencodeTokens(usage, d.tokens, d.cost);
          out.push(usageChunk(sid, msgId, usage));
        }
        return out;
      }
      case "session.retry.scheduled": {
        const msgId = str(d.assistantMessageID);
        const attempt = typeof d.attempt === "number" && Number.isFinite(d.attempt) ? d.attempt : null;
        if (!msgId || attempt === null) return [];
        return [{
          stream: "status",
          data: `opencode: ${opencodeErrorMessage(d.error)} — retrying (attempt ${attempt})`,
          lineUuid: `opencode:${sid}:retry:${msgId}:${attempt}`,
        }];
      }
      default:
        return []; // see the ignore list in the file header
    }
  }

  function applyWalk(out: WalkOut): OpencodeMappedChunk[] {
    const replaced = adoptToolNames(out.toolNames);
    if (out.lastAssistantId) lastAssistantId = out.lastAssistantId;
    if (out.lastErrorData) lastErrorData = out.lastErrorData;
    return [...replaced, ...admitAll(out.chunks)];
  }

  const mapper: OpencodeEventMapper = {
    feed(e) {
      try {
        if (!isRec(e) || typeof e.type !== "string") return [];
        const d = isRec(e.data) ? e.data : null;
        if (!d || d.sessionID !== sid) return [];
        return admitAll(mapEvent(e.type, d));
      } catch {
        return [];
      }
    },
    terminal: () => (terminal ? { ...terminal } : null),
    usage: () => ({ ...usage }),
    reset() {
      emitted = new Map();
      toolNames = new Map();
      fallbackInputs = new Map();
      usage = emptyUsage();
      usageSeen = new Set();
      terminal = null;
      lastErrorData = null;
      lastAssistantId = null;
      executions = 0;
    },
    beginSeed(seedOpts) {
      const st: WalkState = { anchor: seedOpts?.afterUserMessageId, found: !seedOpts?.afterUserMessageId };
      let ended = false;
      return {
        push(page) {
          if (ended) return [];
          try {
            return applyWalk(walkMessages(page, sid, st, { totals: usage, seen: usageSeen }));
          } catch {
            return [];
          }
        },
        anchorFound: () => st.found,
        end() {
          ended = true;
        },
      };
    },
    seedFromSnapshot(messages, seedOpts) {
      const seed = mapper.beginSeed(seedOpts);
      const chunks = seed.push(messages);
      seed.end();
      return chunks;
    },
    provisionalUuids() {
      const out: string[] = [];
      for (const [uuid, e] of emitted) if (e.replaceable) out.push(uuid);
      return out;
    },
  };
  return mapper;
}

/** Test-only: the stateless snapshot mapper (production seeds through `beginSeed`). */
export const __forTest = { snapshotToChunks };

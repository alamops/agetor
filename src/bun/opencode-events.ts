/**
 * OpenCode v2 server events and message snapshots → agetor run-event chunks.
 *
 * Pure: no I/O, no db access, no clock. The driver (`opencode-driver.ts`) is the only writer of a
 * run's events (invariant I5): it feeds live SSE envelopes through `createOpencodeEventMapper(...)`
 * and, on a catch-up (agetor restart, hub reconnect), a message snapshot through
 * `mapper.seedFromSnapshot(...)` / `snapshotToChunks(...)`. Both paths produce the SAME `lineUuid`
 * for the same content, built only from ids that exist in BOTH shapes, so a snapshot followed by the
 * live stream never duplicates a line.
 *
 * Chunk shapes are the tmux driver's (`mapOpencodePart` in opencode-tmux.ts): `assistant` / `thinking`
 * carry the plain text, `tool_use` carries `{id, name, input, serverSide:false, title}` (OpenCode's
 * `todowrite` surfaces as `TodoWrite` through `normalizeOpencodeTool`), `tool_result` carries
 * `{toolUseId, content, isError}`, usage is a `FX_USAGE_STATUS_PREFIX` status line built by
 * `opencodeUsagePayload`, errors are `opencode: <message>[ — <quota hint>]` status lines. RunPanel and
 * the TODO tracker therefore need no change.
 *
 * Line uuids (S = session id, M = assistant message id):
 *   text       opencode:S:text:M:<text ordinal>        (ordinal counts text blocks only; the live
 *                                                       event carries it, the snapshot derives it by
 *                                                       counting `type:"text"` items of the message)
 *   reasoning  opencode:S:reasoning:M:<ordinal>        (same, counting reasoning blocks only)
 *   tool       opencode:S:tool:<callId>:use | :result  (call id is `content[].id` in a snapshot)
 *   usage      opencode:S:usage:M                      (one line per assistant message)
 *   error      opencode:S:error:M                      (step.failed / assistant `error`)
 *              opencode:S:error:execution:<n>          (execution.failed; n = executions seen)
 *   retry      opencode:S:retry:M:<attempt>            (live only)
 *
 * Events that carry another session's id (children, other tasks) map to nothing. Everything that is
 * not mapped is ignored on purpose:
 *   server.connected, session.created / renamed / moved / metadata.updated / permissions / viewed /
 *   archived / deleted / forked (the driver and hub handle sessions), session.agent.selected,
 *   session.model.selected, session.inbox.* (the user's own message is already persisted by agetor,
 *   and a steered message belongs to the same execution), session.instructions.updated,
 *   session.synthetic, session.skill.activated, skill.updated, session.shell.* and shell.*
 *   (`!`-shell blocks and shell-process bookkeeping; a model shell call is a tool), session.step.started
 *   and session.step.streamed (no content), session.text.started / .delta, session.reasoning.started /
 *   .delta, session.tool.input.delta, session.tool.progress (live-only metadata), session.usage.updated
 *   (the session's lifetime total, not this turn's: the turn total is accumulated from step events),
 *   session.compaction.*, session.revert.*, permission.* and form.* (the driver turns these into
 *   cards). Malformed envelopes never throw: they map to nothing.
 */
import {
  addOpencodeTokens,
  normalizeOpencodeTool,
  opencodeErrorMessage,
  opencodeUsagePayload,
  type OpencodeUsageTotals,
} from "./opencode-tmux.ts";
import { opencodeQuotaHint } from "../shared/opencode.ts";
import { FX_USAGE_STATUS_PREFIX, type RunEventStream } from "../shared/types.ts";

/** A decoded SSE envelope. Only `type` and `data` are read; ids, `location`, `durable` are ignored. */
export type OpencodeEventLike = { type: string; data?: unknown };

export interface OpencodeMappedChunk {
  stream: RunEventStream;
  data: string;
  lineUuid: string;
}

export interface OpencodeTerminal {
  outcome: "succeeded" | "failed" | "interrupted";
  /** `interrupted`: OpenCode's reason (`user`, `shutdown`, `superseded`, `inactivity`). */
  reason?: string;
  /** `failed`: the plain error message (no hint, no `opencode:` prefix). */
  error?: string;
}

type Rec = Record<string, unknown>;
function isRec(v: unknown): v is Rec {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}
function ordinalOf(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

function emptyUsage(): OpencodeUsageTotals {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/* ── chunk builders (shared by the live and snapshot paths) ───────────────── */

function textChunk(stream: "assistant" | "thinking", sid: string, kind: "text" | "reasoning", msgId: string, ordinal: number, text: string): OpencodeMappedChunk[] {
  if (text === "") return [];
  return [{ stream, data: text, lineUuid: `opencode:${sid}:${kind}:${msgId}:${ordinal}` }];
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

/** Accumulator shared by `snapshotToChunks` and `seedFromSnapshot`. */
interface SnapshotAcc {
  chunks: OpencodeMappedChunk[];
  usage: OpencodeUsageTotals;
  usageSeen: Set<string>;
  toolNames: Map<string, string>;
}

function walkSnapshot(messages: unknown[], opts: { sessionId: string; afterUserMessageId?: string }): SnapshotAcc {
  const acc: SnapshotAcc = { chunks: [], usage: emptyUsage(), usageSeen: new Set(), toolNames: new Map() };
  if (!Array.isArray(messages)) return acc;
  const sid = opts.sessionId;
  let start = 0;
  if (opts.afterUserMessageId) {
    const idx = messages.findIndex((m) => isRec(m) && m.id === opts.afterUserMessageId);
    // The anchor is not in this page: map nothing rather than flood the run with older history.
    // The caller pages until it finds the anchor.
    if (idx < 0) return acc;
    start = idx + 1;
  }
  for (let i = start; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRec(msg) || msg.type !== "assistant") continue; // user / idle / shell / compaction: nothing
    const msgId = str(msg.id);
    if (!msgId) continue;
    let textOrdinal = 0;
    let reasoningOrdinal = 0;
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const item of content) {
      if (!isRec(item)) continue;
      if (item.type === "text") {
        const ord = textOrdinal++;
        if (typeof item.text === "string") acc.chunks.push(...textChunk("assistant", sid, "text", msgId, ord, item.text));
      } else if (item.type === "reasoning") {
        const ord = reasoningOrdinal++;
        if (typeof item.text === "string") acc.chunks.push(...textChunk("thinking", sid, "reasoning", msgId, ord, item.text));
      } else if (item.type === "tool") {
        const callId = str(item.id);
        const name = str(item.name) ?? "tool";
        const state = isRec(item.state) ? item.state : null;
        if (!callId || !state) continue;
        acc.toolNames.set(callId, name);
        const status = state.status;
        if (status === "running" || status === "completed" || status === "error") {
          acc.chunks.push(toolUseChunk(sid, callId, name, state.input));
        }
        if (status === "completed") acc.chunks.push(toolResultChunk(sid, callId, resultContent(state.content, null), false));
        else if (status === "error") acc.chunks.push(toolResultChunk(sid, callId, resultContent(state.content, state.error), true));
        // "streaming": the input is incomplete; `session.tool.called` emits the tool_use live.
      }
    }
    if (msg.error !== undefined && !isAborted(msg.error)) {
      acc.chunks.push({ stream: "status", data: errorStatusData(msg.error), lineUuid: `opencode:${sid}:error:${msgId}` });
    }
    if (isRec(msg.tokens) && !acc.usageSeen.has(msgId)) {
      acc.usageSeen.add(msgId);
      addOpencodeTokens(acc.usage, msg.tokens, msg.cost);
      acc.chunks.push(usageChunk(sid, msgId, acc.usage));
    }
  }
  return acc;
}

/**
 * The chunks a message snapshot (`GET /api/session/{id}/message`, ascending) stands for: every
 * assistant message after the user message `afterUserMessageId` (all of them when omitted). User
 * messages and the trailing `idle` marker produce nothing. A tool still `running` yields only its
 * `tool_use`; a `streaming` one nothing. Usage is cumulative over the mapped window, so a mapper
 * seeded from the same window continues the same totals (`seedFromSnapshot`). When
 * `afterUserMessageId` is given but not present in `messages`, the result is empty.
 */
export function snapshotToChunks(
  messages: unknown[],
  opts: { sessionId: string; afterUserMessageId?: string },
): OpencodeMappedChunk[] {
  try {
    return walkSnapshot(messages, opts).chunks;
  } catch {
    return [];
  }
}

/* ── live mapper ──────────────────────────────────────────────────────────── */

export interface OpencodeEventMapper {
  /** Map one SSE envelope. Only events whose `data.sessionID` is this mapper's session map to chunks;
   *  a chunk whose line uuid was already produced (by a seeded snapshot or an earlier event) is dropped. */
  feed(e: OpencodeEventLike): OpencodeMappedChunk[];
  /** Set by `session.execution.succeeded | failed | interrupted`; cleared by `session.execution.started`. */
  terminal(): OpencodeTerminal | null;
  /** Cumulative token/cost totals for this mapper's lifetime (a turn), a copy. */
  usage(): OpencodeUsageTotals;
  /** Forget everything (terminal, usage, produced uuids, tool names): a new execution begins in the
   *  same session, e.g. a server wake with a fresh run. */
  reset(): void;
  /**
   * Catch-up: map `messages` like `snapshotToChunks`, and adopt what the live stream needs to stay
   * consistent with them: the produced uuids (so live events for the same content are dropped), the
   * cumulative usage (so the next step continues the total and an already-counted step is not added
   * twice) and the tool names (a live `tool.called` carries none). Returns the chunks to emit.
   */
  seedFromSnapshot(messages: unknown[], opts?: { afterUserMessageId?: string }): OpencodeMappedChunk[];
}

export function createOpencodeEventMapper(opts: { sessionId: string }): OpencodeEventMapper {
  const sid = opts.sessionId;
  let emitted = new Set<string>();
  let toolNames = new Map<string, string>();
  let usage = emptyUsage();
  let usageSeen = new Set<string>();
  let terminal: OpencodeTerminal | null = null;
  let lastErrorData: string | null = null;
  let executions = 0;

  function once(chunks: OpencodeMappedChunk[]): OpencodeMappedChunk[] {
    const out: OpencodeMappedChunk[] = [];
    for (const c of chunks) {
      if (emitted.has(c.lineUuid)) continue;
      emitted.add(c.lineUuid);
      out.push(c);
    }
    return out;
  }

  function mapEvent(type: string, d: Rec): OpencodeMappedChunk[] {
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
        // A failing step already printed the same line; do not repeat it.
        if (data === lastErrorData) return [];
        lastErrorData = data;
        return [{ stream: "status", data, lineUuid: `opencode:${sid}:error:execution:${executions}` }];
      }
      case "session.text.ended": {
        const msgId = str(d.assistantMessageID);
        const ord = ordinalOf(d.ordinal);
        if (!msgId || ord === null || typeof d.text !== "string") return [];
        return textChunk("assistant", sid, "text", msgId, ord, d.text);
      }
      case "session.reasoning.ended": {
        const msgId = str(d.assistantMessageID);
        const ord = ordinalOf(d.ordinal);
        if (!msgId || ord === null || typeof d.text !== "string") return [];
        return textChunk("thinking", sid, "reasoning", msgId, ord, d.text);
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
        return [toolUseChunk(sid, callId, toolNames.get(callId) ?? "tool", isRec(d.input) ? d.input : {})];
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

  return {
    feed(e) {
      try {
        if (!isRec(e) || typeof e.type !== "string") return [];
        const d = isRec(e.data) ? e.data : null;
        if (!d || d.sessionID !== sid) return [];
        return once(mapEvent(e.type, d));
      } catch {
        return [];
      }
    },
    terminal: () => (terminal ? { ...terminal } : null),
    usage: () => ({ ...usage }),
    reset() {
      emitted = new Set();
      toolNames = new Map();
      usage = emptyUsage();
      usageSeen = new Set();
      terminal = null;
      lastErrorData = null;
      executions = 0;
    },
    seedFromSnapshot(messages, seedOpts) {
      try {
        const acc = walkSnapshot(messages, { sessionId: sid, afterUserMessageId: seedOpts?.afterUserMessageId });
        for (const [id, name] of acc.toolNames) toolNames.set(id, name);
        // The server's messages are the truth for the window: rebuild the totals from them (a repeat
        // seed over an overlapping window must not add a step twice). A step seen live is in them too.
        usage = acc.usage;
        usageSeen = acc.usageSeen;
        return once(acc.chunks);
      } catch {
        return [];
      }
    },
  };
}

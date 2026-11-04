/**
 * Pure OpenCode mapping helpers shared by the tmux driver (`opencode-tmux.ts`, which re-exports them)
 * and the v2 server event mapper (`opencode-events.ts`). No db, fs or process access: importing this
 * module must never open the database.
 */
import type { FxUsagePayload, RunEventStream } from "../shared/types.ts";

export interface OpencodeSubagentNotice {
  childSessionId: string;
  description: string | null;
  agentType: string | null;
  toolUseId: string;
  background: boolean;
}


export interface OpencodeChunk {
  stream: RunEventStream;
  data: string;
  lineUuid?: string;
}


/** Running token/cost totals for one run (one turn). */
export interface OpencodeUsageTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}


export type Rec = Record<string, unknown>;
export function isRec(v: unknown): v is Rec {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
export function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}
export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}


/** `5h 3m` / `42s` for a `retryAfterMs` hint (v2 `provider.free-limit`). */
export function formatRetryAfter(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

/** The text of an `error` event: v2 `{type, message, retryAfterMs?}`, v1
 *  `{name, data:{message}}` (spike §2a, A4f). */
export function opencodeErrorMessage(err: unknown): string {
  if (typeof err === "string") return err || "OpenCode error";
  if (!isRec(err)) return "OpenCode error";
  const data = isRec(err.data) ? err.data : null;
  const msg = str(err.message) ?? (data ? str(data.message) : null) ?? str(err.name) ?? str(err.type) ?? "OpenCode error";
  const retry = num(err.retryAfterMs);
  return retry > 0 ? `${msg} (retry after ${formatRetryAfter(retry)})` : msg;
}

/**
 * `todowrite` input → the `TodoWrite` shape the TODO tracker reads
 * (`src/shared/todo-progress.ts`): `{content, status}` only — v1's
 * `priority` is dropped, and `cancelled` reads as `completed` so a plan
 * with a dropped item still finishes (plan Q12, spike A4e).
 */
export function normalizeOpencodeTodos(input: unknown): { todos: Array<{ content: string; status: string }> } {
  const raw = isRec(input) && Array.isArray(input.todos) ? input.todos : [];
  const todos: Array<{ content: string; status: string }> = [];
  for (const t of raw) {
    if (!isRec(t) || t.content == null) continue;
    const status = typeof t.status === "string" ? (t.status === "cancelled" ? "completed" : t.status) : "pending";
    todos.push({ content: String(t.content), status });
  }
  return { todos };
}

/** Tool name + input as agetor renders them: OpenCode's `todowrite` is
 *  surfaced as `TodoWrite` so the TODO tracker and board badge light up. */
export function normalizeOpencodeTool(tool: string, input: unknown): { name: string; input: unknown } {
  if (tool === "todowrite") return { name: "TodoWrite", input: normalizeOpencodeTodos(input) };
  return { name: tool, input: input ?? {} };
}

const V2_SUBAGENT_TEXT_RE = /sessionID[=:]\s*"?(ses_[A-Za-z0-9]+)/;
const V1_SUBAGENT_TEXT_RE = /<task id="(ses_[A-Za-z0-9]+)"/;

/**
 * A `subagent` (v2) / `task` (v1) tool call that names a child session
 * (spike Q12, A4d). The child id is read from the structured metadata
 * first — v2 run `state.metadata.metadata.sessionID`, v2 export
 * `state.metadata.sessionID`, v1 `state.metadata.sessionId` — then from
 * the output/error text. `null` for any other tool or when no id is found.
 */
export function detectOpencodeSubagent(
  tool: string,
  input: unknown,
  state: Rec,
  toolUseId: string,
  extraText: string = "",
): OpencodeSubagentNotice | null {
  if (tool !== "subagent" && tool !== "task") return null;
  const md = isRec(state.metadata) ? state.metadata : {};
  const inner = isRec(md.metadata) ? md.metadata : {};
  let child = str(inner.sessionID) ?? str(md.sessionID) ?? str(md.sessionId);
  if (!child) {
    const errText = typeof state.error === "string" ? state.error : isRec(state.error) ? str(state.error.message) ?? "" : "";
    const text = `${typeof state.output === "string" ? state.output : ""}\n${errText}\n${extraText}`;
    child = V2_SUBAGENT_TEXT_RE.exec(text)?.[1] ?? V1_SUBAGENT_TEXT_RE.exec(text)?.[1] ?? null;
  }
  if (!child) return null;
  const inp = isRec(input) ? input : {};
  return {
    childSessionId: child,
    description: str(inp.description),
    agentType: str(inp.agent) ?? str(inp.subagent_type),
    toolUseId,
    background: inp.background === true || inner.status === "running" || md.background === true,
  };
}

/**
 * The shared part → chunk rules (D-8, spike §2a), used by the live mapper
 * below and by the v1 export adapter (`opencode-export.ts` — v1 export
 * parts have the run shape; v2 export content needs its own adapter, A7).
 * Handles `text`, `reasoning` and terminal `tool` parts; step parts and
 * unknown types produce nothing.
 */
export function mapOpencodePart(part: unknown): { chunks: OpencodeChunk[]; subagent?: OpencodeSubagentNotice } {
  if (!isRec(part)) return { chunks: [] };
  const id = str(part.id);
  switch (part.type) {
    case "text": {
      const text = typeof part.text === "string" ? part.text : "";
      if (!id || text === "") return { chunks: [] };
      return { chunks: [{ stream: "assistant", data: text, lineUuid: `opencode:text:${id}` }] };
    }
    case "reasoning": {
      const text = typeof part.text === "string" ? part.text : "";
      if (!id || text === "") return { chunks: [] };
      return { chunks: [{ stream: "thinking", data: text, lineUuid: `opencode:reasoning:${id}` }] };
    }
    case "tool": {
      const state = isRec(part.state) ? part.state : null;
      if (!state) return { chunks: [] };
      const status = state.status;
      if (status !== "completed" && status !== "error") return { chunks: [] };
      // v2: `partID` = prt_…, `id` = provider call id. v1: `id` = prt_…,
      // `callID` = call id (spike Q3a, A4a).
      const partKey = str(part.partID) ?? id;
      const toolUseId = str(part.callID) ?? id;
      if (!partKey || !toolUseId) return { chunks: [] };
      const tool = str(part.tool) ?? "tool";
      const mapped = normalizeOpencodeTool(tool, state.input);
      const rawTitle = str(state.title);
      const title = rawTitle && rawTitle !== tool && rawTitle !== mapped.name ? rawTitle : undefined;
      const output = typeof state.output === "string" ? state.output : null;
      const err = typeof state.error === "string" ? state.error : isRec(state.error) ? str(state.error.message) : null;
      const content = output ?? err ?? "";
      const chunks: OpencodeChunk[] = [
        {
          stream: "tool_use",
          data: JSON.stringify({ id: toolUseId, name: mapped.name, input: mapped.input, serverSide: false, title }),
          lineUuid: `opencode:tool:${partKey}:use`,
        },
        {
          stream: "tool_result",
          data: JSON.stringify({ toolUseId, content, isError: status === "error" }),
          lineUuid: `opencode:tool:${partKey}:result`,
        },
      ];
      const subagent = detectOpencodeSubagent(tool, state.input, state, toolUseId) ?? undefined;
      return subagent ? { chunks, subagent } : { chunks };
    }
    default:
      return { chunks: [] };
  }
}

/** The usage chip's sentinel body for running totals. */
export function opencodeUsagePayload(u: OpencodeUsageTotals): FxUsagePayload {
  return {
    turn: {
      inputTokens: u.input,
      outputTokens: u.output,
      reasoningTokens: u.reasoning,
      cacheReadTokens: u.cacheRead,
      cacheWriteTokens: u.cacheWrite,
    },
    cost: { amount: u.cost, currency: "USD" },
  };
}

function addTokens(u: OpencodeUsageTotals, tokens: unknown, cost: unknown): void {
  if (isRec(tokens)) {
    u.input += num(tokens.input);
    u.output += num(tokens.output);
    u.reasoning += num(tokens.reasoning);
    const cache = isRec(tokens.cache) ? tokens.cache : {};
    u.cacheRead += num(cache.read);
    u.cacheWrite += num(cache.write);
  }
  u.cost += num(cost);
}
export { addTokens as addOpencodeTokens };

/**
 * Cursor via `cursor-agent acp`: one piped child per turn, NDJSON JSON-RPC
 * on stdio. `cursor/ask_question` blocks on the same ask card Claude uses.
 * There is no mid-turn reattach — a restart rebuilds open rows from
 * `cursor_asks` and the next user message carries the answer.
 *
 * The in-process answer is flat (`CursorAskAnswer`). The RPC result is
 * nested (`{ outcome: { outcome, answers? } }`), which is what this CLI
 * build's ask handler reads.
 *
 * Plan and ask (no `--force`) ask `session/request_permission` before shell,
 * read, edit, delete, and MCP. This build treats JSON-RPC `-32601` as a
 * denial, so those requests are answered `allow-once` — the same unprompted
 * allow print mode already used. A killed turn answers `cancelled`.
 *
 * `tool_call_update` carries the grown `rawInput` and, on `completed` /
 * `failed`, `rawOutput` / `content`. The started `tool_use` row is rewritten
 * in place (a second insert would move `detectCursorPlan` off the plan).
 * Ask and plan calls keep a pinned shape. A later update of the same kind
 * replaces that pin only when its payload is longer: Cursor streams
 * `rawInput` through `refreshToolCall` before the body is complete, and the
 * completed update does not resend it. A shorter or equal replay must not
 * clobber a fuller payload.
 *
 * `session/load` replays the prior transcript as `session/update`s before
 * its result, and `session/new` can emit updates during the handshake.
 * Those lines are dropped until that result line is seen. The gate opens
 * on the result line itself, so a later line in the same stdout chunk is
 * this turn's own update.
 */
import type { Subprocess } from "bun";
import { childEnv, coreSpawn } from "./core-spawn.ts";
import { CURSOR_ASK_RESUME } from "../shared/cursor-ask-verdict.ts";
import { FX_USAGE_STATUS_PREFIX } from "../shared/types.ts";
import type { ChunkHandler, SpawnedAgent } from "./claude-tmux.ts";
import { listOpenCursorAsks, runs } from "./db.ts";
import {
  cancelPendingForTask,
  registerCursorAskQuestions,
  retargetLiveCursorAsksForRun,
  type CursorAskAnswer,
  type CursorAskQuestionInput,
} from "./interactions.ts";

/** Prompt marker the fake driver blocks on. `:2` registers two cards. */
export const FAKE_CURSOR_ASK_PROMPT_MARKER = "__agetor_fake_cursor_ask__";

const RPC_HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_STDOUT_BUFFER_BYTES = 8 * 1024 * 1024;

/** Attempts to write a `cursor/ask_question` result after the card was
 *  registered. Counted before the write so a throw on a dead stdin still
 *  counts. A settle that only retargets the card must not increase this. */
let askResultWrites = 0;

export function cursorAskResultWriteCount(): number {
  return askResultWrites;
}

export interface CursorAcpLaunch {
  taskId: string;
  runId: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  promptText: string;
  /** `"plan"` and `"ask"` send `session/set_mode`. `"auto"` does not — `--force` is argv. */
  mode: string | null;
  /** The same model string `cursorModelArg` builds. Empty skips `session/set_config_option`. */
  model: string;
  resumeSessionId?: string;
  onChunk: ChunkHandler;
  onSessionId?: (id: string) => void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`cursor acp: ${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * `session/request_permission` result. `allow-once` is the option id this
 * CLI's decision provider treats as approved. Anything else, including
 * `-32601`, is a denial.
 */
export function cursorPermissionRpcResult(cancelled: boolean): Record<string, unknown> {
  if (cancelled) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: "allow-once" } };
}

/** Nested ACP result. A flat `{ outcome: "answered" }` is treated as cancelled by the CLI. */
export function cursorAskRpcResult(answer: CursorAskAnswer): Record<string, unknown> {
  if (answer.outcome === "answered") {
    return {
      outcome: {
        outcome: "answered",
        answers: answer.answers.map((a) => ({
          questionId: a.questionId,
          selectedOptionIds: a.selectedOptionIds,
          ...(a.freeformText !== undefined ? { freeformText: a.freeformText } : {}),
        })),
      },
    };
  }
  if (answer.outcome === "skipped") return { outcome: { outcome: "skipped" } };
  return { outcome: { outcome: "cancelled" } };
}

function questionsFromRpc(params: unknown): CursorAskQuestionInput[] {
  if (!isRecord(params) || !Array.isArray(params.questions)) return [];
  const out: CursorAskQuestionInput[] = [];
  for (const raw of params.questions) {
    if (!isRecord(raw) || typeof raw.id !== "string") continue;
    const options: Array<{ id: string; label: string }> = [];
    if (Array.isArray(raw.options)) {
      for (const opt of raw.options) {
        if (!isRecord(opt) || typeof opt.id !== "string" || typeof opt.label !== "string") continue;
        options.push({ id: opt.id, label: opt.label });
      }
    }
    out.push({
      id: raw.id,
      prompt: typeof raw.prompt === "string" ? raw.prompt : "",
      ...(typeof raw.promptMarkdown === "string" ? { promptMarkdown: raw.promptMarkdown } : {}),
      allowMultiple: raw.allowMultiple === true,
      options,
    });
  }
  return out;
}

function chunkText(update: Record<string, unknown>): string {
  const content = update.content;
  if (typeof content === "string") return content;
  if (isRecord(content) && typeof content.text === "string") return content.text;
  if (typeof update.text === "string") return update.text;
  return "";
}

class TurnText {
  private assistant = "";
  private thinking = "";
  private assistantN = 0;
  private thinkingN = 0;

  constructor(
    private readonly runId: string,
    private readonly emit: ChunkHandler,
  ) {}

  assistantDelta(text: string): void {
    if (!text) return;
    this.flushThinking();
    this.assistant += text;
  }

  thinkingDelta(text: string): void {
    if (!text) return;
    this.flushAssistant();
    this.thinking += text;
  }

  flush(): void {
    this.flushAssistant();
    this.flushThinking();
  }

  private flushAssistant(): void {
    if (!this.assistant) return;
    this.emit("assistant", this.assistant, `acp:${this.runId}:a:${this.assistantN++}`);
    this.assistant = "";
  }

  private flushThinking(): void {
    if (!this.thinking) return;
    this.emit("thinking", this.thinking, `acp:${this.runId}:t:${this.thinkingN++}`);
    this.thinking = "";
  }
}

/**
 * `session/prompt` on cursor-agent 2026.10.22-27dcf5f returns only
 * `{ stopReason }`. `presentInteractionUpdate` never forwards `turnEnded`,
 * which is where print mode's token counts live, and it never emits
 * `usage`. This still records `result.usage` when a later CLI attaches it.
 * `usage_update` is a context-window gauge (`size` / `used`), not tokens.
 */
function emitUsage(runId: string, result: unknown, emit: ChunkHandler): void {
  if (!isRecord(result) || !isRecord(result.usage)) return;
  const usage = result.usage;
  const keys = ["inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens"] as const;
  if (!keys.some((k) => typeof usage[k] === "number")) return;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const payload = {
    turn: {
      inputTokens: num(usage.inputTokens),
      outputTokens: num(usage.outputTokens),
      cacheReadTokens: num(usage.cachedReadTokens),
      cacheWriteTokens: num(usage.cachedWriteTokens),
    },
  };
  emit("status", FX_USAGE_STATUS_PREFIX + JSON.stringify(payload), `acp:${runId}:usage`);
}

/**
 * Re-register every unanswered `cursor_asks` row. Does not insert a new row
 * and does not scan `run_events`. `follow-up` (the recorded verdict) delivers
 * the answer as the next user message.
 */
export function rebuildOpenCursorAsks(): void {
  const delivery = CURSOR_ASK_RESUME === "restores-request" ? "live" : "restart-followup";
  for (const row of listOpenCursorAsks()) {
    const questions: CursorAskQuestionInput[] = [];
    for (const raw of row.payload.questions) {
      if (!isRecord(raw) || typeof raw.id !== "string") continue;
      const options: Array<{ id: string; label: string }> = [];
      if (Array.isArray(raw.options)) {
        for (const opt of raw.options) {
          if (!isRecord(opt) || typeof opt.id !== "string" || typeof opt.label !== "string") continue;
          options.push({ id: opt.id, label: opt.label });
        }
      }
      questions.push({
        id: raw.id,
        prompt: typeof raw.prompt === "string" ? raw.prompt : "",
        ...(typeof raw.promptMarkdown === "string" ? { promptMarkdown: raw.promptMarkdown } : {}),
        allowMultiple: raw.allowMultiple === true,
        options,
      });
    }
    registerCursorAskQuestions({
      taskId: row.taskId,
      runId: row.runId,
      toolCallId: row.toolCallId,
      title: row.payload.title,
      questions,
      delivery,
      ...(delivery === "restart-followup" ? { followupCause: "restart" as const } : {}),
      persist: false,
    });
  }
}

const FAKE_CARDS: Array<{
  toolCallId: string;
  title: string;
  questions: CursorAskQuestionInput[];
}> = [
  {
    toolCallId: "fake-ask-1",
    title: "Pick one",
    questions: [{
      id: "q1",
      prompt: "Which option?",
      allowMultiple: false,
      options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }],
    }],
  },
  {
    toolCallId: "fake-ask-2",
    title: "Pick two",
    questions: [{
      id: "q2",
      prompt: "Which other?",
      allowMultiple: false,
      options: [{ id: "c", label: "Gamma" }, { id: "d", label: "Delta" }],
    }],
  },
];

function pinnedAsk(toolCallId: string, title: string, questions: unknown[]): string {
  return JSON.stringify({
    id: toolCallId,
    name: "askQuestionToolCall",
    input: {
      askQuestionToolCall: { args: { title, questions } },
      toolCallId,
    },
    serverSide: false,
  });
}

function fakeAskResultContent(answer: CursorAskAnswer): unknown {
  if (answer.outcome === "answered") return { answered: true, answers: answer.answers };
  return answer.outcome;
}

/** Blocks until every fake card is answered, skipped, or cancelled.
 *  Each settlement writes the `tool_result` a live child would send as
 *  `tool_call_update` `completed`. `kill` records that result itself
 *  before the awaiter resolves, so this path does not write a second one. */
export function spawnFakeCursorAsk(opts: {
  taskId: string;
  runId: string;
  prompt: string;
  onChunk: ChunkHandler;
}): SpawnedAgent {
  const count = opts.prompt.includes(`${FAKE_CURSOR_ASK_PROMPT_MARKER}:2`) ? 2 : 1;
  const cards = FAKE_CARDS.slice(0, count);
  let killed = false;
  const answers = cards.map((card) => {
    opts.onChunk(
      "tool_use",
      pinnedAsk(card.toolCallId, card.title, card.questions),
      `tool_call:${card.toolCallId}:started`,
    );
    return registerCursorAskQuestions({
      taskId: opts.taskId,
      runId: opts.runId,
      toolCallId: card.toolCallId,
      title: card.title,
      questions: card.questions,
      delivery: "live",
    }).answer.then((answer) => {
      if (!killed) {
        opts.onChunk(
          "tool_result",
          JSON.stringify({
            toolUseId: card.toolCallId,
            content: fakeAskResultContent(answer),
            isError: false,
          }),
          `tool_call:${card.toolCallId}:completed`,
        );
      }
      return answer;
    });
  });
  const done = Promise.all(answers).then((settled) => {
    if (killed || settled.some((a) => a.outcome === "cancelled")) return 1;
    opts.onChunk("assistant", "ok", `acp:${opts.runId}:fake-done`);
    return 0;
  });
  return {
    kill() {
      killed = true;
      cancelPendingForTask(opts.taskId, "cancelled");
    },
    writeInput() {
      return false;
    },
    done,
  };
}

export function spawnCursorViaAcp(opts: CursorAcpLaunch): SpawnedAgent {
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });
  let settled = false;
  let killed = false;
  let userCancelled = false;
  let askInFlight = 0;
  let sessionId: string | null = opts.resumeSessionId ?? null;
  /** False until the `session/new` or `session/load` result line is seen.
   *  History replayed before that result must not be written into this run. */
  let acceptSessionUpdates = false;
  let sessionRpcId: number | undefined;
  const emittedTools = new Set<string>();
  /** `"ask"` / `"plan"` keep the pinned tool_use and may grow it.
   *  `"generic"` may be rewritten on every larger or different payload. */
  const toolKind = new Map<string, "ask" | "plan" | "generic">();
  const toolPayload = new Map<string, string>();
  const resultEmitted = new Set<string>();
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  const text = new TurnText(opts.runId, opts.onChunk);

  const proc = coreSpawn(opts.argv, {
    cwd: opts.cwd,
    env: childEnv(opts.env),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as Subprocess<"pipe", "pipe", "pipe">;

  function writeLine(msg: unknown): void {
    proc.stdin.write(`${JSON.stringify(msg)}\n`);
    const sink = proc.stdin as { flush?: () => void | Promise<unknown> };
    try {
      sink.flush?.();
    } catch {
      /* a closed stdin flush is the same as a failed write */
    }
  }

  function settle(code: number): void {
    if (settled) return;
    settled = true;
    text.flush();
    // The child can no longer read a live RPC result. Leave the row open
    // and point this run's card at the follow-up, with cause `child-exit`,
    // so a later submit is a user message rather than an answer reported
    // against a dead stdin. The boot rebuild uses cause `restart` instead.
    try {
      retargetLiveCursorAsksForRun(opts.runId);
    } catch {
      /* the card registry must not keep a dead turn alive */
    }
    const err = new Error("cursor acp settled");
    for (const waiter of pending.values()) waiter.reject(err);
    pending.clear();
    resolveDone(code);
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }

  function fail(message: string): void {
    if (!settled) {
      try {
        opts.onChunk("status", message);
      } catch {
        /* a chunk handler must not keep the turn alive */
      }
      try {
        opts.onChunk("stderr", message);
      } catch {
        /* same */
      }
    }
    settle(1);
  }

  function sendRpc(method: string, params: unknown): Promise<unknown> {
    const id = nextId++;
    if (method === "session/new" || method === "session/load") sessionRpcId = id;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        writeLine({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  function emitPinned(toolCallId: string, kind: "ask" | "plan", data: string): void {
    if (!toolCallId) return;
    const current = toolKind.get(toolCallId);
    const other = kind === "ask" ? "plan" : "ask";
    if (current === other) return;
    if (current === kind) {
      const prev = toolPayload.get(toolCallId);
      if (prev !== undefined && data.length <= prev.length) return;
    }
    const uuid = `tool_call:${toolCallId}:started`;
    // A partial tool_call can arrive before `_toolName` says this is an ask
    // or a plan, and a later partial of the same kind can carry a longer
    // body. Replace that row instead of leaving the first payload in place.
    if (emittedTools.has(toolCallId)) runs.replaceMainEventDataByLineUuid(opts.runId, uuid, data);
    emittedTools.add(toolCallId);
    toolKind.set(toolCallId, kind);
    toolPayload.set(toolCallId, data);
    opts.onChunk("tool_use", data, uuid);
  }

  function emitAsk(toolCallId: string, title: string, questions: unknown[]): void {
    emitPinned(toolCallId, "ask", pinnedAsk(toolCallId, title, questions));
  }

  function emitPlan(toolCallId: string, name: string, plan: string): void {
    emitPinned(
      toolCallId,
      "plan",
      JSON.stringify({
        id: toolCallId,
        name: "createPlanToolCall",
        input: { createPlanToolCall: { args: { name, plan } } },
        serverSide: false,
      }),
    );
  }

  function publishGenericTool(toolCallId: string, name: string, input: unknown): void {
    if (!toolCallId || toolKind.get(toolCallId) === "ask" || toolKind.get(toolCallId) === "plan") return;
    const data = JSON.stringify({ id: toolCallId, name, input, serverSide: false });
    const prev = toolPayload.get(toolCallId);
    if (prev === data) return;
    const uuid = `tool_call:${toolCallId}:started`;
    // Rewrite the started row. A second insert would become lastToolUseData
    // and hide a later createPlanToolCall from detectCursorPlan.
    if (prev !== undefined) runs.replaceMainEventDataByLineUuid(opts.runId, uuid, data);
    toolPayload.set(toolCallId, data);
    toolKind.set(toolCallId, "generic");
    emittedTools.add(toolCallId);
    opts.onChunk("tool_use", data, uuid);
  }

  function onToolCall(update: Record<string, unknown>): void {
    text.flush();
    const toolCallId = asString(update.toolCallId) ?? "";
    const raw = isRecord(update.rawInput) ? update.rawInput : {};
    const toolName = asString(raw._toolName);
    if (toolName === "askQuestion" || toolName === "askQuestionToolCall") {
      emitAsk(toolCallId, asString(raw.title) ?? "", Array.isArray(raw.questions) ? raw.questions : []);
      return;
    }
    if (toolName === "createPlan" || toolName === "createPlanToolCall") {
      emitPlan(toolCallId, asString(raw.name) ?? "", asString(raw.plan) ?? "");
      return;
    }
    if (toolCallId) publishGenericTool(toolCallId, toolName ?? asString(update.title) ?? "tool", raw);
  }

  function toolResultContent(update: Record<string, unknown>): unknown {
    if ("rawOutput" in update && update.rawOutput !== undefined) return update.rawOutput;
    if ("content" in update && update.content !== undefined) return update.content;
    return "";
  }

  function onToolCallUpdate(update: Record<string, unknown>): void {
    text.flush();
    const toolCallId = asString(update.toolCallId) ?? "";
    if (!toolCallId) return;
    // A revision after the result becomes a second live `tool_use` (same
    // line uuid, so the row is rewritten, but the chunk is still broadcast).
    // The rendered card is that later row, and a result-only search has no
    // `data-evid` on it. The completing update still publishes rawInput
    // first, then the result, in this same call.
    if (!resultEmitted.has(toolCallId)) {
      const raw = isRecord(update.rawInput) ? update.rawInput : undefined;
      const toolName = raw ? asString(raw._toolName) : undefined;
      if (toolName === "askQuestion" || toolName === "askQuestionToolCall") {
        emitAsk(toolCallId, asString(raw?.title) ?? "", Array.isArray(raw?.questions) ? raw.questions : []);
      } else if (toolName === "createPlan" || toolName === "createPlanToolCall") {
        emitPlan(toolCallId, asString(raw?.name) ?? "", asString(raw?.plan) ?? "");
      } else if (raw && toolKind.get(toolCallId) !== "ask" && toolKind.get(toolCallId) !== "plan") {
        publishGenericTool(toolCallId, toolName ?? asString(update.title) ?? "tool", raw);
      } else if (!emittedTools.has(toolCallId)) {
        publishGenericTool(toolCallId, asString(update.title) ?? "tool", raw ?? {});
      }
    }
    const status = asString(update.status);
    if ((status !== "completed" && status !== "failed") || resultEmitted.has(toolCallId)) return;
    resultEmitted.add(toolCallId);
    opts.onChunk(
      "tool_result",
      JSON.stringify({
        toolUseId: toolCallId,
        content: toolResultContent(update),
        isError: status === "failed",
      }),
      `tool_call:${toolCallId}:completed`,
    );
  }

  function onUpdate(update: Record<string, unknown>): void {
    const kind = asString(update.sessionUpdate);
    if (kind === "agent_message_chunk") {
      text.assistantDelta(chunkText(update));
      return;
    }
    if (kind === "agent_thought_chunk") {
      text.thinkingDelta(chunkText(update));
      return;
    }
    if (kind === "tool_call") {
      onToolCall(update);
      return;
    }
    if (kind === "tool_call_update") {
      onToolCallUpdate(update);
      return;
    }
    // `usage_update` is a context-window gauge, not token counts.
    if (kind === "usage_update") text.flush();
  }

  async function handleRequest(id: unknown, method: string, params: unknown): Promise<void> {
    if (method === "session/request_permission") {
      try {
        writeLine({
          jsonrpc: "2.0",
          id,
          result: cursorPermissionRpcResult(killed || userCancelled || settled),
        });
      } catch {
        /* the child is gone */
      }
      return;
    }
    if (method !== "cursor/ask_question") {
      try {
        writeLine({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      } catch {
        /* the child is gone */
      }
      return;
    }
    // A line already sitting in the stdout buffer is parsed after `kill()`.
    // `kill` has cancelled every card that existed at that moment; registering
    // this one would put a question back on a turn that is already stopping.
    // Answer cancelled and leave the registry alone.
    if (killed || settled) {
      try {
        writeLine({ jsonrpc: "2.0", id, result: cursorAskRpcResult({ outcome: "cancelled" }) });
      } catch {
        /* the child is gone */
      }
      return;
    }
    const toolCallId = isRecord(params) ? asString(params.toolCallId) ?? "" : "";
    if (!toolCallId) {
      try {
        writeLine({ jsonrpc: "2.0", id, result: cursorAskRpcResult({ outcome: "cancelled" }) });
      } catch {
        /* the child is gone */
      }
      return;
    }
    const title = isRecord(params) ? asString(params.title) ?? "" : "";
    const questions = questionsFromRpc(params);
    emitAsk(toolCallId, title, questions);
    const registered = registerCursorAskQuestions({
      taskId: opts.taskId,
      runId: opts.runId,
      toolCallId,
      title,
      questions,
      delivery: "live",
    });
    askInFlight++;
    try {
      const answer = await registered.answer;
      // settle() already retargeted this card and may have killed the child.
      // A write here would report the answer to a process that has exited.
      if (settled) return;
      if (answer.outcome === "cancelled") userCancelled = true;
      try {
        askResultWrites++;
        writeLine({ jsonrpc: "2.0", id, result: cursorAskRpcResult(answer) });
      } catch {
        /* kill already closed stdin */
      }
    } finally {
      askInFlight--;
      // The reply is in the pipe. Killing in this same turn can SIGKILL the
      // child before it reads the cancelled result, so the turn ends on the
      // next tick instead — still a non-zero settle, never a success.
      if (killed) setTimeout(() => settle(1), 50);
    }
  }

  function handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) return;
      msg = parsed;
    } catch {
      return;
    }
    const id = msg.id;
    const isReply =
      id !== undefined
      && pending.has(id as number)
      && (Object.prototype.hasOwnProperty.call(msg, "result") || Object.prototype.hasOwnProperty.call(msg, "error"));
    if (isReply) {
      const waiter = pending.get(id as number)!;
      pending.delete(id as number);
      if (msg.error) {
        const err = isRecord(msg.error) ? asString(msg.error.message) ?? "rpc error" : "rpc error";
        waiter.reject(new Error(err));
      } else {
        // Open on this line, not when the await resumes. A live update can
        // share the stdout chunk with the session result and would otherwise
        // be dropped as replay.
        if (id === sessionRpcId) acceptSessionUpdates = true;
        waiter.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string" && id !== undefined) {
      void handleRequest(id, msg.method, msg.params);
      return;
    }
    if (msg.method === "session/update" && isRecord(msg.params)) {
      if (!acceptSessionUpdates) return;
      const update = isRecord(msg.params.update) ? msg.params.update : msg.params;
      onUpdate(update);
    }
  }

  void (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim().length > 0) handleLine(line);
        }
        if (buf.length * 3 >= MAX_STDOUT_BUFFER_BYTES && Buffer.byteLength(buf, "utf8") > MAX_STDOUT_BUFFER_BYTES) {
          fail(`cursor acp: stdout exceeded ${MAX_STDOUT_BUFFER_BYTES} bytes without a newline`);
          return;
        }
      }
    } catch {
      /* stream closed on process exit */
    }
    if (!settled) settle(1);
  })();

  void (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        const textChunk = decoder.decode(value, { stream: true });
        for (const raw of textChunk.split("\n")) {
          const line = raw.trim();
          if (line) opts.onChunk("stderr", line);
        }
      }
    } catch {
      /* closed */
    }
  })();

  void proc.exited.then((code) => {
    if (!settled) settle(typeof code === "number" ? code : 1);
  });

  void (async () => {
    try {
      await withTimeout(
        sendRpc("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "agetor", version: "0" },
        }),
        RPC_HANDSHAKE_TIMEOUT_MS,
        "initialize",
      );
      if (settled) return;

      const sessionMethod = opts.resumeSessionId ? "session/load" : "session/new";
      const sessionParams = opts.resumeSessionId
        ? { sessionId: opts.resumeSessionId, cwd: opts.cwd, mcpServers: [] }
        : { cwd: opts.cwd, mcpServers: [] };
      const sessionResult = await withTimeout(
        sendRpc(sessionMethod, sessionParams),
        RPC_HANDSHAKE_TIMEOUT_MS,
        sessionMethod,
      );
      if (settled) return;
      const reported = isRecord(sessionResult) ? asString(sessionResult.sessionId) : undefined;
      sessionId = reported ?? opts.resumeSessionId ?? null;
      if (!sessionId) {
        fail("cursor acp: session response had no sessionId");
        return;
      }
      opts.onSessionId?.(sessionId);

      if (opts.model.trim().length > 0) {
        await withTimeout(
          sendRpc("session/set_config_option", { sessionId, configId: "model", value: opts.model }),
          RPC_HANDSHAKE_TIMEOUT_MS,
          "session/set_config_option",
        );
        if (settled) return;
      }

      if (opts.mode === "plan" || opts.mode === "ask") {
        await withTimeout(
          sendRpc("session/set_mode", { sessionId, modeId: opts.mode }),
          RPC_HANDSHAKE_TIMEOUT_MS,
          "session/set_mode",
        );
        if (settled) return;
      }

      const promptResult = await sendRpc("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: opts.promptText }],
      });
      if (settled) return;
      text.flush();
      emitUsage(opts.runId, promptResult, opts.onChunk);
      const stop = isRecord(promptResult) ? asString(promptResult.stopReason) : undefined;
      const ok = !killed && !userCancelled && (stop === "end_turn" || stop === undefined);
      settle(ok ? 0 : 1);
    } catch (err) {
      if (settled) return;
      const message = err instanceof Error ? err.message : String(err);
      fail(message);
    }
  })();

  return {
    kill() {
      killed = true;
      try {
        cancelPendingForTask(opts.taskId, "cancelled");
      } catch {
        /* the card registry must not keep a killed turn alive */
      }
      if (sessionId) {
        try {
          writeLine({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
        } catch {
          /* stdin already closed */
        }
      }
      if (askInFlight === 0) settle(1);
    },
    writeInput() {
      return false;
    },
    done,
  };
}

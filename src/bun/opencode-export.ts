import { existsSync } from "node:fs";
import { coreSpawn } from "./core-spawn.ts";
import type { RunEventStream } from "../shared/types.ts";
import {
  addOpencodeTokens,
  mapOpencodePart,
  normalizeOpencodeTool,
  opencodeErrorMessage,
  type OpencodeUsageTotals,
} from "./opencode-tmux.ts";

/**
 * OpenCode session exports (`docs/plans/add-opencode-harness.md` D-12),
 * shared by the subagent tabs (`opencode-subagents.ts`) and session import
 * so the two can't drift.
 *
 * There are TWO shapes (spike §2c/§2d, amendment A7):
 *  - v2 `opencode session export [--standalone] <id>` →
 *    `{info, messages:[{type:"user"|"assistant"|"idle", content:[…]}]}`.
 *    Content items carry no part id, so their line uuid is
 *    `opencode:<messageId>:<index>` (a tool pair `…:<index>:use|result`).
 *    Tool fields differ from the run stream (`name`, `state.content[].text`,
 *    `state.error.message`), so v2 has its own content → chunk adapter.
 *  - v1 `opencode export <id>` (top-level command; stderr gets
 *    `Exporting session: <id>`) → `{info, messages:[{info, parts}]}` whose
 *    parts are run-shaped, so they go through the live mapper's shared
 *    `mapOpencodePart` and keep its `opencode:<type>:<partId>` uuids.
 */

/** A parsed export; `raw` is the CLI's JSON, shape-checked to `{info, messages[]}`. */
export type OpencodeExport = { major: 1 | 2; raw: unknown };

export interface OpencodeExportEvent {
  stream: RunEventStream;
  data: string;
  lineUuid: string;
}

export interface OpencodeExportSummary {
  sessionId: string;
  title: string | null;
  directory: string | null;
  /** `providerID/id` */
  model: string | null;
  variant: string | null;
  agent: string | null;
  firstUserText: string | null;
  updatedAt: number | null;
  createdAt: number | null;
  complete: boolean;
}

export interface RunOpencodeExportArgs {
  sessionId: string;
  bin: string;
  env: Record<string, string>;
  cwd: string;
  major: 1 | 2;
  standalone: boolean;
  timeoutMs?: number;
}

type Rec = Record<string, unknown>;
function isRec(v: unknown): v is Rec {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function infoOf(exp: OpencodeExport): Rec {
  return isRec(exp.raw) && isRec(exp.raw.info) ? exp.raw.info : {};
}
function messagesOf(exp: OpencodeExport): unknown[] {
  return isRec(exp.raw) && Array.isArray(exp.raw.messages) ? exp.raw.messages : [];
}
/** v1 message → its `info` record. */
function v1Info(m: unknown): Rec {
  return isRec(m) && isRec(m.info) ? m.info : {};
}
function v1Parts(m: unknown): unknown[] {
  return isRec(m) && Array.isArray(m.parts) ? m.parts : [];
}

/** The export command line for each OpenCode line (spike A6c). */
export function opencodeExportArgv(a: { bin: string; sessionId: string; major: 1 | 2; standalone: boolean }): string[] {
  return a.major === 1
    ? [a.bin, "export", a.sessionId]
    : [a.bin, "session", "export", ...(a.standalone ? ["--standalone"] : []), a.sessionId];
}

/** Parse an export's stdout. Tolerates leading/trailing chatter around the
 *  JSON object; `null` unless it is `{info:{id…}, messages:[…]}`. */
export function parseOpencodeExport(text: string, major: 1 | 2): OpencodeExport | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      raw = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (!isRec(raw) || !isRec(raw.info) || !str(raw.info.id) || !Array.isArray(raw.messages)) return null;
  return { major, raw };
}

type ExportRunner = (a: RunOpencodeExportArgs) => Promise<OpencodeExport | null>;
let exportRunnerOverride: ExportRunner | null = null;

const DEFAULT_EXPORT_TIMEOUT_MS = 10_000;

async function defaultExportRunner(a: RunOpencodeExportArgs): Promise<OpencodeExport | null> {
  const argv = opencodeExportArgv(a);
  const env: Record<string, string | undefined> = { ...process.env, ...a.env };
  env.OPENCODE_DISABLE_AUTOUPDATE ??= "1";
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    // coreSpawn: `opencode` is agent-plantable and its cwd may sit in a
    // macOS-protected folder, so it runs disclaimed, never as Agetor.
    proc = coreSpawn(argv, {
      cwd: a.cwd && existsSync(a.cwd) ? a.cwd : undefined,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return null;
  }
  // Race the read against the deadline rather than only killing on it: a
  // grandchild that inherited stdout (a hung helper) would otherwise keep the
  // pipe open — and the read pending — past the kill.
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* noop */ }
      resolve(null);
    }, a.timeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS);
  });
  const read = (async (): Promise<OpencodeExport | null> => {
    const [out] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0) return null;
    return parseOpencodeExport(out, a.major);
  })().catch(() => null);
  try {
    return await Promise.race([read, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The canned complete v2 child export the fake driver's subagent scenario
 *  reads back (`AGETOR_OPENCODE_DRIVER=fake`, ids starting `ses_fakechild`). */
export function fakeOpencodeChildExport(sessionId: string, cwd: string): OpencodeExport {
  const now = Date.now();
  const model = { id: "big-pickle", providerID: "opencode", variant: "default" };
  return {
    major: 2,
    raw: {
      info: {
        id: sessionId,
        parentID: "ses_fakeparent",
        projectID: "global",
        agent: "explore",
        title: "Fake subagent",
        model,
        cost: 0,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        outcome: "succeeded",
        time: { created: now - 2_000, updated: now - 10, idle: now },
        location: { directory: cwd },
      },
      messages: [
        { id: `msg_${sessionId}_u`, type: "user", text: "List the files in the current directory.", files: [], time: { created: now - 2_000 } },
        {
          id: `msg_${sessionId}_a1`,
          type: "assistant",
          agent: "explore",
          model,
          finish: "tool-calls",
          cost: 0,
          tokens: { input: 6, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now - 1_900, completed: now - 1_000 },
          content: [
            { type: "text", text: "Looking at the directory." },
            {
              type: "tool",
              id: `call_${sessionId}`,
              name: "read",
              executed: false,
              state: { status: "completed", input: { path: cwd }, content: [{ type: "text", text: "a.txt\nb.txt" }] },
            },
          ],
        },
        {
          id: `msg_${sessionId}_a2`,
          type: "assistant",
          agent: "explore",
          model,
          finish: "stop",
          cost: 0,
          tokens: { input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now - 900, completed: now - 10 },
          content: [{ type: "text", text: "The directory has a.txt and b.txt." }],
        },
        { id: `msg_${sessionId}_i`, type: "idle", outcome: "succeeded", time: { created: now } },
      ],
    },
  };
}

/** Run the export command (bounded by `timeoutMs`, default 10 s). Null on any
 *  failure — a missing binary, non-zero exit, a timeout or unparsable output. */
export async function runOpencodeExport(a: RunOpencodeExportArgs): Promise<OpencodeExport | null> {
  if (exportRunnerOverride) return exportRunnerOverride(a);
  if (process.env.AGETOR_OPENCODE_DRIVER === "fake" && a.sessionId.startsWith("ses_fakechild")) {
    return fakeOpencodeChildExport(a.sessionId, a.cwd);
  }
  return defaultExportRunner(a);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Export → events.
 * ────────────────────────────────────────────────────────────────────────── */

function v2ToolEvents(mid: string, i: number, c: Rec): OpencodeExportEvent[] {
  const id = str(c.id) ?? `${mid}:${i}`;
  const tool = str(c.name) ?? "tool";
  const state = isRec(c.state) ? c.state : {};
  const mapped = normalizeOpencodeTool(tool, state.input);
  const out: OpencodeExportEvent[] = [{
    stream: "tool_use",
    data: JSON.stringify({ id, name: mapped.name, input: mapped.input, serverSide: false }),
    lineUuid: `opencode:${mid}:${i}:use`,
  }];
  const status = state.status;
  if (status === "completed" || status === "error") {
    const text = Array.isArray(state.content)
      ? state.content
        .map((b) => (isRec(b) && b.type === "text" && typeof b.text === "string" ? b.text : ""))
        .filter((t) => t !== "")
        .join("\n")
      : typeof state.output === "string" ? state.output : "";
    const err = isRec(state.error) ? str(state.error.message) : typeof state.error === "string" ? state.error : null;
    out.push({
      stream: "tool_result",
      data: JSON.stringify({ toolUseId: id, content: status === "error" ? err ?? text : text || err || "", isError: status === "error" }),
      lineUuid: `opencode:${mid}:${i}:result`,
    });
  }
  return out;
}

function v2Events(messages: unknown[]): OpencodeExportEvent[] {
  const out: OpencodeExportEvent[] = [];
  for (const m of messages) {
    if (!isRec(m)) continue;
    const mid = str(m.id);
    if (!mid) continue;
    if (m.type === "user") {
      const text = typeof m.text === "string" ? m.text : "";
      if (text) out.push({ stream: "user", data: text, lineUuid: `opencode:${mid}:user` });
      continue;
    }
    if (m.type !== "assistant") continue;
    const content = Array.isArray(m.content) ? m.content : [];
    content.forEach((c, i) => {
      if (!isRec(c)) return;
      if (c.type === "text" && typeof c.text === "string" && c.text) {
        out.push({ stream: "assistant", data: c.text, lineUuid: `opencode:${mid}:${i}` });
      } else if (c.type === "reasoning" && typeof c.text === "string" && c.text) {
        out.push({ stream: "thinking", data: c.text, lineUuid: `opencode:${mid}:${i}` });
      } else if (c.type === "tool") {
        out.push(...v2ToolEvents(mid, i, c));
      }
    });
    if (m.error !== undefined && m.error !== null) {
      out.push({ stream: "status", data: `opencode: ${opencodeErrorMessage(m.error)}`, lineUuid: `opencode:${mid}:error` });
    }
  }
  return out;
}

function v1Events(messages: unknown[]): OpencodeExportEvent[] {
  const out: OpencodeExportEvent[] = [];
  for (const m of messages) {
    const info = v1Info(m);
    const parts = v1Parts(m);
    if (info.role === "user") {
      for (const p of parts) {
        if (!isRec(p) || p.type !== "text" || p.synthetic === true) continue;
        const id = str(p.id);
        const text = typeof p.text === "string" ? p.text : "";
        if (id && text) out.push({ stream: "user", data: text, lineUuid: `opencode:text:${id}` });
      }
      continue;
    }
    if (info.role !== "assistant") continue;
    for (const p of parts) {
      for (const c of mapOpencodePart(p).chunks) {
        if (c.lineUuid) out.push({ stream: c.stream, data: c.data, lineUuid: c.lineUuid });
      }
    }
    if (info.error !== undefined && info.error !== null) {
      const mid = str(info.id) ?? "message";
      out.push({ stream: "status", data: `opencode: ${opencodeErrorMessage(info.error)}`, lineUuid: `opencode:${mid}:error` });
    }
  }
  return out;
}

/** The export as run events (user, assistant, thinking, tool pairs), in
 *  order. `sinceMessageCount` skips that many leading `messages` entries. */
export function exportToEvents(exp: OpencodeExport, opts: { sinceMessageCount?: number } = {}): OpencodeExportEvent[] {
  const messages = messagesOf(exp).slice(Math.max(0, opts.sinceMessageCount ?? 0));
  return exp.major === 1 ? v1Events(messages) : v2Events(messages);
}

/**
 * Whether OpenCode finished the session's last turn (A7):
 *  v2 — `info.outcome` set and the last message is `type:"idle"`;
 *  v1 — the last message is an assistant with `time.completed` and a
 *  `finish` other than `"tool-calls"`.
 * A killed Standalone session (or a Standalone background child) never
 * completes: v2 leaves `outcome` unset forever (spike Q12/Q14).
 */
export function exportIsComplete(exp: OpencodeExport): boolean {
  const messages = messagesOf(exp);
  const last = messages[messages.length - 1];
  if (exp.major === 2) {
    const info = infoOf(exp);
    return info.outcome !== null && info.outcome !== undefined && isRec(last) && last.type === "idle";
  }
  const info = v1Info(last);
  const time = isRec(info.time) ? info.time : {};
  return info.role === "assistant" && numOrNull(time.completed) !== null && info.finish !== "tool-calls";
}

/** `succeeded` / `failed` for a complete export (v2 outcome other than
 *  `succeeded`, or a v1 last `finish:"error"`, is a failure); `unfinished`
 *  otherwise. */
export function exportOutcome(exp: OpencodeExport): "succeeded" | "failed" | "unfinished" {
  if (!exportIsComplete(exp)) return "unfinished";
  if (exp.major === 2) return infoOf(exp).outcome === "succeeded" ? "succeeded" : "failed";
  const messages = messagesOf(exp);
  return v1Info(messages[messages.length - 1]).finish === "error" ? "failed" : "succeeded";
}

/**
 * Token/cost totals of the session's LAST turn — every assistant message
 * after the last user message (A4c). Null when that turn has no assistant
 * message carrying tokens.
 */
export function exportTurnUsage(exp: OpencodeExport): OpencodeUsageTotals | null {
  const messages = messagesOf(exp);
  const isUser = (m: unknown) => (exp.major === 2 ? isRec(m) && m.type === "user" : v1Info(m).role === "user");
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isUser(messages[i])) { start = i + 1; break; }
  }
  const total: OpencodeUsageTotals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let any = false;
  for (const m of messages.slice(start)) {
    const rec = exp.major === 2 ? (isRec(m) && m.type === "assistant" ? m : null) : (v1Info(m).role === "assistant" ? v1Info(m) : null);
    if (!rec || !isRec(rec.tokens)) continue;
    any = true;
    addOpencodeTokens(total, rec.tokens, rec.cost);
  }
  return any ? total : null;
}

/** Listing / import metadata for one export (D-13, A8e). `agent` prefers
 *  the last assistant message's agent (`build` / `plan` / a subagent's),
 *  falling back to `info.agent`. */
export function exportSummary(exp: OpencodeExport): OpencodeExportSummary {
  const info = infoOf(exp);
  const messages = messagesOf(exp);
  const model = isRec(info.model) ? info.model : null;
  const modelId = model && str(model.providerID) && str(model.id) ? `${model.providerID}/${model.id}` : null;
  const time = isRec(info.time) ? info.time : {};
  let firstUserText: string | null = null;
  let lastAgent: string | null = null;
  for (const m of messages) {
    if (exp.major === 2) {
      if (!isRec(m)) continue;
      if (m.type === "user" && firstUserText === null) firstUserText = str(m.text);
      if (m.type === "assistant") lastAgent = str(m.agent) ?? lastAgent;
    } else {
      const mi = v1Info(m);
      if (mi.role === "user" && firstUserText === null) {
        const part = v1Parts(m).find((p) => isRec(p) && p.type === "text" && p.synthetic !== true && str(p.text));
        firstUserText = isRec(part) ? str(part.text) : null;
      }
      if (mi.role === "assistant") lastAgent = str(mi.agent) ?? str(mi.mode) ?? lastAgent;
    }
  }
  const location = isRec(info.location) ? info.location : {};
  return {
    sessionId: str(info.id) ?? "",
    title: str(info.title),
    directory: exp.major === 2 ? str(location.directory) ?? str(info.directory) : str(info.directory),
    model: modelId,
    variant: model ? str(model.variant) : null,
    agent: lastAgent ?? str(info.agent),
    firstUserText,
    updatedAt: numOrNull(time.updated),
    createdAt: numOrNull(time.created),
    complete: exportIsComplete(exp),
  };
}

export const __forTest = {
  /** Replace the export command for unit tests; `null` restores the real one. */
  setExportRunner(fn: ExportRunner | null): ExportRunner | null {
    const prev = exportRunnerOverride;
    exportRunnerOverride = fn;
    return prev;
  },
};

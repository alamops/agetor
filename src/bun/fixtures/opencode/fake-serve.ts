#!/usr/bin/env bun
/**
 * A fake OpenCode 2.x HTTP server (`opencode serve`) for unit and e2e tests of
 * the OpenCode v2 server driver (docs/plans/opencode-server-driver.md, D13).
 *
 *   bun src/bun/fixtures/opencode/fake-serve.ts --hostname 127.0.0.1 --port 0
 *
 * It speaks the subset of the real API the driver uses, with the real paths,
 * bodies, status codes and event envelopes (checked against the v2.1.3
 * `openapi.json` and the live transcripts in the T4 verification notes), and
 * it never runs a command or touches the file system except its own optional
 * state file. A turn's script is chosen by a marker in the prompt text:
 *
 *   __agetor_fake_oc_steer__       a long tool step; a steer prompt arriving
 *                                  mid-step is delivered at the step boundary
 *   __agetor_fake_oc_permission__  a shell tool that always asks first
 *   __agetor_fake_oc_question__    a `question` tool that raises a form
 *   __agetor_fake_oc_subagent__    a foreground child session
 *   __agetor_fake_oc_wake__        a background child that finishes after the
 *                                  parent turn, which then wakes the parent
 *   __agetor_fake_oc_error__       step.failed + execution.failed (402 quota)
 *   __agetor_fake_oc_slow__        a shell tool that runs until interrupted
 *   __agetor_fake_oc_todo__        a `todowrite` call with three todos
 *   __agetor_fake_oc_retry__       two `session.retry.scheduled` then success
 *   __agetor_fake_oc_tool__        one `echo hi` shell step, then `OK` (the v2-http-tool-turn shape)
 *   __agetor_fake_oc_files__       read + write + shell in one step (three
 *                                  parallel permission asks in an all-ask session)
 *
 * No marker: one step answering `ACK: <prompt snippet>`.
 *
 * Environment (all optional):
 *   OPENCODE_PASSWORD        Basic-auth password (else random, printed like serve)
 *   FAKE_OC_SPEED            delay multiplier, default 1 (tests use 0.02 to 0.1)
 *   FAKE_OC_HEARTBEAT_MS     SSE `: heartbeat` period, default 15000
 *   FAKE_OC_STATE_FILE       persist sessions here; reloaded on the next start
 *   FAKE_OC_QUOTA_MODELS     comma list of `provider/model` ids that fail with
 *                            the 402 quota error, default `opencode/deepseek-v4.1-flash`
 *   FAKE_OC_VERSION          reported version, default 2.1.3
 *
 * The behaviours marked "unverified" in comments were not observed live and
 * are the fake's best guess; everything else follows a recorded transcript.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

type J = Record<string, any>;

export interface FakeOpencodeOptions {
  hostname?: string;
  /** 0 picks a free port. */
  port?: number;
  password?: string;
  /** Delay multiplier; 0 removes the realistic pauses. */
  speed?: number;
  heartbeatMs?: number;
  stateFile?: string;
  version?: string;
  quotaModels?: string[];
}

export interface FakeOpencodeServer {
  url: string;
  port: number;
  password: string;
  /** Close every open `/api/event` connection (the client sees a clean end). */
  dropEventStreams(): void;
  /** Stop serving; in-flight turns are interrupted and the state file flushed. */
  stop(): Promise<void>;
}

const QUOTA_ERROR = {
  type: "provider.quota",
  message: "Upstream request failed: Insufficient account funds",
  status: 402,
  response: { body: '{"error":{"type":"server_error","message":"Upstream request failed: Insufficient account funds"}}' },
};

/** The markers, in priority order when a prompt carries more than one. */
export const FAKE_OC_MARKERS = {
  slow: "__agetor_fake_oc_slow__",
  steer: "__agetor_fake_oc_steer__",
  permission: "__agetor_fake_oc_permission__",
  question: "__agetor_fake_oc_question__",
  subagent: "__agetor_fake_oc_subagent__",
  wake: "__agetor_fake_oc_wake__",
  error: "__agetor_fake_oc_error__",
  todo: "__agetor_fake_oc_todo__",
  retry: "__agetor_fake_oc_retry__",
  files: "__agetor_fake_oc_files__",
  tool: "__agetor_fake_oc_tool__",
} as const;
type ScenarioName = keyof typeof FAKE_OC_MARKERS | "default";

// ---------------------------------------------------------------- utilities

const B62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
let idCounter = 0;
function rand62(n: number): string {
  const b = randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += B62[b[i]! % 62];
  return out;
}
function newId(prefix: string): string {
  const t = Date.now().toString(16).padStart(12, "0");
  const c = (idCounter++ % 4096).toString(16).padStart(3, "0");
  return `${prefix}_${t}${c}${rand62(11)}`;
}
const SLUG_A = ["kind", "swift", "quiet", "brave", "calm", "witty"];
const SLUG_B = ["otter", "comet", "harbor", "falcon", "maple", "ember"];
function slug(): string {
  return `${SLUG_A[Math.floor(Math.random() * SLUG_A.length)]}-${SLUG_B[Math.floor(Math.random() * SLUG_B.length)]}`;
}

function wild(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(value);
}

class Interrupted extends Error {
  constructor(public reason: string) {
    super(`interrupted: ${reason}`);
  }
}
/** The turn fails (session.execution.failed carries `error`). */
class ExecFailed extends Error {
  constructor(public error: J) {
    super(String(error.message ?? "failed"));
  }
}
/** A tool call fails; `interrupt` also ends the turn with that reason. */
class ToolFail extends Error {
  constructor(public error: J, public interrupt?: string) {
    super(String(error.message ?? "tool failed"));
  }
}

function jsonResponse(status: number, body?: unknown): Response {
  if (status === 204 || body === undefined) return new Response(null, { status });
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const err = {
  session: (id: string) => jsonResponse(404, { _tag: "SessionNotFoundError", sessionID: id, message: `Session not found: ${id}` }),
  invalid: (message: string, kind = "Payload") => jsonResponse(400, { _tag: "InvalidRequestError", message, kind }),
  conflict: (message: string, resource?: string) => jsonResponse(409, { _tag: "ConflictError", message, ...(resource ? { resource } : {}) }),
};

function tokensFor(len: number): J {
  return { input: 55 + len, output: 20 + Math.ceil(len / 4), reasoning: 0, cache: { read: 12544, write: 0 } };
}
function costOf(t: J): number {
  return (t.input * 0.9 + t.output * 2.2 + t.cache.read * 0.01) / 1e6;
}
const strip = (text: string): string => {
  let t = text;
  for (const m of Object.values(FAKE_OC_MARKERS)) t = t.split(m).join("");
  return t.replace(/\s+/g, " ").trim();
};

// ------------------------------------------------------------------- model

interface Rule { action: string; resource: string; effect: "allow" | "deny" | "ask" }
interface InboxItem {
  id: string;
  sessionID: string;
  time: { created: number };
  type: "user" | "synthetic";
  payload: J;
  delivery: "steer" | "queue";
  delivered?: boolean;
}
interface Session {
  id: string;
  parentID?: string;
  projectID: string;
  slug: string;
  title?: string;
  agent?: string;
  model: { id: string; providerID: string; variant: string };
  directory: string;
  permissions: Rule[];
  metadata?: J;
  cost: number;
  tokens: J;
  outcome?: "succeeded" | "failed" | "interrupted";
  time: { created: number; updated: number; idle?: number; archived?: number };
  messages: J[];
  inbox: InboxItem[];
  seq: number;
  snapshot: string;
  instructionsSent: boolean;
}
interface PermRec { req: J; resolve(v: { decision: string; message?: string }): void }
type FormOutcome = { kind: "answered"; answer: J } | { kind: "cancelled"; message?: string };
interface FormRec {
  form: J;
  state: { status: "pending" } | { status: "answered"; answer: J } | { status: "cancelled"; message?: string };
  resolve(v: FormOutcome): void;
}
interface Exec {
  ac: AbortController;
  done: Promise<void>;
  finalText?: string;
  failed?: J;
  script?: Scenario;
  /** Items delivered mid-execution that no final answer has acknowledged yet. */
  unanswered: InboxItem[];
  step?: Step;
}
interface Runtime { exec?: Exec; perms: Map<string, PermRec>; forms: Map<string, FormRec> }
interface ToolRec {
  id: string;
  name: string;
  input: J;
  part: J;
  settled: boolean;
  shellID?: string;
}
interface Step {
  id: string;
  msg: J;
  tools: ToolRec[];
  textOrdinal: number;
  reasoningOrdinal: number;
  streamed: boolean;
  closed: boolean;
  usage: J;
}
/** `after` runs once tool.success has been published (a shell that exits just after its result). */
type ToolResult = { content: J[]; metadata: J; after?: () => void };
type ToolOutcome = { ok: true } | { ok: false; kind: "rejected" | "denied"; message?: string };
type Scenario = (c: Ctx, initial: InboxItem[]) => Promise<void>;

interface Ctx {
  s: Session;
  ex: Exec;
  /** Scaled, interrupt-aware pause. */
  pause(ms: number): Promise<void>;
  /** Await a promise, rejecting with Interrupted if the turn is interrupted. */
  wait<T>(p: Promise<T>): Promise<T>;
  emit(type: string, data?: J, extra?: J): void;
  startStep(): Step;
  say(step: Step, text: string): Promise<void>;
  think(step: Step, text: string): Promise<void>;
  declare(step: Step, name: string, input: J): ToolRec;
  streamed(step: Step): void;
  tool(step: Step, rec: ToolRec, spec: ToolSpec): Promise<ToolOutcome>;
  endStep(step: Step, finish: "stop" | "tool-calls"): InboxItem[];
  answer(base: string): Promise<void>;
}
interface ToolSpec {
  action?: string;
  resources?: string[];
  save?: string[];
  metadata?: J;
  forceAsk?: boolean;
  run(rec: ToolRec): Promise<ToolResult>;
}

// ----------------------------------------------------------------- the app

export async function startFakeOpencodeServer(opts: FakeOpencodeOptions = {}): Promise<FakeOpencodeServer> {
  const speed = opts.speed ?? 1;
  const heartbeatMs = opts.heartbeatMs ?? 15000;
  const version = opts.version ?? "2.1.3";
  const quotaModels = new Set(opts.quotaModels ?? ["opencode/deepseek-v4.1-flash"]);
  const password = opts.password ?? randomBytes(16).toString("hex");
  const expectedAuth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const stateFile = opts.stateFile;

  const sessions = new Map<string, Session>();
  const runtimes = new Map<string, Runtime>();
  const subscribers = new Set<{ send(chunk: string): void; close(): void }>();
  let stopped = false;

  const rt = (id: string): Runtime => {
    let r = runtimes.get(id);
    if (!r) {
      r = { perms: new Map(), forms: new Map() };
      runtimes.set(id, r);
    }
    return r;
  };

  // ------------------------------------------------------- persistence
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function saveNow(): void {
    if (!stateFile) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = undefined;
    const tmp = `${stateFile}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ sessions: [...sessions.values()] }));
      renameSync(tmp, stateFile);
    } catch (e) {
      // The state directory vanishing under a running fake (a test cleaned up first) is not fatal.
      console.error(`fake-serve: could not write ${stateFile}: ${String((e as Error)?.message ?? e)}`);
    }
  }
  function dirty(): void {
    if (!stateFile || saveTimer) return;
    saveTimer = setTimeout(saveNow, 10);
  }
  if (stateFile && existsSync(stateFile)) {
    try {
      const raw = JSON.parse(readFileSync(stateFile, "utf8")) as { sessions?: Session[] };
      for (const s of raw.sessions ?? []) sessions.set(s.id, s);
    } catch {
      // A half-written file from a killed process is treated as empty.
    }
  }

  // ------------------------------------------------------- events
  function publish(type: string, data: J, extra: J = {}): void {
    const sid = typeof data.sessionID === "string" ? (data.sessionID as string) : undefined;
    const s = sid ? sessions.get(sid) : undefined;
    const env: J = { id: newId("evt"), created: Date.now(), type, data, ...extra };
    if (s && type.startsWith("session.")) env.durable = { aggregateID: s.id, seq: s.seq++, version: 1 };
    const frame = `data: ${JSON.stringify(env)}\n\n`;
    for (const sub of subscribers) sub.send(frame);
    dirty();
  }
  
  // ------------------------------------------------------- sessions
  function sessionJson(s: Session): J {
    const out: J = {
      id: s.id,
      ...(s.parentID ? { parentID: s.parentID } : {}),
      projectID: s.projectID,
      ...(s.agent ? { agent: s.agent } : {}),
      model: s.model,
      cost: s.cost,
      tokens: s.tokens,
      ...(s.outcome ? { outcome: s.outcome } : {}),
      time: s.time,
      ...(s.title !== undefined ? { title: s.title } : {}),
      ...(s.metadata ? { metadata: s.metadata } : {}),
      ...(s.permissions.length ? { permissions: s.permissions } : {}),
      location: { directory: s.directory },
    };
    return out;
  }
  function createSession(body: J): Session | Response {
    const parent = typeof body.parentID === "string" ? sessions.get(body.parentID) : undefined;
    if (typeof body.parentID === "string" && !parent) return err.session(body.parentID);
    const now = Date.now();
    const id = typeof body.id === "string" && body.id ? body.id : newId("ses");
    if (sessions.has(id)) return err.conflict(`Session already exists: ${id}`, id);
    const model = body.model ?? parent?.model ?? { providerID: "opencode-go", id: "deepseek-v4.1-flash" };
    const s: Session = {
      id,
      parentID: parent?.id,
      projectID: "global",
      slug: slug(),
      title: typeof body.title === "string" ? body.title : undefined,
      agent: typeof body.agent === "string" ? body.agent : undefined,
      model: { id: model.id, providerID: model.providerID, variant: model.variant ?? "default" },
      directory: body.location?.directory ?? parent?.directory ?? process.cwd(),
      // A child inherits the parent's rules (unverified against the real server).
      permissions: Array.isArray(body.permissions) ? body.permissions : [...(parent?.permissions ?? [])],
      metadata: body.metadata,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now, updated: now },
      messages: [],
      inbox: [],
      seq: 0,
      snapshot: randomBytes(20).toString("hex"),
      instructionsSent: false,
    };
    sessions.set(id, s);
    publish(
      "session.created",
      {
        sessionID: id,
        slug: s.slug,
        version,
        projectID: s.projectID,
        ...(s.parentID ? { parentID: s.parentID } : {}),
        location: { directory: s.directory },
        subpath: "",
        title: s.title,
        ...(s.agent ? { agent: s.agent } : {}),
        model: s.model,
      },
      { location: { directory: s.directory } },
    );
    return s;
  }

  // ------------------------------------------------------- inbox
  function enqueue(s: Session, item: Omit<InboxItem, "sessionID" | "time"> & { time?: InboxItem["time"] }, script?: Scenario): InboxItem {
    const full: InboxItem = { ...item, sessionID: s.id, time: item.time ?? { created: Date.now() } };
    s.inbox.push(full);
    publish(
      "session.inbox.enqueued",
      { inboxID: full.id, sessionID: s.id, item: { type: full.type, payload: full.payload, delivery: full.delivery } },
      { location: { directory: s.directory } },
    );
    queueMicrotask(() => {
      if (!stopped) maybeStart(s, script);
    });
    return full;
  }
  const itemText = (i: InboxItem): string => String(i.payload?.text ?? "");

  function promote(s: Session, mode: "steer" | "input"): InboxItem[] {
    const pending = s.inbox.filter((i) => !i.delivered);
    let take = pending.filter((i) => i.delivery === "steer");
    if (take.length === 0 && mode === "input") take = pending.filter((i) => i.delivery === "queue").slice(0, 1);
    for (const it of take) {
      it.delivered = true;
      s.messages.push(
        it.type === "user"
          ? { id: it.id, time: it.time, text: itemText(it), type: "user" }
          : { id: it.id, metadata: it.payload.metadata, time: it.time, text: itemText(it), description: it.payload.description, type: "synthetic" },
      );
      publish("session.inbox.delivered", { sessionID: s.id, inboxID: it.id });
    }
    return take;
  }

  // ------------------------------------------------------- execution
  function maybeStart(s: Session, script?: Scenario): Exec | undefined {
    const r = rt(s.id);
    if (r.exec || !sessions.has(s.id)) return r.exec;
    if (!s.inbox.some((i) => !i.delivered)) return undefined;
    let finish!: () => void;
    const done = new Promise<void>((res) => (finish = res));
    const ex: Exec = { ac: new AbortController(), done, unanswered: [], script };
    r.exec = ex;
    void runExecution(s, ex).finally(() => {
      r.exec = undefined;
      finish();
      // Anything that arrived while the turn was ending starts the next one.
      queueMicrotask(() => {
        if (!stopped && sessions.has(s.id)) maybeStart(s);
      });
    });
    return ex;
  }

  function effectFor(s: Session, action: string, resource: string): "allow" | "deny" | "ask" {
    let effect: "allow" | "deny" | "ask" = "allow";
    for (const rule of s.permissions) if (wild(rule.action, action) && wild(rule.resource, resource)) effect = rule.effect;
    return effect;
  }

  async function runExecution(s: Session, ex: Exec): Promise<void> {
    const r = rt(s.id);
    const c = makeCtx(s, ex);
    let outcome: "succeeded" | "failed" | "interrupted" = "succeeded";
    let error: J | undefined;
    publish("session.execution.started", { sessionID: s.id });
    if (!s.instructionsSent) {
      s.instructionsSent = true;
      publish(
        "session.instructions.updated",
        { sessionID: s.id, delta: { "core/environment": randomBytes(32).toString("hex") } },
        { metadata: { instructions: { initial: true } }, location: { directory: s.directory } },
      );
    }
    const initial = promote(s, "input");
    try {
      const model = `${s.model.providerID}/${s.model.id}`;
      if (quotaModels.has(model)) await scenarioError(c);
      else await (ex.script ?? pickScenario(initial.map(itemText).join("\n")))(c, initial);
      publish("session.execution.succeeded", { sessionID: s.id });
    } catch (e) {
      if (e instanceof Interrupted) {
        outcome = "interrupted";
        closeInterrupted(c, e.reason);
      } else {
        // A bug in the fake itself is surfaced as a failed turn, never a hung one.
        outcome = "failed";
        error = e instanceof ExecFailed ? e.error : { type: "fake.internal", message: String((e as Error)?.stack ?? e) };
        ex.failed = error;
        publish("session.execution.failed", { sessionID: s.id, error });
      }
    }
    // Pending cards die with the turn.
    for (const [, f] of r.forms) {
      if (f.state.status === "pending") {
        f.state = { status: "cancelled" };
        publish("form.cancelled", { id: f.form.id, sessionID: s.id });
      }
    }
    r.perms.clear();
    const now = Date.now();
    s.messages.push({ id: newId("msg"), time: { created: now }, type: "idle", outcome, ...(error ? { error } : {}) });
    s.outcome = outcome;
    s.time.updated = now;
    s.time.idle = now;
    dirty();
  }

  function closeInterrupted(c: Ctx, reason: string): void {
    const step = c.ex.step;
    if (step && !step.closed) {
      for (const rec of step.tools) {
        if (rec.settled) continue;
        rec.settled = true;
        rec.part.state = { ...rec.part.state, status: "error", error: { type: "aborted", message: "Tool execution interrupted" } };
        c.emit("session.tool.failed", {
          assistantMessageID: step.id,
          id: rec.id,
          error: { type: "aborted", message: "Tool execution interrupted" },
          ...(rec.shellID ? { metadata: { shellID: rec.shellID } } : {}),
          executed: false,
        });
      }
      failStep(c, step, { type: "aborted", message: "Step interrupted" }, true);
    }
    publish("session.execution.interrupted", { sessionID: c.s.id, reason });
  }

  function failStep(c: Ctx, step: Step, error: J, withUsage: boolean): void {
    step.closed = true;
    step.msg.finish = "error";
    step.msg.error = error;
    step.msg.time.completed = Date.now();
    if (withUsage) {
      step.msg.cost = costOf(step.usage);
      step.msg.tokens = step.usage;
    }
    c.emit("session.step.failed", {
      assistantMessageID: step.id,
      error,
      ...(step.tools.length ? { rawFinish: "tool_calls" } : {}),
      ...(withUsage ? { cost: costOf(step.usage), tokens: step.usage } : {}),
      snapshot: c.s.snapshot,
      files: [],
    });
    if (withUsage) addUsage(c, step.usage);
  }

  function addUsage(c: Ctx, usage: J): void {
    const s = c.s;
    s.cost += costOf(usage);
    for (const k of ["input", "output", "reasoning"]) s.tokens[k] += usage[k];
    s.tokens.cache.read += usage.cache.read;
    s.tokens.cache.write += usage.cache.write;
    c.emit("session.usage.updated", { cost: s.cost, tokens: s.tokens });
  }

  function makeCtx(s: Session, ex: Exec): Ctx {
    const r = rt(s.id);
    const aborted = (): Interrupted => new Interrupted(String(ex.ac.signal.reason ?? "user"));
    const c: Ctx = {
      s,
      ex,
      pause(ms) {
        return new Promise<void>((res, rej) => {
          if (ex.ac.signal.aborted) return rej(aborted());
          const on = (): void => {
            clearTimeout(t);
            rej(aborted());
          };
          const t = setTimeout(() => {
            ex.ac.signal.removeEventListener("abort", on);
            res();
          }, Math.max(0, ms * speed));
          ex.ac.signal.addEventListener("abort", on, { once: true });
        });
      },
      wait<T>(p: Promise<T>): Promise<T> {
        return new Promise<T>((res, rej) => {
          if (ex.ac.signal.aborted) return rej(aborted());
          const on = (): void => rej(aborted());
          ex.ac.signal.addEventListener("abort", on, { once: true });
          p.then(
            (v) => {
              ex.ac.signal.removeEventListener("abort", on);
              res(v);
            },
            (e) => {
              ex.ac.signal.removeEventListener("abort", on);
              rej(e);
            },
          );
        });
      },
      emit(type, data = {}, extra) {
        publish(type, { sessionID: s.id, ...data }, extra);
      },
      startStep() {
        const id = newId("msg");
        const now = Date.now();
        const msg: J = {
          id,
          time: { created: now },
          type: "assistant",
          agent: s.agent ?? "build",
          model: { ...s.model },
          content: [],
          snapshot: { start: s.snapshot, end: s.snapshot, files: [] },
        };
        s.messages.push(msg);
        const step: Step = { id, msg, tools: [], textOrdinal: 0, reasoningOrdinal: 0, streamed: false, closed: false, usage: tokensFor(40) };
        ex.step = step;
        c.emit("session.step.started", { agent: msg.agent, model: msg.model, assistantMessageID: id, snapshot: s.snapshot, started: now });
        return step;
      },
      async say(step, text) {
        const ordinal = step.textOrdinal++;
        const part: J = { type: "text", text: "" };
        step.msg.content.push(part);
        c.emit("session.text.started", { assistantMessageID: step.id, ordinal });
        // The real message updater applies no deltas: a streaming part stays `text: ""` until text.ended.
        for (let i = 0; i < text.length; i += 14) {
          c.emit("session.text.delta", { assistantMessageID: step.id, ordinal, delta: text.slice(i, i + 14) });
          await c.pause(4);
        }
        part.text = text;
        step.usage = tokensFor(text.length);
        c.emit("session.text.ended", { assistantMessageID: step.id, ordinal, text });
      },
      async think(step, text) {
        const ordinal = step.reasoningOrdinal++;
        const native = { reasoningField: "reasoning_content" };
        const part: J = { type: "reasoning", text: "", native, time: { created: Date.now() } };
        step.msg.content.push(part);
        c.emit("session.reasoning.started", { assistantMessageID: step.id, ordinal, native });
        for (let i = 0; i < text.length; i += 24) {
          c.emit("session.reasoning.delta", { assistantMessageID: step.id, ordinal, delta: text.slice(i, i + 24) });
          await c.pause(4);
        }
        part.text = text;
        part.time.completed = Date.now();
        c.emit("session.reasoning.ended", { assistantMessageID: step.id, ordinal, text, native });
      },
      declare(step, name, input) {
        const id = `call_${rand62(8).toLowerCase()}${randomBytes(8).toString("hex")}`;
        const part: J = { type: "tool", id, name, executed: false, state: { status: "pending", input: {} }, time: { created: Date.now() } };
        step.msg.content.push(part);
        const rec: ToolRec = { id, name, input, part, settled: false };
        step.tools.push(rec);
        c.emit("session.tool.input.started", { assistantMessageID: step.id, id, name });
        c.emit("session.tool.input.ended", { assistantMessageID: step.id, id, text: JSON.stringify(input) });
        part.state = { status: "running", input };
        c.emit("session.tool.called", { assistantMessageID: step.id, id, input, executed: false });
        return rec;
      },
      streamed(step) {
        if (step.streamed) return;
        step.streamed = true;
        step.msg.time.streamed = Date.now();
        c.emit("session.step.streamed", { assistantMessageID: step.id });
      },
      async tool(step, rec, spec) {
        const action = spec.action ?? rec.name;
        const resources = spec.resources ?? [];
        const settle = (status: "completed" | "error", fields: J): void => {
          rec.settled = true;
          rec.part.state = { status, input: rec.input, ...fields };
          rec.part.time = { ...rec.part.time, completed: Date.now() };
        };
        // Permission gate. Question, todo and subagent calls never ask (unverified for the last two).
        if (spec.action !== undefined) {
          let effect = spec.forceAsk ? "ask" : effectFor(s, action, resources[0] ?? "*");
          if (effect === "ask" && spec.save && s.permissions.some((p) => p.effect === "allow" && wild(p.action, action) && spec.save!.some((sv) => p.resource === sv))) {
            effect = "allow";
          }
          if (effect === "deny") {
            const error = { type: "permission.denied", message: `Permission denied: ${action}` };
            settle("error", { error });
            c.emit("session.tool.failed", { assistantMessageID: step.id, id: rec.id, error, executed: false });
            return { ok: false, kind: "denied", message: error.message };
          }
          if (effect === "ask") {
            const reqId = newId("per");
            const req: J = {
              id: reqId,
              sessionID: s.id,
              action,
              resources,
              ...(spec.save ? { save: spec.save } : {}),
              ...(spec.metadata ? { metadata: spec.metadata } : {}),
              source: { type: "tool", messageID: step.id, id: rec.id },
            };
            const reply = new Promise<{ decision: string; message?: string }>((resolve) => r.perms.set(reqId, { req, resolve }));
            publish("permission.asked", req);
            const { decision, message } = await c.wait(reply);
            if (decision === "reject") {
              if (message) {
                const error = { type: "permission.rejected", message };
                settle("error", { error });
                c.emit("session.tool.failed", { assistantMessageID: step.id, id: rec.id, error, executed: false });
                return { ok: false, kind: "rejected", message };
              }
              // Observed live: a reject without a message ends the whole turn.
              const error = { type: "aborted", message: "The user declined this tool call" };
              settle("error", { error });
              c.emit("session.tool.failed", { assistantMessageID: step.id, id: rec.id, error, executed: false });
              ex.ac.abort("shutdown");
              throw new Interrupted("shutdown");
            }
            if (decision === "always" && spec.save) {
              for (const sv of spec.save) s.permissions.push({ action, resource: sv, effect: "allow" });
            }
          }
        }
        try {
          const result = await spec.run(rec);
          settle("completed", { content: result.content, metadata: result.metadata });
          c.emit("session.tool.success", { assistantMessageID: step.id, id: rec.id, content: result.content, metadata: result.metadata, executed: false });
          result.after?.();
          return { ok: true };
        } catch (e) {
          if (e instanceof ToolFail) {
            settle("error", { error: e.error });
            c.emit("session.tool.failed", { assistantMessageID: step.id, id: rec.id, error: e.error, executed: false });
            if (e.interrupt) {
              ex.ac.abort(e.interrupt);
              throw new Interrupted(e.interrupt);
            }
            return { ok: false, kind: "rejected", message: String(e.error.message) };
          }
          throw e;
        }
      },
      endStep(step, finish) {
        c.streamed(step);
        step.closed = true;
        step.msg.finish = finish;
        step.msg.rawFinish = finish === "stop" ? "stop" : "tool_calls";
        step.msg.time.completed = Date.now();
        step.msg.cost = costOf(step.usage);
        step.msg.tokens = step.usage;
        c.emit("session.step.ended", {
          assistantMessageID: step.id,
          finish,
          rawFinish: step.msg.rawFinish,
          cost: step.msg.cost,
          tokens: step.usage,
          snapshot: s.snapshot,
          files: [],
        });
        addUsage(c, step.usage);
        // Step boundary: steers are promoted here.
        const promoted = promote(s, "steer");
        ex.unanswered.push(...promoted);
        return promoted;
      },
      async answer(base) {
        let first = true;
        for (;;) {
          const carried = ex.unanswered.splice(0);
          const suffix = carried.map((i) => `[${i.delivery}: ${strip(itemText(i))}]`).join(" ");
          const text = first ? (suffix ? `${base} ${suffix}` : base) : `ACK: ${suffix}`;
          first = false;
          const step = c.startStep();
          await c.say(step, text);
          c.streamed(step);
          ex.finalText = text;
          c.endStep(step, "stop"); // promotes mid-turn steers into ex.unanswered
          // The idle boundary also takes one queued input.
          if (ex.unanswered.length === 0) ex.unanswered.push(...promote(s, "input"));
          if (ex.unanswered.length === 0) return;
        }
      },
    };
    return c;
  }

  // ------------------------------------------------------- scenarios
  function pickScenario(text: string): (c: Ctx, initial: InboxItem[]) => Promise<void> {
    const t = text;
    const name = (Object.keys(FAKE_OC_MARKERS) as Array<keyof typeof FAKE_OC_MARKERS>).find((k) => t.includes(FAKE_OC_MARKERS[k]));
    return (c, initial) => scenarios[(name ?? "default") as ScenarioName](c, initial);
  }

  const snippet = (initial: InboxItem[]): string => strip(initial.map(itemText).join(" ")).slice(0, 60);

  function shellOutput(command: string): string {
    const m = /echo\s+(.+?)\s*$/.exec(command);
    return m ? `${m[1]!.replace(/^["']|["']$/g, "")}\n` : "(no output)";
  }

  /**
   * The shell tool: shell.created, tool.progress, (wait), shell.exited, result.
   * `order` is which of tool.success and shell.exited comes first: the live
   * transcripts show both (v2-http-tool-turn: exited first; v2-http-steer: success first).
   * An interrupt kills the shell the way the real server does: exited(killed), then deleted.
   */
  function shellRun(c: Ctx, step: Step, command: string, durationMs: number, gate?: () => Promise<void>, order: "exit-first" | "success-first" = "exit-first") {
    return async (rec: ToolRec): Promise<ToolResult> => {
      const shellID = newId("sh");
      rec.shellID = shellID;
      publish("shell.created", {
        info: {
          id: shellID,
          status: "running",
          command,
          cwd: c.s.directory,
          shell: "/bin/zsh",
          file: `/tmp/fake-opencode/shell/${shellID}.out`,
          metadata: { sessionID: c.s.id },
          time: { started: Date.now() },
        },
      });
      c.emit("session.tool.progress", { assistantMessageID: step.id, id: rec.id, metadata: { shellID } });
      try {
        if (gate) await gate();
        await c.pause(durationMs);
      } catch (e) {
        if (e instanceof Interrupted) {
          publish("shell.exited", { id: shellID, status: "killed" });
          publish("shell.deleted", { id: shellID });
        }
        throw e;
      }
      const exited = (): void => publish("shell.exited", { id: shellID, exit: 0, status: "exited" });
      if (order === "exit-first") exited();
      return {
        content: [{ type: "text", text: shellOutput(command) }],
        metadata: { status: "completed", truncated: false, exit: 0 },
        ...(order === "success-first" ? { after: exited } : {}),
      };
    };
  }
  const shellSpec = (
    c: Ctx,
    step: Step,
    command: string,
    ms: number,
    extra: Partial<ToolSpec> = {},
    gate?: () => Promise<void>,
    order?: "exit-first" | "success-first",
  ): ToolSpec => ({
    action: "shell",
    resources: [command],
    save: [`${command.split(/\s+/)[0] ?? ""} *`],
    run: shellRun(c, step, command, ms, gate, order),
    ...extra,
  });

  async function scenarioError(c: Ctx): Promise<void> {
    const step = c.startStep();
    await c.pause(20);
    failStep(c, step, QUOTA_ERROR, false);
    throw new ExecFailed(QUOTA_ERROR);
  }

  const scenarios: Record<ScenarioName, (c: Ctx, initial: InboxItem[]) => Promise<void>> = {
    default: async (c, initial) => {
      const wake = initial.find((i) => i.type === "synthetic" && i.payload?.metadata?.source === "subagent");
      if (wake) await c.answer(`The background subagent finished: ${wake.payload.description ?? "done"}.`);
      else await c.answer(`ACK: ${snippet(initial)}`);
    },

    error: async (c) => {
      await scenarioError(c);
    },

    retry: async (c) => {
      const step = c.startStep();
      for (let attempt = 1; attempt <= 2; attempt++) {
        await c.pause(10);
        c.emit("session.retry.scheduled", {
          assistantMessageID: step.id,
          attempt,
          at: Date.now() + 5000,
          error: { type: "provider.rate-limit", message: "Rate limited by the provider", status: 429, retryAfterMs: 5000 },
        });
      }
      await c.say(step, "Done.");
      c.ex.finalText = "Done.";
      c.endStep(step, "stop");
      if (c.ex.unanswered.length) await c.answer("");
    },

    slow: async (c) => {
      const step = c.startStep();
      await c.think(step, "Run the long command.");
      const rec = c.declare(step, "shell", { command: "sleep 3600" });
      c.streamed(step);
      // Never resolves: only an interrupt ends this tool, whatever FAKE_OC_SPEED is.
      await c.tool(step, rec, shellSpec(c, step, "sleep 3600", 0, {}, () => c.wait(new Promise<void>(() => {}))));
      c.endStep(step, "tool-calls");
      await c.answer("Finished.");
    },

    steer: async (c) => {
      const step = c.startStep();
      await c.think(step, "Run the long command, then answer.");
      const rec = c.declare(step, "shell", { command: "sleep 2" });
      c.streamed(step);
      const out = await c.tool(step, rec, shellSpec(c, step, "sleep 2", 1500, {}, undefined, "success-first"));
      c.endStep(step, "tool-calls");
      await c.answer(out.ok ? "Done." : "The step did not run.");
    },

    permission: async (c) => {
      const step = c.startStep();
      await c.say(step, "I'll run it.");
      const rec = c.declare(step, "shell", { command: "echo hi" });
      c.streamed(step);
      const out = await c.tool(step, rec, shellSpec(c, step, "echo hi", 40, { forceAsk: true }));
      c.endStep(step, "tool-calls");
      await c.answer(out.ok ? "The command ran: hi" : out.kind === "rejected" ? `The command was rejected: ${out.message}` : "The command was denied.");
    },

    question: async (c) => {
      const step = c.startStep();
      await c.say(step, "I'll ask you now.");
      const input = {
        questions: [
          {
            question: "Which color do you pick?",
            header: "Pick a color",
            options: [
              { label: "Red", description: "Go with Red" },
              { label: "Blue", description: "Go with Blue" },
            ],
          },
        ],
      };
      const rec = c.declare(step, "question", input);
      c.streamed(step);
      const r = rt(c.s.id);
      let picked: string | undefined;
      let declined: string | undefined;
      const out = await c.tool(step, rec, {
        run: async () => {
          const formId = newId("frm");
          const form: J = {
            id: formId,
            sessionID: c.s.id,
            title: "Questions",
            metadata: { kind: "question", tool: { messageID: step.id, id: rec.id } },
            fields: [
              {
                key: "q0",
                title: "Pick a color",
                description: "Which color do you pick?",
                type: "string",
                options: [
                  { value: "Red", label: "Red", description: "Go with Red" },
                  { value: "Blue", label: "Blue", description: "Go with Blue" },
                ],
                custom: true,
              },
            ],
          };
          const outcome = new Promise<FormOutcome>((resolve) => r.forms.set(formId, { form, state: { status: "pending" }, resolve }));
          publish("form.created", { form });
          const res = await c.wait(outcome);
          if (res.kind === "cancelled") {
            if (res.message) {
              declined = res.message;
              throw new ToolFail({ type: "tool.execution", message: res.message });
            }
            throw new ToolFail({ type: "aborted", message: "The user dismissed this question" }, "shutdown");
          }
          const a = res.answer.q0;
          picked = typeof a === "string" ? a : undefined;
          const shown = picked === undefined ? "Unanswered" : picked;
          return {
            content: [{ type: "text", text: `User has answered your questions: "Which color do you pick?"="${shown}". You can now continue with the user's answers in mind.` }],
            metadata: { answers: [picked === undefined ? [] : [picked]], truncated: false },
          };
        },
      });
      c.endStep(step, "tool-calls");
      if (out.ok) await c.answer(picked ? `You picked **${picked}**.` : "You gave no answer.");
      else await c.answer(`The question was declined: ${declined ?? ""}`.trim());
    },

    files: async (c) => {
      const step = c.startStep();
      await c.say(step, "I'll do these three steps now.");
      const patch = "Index: note.txt\n===================================================================\n--- note.txt\n+++ note.txt\n@@ -0,0 +1,1 @@\n+hi\n";
      const read = c.declare(step, "read", { path: "a.txt" });
      const write = c.declare(step, "write", { path: "note.txt", content: "hi\n" });
      const shell = c.declare(step, "shell", { command: "echo done" });
      c.streamed(step);
      await Promise.all([
        c.tool(step, read, {
          action: "read",
          resources: ["a.txt"],
          save: ["*"],
          run: async () => {
            await c.pause(20);
            return { content: [{ type: "text", text: "Read file a.txt, lines 1-1\n1: hello" }], metadata: { truncated: false } };
          },
        }),
        c.tool(step, write, {
          action: "edit",
          resources: ["note.txt"],
          save: ["*"],
          metadata: { files: [{ file: "note.txt", patch, status: "added", additions: 1, deletions: 0 }] },
          run: async () => {
            await c.pause(20);
            return { content: [{ type: "text", text: "Created file successfully: note.txt" }], metadata: { truncated: false } };
          },
        }),
        c.tool(step, shell, shellSpec(c, step, "echo done", 30)),
      ]);
      c.endStep(step, "tool-calls");
      await c.answer("FINISHED");
    },

    tool: async (c) => {
      const step = c.startStep();
      const rec = c.declare(step, "shell", { command: "echo hi" });
      c.streamed(step);
      await c.tool(step, rec, shellSpec(c, step, "echo hi", 30));
      c.endStep(step, "tool-calls");
      await c.answer("OK");
    },

    todo: async (c) => {
      const step = c.startStep();
      await c.think(step, "Write the todo list, then reply OK.");
      const todos = [
        { content: "alpha", status: "completed", priority: "high" },
        { content: "beta", status: "in_progress", priority: "medium" },
        { content: "gamma", status: "pending", priority: "low" },
      ];
      const rec = c.declare(step, "todowrite", { todos });
      c.streamed(step);
      await c.tool(step, rec, {
        run: async () => {
          c.emit("session.tool.progress", { assistantMessageID: step.id, id: rec.id, metadata: { todos: todos.length } });
          await c.pause(10);
          return { content: [{ type: "text", text: "Todos updated: 1/3 completed, 1 pending" }], metadata: { todos } };
        },
      });
      c.endStep(step, "tool-calls");
      await c.answer("OK");
    },

    subagent: async (c) => {
      const prompt = `Run the shell command \`echo CHILD\` and reply with exactly what it printed (and the exit status).`;
      const step = c.startStep();
      await c.think(step, "The user wants me to run a subagent that runs `echo CHILD`.");
      const input = { agent: "general", description: "Run echo CHILD", prompt };
      const rec = c.declare(step, "subagent", input);
      c.streamed(step);
      const child = spawnChild(c, input.description, "general");
      await c.tool(step, rec, {
        run: async () => {
          c.emit("session.tool.progress", { assistantMessageID: step.id, id: rec.id, metadata: { sessionID: child.id, status: "running" } });
          const cex = startChild(child, prompt, async (cc) => {
            const cs = cc.startStep();
            const crec = cc.declare(cs, "shell", { command: "echo CHILD" });
            cc.streamed(cs);
            await cc.tool(cs, crec, shellSpec(cc, cs, "echo CHILD", 30));
            cc.endStep(cs, "tool-calls");
            await cc.answer("```\nCHILD\n```\n\nExit status: 0");
          });
          try {
            await c.wait(cex.done);
          } catch (e) {
            if (e instanceof Interrupted) cex.ac.abort(e.reason);
            throw e;
          }
          const failed = cex.failed;
          return {
            content: [
              { type: "text", text: `<subagent sessionID="${child.id}" state="${failed ? "failed" : "completed"}">\n${failed ? String(failed.message) : (cex.finalText ?? "")}\n</subagent>` },
            ],
            metadata: { sessionID: child.id, status: failed ? "failed" : "completed", truncated: false },
          };
        },
      });
      c.endStep(step, "tool-calls");
      await c.answer("The subagent ran `echo CHILD` and it printed CHILD (exit status 0).");
    },

    wake: async (c) => {
      const prompt = "Run this shell command and report its output: `sleep 8 && echo LATE`";
      const description = "Run sleep and echo";
      const step = c.startStep();
      await c.think(step, "Launch the subagent in the background, then end the turn with LAUNCHED.");
      const input = { agent: "general", description, prompt, background: true };
      const rec = c.declare(step, "subagent", input);
      c.streamed(step);
      const child = spawnChild(c, description, "general");
      const parentExec = c.ex;
      await c.tool(step, rec, {
        run: async () => {
          c.emit("session.tool.progress", { assistantMessageID: step.id, id: rec.id, metadata: { sessionID: child.id, status: "running" } });
          const cex = startChild(child, prompt, async (cc) => {
            const cs = cc.startStep();
            const crec = cc.declare(cs, "shell", { command: "sleep 8 && echo LATE" });
            cc.streamed(cs);
            // The child outlives the parent turn: it finishes ~1 s after the parent settled.
            await cc.tool(
              cs,
              crec,
              shellSpec(cc, cs, "sleep 8 && echo LATE", 0, {
                run: async (r2) => {
                  const shellID = newId("sh");
                  r2.shellID = shellID;
                  publish("shell.created", {
                    info: { id: shellID, status: "running", command: "sleep 8 && echo LATE", cwd: child.directory, shell: "/bin/zsh", file: `/tmp/fake-opencode/shell/${shellID}.out`, metadata: { sessionID: child.id }, time: { started: Date.now() } },
                  });
                  cc.emit("session.tool.progress", { assistantMessageID: cs.id, id: r2.id, metadata: { shellID } });
                  await cc.wait(parentExec.done);
                  await cc.pause(1000);
                  publish("shell.exited", { id: shellID, exit: 0, status: "exited" });
                  return { content: [{ type: "text", text: "LATE\n" }], metadata: { status: "completed", truncated: false, exit: 0 } };
                },
              }),
            );
            cc.endStep(cs, "tool-calls");
            await cc.answer("Output: `LATE`\n\nThe command completed after the 8-second sleep and printed `LATE` as expected.");
          });
          void cex.done.then(() => {
            const state = cex.failed ? "failed" : "completed";
            const text = `<subagent sessionID="${child.id}" state="${state}" description="${description}">\n${cex.failed ? String(cex.failed.message) : (cex.finalText ?? "")}\n</subagent>`;
            if (stopped || !sessions.has(c.s.id)) return;
            enqueue(c.s, {
              id: newId("msg"),
              type: "synthetic",
              payload: { text, description, metadata: { source: "subagent", childID: child.id, agent: "General", state } },
              delivery: "steer",
            });
          });
          const text =
            `The subagent is working in the background (sessionID: ${child.id}). You will be notified automatically when it finishes.\n` +
            "DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.\n" +
            "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.";
          return { content: [{ type: "text", text }], metadata: { sessionID: child.id, status: "running", truncated: false } };
        },
      });
      c.endStep(step, "tool-calls");
      await c.answer("LAUNCHED");
    },
  };

  function spawnChild(c: Ctx, title: string, agent: string): Session {
    const made = createSession({ parentID: c.s.id, title, agent });
    if (made instanceof Response) throw new Error("fake: could not create the child session");
    return made;
  }
  function startChild(child: Session, prompt: string, script: Scenario): Exec {
    enqueue(child, { id: newId("msg"), type: "user", payload: { text: `You are a subagent spawned by another session.\n${prompt}` }, delivery: "steer" }, script);
    // enqueue() starts the turn on a microtask; the parent needs the handle now.
    const ex = maybeStart(child, script);
    if (!ex) throw new Error("fake: the child execution did not start");
    return ex;
  }

  // ------------------------------------------------------- messages
  function listMessages(s: Session, q: URLSearchParams): Response {
    if (q.get("cursor") && q.get("order") !== null) return jsonResponse(400, { _tag: "InvalidCursorError", message: "Cursor cannot be combined with order" });
    let decoded: { id: string; order: "asc" | "desc"; direction: "previous" | "next" } | undefined;
    if (q.get("cursor")) {
      try {
        decoded = JSON.parse(Buffer.from(q.get("cursor")!, "base64url").toString("utf8"));
      } catch {
        return jsonResponse(400, { _tag: "InvalidCursorError", message: "Invalid cursor" });
      }
    }
    const order = decoded?.order ?? (q.get("order") === "asc" ? "asc" : "desc");
    const limit = Math.min(Math.max(parseInt(q.get("limit") ?? "50", 10) || 50, 1), 200);
    const type = q.get("type");
    let all = s.messages.map((m) => structuredClone(m));
    if (type) all = all.filter((m) => m.type === type);
    if (order === "desc") all.reverse();
    let page: J[];
    if (decoded) {
      const at = all.findIndex((m) => m.id === decoded!.id);
      if (at < 0) return jsonResponse(400, { _tag: "InvalidCursorError", message: "Invalid cursor" });
      page = decoded.direction === "next" ? all.slice(at + 1, at + 1 + limit) : all.slice(Math.max(0, at - limit), at);
    } else {
      page = all.slice(0, limit);
    }
    const enc = (m: J, direction: string): string => Buffer.from(JSON.stringify({ id: m.id, order, direction })).toString("base64url");
    const first = page[0];
    const last = page.at(-1);
    return jsonResponse(200, { data: page, cursor: { ...(first ? { previous: enc(first, "previous") } : {}), ...(last ? { next: enc(last, "next") } : {}) } });
  }

  // ------------------------------------------------------- http
  async function readBody(req: Request): Promise<J | Response> {
    const text = await req.text();
    if (!text) return {};
    try {
      const v = JSON.parse(text);
      return v && typeof v === "object" ? v : err.invalid("Expected an object");
    } catch {
      return err.invalid("Invalid JSON");
    }
  }

  async function handle(req: Request): Promise<Response> {
    if (req.headers.get("authorization") !== expectedAuth) {
      return new Response(JSON.stringify({ _tag: "UnauthorizedError", message: "Authentication required" }), {
        status: 401,
        headers: { "content-type": "application/json", "www-authenticate": 'Basic realm="opencode"' },
      });
    }
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === "GET" && path === "/api/info") {
      return jsonResponse(200, { version, pid: process.pid, urls: [serverUrl], paths: { tmp: "/tmp/fake-opencode" }, capabilities: { persistentPty: true } });
    }
    if (method === "GET" && path === "/api/event") return eventStream();
    if (method === "GET" && path === "/api/session/active") {
      const data: J = {};
      for (const [id, r] of runtimes) if (r.exec) data[id] = { type: "running" };
      return jsonResponse(200, { data });
    }
    if (path === "/api/session") {
      if (method === "GET") {
        const parent = url.searchParams.get("parentID");
        const dir = url.searchParams.get("directory");
        const archived = url.searchParams.get("archived");
        const search = url.searchParams.get("search")?.toLowerCase();
        let list = [...sessions.values()].filter((s) => (parent ? s.parentID === parent : true));
        if (dir) list = list.filter((s) => s.directory === dir);
        if (archived !== null) list = list.filter((s) => (archived === "true") === (s.time.archived !== undefined));
        if (search) list = list.filter((s) => (s.title ?? "").toLowerCase().includes(search));
        list.sort((a, b) => b.time.updated - a.time.updated);
        if (url.searchParams.get("order") === "asc") list.reverse();
        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 200);
        const page = list.slice(0, limit).map(sessionJson);
        const first = page[0];
        const last = page.at(-1);
        return jsonResponse(200, {
          data: page,
          cursor: { ...(first ? { previous: Buffer.from(JSON.stringify({ id: first.id, direction: "previous" })).toString("base64url") } : {}), ...(last ? { next: Buffer.from(JSON.stringify({ id: last.id, direction: "next" })).toString("base64url") } : {}) },
        });
      }
      if (method === "POST") {
        const body = await readBody(req);
        if (body instanceof Response) return body;
        if (body.model !== undefined && (typeof body.model?.id !== "string" || typeof body.model?.providerID !== "string")) return err.invalid('Missing key\n  at ["model"]["id"]');
        const made = createSession(body);
        if (made instanceof Response) return made;
        return jsonResponse(200, { data: sessionJson(made) });
      }
    }

    const m = /^\/api\/session\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (!m) return new Response(null, { status: 404 });
    const sid = decodeURIComponent(m[1]!);
    const rest = m[2] ?? "";
    const s = sessions.get(sid);
    if (!s) return err.session(sid);
    const r = rt(sid);

    if (rest === "") {
      if (method === "GET") return jsonResponse(200, { data: sessionJson(s) });
      if (method === "DELETE") {
        r.exec?.ac.abort("shutdown");
        sessions.delete(sid);
        runtimes.delete(sid);
        dirty();
        return jsonResponse(204);
      }
      if (method === "PATCH") {
        const body = await readBody(req);
        if (body instanceof Response) return body;
        if (typeof body.title === "string") s.title = body.title;
        if (body.metadata && typeof body.metadata === "object") s.metadata = body.metadata;
        if (Array.isArray(body.permissions)) s.permissions = body.permissions;
        if (typeof body.archived === "boolean") s.time.archived = body.archived ? Date.now() : undefined;
        s.time.updated = Date.now();
        dirty();
        return jsonResponse(204);
      }
    }

    if (rest === "model" && method === "POST") {
      const body = await readBody(req);
      if (body instanceof Response) return body;
      const model = body.model;
      if (!model || typeof model.id !== "string" || typeof model.providerID !== "string") return err.invalid('Missing key\n  at ["model"]');
      const next = { id: model.id, providerID: model.providerID, variant: model.variant ?? "default" };
      const same = next.id === s.model.id && next.providerID === s.model.providerID && next.variant === s.model.variant;
      if (!same) {
        const previous = s.model;
        s.model = next;
        s.messages.push({ id: newId("msg"), time: { created: Date.now() }, type: "model-switched", model: next, previous });
        publish("session.model.selected", { sessionID: sid, model: next, previous });
      }
      return jsonResponse(204);
    }
    if (rest === "agent" && method === "POST") {
      const body = await readBody(req);
      if (body instanceof Response) return body;
      if (typeof body.agent !== "string") return err.invalid('Missing key\n  at ["agent"]');
      const previous = s.agent;
      s.agent = body.agent;
      s.messages.push({ id: newId("msg"), time: { created: Date.now() }, type: "agent-switched", agent: body.agent, ...(previous ? { previous } : {}) });
      publish("session.agent.selected", { sessionID: sid, agent: body.agent, ...(previous ? { previous } : {}) });
      return jsonResponse(204);
    }
    if (rest === "prompt" && method === "POST") {
      const body = await readBody(req);
      if (body instanceof Response) return body;
      if (typeof body.text !== "string") return err.invalid('Missing key\n  at ["text"]');
      const delivery = body.delivery === "queue" ? "queue" : "steer";
      const id = typeof body.id === "string" && body.id ? body.id : newId("msg");
      if (s.inbox.some((i) => i.id === id) || s.messages.some((x) => x.id === id)) return err.conflict(`Message already exists: ${id}`, id);
      const item = enqueue(s, { id, type: "user", payload: { text: body.text, ...(body.metadata ? { metadata: body.metadata } : {}) }, delivery });
      return jsonResponse(200, { data: { id: item.id, sessionID: sid, time: item.time, type: "user", payload: item.payload, delivery } });
    }
    if (rest === "interrupt" && method === "POST") {
      const ex = r.exec;
      if (!ex) return jsonResponse(200, { interrupted: false });
      ex.ac.abort("user");
      return jsonResponse(200, { interrupted: true });
    }
    if (rest === "message" && method === "GET") return listMessages(s, url.searchParams);
    if (rest === "permission" && method === "GET") return jsonResponse(200, { data: [...r.perms.values()].map((p) => p.req) });
    if (rest === "form" && method === "GET") {
      return jsonResponse(200, { data: [...r.forms.values()].filter((f) => f.state.status === "pending").map((f) => f.form) });
    }

    const pm = /^permission\/([^/]+)\/reply$/.exec(rest);
    if (pm && method === "POST") {
      const rid = decodeURIComponent(pm[1]!);
      const body = await readBody(req);
      if (body instanceof Response) return body;
      if (!["once", "always", "reject"].includes(body.decision)) return err.invalid('Expected "once" | "always" | "reject"\n  at ["decision"]');
      const rec = r.perms.get(rid);
      if (!rec) return jsonResponse(404, { _tag: "PermissionNotFoundError", requestID: rid, message: `Permission request not found: ${rid}` });
      r.perms.delete(rid);
      publish("permission.replied", { sessionID: sid, requestID: rid, reply: body.decision });
      rec.resolve({ decision: body.decision, ...(typeof body.message === "string" && body.message ? { message: body.message } : {}) });
      return jsonResponse(204);
    }

    const fm = /^form\/([^/]+)(\/reply)?$/.exec(rest);
    if (fm) {
      const fid = decodeURIComponent(fm[1]!);
      const rec = r.forms.get(fid);
      if (!rec) return jsonResponse(404, { _tag: "FormNotFoundError", id: fid, message: `Form not found: ${fid}` });
      const settled = jsonResponse(409, { _tag: "FormAlreadySettledError", id: fid, message: `Form already settled: ${fid}` });
      if (fm[2] && method === "POST") {
        const body = await readBody(req);
        if (body instanceof Response) return body;
        if (!body.answer || typeof body.answer !== "object" || Array.isArray(body.answer)) return err.invalid('Missing key\n  at ["answer"]');
        if (rec.state.status !== "pending") return settled;
        for (const [k, v] of Object.entries(body.answer)) {
          if (typeof v !== "string") return jsonResponse(400, { _tag: "FormInvalidAnswerError", id: fid, message: `Invalid answer for ${k}` });
        }
        rec.state = { status: "answered", answer: body.answer };
        publish("form.replied", { id: fid, sessionID: sid, answer: body.answer });
        rec.resolve({ kind: "answered", answer: body.answer });
        return jsonResponse(204);
      }
      if (!fm[2] && method === "GET") return jsonResponse(200, { data: { ...rec.form, state: rec.state } });
      if (!fm[2] && method === "DELETE") {
        if (rec.state.status !== "pending") return settled;
        const message = url.searchParams.get("message") || undefined;
        rec.state = { status: "cancelled", ...(message ? { message } : {}) };
        publish("form.cancelled", { id: fid, sessionID: sid });
        rec.resolve({ kind: "cancelled", message });
        return jsonResponse(204);
      }
    }
    return new Response(null, { status: 404 });
  }

  function eventStream(): Response {
    const enc = new TextEncoder();
    let sub: { send(chunk: string): void; close(): void } | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        sub = {
          send: (chunk) => {
            try {
              controller.enqueue(enc.encode(chunk));
            } catch {
              // The client went away between the enqueue and the cancel callback.
            }
          },
          close: () => {
            if (timer) clearInterval(timer);
            try {
              controller.close();
            } catch {
              // Already closed.
            }
          },
        };
        subscribers.add(sub);
        sub.send(`data: ${JSON.stringify({ id: newId("evt"), type: "server.connected", data: {} })}\n\n`);
        timer = setInterval(() => sub?.send(": heartbeat\n\n"), heartbeatMs);
      },
      cancel() {
        if (timer) clearInterval(timer);
        if (sub) subscribers.delete(sub);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff",
      },
    });
  }

  const server = Bun.serve({
    hostname: opts.hostname ?? "127.0.0.1",
    port: opts.port ?? 0,
    idleTimeout: 0,
    fetch: (req) =>
      handle(req).catch((e) => jsonResponse(500, { _tag: "UnknownError", message: String((e as Error)?.message ?? e) })),
  });
  const serverUrl = `http://${server.hostname}:${server.port}`;

  return {
    url: serverUrl,
    port: server.port ?? 0,
    password,
    dropEventStreams() {
      for (const sub of [...subscribers]) {
        subscribers.delete(sub);
        sub.close();
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const r of runtimes.values()) r.exec?.ac.abort("shutdown");
      await Promise.all([...runtimes.values()].map((r) => r.exec?.done));
      for (const sub of [...subscribers]) sub.close();
      subscribers.clear();
      saveNow();
      await server.stop(true);
    },
  };
}

// --------------------------------------------------------------------- CLI

function argOf(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const given = process.env.OPENCODE_PASSWORD;
  const password = given || randomBytes(16).toString("hex");
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
  };
  const srv = await startFakeOpencodeServer({
    hostname: argOf(argv, "--hostname") ?? "127.0.0.1",
    port: num(argOf(argv, "--port"), 0),
    password,
    speed: num(process.env.FAKE_OC_SPEED, 1),
    heartbeatMs: num(process.env.FAKE_OC_HEARTBEAT_MS, 15000),
    stateFile: process.env.FAKE_OC_STATE_FILE || undefined,
    version: process.env.FAKE_OC_VERSION || undefined,
    quotaModels: process.env.FAKE_OC_QUOTA_MODELS ? process.env.FAKE_OC_QUOTA_MODELS.split(",").map((x) => x.trim()).filter(Boolean) : undefined,
  });
  console.log(`server listening on ${srv.url}`);
  // Like the real serve, print a generated password only when none was given.
  if (!given) console.log(`server password ${password}`);
  const quit = (): void => {
    void srv.stop().finally(() => process.exit(0));
  };
  process.on("SIGTERM", quit);
  process.on("SIGINT", quit);
  // A test double must not outlive whoever started it: the direct test host
  // (AGETOR_OPENCODE_SERVER_HOST=direct) spawns this as a child of the bun
  // test process or an e2e backend, and when that process exits without
  // stopping it the child was re-parented to launchd and ran forever. Exit as
  // soon as the parent changes (under tmux the parent is the tmux server, so a
  // kill-session/kill-server ends it too).
  // (Bun caches process.ppid, so probe the original parent pid instead.)
  const parent = process.ppid;
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      quit();
    }
  }, 1000);
}

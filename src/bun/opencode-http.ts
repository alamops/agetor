/**
 * Typed HTTP + SSE client for an `opencode serve` process (OpenCode v2.x,
 * `/api/*`). Plan: `docs/plans/opencode-server-driver.md` (T1) — the server hub
 * (T7) owns the connection lifecycle and the driver (T9) maps what this client
 * returns; this module only speaks the wire protocol.
 *
 * Facts it encodes (live-verified on v2.1.3, cross-checked with the server's
 * own openapi document):
 *
 *   - Auth is HTTP Basic, username `opencode`, password = the server's
 *     `OPENCODE_PASSWORD`. `GET /api/info` is authenticated too.
 *   - Reads wrap their payload as `{ data }` (`GET /api/info` is the exception:
 *     the object itself). Writes that return nothing answer 204.
 *   - Errors are JSON `{ _tag, message }` (`ConflictError`,
 *     `SessionNotFoundError`, ...); a 401 carries no useful body.
 *   - `GET /api/session/{id}/message` pages with `cursor` and takes `order`
 *     only for the first page — the two must not be combined.
 *   - `GET /api/event` is one global SSE stream: `data: <json>\n\n` frames, a
 *     `: heartbeat` comment every 15 s, no `id:` field and no replay.
 *
 * Invariants (plan section 7):
 *   - I4: the password lives only in the Authorization header this module
 *     builds. It is never put in a URL, an error message or a log line;
 *     everything that becomes an error message is redacted first.
 *   - I7: HTTP goes to a loopback `http:` origin only. Both constructors
 *     refuse anything else, so a bad state file can never send the password
 *     off the machine.
 *
 * Timeouts: every request op has an `AbortController` timeout (default 10 s).
 * The SSE fetch has no overall timeout — it is long-lived by design — so Bun's
 * own fetch timeout is switched off (`timeout: false`) and a stall watchdog
 * (no bytes, heartbeats included, for `stallMs`) replaces it. There is no
 * reconnect here: the hub owns reconnect, resync and backoff.
 */

/** Where one `opencode serve` listens and the password it was started with. */
export interface OpencodeServerRef {
  url: string;
  password: string;
}

/** One SSE frame's JSON. `data` is event-specific and mapped by the driver. */
export interface OpencodeEnvelope {
  id?: string;
  type: string;
  created?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  location?: { directory?: string };
  durable?: { aggregateID: string; seq: number; version?: number };
}

export interface OpencodeModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export interface OpencodePermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

/** Default per-call timeout for request ops (never applied to SSE). */
export const OPENCODE_HTTP_TIMEOUT_MS = 10_000;
/** Default SSE stall budget: three missed 15 s heartbeats. */
export const OPENCODE_SSE_STALL_MS = 45_000;
/** A single SSE frame (or an unterminated line) above this aborts the stream. */
const MAX_SSE_PENDING_CHARS = 16 * 1024 * 1024;
/** `listChildren` page size and the cap on pages followed. */
const CHILD_PAGE_LIMIT = 200;
const CHILD_MAX_PAGES = 10;
/** Cap on the server-supplied text that is folded into an error message. */
const MAX_ERROR_TEXT_CHARS = 300;

/** A failed OpenCode HTTP call. `status` is 0 for a transport failure or a
 *  timeout (`tag` is then `"Timeout"`, `"NetworkError"` or `"BadResponse"`);
 *  otherwise the HTTP status, with the server's `_tag` when it sent one. The
 *  message never contains the password or the Authorization header. */
export class OpencodeHttpError extends Error {
  status: number;
  tag?: string;
  op: string;
  constructor(op: string, status: number, message: string, tag?: string) {
    super(message);
    this.name = "OpencodeHttpError";
    this.op = op;
    this.status = status;
    this.tag = tag;
  }
}

/** `"Basic " + base64("opencode:" + password)`. */
export function opencodeAuthHeader(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
}

/** True for a plain `http:` URL on 127.0.0.1, ::1 or localhost, with no
 *  userinfo. Anything else — https, a LAN address, a hostname that merely
 *  starts with `localhost` — is refused (I7). */
export function isLoopbackOpencodeUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  return u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "localhost";
}

function assertServerRef(ref: OpencodeServerRef): string {
  if (!isLoopbackOpencodeUrl(ref.url)) {
    throw new Error("OpenCode server URL must be an http loopback address (127.0.0.1, ::1 or localhost)");
  }
  if (!ref.password) throw new Error("OpenCode server password is empty");
  return new URL(ref.url).origin;
}

/** Strip the password and its base64 form out of text bound for an error. */
function redactSecrets(text: string, password: string): string {
  let out = text;
  for (const secret of [password, Buffer.from(`opencode:${password}`).toString("base64")]) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** Server-supplied text folded into an error: redacted, control characters
 *  flattened, capped. (Printing it to a terminal still goes through
 *  `escapeFreeText` at the call site.) */
function safeErrorText(text: string, password: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = redactSecrets(text, password).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length > MAX_ERROR_TEXT_CHARS ? `${flat.slice(0, MAX_ERROR_TEXT_CHARS)}...` : flat;
}

export interface OpencodeClient {
  info(): Promise<{ version: string; pid?: number }>;
  createSession(a: {
    directory: string;
    title?: string;
    agent?: string;
    model?: OpencodeModelRef;
    permissions?: OpencodePermissionRule[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): Promise<any>;
  /** `null` when the server has no such session (404). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getSession(id: string): Promise<any | null>;
  updateSession(id: string, a: { title?: string; permissions?: OpencodePermissionRule[] }): Promise<void>;
  switchModel(id: string, model: OpencodeModelRef): Promise<void>;
  switchAgent(id: string, agent: string): Promise<void>;
  prompt(id: string, a: { id?: string; text: string; delivery?: "steer" | "queue" }): Promise<{ id: string; delivery?: string }>;
  /** True when an execution was actually interrupted. */
  interrupt(id: string): Promise<boolean>;
  activeSessions(): Promise<Record<string, { type: string }>>;
  listMessages(
    id: string,
    a?: { limit?: number; cursor?: string; order?: "asc" | "desc" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ data: any[]; cursor?: { next?: string; previous?: string } }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listPermissions(sessionId: string): Promise<any[]>;
  replyPermission(sessionId: string, requestId: string, a: { decision: "once" | "always" | "reject"; message?: string }): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listForms(sessionId: string): Promise<any[]>;
  replyForm(sessionId: string, formId: string, answer: Record<string, unknown>): Promise<void>;
  cancelForm(sessionId: string, formId: string, message?: string): Promise<void>;
  /** Child (subagent) sessions of `sessionId`, newest page first, all pages up
   *  to a cap. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listChildren(sessionId: string): Promise<any[]>;
}

interface CallArgs {
  op: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** Statuses to hand back to the caller instead of throwing. */
  passStatuses?: number[];
}

/** Drop `undefined` fields so an optional argument is absent on the wire,
 *  not `null`. Builds a fresh object from known keys only. */
function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

export function createOpencodeClient(
  ref: OpencodeServerRef,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): OpencodeClient {
  const origin = assertServerRef(ref);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? OPENCODE_HTTP_TIMEOUT_MS;
  const authorization = opencodeAuthHeader(ref.password);
  const password = ref.password;

  /** One HTTP exchange. Resolves `{status, json}` for a 2xx (json undefined on
   *  204/empty) or for a status in `passStatuses`; throws `OpencodeHttpError`
   *  for everything else. */
  async function call(a: CallArgs): Promise<{ status: number; json: unknown }> {
    const qs = a.query
      ? Object.entries(a.query)
          .filter((kv): kv is [string, string] => kv[1] !== undefined)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&")
      : "";
    const url = `${origin}${a.path}${qs ? `?${qs}` : ""}`;
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs);
    try {
      let res: Response;
      let text: string;
      try {
        res = await fetchImpl(url, {
          method: a.method,
          signal: ac.signal,
          redirect: "error",
          headers: {
            authorization,
            accept: "application/json",
            ...(a.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: a.body !== undefined ? JSON.stringify(a.body) : undefined,
        });
        // Read the body inside the same timeout: a server that sends headers
        // and then stalls must not hang the caller.
        text = await res.text();
      } catch (err) {
        if (timedOut) {
          throw new OpencodeHttpError(a.op, 0, `${a.op} timed out after ${timeoutMs} ms`, "Timeout");
        }
        const name = err instanceof Error ? err.name : "Error";
        const detail = err instanceof Error ? safeErrorText(err.message, password) : "";
        throw new OpencodeHttpError(a.op, 0, `${a.op} failed: ${name}${detail ? ` (${detail})` : ""}`, "NetworkError");
      }
      let json: unknown;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
          if (res.ok) throw new OpencodeHttpError(a.op, res.status, `${a.op} returned a non-JSON body`, "BadResponse");
        }
      }
      if (res.ok || a.passStatuses?.includes(res.status)) return { status: res.status, json };
      const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
      const tag = typeof obj._tag === "string" ? safeErrorText(obj._tag, password) : undefined;
      const msg = typeof obj.message === "string" ? safeErrorText(obj.message, password) : "";
      throw new OpencodeHttpError(
        a.op,
        res.status,
        `${a.op} failed: HTTP ${res.status}${tag ? ` ${tag}` : ""}${msg ? `: ${msg}` : ""}`,
        tag,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** The `data` member of a `{ data }` reply; a reply without it is malformed. */
  function dataOf(op: string, json: unknown): unknown {
    if (json && typeof json === "object" && "data" in json) return (json as { data: unknown }).data;
    throw new OpencodeHttpError(op, 200, `${op} reply has no data`, "BadResponse");
  }

  const sid = (id: string) => `/api/session/${encodeURIComponent(id)}`;

  return {
    async info() {
      const { json } = await call({ op: "info", method: "GET", path: "/api/info" });
      const o = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
      if (typeof o.version !== "string") {
        throw new OpencodeHttpError("info", 200, "info reply has no version", "BadResponse");
      }
      return { version: o.version, pid: typeof o.pid === "number" ? o.pid : undefined };
    },

    async createSession(a) {
      const body = defined({
        title: a.title,
        agent: a.agent,
        model: a.model ? defined({ providerID: a.model.providerID, id: a.model.id, variant: a.model.variant }) : undefined,
        location: { directory: a.directory },
        permissions: a.permissions,
      });
      const { json } = await call({ op: "createSession", method: "POST", path: "/api/session", body });
      const session = dataOf("createSession", json) as { id?: unknown } | null;
      if (!session || typeof session.id !== "string") {
        throw new OpencodeHttpError("createSession", 200, "createSession reply has no session id", "BadResponse");
      }
      return session;
    },

    async getSession(id) {
      const { status, json } = await call({ op: "getSession", method: "GET", path: sid(id), passStatuses: [404] });
      if (status === 404) return null;
      return dataOf("getSession", json);
    },

    async updateSession(id, a) {
      await call({
        op: "updateSession",
        method: "PATCH",
        path: sid(id),
        body: defined({ title: a.title, permissions: a.permissions }),
      });
    },

    async switchModel(id, model) {
      await call({
        op: "switchModel",
        method: "POST",
        path: `${sid(id)}/model`,
        body: { model: defined({ providerID: model.providerID, id: model.id, variant: model.variant }) },
      });
    },

    async switchAgent(id, agent) {
      await call({ op: "switchAgent", method: "POST", path: `${sid(id)}/agent`, body: { agent } });
    },

    async prompt(id, a) {
      const { json } = await call({
        op: "prompt",
        method: "POST",
        path: `${sid(id)}/prompt`,
        body: defined({ id: a.id, text: a.text, delivery: a.delivery }),
      });
      const item = dataOf("prompt", json) as { id?: unknown; delivery?: unknown } | null;
      if (!item || typeof item.id !== "string") {
        throw new OpencodeHttpError("prompt", 200, "prompt reply has no message id", "BadResponse");
      }
      return { id: item.id, delivery: typeof item.delivery === "string" ? item.delivery : undefined };
    },

    async interrupt(id) {
      const { json } = await call({ op: "interrupt", method: "POST", path: `${sid(id)}/interrupt` });
      return !!json && typeof json === "object" && (json as { interrupted?: unknown }).interrupted === true;
    },

    async activeSessions() {
      const { json } = await call({ op: "activeSessions", method: "GET", path: "/api/session/active" });
      const data = dataOf("activeSessions", json);
      return data && typeof data === "object" ? (data as Record<string, { type: string }>) : {};
    },

    async listMessages(id, a = {}) {
      const { json } = await call({
        op: "listMessages",
        method: "GET",
        path: `${sid(id)}/message`,
        // `order` only shapes the first page; the server rejects it with a cursor.
        query: {
          limit: a.limit !== undefined ? String(a.limit) : undefined,
          cursor: a.cursor,
          order: a.cursor === undefined ? a.order : undefined,
        },
      });
      const data = dataOf("listMessages", json);
      const cur = (json as { cursor?: { next?: unknown; previous?: unknown } | null }).cursor;
      return {
        data: Array.isArray(data) ? data : [],
        cursor: cur
          ? {
              next: typeof cur.next === "string" ? cur.next : undefined,
              previous: typeof cur.previous === "string" ? cur.previous : undefined,
            }
          : undefined,
      };
    },

    async listPermissions(sessionId) {
      const { json } = await call({ op: "listPermissions", method: "GET", path: `${sid(sessionId)}/permission` });
      const data = dataOf("listPermissions", json);
      return Array.isArray(data) ? data : [];
    },

    async replyPermission(sessionId, requestId, a) {
      await call({
        op: "replyPermission",
        method: "POST",
        path: `${sid(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
        body: defined({ decision: a.decision, message: a.message }),
      });
    },

    async listForms(sessionId) {
      const { json } = await call({ op: "listForms", method: "GET", path: `${sid(sessionId)}/form` });
      const data = dataOf("listForms", json);
      return Array.isArray(data) ? data : [];
    },

    async replyForm(sessionId, formId, answer) {
      await call({
        op: "replyForm",
        method: "POST",
        path: `${sid(sessionId)}/form/${encodeURIComponent(formId)}/reply`,
        body: { answer },
      });
    },

    async cancelForm(sessionId, formId, message) {
      await call({
        op: "cancelForm",
        method: "DELETE",
        path: `${sid(sessionId)}/form/${encodeURIComponent(formId)}`,
        query: { message },
      });
    },

    async listChildren(sessionId) {
      const out: unknown[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < CHILD_MAX_PAGES; page++) {
        const { json } = await call({
          op: "listChildren",
          method: "GET",
          path: "/api/session",
          query: { parentID: sessionId, limit: String(CHILD_PAGE_LIMIT), cursor },
        });
        const data = dataOf("listChildren", json);
        if (Array.isArray(data)) {
          for (const s of data) {
            const sidValue = s && typeof s === "object" ? (s as { id?: unknown }).id : undefined;
            if (typeof sidValue === "string") {
              if (seen.has(sidValue)) continue;
              seen.add(sidValue);
            }
            out.push(s);
          }
        }
        const next = (json as { cursor?: { next?: unknown } | null }).cursor?.next;
        if (typeof next !== "string" || !next || next === cursor || !Array.isArray(data) || data.length === 0) break;
        cursor = next;
      }
      return out;
    },
  };
}

export type OpencodeStreamCloseReason = "aborted" | "stalled" | "ended" | "error";

export interface OpencodeEventStreamHandlers {
  onEvent(e: OpencodeEnvelope): void;
  /** The HTTP response arrived with a 2xx status (the first `server.connected`
   *  frame follows as an ordinary event). */
  onOpen?(): void;
  /** Called exactly once, whatever the cause. */
  onClose(reason: OpencodeStreamCloseReason, err?: unknown): void;
}

export interface OpencodeEventStream {
  close(): void;
  /** Frames delivered to `onEvent` and frames dropped as unparsable. */
  stats(): { events: number; dropped: number };
}

/**
 * Open `GET /api/event` and feed each parsed frame to `h.onEvent`. One call, one
 * connection: when it ends, stalls or fails, `h.onClose` fires once and the
 * caller (the hub) decides whether and when to reconnect and resync.
 *
 * The stall watchdog covers the whole life of the stream, connect included: no
 * bytes at all (a `: heartbeat` comment counts) for `stallMs` aborts the fetch
 * and reports `"stalled"`.
 */
export function openOpencodeEventStream(
  ref: OpencodeServerRef,
  h: OpencodeEventStreamHandlers,
  opts: { stallMs?: number; fetchImpl?: typeof fetch } = {},
): OpencodeEventStream {
  const origin = assertServerRef(ref);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stallMs = opts.stallMs ?? OPENCODE_SSE_STALL_MS;
  const authorization = opencodeAuthHeader(ref.password);
  const password = ref.password;
  const ac = new AbortController();
  let finished = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let events = 0;
  let dropped = 0;

  const finish = (reason: OpencodeStreamCloseReason, err?: unknown) => {
    if (finished) return;
    finished = true;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
    ac.abort();
    reader?.cancel().catch(() => {});
    h.onClose(reason, err);
  };

  const armWatchdog = () => {
    if (finished) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => finish("stalled"), stallMs);
  };

  /** Deliver one complete frame's `data` lines. */
  const dispatch = (dataLines: string[]) => {
    if (dataLines.length === 0 || finished) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataLines.join("\n"));
    } catch {
      dropped++;
      return;
    }
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
      dropped++;
      return;
    }
    events++;
    try {
      h.onEvent(parsed as OpencodeEnvelope);
    } catch (err) {
      // A handler that threw may have lost state; end the stream so the hub
      // reconnects and resyncs rather than carry on half-applied.
      finish("error", err);
    }
  };

  void (async () => {
    armWatchdog();
    try {
      // `timeout: false` turns off Bun's own fetch timeout, which would
      // otherwise cut a healthy long-lived stream; the watchdog replaces it.
      const res = await fetchImpl(`${origin}/api/event`, {
        method: "GET",
        signal: ac.signal,
        redirect: "error",
        headers: { authorization, accept: "text/event-stream", "cache-control": "no-cache" },
        timeout: false,
      } as RequestInit);
      if (finished) {
        res.body?.cancel().catch(() => {});
        return;
      }
      if (!res.ok || !res.body) {
        // The body of an error reply is not needed (and not trusted).
        res.body?.cancel().catch(() => {});
        finish("error", new OpencodeHttpError("events", res.status, `events failed: HTTP ${res.status}`));
        return;
      }
      armWatchdog();
      h.onOpen?.();
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      // Line assembly. `pending` is the unterminated tail; a trailing "\r" is
      // held back because the "\n" of a CRLF pair may arrive in the next chunk.
      let pending = "";
      let dataLines: string[] = [];
      let frameChars = 0;

      const handleLine = (line: string) => {
        if (line === "") {
          dispatch(dataLines);
          dataLines = [];
          frameChars = 0;
        } else if (line.startsWith(":")) {
          // comment / heartbeat
        } else if (line.startsWith("data:")) {
          const v = line.slice(5);
          dataLines.push(v.startsWith(" ") ? v.slice(1) : v);
          frameChars += v.length;
        }
        // event:, id:, retry: carry nothing this API uses.
      };

      const consume = (final: boolean) => {
        let start = 0;
        for (let i = 0; i < pending.length && !finished; i++) {
          const ch = pending.charCodeAt(i);
          if (ch !== 10 && ch !== 13) continue;
          if (ch === 13) {
            if (i + 1 >= pending.length && !final) break; // maybe CRLF split across chunks
            handleLine(pending.slice(start, i));
            if (pending.charCodeAt(i + 1) === 10) i++;
            start = i + 1;
          } else {
            handleLine(pending.slice(start, i));
            start = i + 1;
          }
        }
        pending = pending.slice(start);
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (finished) return;
        if (done) {
          pending += decoder.decode();
          consume(true);
          // A final unterminated line is not a complete frame; drop it.
          finish("ended");
          return;
        }
        armWatchdog();
        pending += decoder.decode(value, { stream: true });
        consume(false);
        if (finished) return;
        if (pending.length + frameChars > MAX_SSE_PENDING_CHARS) {
          finish("error", new Error("OpenCode event stream line exceeded the size cap"));
          return;
        }
      }
    } catch (err) {
      if (finished) return; // abort() from close() or the watchdog
      finish("error", err instanceof Error ? new Error(safeErrorText(err.message, password)) : err);
    }
  })().catch((err) => finish("error", err));

  return {
    close() {
      finish("aborted");
    },
    stats() {
      return { events, dropped };
    },
  };
}

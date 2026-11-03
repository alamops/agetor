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

/** One undelivered inbox item of a session (`GET /api/session/{id}/inbox`).
 *  `text` and `metadata` come from the item's `payload`. A user prompt or
 *  steer is `type: "user"`; a subagent's notice to its parent is
 *  `type: "synthetic"` with `metadata.source === "subagent"`. */
export type OpencodeInboxItem = {
  id: string;
  type: string;
  delivery?: string;
  text?: string;
  metadata?: { source?: string; childID?: string; agent?: string; state?: string };
};

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
/** The most bytes of one request op's response body the client reads. */
export const OPENCODE_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

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

/**
 * Strip the password out of text bound for an error, a log or a status line:
 * the raw password and its base64 `opencode:<password>` form, then anything
 * that looks like it travels with a credential (`password=...`,
 * `OPENCODE_PASSWORD=...`, `Authorization: ...`, `Basic <b64>`, `Bearer <tok>`),
 * JSON-quoted keys and values included (`"password":"x"`,
 * `"OPENCODE_PASSWORD": "x"`, `"authorization":"Basic x"`), so a password it
 * was not told is still caught in a dumped config or request.
 * The single redactor for the OpenCode server code.
 */
export function redactSecrets(text: string, password?: string): string {
  let out = text;
  if (password) {
    for (const secret of [password, Buffer.from(`opencode:${password}`).toString("base64")]) {
      if (secret) out = out.split(secret).join("[redacted]");
    }
  }
  return (
    out
      // A quoted value (`password: "a b"`, `"password":"x"`, `password "x"`), up
      // to its closing quote or the end of the line when it has none.
      .replace(/(password(?:"?\s*[=:]\s*|\s+))"(?:[^"\\\n]|\\.)*"?/gi, '$1"[redacted]"')
      // A bare value (`password=x`, `"password": 12`, `password x`). It never
      // starts with a quote, so a value the line above redacted stays as it is.
      .replace(/(password(?:"?\s*[=:]\s*|\s+))(?!")\S+/gi, "$1[redacted]")
      .replace(/(authorization"?\s*[:=]\s*"?)(?:(?:basic|bearer)\s+)?[^\s"]+/gi, "$1[redacted]")
      .replace(/\b(basic|bearer)(\s+)[A-Za-z0-9+/=._~-]{8,}/gi, "$1$2[redacted]")
  );
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
  /** `resume: false` enqueues without starting an execution (a replay after idle otherwise runs an empty one; live: docs/plans/opencode-server-driver-spikes.md). */
  prompt(id: string, a: { id?: string; text: string; delivery?: "steer" | "queue"; resume?: boolean }): Promise<{ id: string; delivery?: string }>;
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
  /** The session's inbox: items enqueued and not yet delivered, in enqueue
   *  order. Malformed entries (no string `id` or `type`) are dropped. */
  listInbox(sessionId: string): Promise<OpencodeInboxItem[]>;
  /** Ask the server to cancel one undelivered inbox item. True when it accepted
   *  the request (2xx). That does NOT prove the item was removed: live 2.1.3
   *  answers 204 for any well-formed `msg_…` id, whether it removed a pending
   *  item or the item was already delivered, already cancelled or unknown; only
   *  a real removal publishes `session.inbox.cancelled{sessionID, inboxID}`.
   *  False on 404 (no such session). Throws on anything else, a 400
   *  (`InvalidRequestError`, a malformed id) included. */
  cancelInboxItem(sessionId: string, inboxId: string): Promise<boolean>;
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

/**
 * The response body as text, read incrementally and refused once it passes
 * `max` bytes (a declared `content-length` over the cap is refused before any
 * body is read), so a misbehaving server cannot make the core buffer an
 * unbounded reply. The message carries no server text. Over the cap it throws
 * an `OpencodeHttpError` (`status` 0, `tag` `"BadResponse"`); a failed read
 * rethrows the stream's own error. Also used by the server manager's health
 * probe (`opencode-server.ts`), so every body read from the server is capped.
 */
export async function readCappedText(op: string, res: Response, max: number): Promise<string> {
  const tooBig = () => new OpencodeHttpError(op, 0, `${op} reply is larger than ${max} bytes`, "BadResponse");
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw tooBig();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const optStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** One raw inbox entry → `OpencodeInboxItem`, or null when it has no string
 *  `id`/`type`. Only known fields are copied, and only when they are strings. */
function parseInboxItem(raw: unknown): OpencodeInboxItem | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id === "" || typeof o.type !== "string") return null;
  const item: OpencodeInboxItem = { id: o.id, type: o.type };
  const delivery = optStr(o.delivery);
  if (delivery !== undefined) item.delivery = delivery;
  const payload = o.payload && typeof o.payload === "object" ? (o.payload as Record<string, unknown>) : undefined;
  const text = optStr(payload?.text);
  if (text !== undefined) item.text = text;
  const m = payload?.metadata && typeof payload.metadata === "object" ? (payload.metadata as Record<string, unknown>) : undefined;
  if (m) {
    const metadata: NonNullable<OpencodeInboxItem["metadata"]> = {};
    for (const k of ["source", "childID", "agent", "state"] as const) {
      const v = optStr(m[k]);
      if (v !== undefined) metadata[k] = v;
    }
    item.metadata = metadata;
  }
  return item;
}

export function createOpencodeClient(
  ref: OpencodeServerRef,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number } = {},
): OpencodeClient {
  const origin = assertServerRef(ref);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? OPENCODE_HTTP_TIMEOUT_MS;
  const maxBytes = opts.maxResponseBytes ?? OPENCODE_MAX_RESPONSE_BYTES;
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
        text = await readCappedText(a.op, res, maxBytes);
      } catch (err) {
        if (err instanceof OpencodeHttpError) throw err;
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
        body: defined({ id: a.id, text: a.text, delivery: a.delivery, resume: a.resume }),
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

    async listInbox(sessionId) {
      const { json } = await call({ op: "listInbox", method: "GET", path: `${sid(sessionId)}/inbox` });
      // `{ data: [...] }` like the other lists; a bare array is accepted too.
      const data = Array.isArray(json) ? json : dataOf("listInbox", json);
      return Array.isArray(data) ? data.map(parseInboxItem).filter((x): x is OpencodeInboxItem => x !== null) : [];
    },

    async cancelInboxItem(sessionId, inboxId) {
      const { status } = await call({
        op: "cancelInboxItem",
        method: "DELETE",
        path: `${sid(sessionId)}/inbox/${encodeURIComponent(inboxId)}`,
        passStatuses: [404],
      });
      return status >= 200 && status < 300;
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
      // Line assembly. Only the newly decoded text is scanned, and the
      // unterminated tail is kept as a list of pieces joined once its line
      // ends, so a large single-line frame costs O(n), not O(n^2), on the
      // shared main thread. A CR ends a line at once; `crPending` swallows the
      // LF of a CRLF pair that arrives in the next chunk.
      let tail: string[] = [];
      let tailChars = 0;
      let crPending = false;
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

      const emit = (segment: string) => {
        const line = tail.length > 0 ? tail.join("") + segment : segment;
        tail = [];
        tailChars = 0;
        handleLine(line);
      };

      const consume = (text: string) => {
        let start = 0;
        let i = 0;
        if (crPending) {
          crPending = false;
          if (text.charCodeAt(0) === 10) start = i = 1;
        }
        for (; i < text.length && !finished; i++) {
          const ch = text.charCodeAt(i);
          if (ch !== 10 && ch !== 13) continue;
          emit(text.slice(start, i));
          if (ch === 13) {
            if (i + 1 < text.length) {
              if (text.charCodeAt(i + 1) === 10) i++;
            } else {
              crPending = true;
            }
          }
          start = i + 1;
        }
        if (!finished && start < text.length) {
          tail.push(text.slice(start));
          tailChars += text.length - start;
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (finished) return;
        if (done) {
          consume(decoder.decode());
          // A final unterminated line is not a complete frame; drop it.
          finish("ended");
          return;
        }
        armWatchdog();
        consume(decoder.decode(value, { stream: true }));
        if (finished) return;
        if (tailChars + frameChars > MAX_SSE_PENDING_CHARS) {
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

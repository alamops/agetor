/**
 * Cursor usage/quota provider for the per-harness usage tracker
 * (docs/plans/harness-usage-tracker.md, section 2 "cursor" bullets, section 3
 * "Cursor is opt-in-flavored but on by default", and Wave B3).
 *
 * **Cursor stores no local usage/quota data at all** (Phase 1 probe:
 * `cli-config.json` and the `ai-tracking` SQLite DB carry no quota fields).
 * The only known path — CodexBar's — is to obtain the Cursor **web** session
 * cookie (`WorkosCursorSessionToken`) from either the Cursor IDE's
 * `state.vscdb` or a browser cookie store, then call `cursor.com`'s
 * undocumented `usage-summary`/`auth/me` endpoints with that cookie. This is
 * invasive and OS-permission-gated, so per the plan's explicit decision this
 * whole module is **best-effort and must fail soft**: every exported function
 * resolves (never throws) and degrades to `status:"unavailable"` with a
 * human-readable `reason` whenever a cookie can't be obtained, the network
 * call fails, or the response shape isn't recognized. Never prompts the user,
 * never blocks the poller (`src/bun/usage/poller.ts`), never blocks any other
 * provider.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import type { Harness, HarnessQuota, QuotaMeter } from "../../shared/types.ts";

const USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary";
const AUTH_ME_URL = "https://cursor.com/api/auth/me";
const FETCH_TIMEOUT_MS = 5000;

const COOKIE_NAME = "WorkosCursorSessionToken";

const OAUTH_TOKEN_URL = "https://api2.cursor.sh/oauth/token";
/** Cursor's public OAuth client id (the same one the IDE/CLI refresh with). */
const OAUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";

/** Shown when the saved login can't be used (expired and unrefreshable, or
 *  rejected by `usage-summary`). Deliberately carries no URL. */
export const CURSOR_LOGIN_EXPIRED_REASON =
  "Cursor's saved login expired or was rejected. Open the Cursor app and sign in again, then click Refresh \u2014 Agetor reads Cursor's local login to fetch plan usage.";

/**
 * Path to the Cursor IDE's VS Code-style global storage SQLite DB, where the
 * desktop app persists its own signed-in session. `harness.home` re-homes
 * `cursor-agent` via a plain `HOME` override (see `Harness.home` doc), but
 * the Cursor *IDE* (a separate GUI app, not the CLI) is not home-scoped by
 * agetor — it always lives under the real user's `~/Library/Application
 * Support`. We probe that fixed location regardless of `harness.home`;
 * `harness` is accepted for API symmetry with the other providers and to
 * leave room for a future per-harness override.
 */
function cursorStateDbPath(): string {
  return path.join(
    homedir(),
    "Library",
    "Application Support",
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb",
  );
}

/**
 * Best-effort extraction of a `WorkosCursorSessionToken` value from a
 * `state.vscdb` `ItemTable` row's stored value. The Cursor IDE has stored
 * this under a few observed shapes — a bare cookie-value string, a JSON blob
 * with a `cookie`/`token`/`accessToken` field, or a raw `Cookie:`-style
 * string containing `WorkosCursorSessionToken=<value>` — so this is
 * deliberately shape-tolerant rather than assuming one exact encoding.
 * Returns `null` if nothing recognizable is found. Never throws (caller
 * wraps in try/catch, but this is written defensively too).
 */
function extractTokenFromValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Shape 1: `WorkosCursorSessionToken=<value>` embedded in a cookie string
  // (possibly with other `; `-separated cookies alongside it).
  const cookieMatch = trimmed.match(
    new RegExp(`${COOKIE_NAME}=([^;\\s"']+)`),
  );
  if (cookieMatch?.[1]) return cookieMatch[1];

  // Shape 2: JSON blob with a token-ish field.
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const candidates = [
        (parsed as Record<string, unknown>).accessToken,
        (parsed as Record<string, unknown>).cookie,
        (parsed as Record<string, unknown>).token,
        (parsed as Record<string, unknown>).WorkosCursorSessionToken,
      ];
      for (const c of candidates) {
        if (typeof c === "string" && c) {
          const nested = extractTokenFromValueNonJson(c);
          if (nested) return nested;
        }
      }
    }
  } catch {
    // not JSON — fall through
  }

  // Shape 3: a bare token value with no wrapper at all (e.g. the raw
  // `cursorAuth/accessToken` JWT string). Previously only reachable via the
  // JSON-nested path — a plain string value must get the same treatment.
  return extractTokenFromValueNonJson(trimmed);
}

/** Helper for the JSON-nested-cookie-string case in `extractTokenFromValue`,
 *  split out so it doesn't recurse into JSON parsing again. */
function extractTokenFromValueNonJson(value: string): string | null {
  const cookieMatch = value.match(new RegExp(`${COOKIE_NAME}=([^;\\s"']+)`));
  if (cookieMatch?.[1]) return cookieMatch[1];
  // A bare token value with no `key=` wrapper — accept it as-is if it looks
  // like an opaque session token (non-trivial length, no whitespace).
  if (/^[A-Za-z0-9._-]{20,}$/.test(value)) return value;
  return null;
}

/**
 * Derive the `WorkosCursorSessionToken` cookie value from the IDE's stored
 * OAuth access token. The IDE keeps a bare JWT under `cursorAuth/accessToken`
 * — NOT the web cookie itself. The web session cookie's observed format
 * (what CodexBar derives, and what cursor.com's dashboard sends) is
 * `<userId>%3A%3A<jwt>` — the user id URL-encoded-joined (`::`) with the
 * JWT, where the user id is the tail of the JWT payload's `sub` claim
 * (e.g. `sub: "auth0|user_xxx"` → `user_xxx`). Returns `null` when the
 * token doesn't decode as a JWT with a usable `sub`. Never throws.
 */
function deriveSessionCookieFromJwt(accessToken: string): string | null {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const sub = payload.sub;
    if (typeof sub !== "string" || !sub) return null;
    const userId = sub.includes("|") ? sub.slice(sub.lastIndexOf("|") + 1) : sub;
    if (!userId) return null;
    return `${userId}%3A%3A${accessToken}`;
  } catch {
    return null;
  }
}

/** A bare JWT: three dot-separated base64url segments. */
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Probe the Cursor IDE's `state.vscdb` (a `bun:sqlite`-readable SQLite file)
 * for a Cursor web session. Opens read-only so we never corrupt or lock a
 * file the live Cursor app may also have open. Returns `null` (never throws)
 * if the file, table, or a matching row don't exist.
 *
 * Query discipline: this DB can be multi-GB (3.8GB observed on a real
 * machine), so we only ever run *key*-indexed lookups — a `value LIKE '%…%'`
 * would full-scan every blob in the table on every poll sweep.
 */
function readCursorIdeCookie(): string | null {
  const dbPath = cursorStateDbPath();
  if (!existsSync(dbPath)) return null;

  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    // ItemTable is VS Code's (and Cursor's, which forks it) standard
    // global-storage key/value table: `key TEXT, value BLOB/TEXT`.

    // Primary path: the IDE's OAuth access token (a bare JWT) under the
    // well-known key — derive the web session cookie from it.
    const tokenRow = db
      .query<{ value: string }, []>(
        "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'",
      )
      .get();
    if (tokenRow && typeof tokenRow.value === "string") {
      const jwt = tokenRow.value.trim().replace(/^"|"$/g, "");
      if (JWT_RE.test(jwt)) {
        const derived = deriveSessionCookieFromJwt(jwt);
        if (derived) return derived;
      }
    }

    // Fallback: any auth-ish *key* whose value carries a recognizable cookie
    // shape (older/alternative storage layouts). Key-LIKE only — never
    // value-LIKE (see query discipline above).
    const rows = db
      .query<{ key: string; value: string }, []>(
        "SELECT key, value FROM ItemTable WHERE key LIKE '%cursorAuth%' OR key LIKE '%workos%'",
      )
      .all();
    for (const row of rows) {
      if (typeof row.value !== "string") continue;
      const token = extractTokenFromValue(row.value);
      if (token) {
        // A bare JWT found via the fallback still needs the cookie derivation.
        if (JWT_RE.test(token)) return deriveSessionCookieFromJwt(token) ?? null;
        return token;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Read the IDE's OAuth `cursorAuth/accessToken` and `cursorAuth/refreshToken`
 * from `state.vscdb`. Same read-only open and key-equality-only discipline as
 * `readCursorIdeCookie` (multi-GB DB: never a value-LIKE). Never throws;
 * missing file/rows yield nulls. Callers must have already decided the
 * cross-app read is allowed (TCC rule — see `fetchCursorQuota`).
 */
function readCursorIdeAuth(): {
  accessToken: string | null;
  refreshToken: string | null;
} {
  const out = { accessToken: null as string | null, refreshToken: null as string | null };
  const dbPath = cursorStateDbPath();
  if (!existsSync(dbPath)) return out;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const read = (key: string): string | null => {
      const row = db!
        .query<{ value: unknown }, [string]>(
          "SELECT value FROM ItemTable WHERE key = ?",
        )
        .get(key);
      if (!row || typeof row.value !== "string") return null;
      const v = row.value.trim().replace(/^"|"$/g, "");
      return v || null;
    };
    out.accessToken = read("cursorAuth/accessToken");
    out.refreshToken = read("cursorAuth/refreshToken");
  } catch {
    // fail soft — whatever was read so far is returned
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
  return out;
}

/** JWT `exp` claim in epoch seconds, or `null` if absent/undecodable. */
function jwtExpSeconds(jwt: string): number | null {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp
      : null;
  } catch {
    return null;
  }
}

/** Thrown by `fetchJson` for a non-OK response so callers can branch on 401. */
class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A refresh Cursor refused (`shouldLogout`, empty token, non-JWT) versus one
 *  that never answered (timeout, network, non-OK HTTP). Callers must not
 *  treat those the same: a refusal is the sign-in sentence, a transport
 *  failure keeps a short error that does not claim the login was rejected.
 *  The new access token is only ever held in memory, and never returned. */
type CursorRefreshResult =
  | { outcome: "cookie"; cookie: string }
  | { outcome: "rejected" }
  | { outcome: "failed"; reason: string };

const REFRESH_FAILED_REASON = "Cursor login refresh failed";

/** Drop the refresh token if a thrown message quoted the request, then cap. */
function scrubRefreshReason(raw: string, refreshToken: string): string {
  const scrubbed = raw.split(refreshToken).join("").replace(/\s+/g, " ").trim();
  return (scrubbed || REFRESH_FAILED_REASON).slice(0, 200);
}

/**
 * Exchange a refresh token for a fresh access token and derive the web
 * session cookie from it. `rejected` and `failed` both mean "do not retry
 * with an empty cookie". The new token is only ever held in memory.
 */
async function refreshCursorCookie(
  refreshToken: string,
  fetchImpl: typeof fetch,
): Promise<CursorRefreshResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        outcome: "failed",
        reason: `${REFRESH_FAILED_REASON} (HTTP ${res.status})`,
      };
    }
    const body = (await res.json()) as Record<string, unknown> | null;
    if (!body || body.shouldLogout === true) return { outcome: "rejected" };
    const token = body.access_token;
    if (typeof token !== "string" || !JWT_RE.test(token)) return { outcome: "rejected" };
    const cookie = deriveSessionCookieFromJwt(token);
    if (!cookie) return { outcome: "rejected" };
    return { outcome: "cookie", cookie };
  } catch (err) {
    const raw = err instanceof Error ? err.message : REFRESH_FAILED_REASON;
    return { outcome: "failed", reason: scrubRefreshReason(raw, refreshToken) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Browser cookie store import — **not implemented in v1**, left as a
 * documented stub per the task spec. Two known stores exist on macOS:
 *  - Safari: `~/Library/Cookies/Cookies.binarycookies`, a proprietary binary
 *    format, additionally gated behind Full Disk Access (TCC) on modern
 *    macOS — reading it without FDA silently returns nothing or throws an
 *    OS-level permission error.
 *  - Chrome (and Chromium forks): cookies are stored AES-encrypted in an
 *    SQLite DB (`~/Library/Application Support/Google/Chrome/Default/Cookies`)
 *    with the decryption key itself wrapped in the macOS Keychain
 *    (`Chrome Safe Storage`) — decrypting needs a Keychain prompt plus
 *    Chrome's specific key-derivation (PBKDF2) and AES-CBC parameters.
 * Both are meaningfully more invasive than the IDE-state-DB path above and
 * are out of v1 scope (plan section 7: cursor cookie reads are explicitly
 * the riskiest task and must not grow scope). Always returns `null`.
 */
function readBrowserCookie(_harness: Harness): string | null {
  // Future work: Safari `Cookies.binarycookies` parser (needs FDA) and/or
  // Chrome `Cookies` SQLite + Keychain `Chrome Safe Storage` AES decrypt.
  return null;
}

/**
 * Best-effort discovery of the Cursor web session cookie
 * (`WorkosCursorSessionToken`), tried in order:
 *  1. Cursor IDE `state.vscdb` (read-only SQLite read) — a **cross-app data
 *     read** under `~/Library/Application Support/Cursor`, which on macOS
 *     Sequoia trips the `kTCCServiceSystemPolicyAppData` "Agetor would like
 *     to access data from other apps" prompt. Gated on `opts.allowIdeRead`
 *     (default `true` when `opts` is omitted, so a direct caller or the
 *     explicit-refresh path behaves exactly as before): when it's `false`,
 *     this step — including the `existsSync` probe itself — is skipped
 *     entirely, so agetor's process never touches that directory. See
 *     `fetchCursorQuota` / `src/bun/usage/poller.ts`'s `refreshOne` for the
 *     policy that decides when `allowIdeRead` is true.
 *  2. Browser cookie store (stubbed — always `null` in v1, see
 *     `readBrowserCookie`).
 * Every step is wrapped so a failure in one falls through to the next
 * rather than aborting discovery. Never throws; returns `null` when no
 * cookie could be found anywhere.
 */
export async function discoverCursorCookie(
  harness: Harness,
  opts?: { allowIdeRead?: boolean },
): Promise<string | null> {
  const allowIdeRead = opts?.allowIdeRead ?? true;

  if (allowIdeRead) {
    try {
      const ideCookie = readCursorIdeCookie();
      if (ideCookie) return ideCookie;
    } catch {
      // fall through
    }
  }

  try {
    const browserCookie = readBrowserCookie(harness);
    if (browserCookie) return browserCookie;
  } catch {
    // fall through
  }

  return null;
}

/** Read a numeric-ish value out of an unknown object at any of the given
 *  dotted-or-flat candidate keys, returning the first that parses as a
 *  finite number. Used throughout `parseCursorUsage` to probe several
 *  plausible field names since the `usage-summary` schema is unstable and
 *  reverse-engineered (see module doc + plan section 2). */
function firstNumber(
  obj: unknown,
  paths: string[],
): number | null {
  for (const p of paths) {
    const val = getPath(obj, p);
    if (typeof val === "number" && Number.isFinite(val)) return val;
    if (typeof val === "string" && val.trim() !== "") {
      const n = Number(val);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function firstString(obj: unknown, paths: string[]): string | null {
  for (const p of paths) {
    const val = getPath(obj, p);
    if (typeof val === "string" && val.trim() !== "") return val;
  }
  return null;
}

function getPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const key of dotted.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Parse an epoch-ms, epoch-seconds, or ISO-8601 date-ish value into epoch
 *  ms, or `null` if unrecognized. */
function parseResetsAtMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: anything below ~1e12 is almost certainly seconds, not ms
    // (ms epoch for dates after 2001 is 13 digits).
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const asNum = Number(value);
    if (Number.isFinite(asNum) && /^[0-9.]+$/.test(value.trim())) {
      return asNum < 1e12 ? asNum * 1000 : asNum;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/**
 * PURE. Map Cursor's `usage-summary` (+ `auth/me`) responses to normalized
 * `QuotaMeter[]`. **The exact response schema is undocumented and only
 * loosely known** (reverse-engineered via CodexBar, plan section 2) — this
 * parser is deliberately defensive and shape-tolerant: it probes several
 * plausible field names rather than assuming one exact shape, so a minor
 * upstream field rename degrades to "meter not found" instead of a thrown
 * exception. Never throws; unrecognized input yields `{meters:[],
 * planType:null}`.
 *
 * Produces up to two meters:
 *  - `"plan"` — the primary plan/quota usage percentage, probed from
 *    `usedPercent` / `usage` / `plan.usedPercent` / a computed `used/limit`
 *    pair, with a reset time from `resetAt` / `billingCycleEnd` /
 *    `plan.resetAt` / `billingCycleStart`+cycle-length-derived fields.
 *  - `"on-demand"` — overage/on-demand spend as a percentage of its own
 *    budget, when the response exposes one (also probed across several
 *    plausible field names).
 */
export function parseCursorUsage(
  summaryJson: unknown,
  meJson: unknown,
  fetchedAtMs: number,
): { meters: QuotaMeter[]; planType: string | null } {
  const meters: QuotaMeter[] = [];

  if (summaryJson == null || typeof summaryJson !== "object") {
    return { meters: [], planType: null };
  }

  // --- Confirmed live shape (verified 2026-08 against a real pro_plus
  // account): meters live under `individualUsage`, with distinct percent
  // fields per bucket — `totalPercentUsed` (the authoritative overall plan
  // meter; note `used/limit` alone misleads here because bonus credits extend
  // the included quota), `autoPercentUsed`, `apiPercentUsed`, and an
  // `onDemand` used/limit pair. Reset = `billingCycleEnd`. When this shape is
  // present it's used exclusively; the legacy probing below stays as the
  // fallback for other/older schema variants.
  const liveShape = getPath(summaryJson, "individualUsage.plan");
  if (liveShape != null && typeof liveShape === "object") {
    const cycleResetsAtMs = parseResetsAtMs(
      getPath(summaryJson, "billingCycleEnd"),
    );
    const liveFields: Array<{ path: string; id: string; label: string }> = [
      { path: "individualUsage.plan.totalPercentUsed", id: "plan", label: "Plan (total)" },
      { path: "individualUsage.plan.autoPercentUsed", id: "auto", label: "Auto" },
      { path: "individualUsage.plan.apiPercentUsed", id: "api", label: "API" },
    ];
    for (const f of liveFields) {
      const pct = firstNumber(summaryJson, [f.path]);
      if (pct != null) {
        meters.push({
          id: f.id,
          label: f.label,
          usedPercent: clampPercent(pct),
          resetsAtMs: cycleResetsAtMs,
        });
      }
    }
    const odUsed = firstNumber(summaryJson, ["individualUsage.onDemand.used"]);
    const odLimit = firstNumber(summaryJson, ["individualUsage.onDemand.limit"]);
    if (odUsed != null && odLimit != null && odLimit > 0) {
      meters.push({
        id: "on-demand",
        label: "On-demand",
        usedPercent: clampPercent((odUsed / odLimit) * 100),
        resetsAtMs: cycleResetsAtMs,
      });
    }
    if (meters.length > 0) {
      const livePlanType =
        firstString(summaryJson, ["membershipType"]) ??
        firstString(meJson, ["plan", "planType", "membershipType", "tier"]);
      return { meters, planType: livePlanType };
    }
    // Shape present but nothing mapped — fall through to legacy probing.
  }

  // --- Plan usage meter (legacy probing) --------------------------------
  let planPercent = firstNumber(summaryJson, [
    "usedPercent",
    "usagePercent",
    "percentUsed",
    "plan.usedPercent",
    "plan.percentUsed",
    "usage",
    "plan.usage",
  ]);

  if (planPercent == null) {
    // Fall back to a used/limit pair, computed as a percentage.
    const used = firstNumber(summaryJson, [
      "used",
      "usedAmount",
      "plan.used",
      "requests.used",
      "usage.used",
    ]);
    const limit = firstNumber(summaryJson, [
      "limit",
      "limitAmount",
      "plan.limit",
      "requests.limit",
      "usage.limit",
    ]);
    if (used != null && limit != null && limit > 0) {
      planPercent = (used / limit) * 100;
    }
  }

  const planResetsAtMs = parseResetsAtMs(
    getPath(summaryJson, "resetAt") ??
      getPath(summaryJson, "billingCycleEnd") ??
      getPath(summaryJson, "plan.resetAt") ??
      getPath(summaryJson, "plan.billingCycleEnd") ??
      getPath(summaryJson, "cycleEnd"),
  );

  if (planPercent != null) {
    meters.push({
      id: "plan",
      label: "Plan usage",
      usedPercent: clampPercent(planPercent),
      resetsAtMs: planResetsAtMs,
    });
  }

  // --- On-demand / overage meter ---------------------------------------
  let onDemandPercent = firstNumber(summaryJson, [
    "onDemand.usedPercent",
    "onDemand.percentUsed",
    "onDemandUsage.usedPercent",
    "overage.usedPercent",
    "usageBasedPricing.usedPercent",
  ]);

  if (onDemandPercent == null) {
    const usedSpend = firstNumber(summaryJson, [
      "onDemand.used",
      "onDemand.spend",
      "onDemandUsage.used",
      "overage.used",
      "usageBasedPricing.used",
    ]);
    const budget = firstNumber(summaryJson, [
      "onDemand.limit",
      "onDemand.budget",
      "onDemandUsage.limit",
      "overage.limit",
      "usageBasedPricing.limit",
    ]);
    if (usedSpend != null && budget != null && budget > 0) {
      onDemandPercent = (usedSpend / budget) * 100;
    }
  }

  if (onDemandPercent != null) {
    const onDemandResetsAtMs = parseResetsAtMs(
      getPath(summaryJson, "onDemand.resetAt") ??
        getPath(summaryJson, "overage.resetAt") ??
        planResetsAtMs,
    );
    meters.push({
      id: "on-demand",
      label: "On-demand",
      usedPercent: clampPercent(onDemandPercent),
      resetsAtMs: onDemandResetsAtMs,
    });
  }

  // --- Plan type ---------------------------------------------------------
  const planType =
    firstString(meJson, ["plan", "planType", "membershipType", "tier"]) ??
    firstString(summaryJson, ["plan", "planType", "membershipType", "tier"]);

  return { meters, planType };
}

async function fetchJson(
  url: string,
  cookie: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      headers: {
        cookie: `${COOKIE_NAME}=${cookie}`,
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new HttpStatusError(res.status, `${url} returned ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch this harness's Cursor quota. **Always resolves** — this is the
 * single entry point the poller (`src/bun/usage/poller.ts`) calls, and the
 * plan is explicit (section 3, section 7) that a Cursor fetch must never
 * throw, prompt, or block. Resolution order:
 *  1. Read the IDE OAuth access and refresh tokens (or `opts.session` in
 *     tests — that path never opens the database). Derive the web cookie
 *     from the access token. If that yields nothing and no session was
 *     injected, fall through to `discoverCursorCookie`. An expired access
 *     token, a missing cookie when a refresh token exists, or a later 401
 *     triggers at most one in-memory OAuth refresh. Still no cookie resolves
 *     `status:"unavailable"`, or `status:"error"` with
 *     `CURSOR_LOGIN_EXPIRED_REASON` when Cursor rejected the refresh
 *     (`shouldLogout`, empty token, non-JWT). A refresh that fails on the
 *     network or with a non-OK status, and still yields no cookie, resolves
 *     `status:"error"` with that failure's short text — not the sign-in
 *     sentence. That `error` still means the database read was already
 *     allowed (the refresh token came from it); do not fold it back to
 *     `unavailable` or the poller will treat a later sign-in as unconsented.
 *  2. With a cookie, fetch `usage-summary` and `auth/me` in parallel (each
 *     under a ~5s timeout) and parse via `parseCursorUsage`. Empty meters
 *     still resolves `status:"unavailable"` (we got a response but
 *     recognized nothing in it); non-empty meters resolve `status:"ok"`.
 *     A 401 resolves `status:"error"` with `CURSOR_LOGIN_EXPIRED_REASON`
 *     (after that one refresh, if a refresh token was available).
 *  3. Any other thrown error (network, timeout, non-401 HTTP, JSON parse)
 *     is caught and resolves `status:"error"` with a short reason — never
 *     propagated. `opts.fetchImpl` replaces `fetch`.
 *
 * `opts.allowIdeRead` (default `true` when `opts` is omitted, preserving
 * today's behavior for any direct caller and the explicit-refresh path)
 * gates the cross-app read of the Cursor IDE's `state.vscdb` inside
 * `discoverCursorCookie` — see that function's doc and
 * `src/bun/usage/poller.ts`'s `refreshOne` for why a background sweep with
 * no prior snapshot passes `false`.
 */
export async function fetchCursorQuota(
  harness: Harness,
  opts?: {
    allowIdeRead?: boolean;
    session?: { accessToken: string | null; refreshToken: string | null };
    fetchImpl?: typeof fetch;
  },
): Promise<HarnessQuota> {
  const allowIdeRead = opts?.allowIdeRead ?? true;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const fetchedAtMs = Date.now();
  const base: Omit<HarnessQuota, "status" | "meters" | "reason" | "planType"> = {
    harnessId: harness.id,
    kind: harness.kind,
    source: "scrape",
    fetchedAtMs,
  };

  let accessToken: string | null = null;
  let refreshToken: string | null = null;
  let cookie: string | null = null;
  try {
    if (opts?.session) {
      accessToken = opts.session.accessToken;
      refreshToken = opts.session.refreshToken;
    } else if (allowIdeRead) {
      ({ accessToken, refreshToken } = readCursorIdeAuth());
    }
    if (accessToken && JWT_RE.test(accessToken)) {
      cookie = deriveSessionCookieFromJwt(accessToken);
    }
    // Legacy storage shapes / browser stub — only when no session was injected.
    if (!cookie && !opts?.session) {
      cookie = await discoverCursorCookie(harness, { allowIdeRead });
    }
  } catch {
    cookie = null;
  }

  let refreshed = false;
  const tryRefresh = async (): Promise<CursorRefreshResult | null> => {
    if (refreshed || !refreshToken) return null;
    refreshed = true;
    return refreshCursorCookie(refreshToken, fetchImpl);
  };

  const expired =
    accessToken != null &&
    (() => {
      const exp = jwtExpSeconds(accessToken);
      return exp != null && exp <= Date.now() / 1000;
    })();

  if (refreshToken && (expired || !cookie)) {
    const fresh = await tryRefresh();
    if (fresh?.outcome === "cookie") cookie = fresh.cookie;
    else if (fresh?.outcome === "failed" && !cookie) {
      // No session to fall back on. A timeout or 5xx is not a rejected login.
      return {
        ...base,
        planType: null,
        status: "error",
        meters: [],
        reason: fresh.reason,
      };
    }
  }

  if (!cookie) {
    if (refreshed) {
      return {
        ...base,
        planType: null,
        status: "error",
        meters: [],
        reason: CURSOR_LOGIN_EXPIRED_REASON,
      };
    }
    return {
      ...base,
      planType: null,
      status: "unavailable",
      meters: [],
      // Actionable guidance — rendered verbatim in the topbar popover, so
      // tell the user exactly how to make usage appear rather than just
      // stating that it can't. When the IDE read itself was skipped (no
      // prior consent/snapshot yet), say so explicitly rather than implying
      // a login problem — the fix here is clicking Refresh, not signing in.
      reason:
        allowIdeRead || opts?.session
          ? "No Cursor session found. Open the Cursor desktop app and sign in, " +
            "then Refresh here \u2014 Agetor reads Cursor's local login to fetch plan usage."
          : "Cursor usage isn't read in the background. Click Refresh to read " +
            "Cursor's local login and show plan usage.",
    };
  }

  const fetchBoth = (c: string) =>
    Promise.all([
      fetchJson(USAGE_SUMMARY_URL, c, fetchImpl),
      fetchJson(AUTH_ME_URL, c, fetchImpl).catch(() => null),
    ]);

  try {
    let summaryJson: unknown;
    let meJson: unknown;
    try {
      [summaryJson, meJson] = await fetchBoth(cookie);
    } catch (err) {
      if (!(err instanceof HttpStatusError) || err.status !== 401) throw err;
      const fresh = await tryRefresh();
      if (fresh?.outcome !== "cookie") {
        // The usage call already 401'd, so a refresh that was rejected or
        // that never answered still means this saved login cannot be used.
        return {
          ...base,
          planType: null,
          status: "error",
          meters: [],
          reason: CURSOR_LOGIN_EXPIRED_REASON,
        };
      }
      [summaryJson, meJson] = await fetchBoth(fresh.cookie);
    }

    const { meters, planType } = parseCursorUsage(
      summaryJson,
      meJson,
      fetchedAtMs,
    );

    if (meters.length === 0) {
      return {
        ...base,
        planType,
        status: "unavailable",
        meters: [],
        reason: "Cursor usage response had no recognizable meters",
      };
    }

    return {
      ...base,
      planType,
      status: "ok",
      meters,
      reason: null,
    };
  } catch (err) {
    if (err instanceof HttpStatusError && err.status === 401) {
      return {
        ...base,
        planType: null,
        status: "error",
        meters: [],
        reason: CURSOR_LOGIN_EXPIRED_REASON,
      };
    }
    const reason =
      err instanceof Error ? err.message.slice(0, 200) : "Cursor usage fetch failed";
    return {
      ...base,
      planType: null,
      status: "error",
      meters: [],
      reason,
    };
  }
}

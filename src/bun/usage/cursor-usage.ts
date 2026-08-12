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

  return null;
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
 * Probe the Cursor IDE's `state.vscdb` (a `bun:sqlite`-readable SQLite file)
 * for a stored `WorkosCursorSessionToken`. Opens read-only so we never
 * corrupt or lock a file the live Cursor app may also have open. Returns
 * `null` (never throws) if the file, table, or a matching row don't exist.
 */
function readCursorIdeCookie(): string | null {
  const dbPath = cursorStateDbPath();
  if (!existsSync(dbPath)) return null;

  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    // ItemTable is VS Code's (and Cursor's, which forks it) standard
    // global-storage key/value table: `key TEXT, value BLOB/TEXT`.
    const rows = db
      .query<{ key: string; value: string }, []>(
        "SELECT key, value FROM ItemTable WHERE key LIKE '%cursorAuth%' OR key LIKE '%workos%' OR value LIKE '%WorkosCursorSessionToken%'",
      )
      .all();
    for (const row of rows) {
      if (typeof row.value !== "string") continue;
      const token = extractTokenFromValue(row.value);
      if (token) return token;
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
 *  1. Cursor IDE `state.vscdb` (read-only SQLite read).
 *  2. Browser cookie store (stubbed — always `null` in v1, see
 *     `readBrowserCookie`).
 * Every step is wrapped so a failure in one falls through to the next
 * rather than aborting discovery. Never throws; returns `null` when no
 * cookie could be found anywhere.
 */
export async function discoverCursorCookie(
  harness: Harness,
): Promise<string | null> {
  try {
    const ideCookie = readCursorIdeCookie();
    if (ideCookie) return ideCookie;
  } catch {
    // fall through
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

  // --- Plan usage meter -----------------------------------------------
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
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        cookie: `${COOKIE_NAME}=${cookie}`,
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`${url} returned ${res.status}`);
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
 *  1. `discoverCursorCookie(harness)` — if it yields nothing, resolve
 *     `status:"unavailable"` immediately with a reason explaining what's
 *     needed, no network call attempted.
 *  2. With a cookie, fetch `usage-summary` and `auth/me` in parallel (each
 *     under a ~5s timeout) and parse via `parseCursorUsage`. Empty meters
 *     still resolves `status:"unavailable"` (we got a response but
 *     recognized nothing in it); non-empty meters resolve `status:"ok"`.
 *  3. Any thrown error (network, timeout, non-2xx, JSON parse) is caught
 *     and resolves `status:"error"` with a short reason — never propagated.
 */
export async function fetchCursorQuota(harness: Harness): Promise<HarnessQuota> {
  const fetchedAtMs = Date.now();
  const base: Omit<HarnessQuota, "status" | "meters" | "reason" | "planType"> = {
    harnessId: harness.id,
    kind: harness.kind,
    source: "scrape",
    fetchedAtMs,
  };

  let cookie: string | null = null;
  try {
    cookie = await discoverCursorCookie(harness);
  } catch {
    cookie = null;
  }

  if (!cookie) {
    return {
      ...base,
      planType: null,
      status: "unavailable",
      meters: [],
      reason: "Cursor usage needs a signed-in Cursor app/browser session",
    };
  }

  try {
    const [summaryJson, meJson] = await Promise.all([
      fetchJson(USAGE_SUMMARY_URL, cookie),
      fetchJson(AUTH_ME_URL, cookie).catch(() => null),
    ]);

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

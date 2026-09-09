// Pure helpers for fx's model-response-recovery sentinel
// (`FX_RECOVERY_STATUS_PREFIX`, see src/shared/types.ts for the wire shape
// and when it's emitted — fx's `_meta.fx.modelResponseRecovery` on a
// `session_info_update` notification, live since fx 0.0.7). No React or bun
// imports here, so both the webview (RunPanel's live notice + Resume
// affordance) and bun-side code (the driver, the CLI, the TUI) can import
// this directly without pulling in either runtime.
import { FX_RECOVERY_STATUS_PREFIX, type FxRecoveryPayload, type FxRecoveryState } from "./types.ts";

/** The four values {@link FxRecoveryState} can take, as one tuple both the
 *  parsers below and any caller that wants to validate a state id can share
 *  — avoids two independently-typed copies of the same literal union
 *  drifting apart. */
export const FX_RECOVERY_STATES = ["active", "paused", "recovered", "cleared"] as const satisfies readonly FxRecoveryState[];

/** Subset of {@link FX_RECOVERY_STATES} fx itself ever puts on the wire
 *  inside a non-null `modelResponseRecovery` object — `"cleared"` is
 *  agetor's own label for the wire's `modelResponseRecovery: null`, never a
 *  string fx sends. */
const WIRE_OBJECT_STATES = ["active", "paused", "recovered"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFxRecoveryState(v: unknown): v is FxRecoveryState {
  return typeof v === "string" && (FX_RECOVERY_STATES as readonly string[]).includes(v);
}

/** Pulls the `kind`/`cause`/`action`/`requiredAction`/`attempt`/
 *  `attemptLimit`/`delaySeconds`/`durable`/`message` fields out of a raw
 *  object, keeping only well-typed, non-empty values — a present-but-wrong-
 *  typed or empty-string field is dropped on its own rather than failing the
 *  whole parse, mirroring `src/mainview/lib/fx-usage.ts`'s `parseFxUsage`. */
function extractFields(raw: Record<string, unknown>): Omit<FxRecoveryPayload, "state"> {
  const out: Omit<FxRecoveryPayload, "state"> = {};
  for (const key of ["kind", "cause", "action", "requiredAction", "message"] as const) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  for (const key of ["attempt", "attemptLimit", "delaySeconds"] as const) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  if (typeof raw.durable === "boolean") out.durable = raw.durable;
  return out;
}

/**
 * Parse the `_meta.fx.modelResponseRecovery` field off a raw ACP
 * `session_info_update` notification (the driver's own update object, before
 * it's ever turned into a sentinel string). Three outcomes:
 *  - `undefined` — `update._meta.fx` isn't a plain object, or it is one but
 *    has no `modelResponseRecovery` key at all (most updates: fx sends this
 *    key only on a recovery-relevant update). Nothing to emit this update.
 *  - `{ state: "cleared" }` — the key is present and explicitly `null`: fx
 *    has dropped the recovery checkpoint.
 *  - a built `FxRecoveryPayload` — the key holds an object; its `state`
 *    becomes the wire value when it's one of `active`/`paused`/`recovered`,
 *    else defaults to `"active"` (fx is expected to always send one of the
 *    three; a missing/garbled one still reads as "something is happening").
 * A `modelResponseRecovery` value that is neither `null` nor a plain object
 * (a stray string/number/array) is treated the same as "key absent":
 * `undefined`.
 */
export function parseFxRecoveryMeta(update: Record<string, unknown>): FxRecoveryPayload | null | undefined {
  const meta = update._meta;
  if (!isPlainObject(meta)) return undefined;
  const fx = meta.fx;
  if (!isPlainObject(fx)) return undefined;
  if (!("modelResponseRecovery" in fx)) return undefined;

  const raw = fx.modelResponseRecovery;
  if (raw === null) return { state: "cleared" };
  if (!isPlainObject(raw)) return undefined;

  const state = isFxRecoveryState(raw.state) && (WIRE_OBJECT_STATES as readonly string[]).includes(raw.state)
    ? (raw.state as FxRecoveryPayload["state"])
    : "active";
  return { state, ...extractFields(raw) };
}

/**
 * Parse a persisted `FX_RECOVERY_STATUS_PREFIX` sentinel body (the JSON
 * agetor itself wrote) back into a {@link FxRecoveryPayload}. Stricter than
 * {@link parseFxRecoveryMeta}: `null` on invalid JSON, a non-object payload,
 * or a `state` that isn't one of all four {@link FX_RECOVERY_STATES} — a
 * sentinel agetor wrote should always carry a valid state, so an invalid one
 * means the row is corrupt/foreign rather than "default to active".
 */
export function parseFxRecoveryPayload(json: string): FxRecoveryPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isPlainObject(raw)) return null;
  if (!isFxRecoveryState(raw.state)) return null;
  const payload: FxRecoveryPayload = { state: raw.state, ...extractFields(raw) };
  // `replayed` is agetor's own stamp (see `FxRecoveryPayload.replayed`), so it
  // is honored only here — on a sentinel agetor wrote — and never by
  // `parseFxRecoveryMeta`, which reads fx's wire object where the key has no
  // meaning. Only a literal `true` survives; `false`/non-boolean is dropped
  // so consumers can test `payload.replayed === true` or truthiness alike.
  if (raw.replayed === true) payload.replayed = true;
  return payload;
}

/** fx's own words for `cause` tags, used only when `message` is absent. */
const CAUSE_LABELS: Record<string, string> = {
  network_interrupted: "Network interrupted",
  response_interrupted: "Response ended early",
  provider_stream_timeout: "Gateway stream timed out",
  provider_unavailable: "Provider unavailable",
  rate_limited: "Rate limited",
  system_resumed: "Mac woke from sleep",
  authentication: "Authentication refreshed",
  request_limit_reached: "Provider request limit reached",
};

/** fx's own words for `action` tags, used only when `message` is absent. */
const ACTION_LABELS: Record<string, string> = {
  retrying_request: "retrying request",
  continuing_response: "restarting response",
  regenerating_tool: "regenerating unstarted tool",
  continuing_after_tool: "continuing after confirmed tool",
  reconciling_tool: "checking uncertain tool state",
  waiting_for_connectivity: "waiting for connection",
  paused: "recovery paused",
};

/** `"N/M"` when both `attempt` and `attemptLimit` are known, else `undefined`. */
function attemptFraction(p: FxRecoveryPayload): string | undefined {
  return typeof p.attempt === "number" && typeof p.attemptLimit === "number"
    ? `${p.attempt}/${p.attemptLimit}`
    : undefined;
}

/**
 * Human-readable one-liner for a recovery payload — what RunPanel's live
 * notice, the CLI's `agetor logs`, and the TUI render.
 *  - `state === "cleared"` always renders as `""` (nothing to show — the
 *    checkpoint is gone).
 *  - `p.message` (fx's own label, e.g. "⚠ Rate limited · HTTP 429 · … ·
 *    retrying request in 8s · attempt 5/10") wins whenever it's a non-empty
 *    string, for any other state.
 *  - Otherwise, for `state === "recovered"`: `"✓ recovered · succeeded on
 *    attempt N/M"`, or bare `"✓ recovered"` when the attempt fraction is
 *    unknown.
 *  - Otherwise (`active`/`paused`/any forward-compat state): composes
 *    `"⚠ <cause label> · <action label> · attempt N/M"` from
 *    {@link CAUSE_LABELS}/{@link ACTION_LABELS} (an unrecognized tag renders
 *    verbatim rather than being dropped), omitting whichever of the three
 *    segments has nothing to show (no cause, no action, or no attempt
 *    fraction). When neither cause nor action nor message is known at all,
 *    falls back to `"⚠ Recovering model response"`.
 */
export function fxRecoveryNoticeText(p: FxRecoveryPayload): string {
  if (p.state === "cleared") return "";

  if (typeof p.message === "string" && p.message.length > 0) return p.message;

  if (p.state === "recovered") {
    const attempt = attemptFraction(p);
    return attempt ? `✓ recovered · succeeded on attempt ${attempt}` : "✓ recovered";
  }

  const causeLabel = p.cause ? (CAUSE_LABELS[p.cause] ?? p.cause) : undefined;
  const actionLabel = p.action ? (ACTION_LABELS[p.action] ?? p.action) : undefined;
  if (!causeLabel && !actionLabel) return "⚠ Recovering model response";

  const segments = [causeLabel, actionLabel].filter((s): s is string => Boolean(s));
  const attempt = attemptFraction(p);
  if (attempt) segments.push(`attempt ${attempt}`);
  return `⚠ ${segments.join(" · ")}`;
}

/**
 * The persisted, terminal-transition-only status line — distinct from the
 * live notice above, this is what stays in the transcript/`agetor logs`/TUI
 * history after the fact (emitted once by the driver, not derived on every
 * render). `null` for `active` (still in progress — nothing final to say
 * yet) and `cleared` (nothing happened worth a line).
 *  - `paused`: `fxRecoveryNoticeText(p)` plus a fixed call to action —
 *    `" — resume once the limit clears, or send a new message."`.
 *  - `recovered`: `fxRecoveryNoticeText(p)` verbatim.
 */
export function fxRecoverySummaryLine(p: FxRecoveryPayload): string | null {
  if (p.state === "paused") return `${fxRecoveryNoticeText(p)} — resume once the limit clears, or send a new message.`;
  if (p.state === "recovered") return fxRecoveryNoticeText(p);
  return null;
}

/**
 * Whether a `paused` recovery payload is the kind Resume can act on: fx's
 * `requiredAction` is `continue_later` (defaulting to `continue_later` when
 * absent, since that's the only `requiredAction` observed live) rather than
 * `inspect_uncertain_tool`/`change_request`, which need a human decision
 * Resume can't make for them. `false` for every other state and for
 * `undefined`/`null` (no payload at all — nothing to resume).
 */
export function isFxRecoveryResumable(p: FxRecoveryPayload | undefined | null): boolean {
  return p != null && p.state === "paused" && (p.requiredAction ?? "continue_later") === "continue_later";
}

/**
 * Reduce a task's full (already-persisted) event list down to the latest
 * recovery payload seen per run — one entry per `runId`, keyed off
 * `status`-stream rows whose `data` starts with `FX_RECOVERY_STATUS_PREFIX`.
 * Walks `events` in array order (assumed to already be in event-id / wire
 * order) so "last wins" matches wall-clock order without needing a
 * timestamp. A row whose JSON body fails to parse is skipped without
 * clearing whatever payload an earlier row for that run already set.
 */
export function latestFxRecoveryByRun(
  events: ReadonlyArray<{ runId: string; stream: string; data: string }>,
): Map<string, FxRecoveryPayload> {
  const out = new Map<string, FxRecoveryPayload>();
  for (const event of events) {
    if (event.stream !== "status") continue;
    if (!event.data.startsWith(FX_RECOVERY_STATUS_PREFIX)) continue;
    const payload = parseFxRecoveryPayload(event.data.slice(FX_RECOVERY_STATUS_PREFIX.length));
    if (payload) out.set(event.runId, payload);
  }
  return out;
}

// Transparent recovery for transient socket failures on the webview <-> bun
// API connection.
//
// WHY: WKWebView's network stack (CFNetwork) pools keep-alive HTTP/1.1
// sockets. Bun's `idleTimeout` can close a pooled connection server-side at
// almost the same moment the webview picks it up to send a new request —
// classically for a POST, which per Apple's own guidance (QA1941) CFNetwork
// will NOT silently retry the way it retries idempotent GETs. The result is
// a fetch() rejection whose message is the useless, generic "Load failed",
// even though the bun process is alive and well. Treating every "Load
// failed" as "the server is down" (the previous behavior) produced a false
// "is the bun process running?" toast on a plain socket race.
//
// FIX: on a network-layer rejection (fetch threw, not an HTTP error status),
// probe the unauthenticated `GET /health` route with a short timeout. If the
// server answers, the original request almost certainly never reached it —
// re-issue it once. If the probe itself fails/times out, the server really
// is unreachable and the original "is the bun process running?" message is
// truthful.
//
// NOTE: re-sending `init` verbatim on retry is safe here because every body
// this app sends through `j()` is a JSON string (or absent) — there is no
// stream/FormData/Blob body that could already be consumed on first attempt.

export interface NetRetryDeps {
  fetchImpl: typeof fetch;
  base: string;
  /** Timeout for the /health probe, in ms. Default 1500. */
  healthTimeoutMs?: number;
}

function unreachableMessage(base: string, path: string): string {
  return `cannot reach agetor API at ${base} (${path}) — is the bun process running? Try restarting \`bun run dev\`.`;
}

function failedTwiceMessage(base: string, path: string, originalMsg: string): string {
  return `request to ${base}${path} failed twice even though the server is up (transient socket errors) — original error: ${originalMsg}`;
}

/** Probes `GET {base}/health`, resolving `true` iff the response is ok
 *  within `timeoutMs`. Never throws — any rejection (network error, abort)
 *  resolves to `false`. */
async function probeHealth(
  fetchImpl: typeof fetch,
  base: string,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Performs `fetchImpl(base + path, init)`. On a network-layer rejection
 *  (fetch threw — not an HTTP error status), probes `GET {base}/health`
 *  with an AbortController timeout:
 *  - probe succeeds (`res.ok`): the server is alive; the original request
 *    almost certainly never reached it (stale keep-alive socket) → re-issue
 *    the original request ONCE. If the retry also rejects, throws a
 *    "request failed twice against a live server" error.
 *  - probe fails/times out: throws the "cannot reach agetor API… is the bun
 *    process running?" error (server genuinely unreachable).
 *  HTTP error statuses (4xx/5xx) are NOT retried — the `Response` is
 *  returned to the caller as-is so existing `!res.ok` handling still runs. */
export async function fetchWithRecovery(
  deps: NetRetryDeps,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const { fetchImpl, base, healthTimeoutMs = 1500 } = deps;
  try {
    return await fetchImpl(`${base}${path}`, init);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    const alive = await probeHealth(fetchImpl, base, healthTimeoutMs);
    if (!alive) {
      throw new Error(unreachableMessage(base, path));
    }
    try {
      return await fetchImpl(`${base}${path}`, init);
    } catch (e2) {
      const msg2 = (e2 as Error).message ?? String(e2);
      throw new Error(failedTwiceMessage(base, path, msg2 || msg));
    }
  }
}

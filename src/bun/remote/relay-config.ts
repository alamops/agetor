/**
 * Where the relay and the push gateway are (docs/plans/remote-readiness.md §3.1 "Relay addresses").
 *
 * `BUILT_IN_RELAY_URL` and `BUILT_IN_PUSH_URL` are null until the relay spec ships them (a signed config on agetor.dev picks the real
 * addresses); with null the relay link refuses with `no-relay-configured` and Settings says so. Development and the e2e suite reach the
 * local test relay and the stub push gateway only through the test seams `AGETOR_REMOTE_RELAY_URL` and `AGETOR_REMOTE_PUSH_URL`, honoured
 * only outside a release build and only under NODE_ENV=test or AGETOR_E2E_HARNESS_SEAMS=1 (`src/shared/build-flags.ts`); the seam may
 * name a plain `ws://` loopback address, the built-in address must be `wss://`.
 */
import { remoteSeamsAllowed } from "../../shared/build-flags.ts";

export const BUILT_IN_RELAY_URL: string | null = null;
export const BUILT_IN_PUSH_URL: string | null = null;

export interface RelayAddress {
  url: string | null;
  source: "built-in" | "override" | "none";
  /** Why `url` is null, when it is. */
  problem?: "no-relay-configured" | "bad-override";
}

const LOOPBACK_WS = /^ws:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/.*)?$/;
const WSS = /^wss:\/\/[^\s/]+(?:\/.*)?$/;
const LOOPBACK_HTTP = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/.*)?$/;
const HTTPS = /^https:\/\/[^\s/]+(?:\/.*)?$/;

/** The relay to dial, or why there is none. */
export function relayAddress(env: Record<string, string | undefined> = process.env): RelayAddress {
  // The seam guard is INLINE so a release bundle drops the override branch (and its env var name) entirely.
  if (!(typeof __AGETOR_RELEASE_BUILD__ !== "undefined" && __AGETOR_RELEASE_BUILD__) && remoteSeamsAllowed(env) && env.AGETOR_REMOTE_RELAY_URL) {
    const v = env.AGETOR_REMOTE_RELAY_URL;
    return LOOPBACK_WS.test(v) || WSS.test(v) ? { url: v, source: "override" } : { url: null, source: "none", problem: "bad-override" };
  }
  if (BUILT_IN_RELAY_URL && WSS.test(BUILT_IN_RELAY_URL)) return { url: BUILT_IN_RELAY_URL, source: "built-in" };
  return { url: null, source: "none", problem: "no-relay-configured" };
}

export function relayUrl(env: Record<string, string | undefined> = process.env): string | null {
  return relayAddress(env).url;
}

/** The push gateway's base URL, or null (then pushes are a no-op with a status note). */
export function pushUrl(env: Record<string, string | undefined> = process.env): string | null {
  if (!(typeof __AGETOR_RELEASE_BUILD__ !== "undefined" && __AGETOR_RELEASE_BUILD__) && remoteSeamsAllowed(env) && env.AGETOR_REMOTE_PUSH_URL) {
    const v = env.AGETOR_REMOTE_PUSH_URL;
    return LOOPBACK_HTTP.test(v) || HTTPS.test(v) ? v : null;
  }
  return BUILT_IN_PUSH_URL && HTTPS.test(BUILT_IN_PUSH_URL) ? BUILT_IN_PUSH_URL : null;
}

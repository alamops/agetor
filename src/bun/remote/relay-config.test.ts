import { describe, expect, test } from "bun:test";
import { BUILT_IN_PUSH_URL, BUILT_IN_RELAY_URL, pushUrl, relayAddress, relayUrl } from "./relay-config.ts";

const seam = { NODE_ENV: "test" };

describe("relay address", () => {
  test("no built-in relay ships in this change, so nothing is configured by default", () => {
    expect(BUILT_IN_RELAY_URL).toBeNull();
    expect(BUILT_IN_PUSH_URL).toBeNull();
    expect(relayAddress({})).toEqual({ url: null, source: "none", problem: "no-relay-configured" });
    expect(relayUrl({})).toBeNull();
    expect(pushUrl({})).toBeNull();
  });

  test("the override works under a test seam and may be a loopback ws:// address or a wss:// one", () => {
    expect(relayAddress({ ...seam, AGETOR_REMOTE_RELAY_URL: "ws://127.0.0.1:8787" })).toEqual({ url: "ws://127.0.0.1:8787", source: "override" });
    expect(relayAddress({ ...seam, AGETOR_REMOTE_RELAY_URL: "ws://localhost:1" }).url).toBe("ws://localhost:1");
    expect(relayAddress({ ...seam, AGETOR_REMOTE_RELAY_URL: "wss://relay.example.test/v1" }).url).toBe("wss://relay.example.test/v1");
    expect(relayAddress({ AGETOR_E2E_HARNESS_SEAMS: "1", AGETOR_REMOTE_RELAY_URL: "ws://127.0.0.1:2" }).source).toBe("override");
  });

  test("a plain ws:// to anything but loopback, or a non-websocket URL, is refused", () => {
    for (const bad of ["ws://evil.example.test", "http://127.0.0.1:1", "ftp://x", "127.0.0.1:1", "ws://127.0.0.1.evil.test"]) {
      expect(relayAddress({ ...seam, AGETOR_REMOTE_RELAY_URL: bad })).toEqual({ url: null, source: "none", problem: "bad-override" });
    }
  });

  test("without a test seam the override is ignored, whatever it says", () => {
    expect(relayAddress({ AGETOR_REMOTE_RELAY_URL: "ws://127.0.0.1:8787" }).url).toBeNull();
    expect(relayAddress({ NODE_ENV: "production", AGETOR_REMOTE_RELAY_URL: "wss://x.example.test" }).url).toBeNull();
    expect(pushUrl({ AGETOR_REMOTE_PUSH_URL: "http://127.0.0.1:9" })).toBeNull();
  });

  test("the push override takes loopback http or https only", () => {
    expect(pushUrl({ ...seam, AGETOR_REMOTE_PUSH_URL: "http://127.0.0.1:9" })).toBe("http://127.0.0.1:9");
    expect(pushUrl({ ...seam, AGETOR_REMOTE_PUSH_URL: "https://push.example.test" })).toBe("https://push.example.test");
    expect(pushUrl({ ...seam, AGETOR_REMOTE_PUSH_URL: "http://evil.example.test" })).toBeNull();
  });
});

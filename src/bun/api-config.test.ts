import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  DEFAULT_API_HOST,
  formatHostForUrl,
  getApiHost,
  getApiPort,
  isLoopbackHost,
  nonLoopbackBindWarning,
} from "./api-config.ts";

let savedHost: string | undefined;
let savedPort: string | undefined;

beforeEach(() => {
  savedHost = process.env.AGETOR_API_HOST;
  savedPort = process.env.AGETOR_API_PORT;
});
afterEach(() => {
  if (savedHost === undefined) delete process.env.AGETOR_API_HOST;
  else process.env.AGETOR_API_HOST = savedHost;
  if (savedPort === undefined) delete process.env.AGETOR_API_PORT;
  else process.env.AGETOR_API_PORT = savedPort;
});

describe("getApiPort", () => {
  it("defaults to 4317", () => {
    delete process.env.AGETOR_API_PORT;
    expect(getApiPort()).toBe(4317);
  });

  it("reads AGETOR_API_PORT fresh on each call", () => {
    process.env.AGETOR_API_PORT = "5001";
    expect(getApiPort()).toBe(5001);
    process.env.AGETOR_API_PORT = "5002";
    expect(getApiPort()).toBe(5002);
  });
});

describe("getApiHost", () => {
  it("defaults to 127.0.0.1", () => {
    delete process.env.AGETOR_API_HOST;
    expect(DEFAULT_API_HOST).toBe("127.0.0.1");
    expect(getApiHost()).toBe("127.0.0.1");
  });

  it("honors an AGETOR_API_HOST override, read fresh on each call", () => {
    process.env.AGETOR_API_HOST = "0.0.0.0";
    expect(getApiHost()).toBe("0.0.0.0");
    process.env.AGETOR_API_HOST = "::";
    expect(getApiHost()).toBe("::");
  });

  it("falls back to the default on an empty or whitespace-only value", () => {
    process.env.AGETOR_API_HOST = "";
    expect(getApiHost()).toBe("127.0.0.1");
    process.env.AGETOR_API_HOST = "   \t\n";
    expect(getApiHost()).toBe("127.0.0.1");
  });

  it("trims surrounding whitespace", () => {
    process.env.AGETOR_API_HOST = "  0.0.0.0 \n";
    expect(getApiHost()).toBe("0.0.0.0");
  });
});

describe("isLoopbackHost", () => {
  it("accepts localhost, 127.0.0.0/8 and ::1", () => {
    for (const h of [
      "localhost",
      "LOCALHOST",
      "127.0.0.1",
      "127.1.2.3",
      "127.255.255.255",
      "::1",
      "[::1]",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
      " 127.0.0.1 ",
    ]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it("rejects wildcards, other addresses and hostnames", () => {
    for (const h of [
      "0.0.0.0",
      "::",
      "[::]",
      "192.168.1.10",
      "10.0.0.1",
      "128.0.0.1",
      "127.0.0.256",
      "127.0.0",
      "::ffff:10.0.0.1",
      "fe80::1",
      "example.com",
      "localhost.example.com",
      "",
    ]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe("formatHostForUrl", () => {
  it("brackets bare IPv6 literals only", () => {
    expect(formatHostForUrl("127.0.0.1")).toBe("127.0.0.1");
    expect(formatHostForUrl("localhost")).toBe("localhost");
    expect(formatHostForUrl("::")).toBe("[::]");
    expect(formatHostForUrl("[::1]")).toBe("[::1]");
  });
});

describe("nonLoopbackBindWarning", () => {
  it("is null for a loopback bind", () => {
    expect(nonLoopbackBindWarning("127.0.0.1", 4317)).toBeNull();
    expect(nonLoopbackBindWarning("::1", 4317)).toBeNull();
  });

  it("is a single line naming the bind and the bearer-token caveat otherwise", () => {
    const w = nonLoopbackBindWarning("0.0.0.0", 4317);
    expect(w).not.toBeNull();
    expect(w!).not.toContain("\n");
    expect(w!).toContain("0.0.0.0:4317");
    expect(w!).toContain("beyond loopback");
    expect(w!).toContain("bearer token");
    expect(w!).toContain("container");
    expect(nonLoopbackBindWarning("::", 4317)!).toContain("[::]:4317");
  });
});

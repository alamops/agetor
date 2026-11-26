import { afterEach, describe, expect, test } from "bun:test";
import type { RemoteDeviceDto, RemoteLogResult } from "../../shared/remote-types.ts";
import type { RemoteAccessStatus } from "../../shared/types.ts";
import { api } from "./api.ts";
import { deviceRowView, lastSeenText, logRowView, macNameProblem, publishRemoteChanged, remoteSectionVisible, subscribeRemoteChanged } from "./remote-access-store.ts";

const NOW = 1_800_000_000_000;
const dev = (over: Partial<RemoteDeviceDto> = {}): RemoteDeviceDto => ({
  id: "ab".repeat(16), name: "Ana's iPhone", platform: "ios", appVersion: "1", level: "respond", trust: "trusted", enrolledAt: NOW - 1000, lastSeenAt: NOW - 5 * 60_000, pushRegistered: true, online: false, ...over,
});

describe("device rows", () => {
  test("a trusted device shows platform, level and last seen, and can be revoked", () => {
    expect(deviceRowView(dev(), NOW)).toEqual({ id: "ab".repeat(16), name: "Ana's iPhone", platform: "iPhone / iPad", level: "respond", notTrusted: null, lastSeen: "5 minutes ago", online: false, canRevoke: true });
  });
  test("an untrusted device says so and why; a revoked one has nothing left to revoke", () => {
    expect(deviceRowView(dev({ trust: "bad-signature" }), NOW).notTrusted).toBe("Not trusted: its entry does not verify, so Agetor ignores it");
    expect(deviceRowView(dev({ trust: "status" }), NOW).notTrusted).toBe("Not trusted: not active");
    const revoked = deviceRowView(dev({ trust: "revoked" }), NOW);
    expect(revoked.notTrusted).toBe("Not trusted: revoked");
    expect(revoked.canRevoke).toBe(false);
    expect(deviceRowView(dev({ trust: "bad-signature" }), NOW).canRevoke).toBe(true);
  });
  test("a name is kept as text, never interpreted", () => {
    expect(deviceRowView(dev({ name: "<img src=x onerror=alert(1)>" }), NOW).name).toBe("<img src=x onerror=alert(1)>");
  });
  test("last seen reads naturally", () => {
    expect(lastSeenText(null, NOW)).toBe("Never connected");
    expect(lastSeenText(NOW - 10_000, NOW)).toBe("Just now");
    expect(lastSeenText(NOW - 3 * 3600_000, NOW)).toBe("3 hours ago");
    expect(lastSeenText(NOW - 3 * 86_400_000, NOW)).toBe("3 days ago");
  });
});

describe("log rows", () => {
  const row = (over: Partial<RemoteLogResult["rows"][number]>): RemoteLogResult["rows"][number] => ({
    seq: 1, ts: NOW, kind: "entry", deviceId: "ab".repeat(16), sessionHash: null, action: "route", route: "POST /runs/r1/input", targetJson: null, resultCode: null, attemptSeq: null, bodyHash: null, signature: null, prevHash: "", hash: "", ...over,
  });
  const devices = [{ id: "ab".repeat(16), name: "Ana's iPhone" }];
  test("names the phone and the route; an attempt with no result reads as outcome unknown", () => {
    const v = logRowView(row({ outcome: "unknown" }), devices);
    expect(v.text).toBe("Request · from Ana's iPhone · POST /runs/r1/input");
    expect(v.outcomeUnknown).toBe(true);
    expect(logRowView(row({ outcome: "200" }), devices).outcomeUnknown).toBe(false);
  });
  test("known actions read as sentences; an anchor row says older entries were trimmed; an unknown device shows a short id", () => {
    expect(logRowView(row({ action: "pair", route: null }), devices).text).toBe("Phone paired · from Ana's iPhone");
    expect(logRowView(row({ kind: "anchor", action: "anchor", deviceId: null, route: null }), devices).text).toBe("Older entries trimmed");
    expect(logRowView(row({ action: "session-open", route: null, deviceId: "cd".repeat(16) }), devices).text).toBe("Phone connected · from cdcdcdcd");
  });
});

describe("the Mac's name", () => {
  test("not empty, not over 40, not only invisible characters", () => {
    expect(macNameProblem("")).not.toBeNull();
    expect(macNameProblem("   ")).not.toBeNull();
    expect(macNameProblem("‮​")).not.toBeNull();
    expect(macNameProblem("x".repeat(41))).not.toBeNull();
    expect(macNameProblem("x".repeat(40))).toBeNull();
    expect(macNameProblem("Ana's Mac")).toBeNull();
  });
});

describe("visibility and the event store", () => {
  const status = (companion: boolean) => ({ enabled: false, preview: true, companion }) as RemoteAccessStatus;
  test("hidden until the status arrives and whenever the Companion is not in this build", () => {
    expect(remoteSectionVisible(null)).toBe(false);
    expect(remoteSectionVisible(status(false))).toBe(false);
    expect(remoteSectionVisible(status(true))).toBe(true);
  });
  test("listeners hear a publish, a throwing one does not stop the others, and unsubscribing stops it", () => {
    const heard: string[] = [];
    const off1 = subscribeRemoteChanged(() => { throw new Error("bug"); });
    const off2 = subscribeRemoteChanged(() => void heard.push("b"));
    publishRemoteChanged();
    off1();
    off2();
    publishRemoteChanged();
    expect(heard).toEqual(["b"]);
  });
});

describe("the api calls", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  function record(body: unknown = {}) {
    const calls: Array<{ method: string; path: string; body: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      calls.push({ method: init?.method ?? "GET", path: u.pathname + u.search, body: typeof init?.body === "string" ? init.body : null });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return calls;
  }
  test("revoke, revoke all, the log, the terminal's Detach and the Mac's name use exactly the routes that exist", async () => {
    const calls = record();
    await api.revokeRemoteDevice("ab".repeat(16));
    await api.revokeAllRemoteDevices();
    await api.getRemoteDevices();
    await api.getRemoteLog({ limit: 20, beforeSeq: 7 });
    await api.detachPhoneTerminal("t 1");
    await api.setMacName("Ana's Mac");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `DELETE /remote-access/devices/${"ab".repeat(16)}`,
      "DELETE /remote-access/devices",
      "GET /remote-access/devices",
      "GET /remote-access/log?limit=20&beforeSeq=7",
      "DELETE /tasks/t%201/phone-terminal",
      "PUT /preferences/remoteMacName",
    ]);
    expect(JSON.parse(calls[5]!.body!)).toEqual({ value: "Ana's Mac" });
  });
  test("nothing here can pair or turn remote access on: there is no such api method", () => {
    const names = Object.keys(api).filter((k) => /pair|enable|turnOn/i.test(k) && /remote|phone|device/i.test(k));
    expect(names).toEqual([]);
  });
});

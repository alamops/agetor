// Static-markup contract of the Settings → Remote access view (no DOM in `bun test`): what is drawn for a seeded list, an untrusted row, the log
// and the chain status, and what is NOT drawn (a pair button, an "on" switch). Wiring to the routes is covered by lib/remote-access-store.test.ts.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteDeviceDto, RemoteLogResult } from "../../../shared/remote-types.ts";
import type { RemoteAccessStatus } from "../../../shared/types.ts";
import { RemoteAccessView, type RemoteAccessViewProps } from "./RemoteAccessSection.tsx";

const NOW = 1_800_000_000_000;
const status = (over: Partial<RemoteAccessStatus> = {}): RemoteAccessStatus => ({
  enabled: true, preview: true, companion: true, relay: { url: "wss://relay.example/ws", state: "up" }, devices: { trusted: 1, untrusted: 1 }, bindWarning: null,
  macName: "Ana's Mac", attachedTerminals: [], auditHead: null, ...over,
});
const dev = (over: Partial<RemoteDeviceDto> = {}): RemoteDeviceDto => ({
  id: "ab".repeat(16), name: "Ana's iPhone", platform: "ios", appVersion: "1", level: "operate", trust: "trusted", enrolledAt: NOW - 1000, lastSeenAt: NOW - 120_000, pushRegistered: true, online: true, ...over,
});
const logRow = (seq: number, over: Partial<RemoteLogResult["rows"][number]> = {}): RemoteLogResult["rows"][number] => ({
  seq, ts: NOW, kind: "entry", deviceId: "ab".repeat(16), sessionHash: null, action: "route", route: "POST /runs/r1/input", targetJson: null, resultCode: null, attemptSeq: null, bodyHash: null, signature: null, prevHash: "", hash: "", ...over,
});

function view(over: Partial<RemoteAccessViewProps> = {}): string {
  return renderToStaticMarkup(
    <RemoteAccessView
      status={status()} devices={[dev(), dev({ id: "cd".repeat(16), name: "Forged", trust: "bad-signature", online: false, lastSeenAt: null })]} log={{ rows: [logRow(2), logRow(1, { action: "pair", route: null })], chain: { ok: true, firstBadSeq: null }, nextBeforeSeq: null }}
      nameDraft="Ana's Mac" busy={false} error={null} now={NOW} onNameChange={() => {}} onNameSave={() => {}} onRevoke={() => {}} onRevokeAll={() => {}} onMoreLog={() => {}}
      {...over}
    />,
  );
}

describe("the Remote access view", () => {
  test("a seeded list renders each phone's name as text with platform, level, last seen and a Revoke button", () => {
    const html = view();
    expect(html).toContain('data-testid="remote-access-section"');
    expect(html).toContain("Ana&#x27;s iPhone");
    expect(html).toContain("iPhone / iPad · operate · 2 minutes ago · connected now");
    expect(html).toContain(`data-testid="remote-device-revoke-${"ab".repeat(16)}"`);
    expect(html).toContain('data-testid="remote-revoke-all"');
  });

  test("an untrusted row says Not trusted and why", () => {
    const html = view();
    expect(html).toContain('data-testid="remote-device-not-trusted"');
    expect(html).toContain("Not trusted: its entry does not verify, so Agetor ignores it");
    expect(html).toContain("Never connected");
  });

  test("a name that looks like markup is escaped, not rendered", () => {
    const html = view({ devices: [dev({ name: "<script>alert(1)</script>" })] });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("the relay address is read-only text, or 'No relay configured'", () => {
    expect(view()).toContain("Relay: wss://relay.example/ws (up)");
    const none = view({ status: status({ relay: { url: null, state: "unconfigured" } }) });
    expect(none).toContain("No relay configured");
    expect(none).not.toContain("<input value=\"wss");
  });

  test("the bind warning shows when there is one and not otherwise", () => {
    expect(view()).not.toContain("remote-access-bind-warning");
    expect(view({ status: status({ bindWarning: "API bound beyond loopback" }) })).toContain("API bound beyond loopback");
  });

  test("the switch state is shown but there is no way to turn it on from here, and no pair button", () => {
    const html = view({ status: status({ enabled: false }) });
    expect(html).toContain('data-enabled="false"');
    expect(html).toContain("Turn it on from Agetor › Remote Access…");
    expect(html).not.toMatch(/role="switch"/);
    expect(html).not.toMatch(/<button[^>]*>\s*(?:Pair|Turn on|Enable)/);
    expect(html).toContain("Pair a phone from the menu bar: Agetor › Pair a Phone…");
  });

  test("no phones: the empty state points at the menu", () => {
    const html = view({ devices: [] });
    expect(html).toContain('data-testid="remote-devices-empty"');
    expect(html).not.toContain('data-testid="remote-revoke-all"');
  });

  test("when every device is already revoked there is nothing to Revoke all", () => {
    const html = view({ devices: [dev({ trust: "revoked" })] });
    expect(html).not.toContain('data-testid="remote-revoke-all"');
    expect(html).not.toContain("remote-device-revoke-");
  });

  test("the log shows the chain status, rows newest first and an unknown outcome", () => {
    const ok = view();
    expect(ok).toContain('data-ok="true"');
    expect(ok).toContain("The log is intact.");
    expect(ok.indexOf("remote-log-row-2")).toBeLessThan(ok.indexOf("remote-log-row-1"));
    const unknown = view({ log: { rows: [logRow(3, { outcome: "unknown" })], chain: { ok: false, firstBadSeq: 2 }, nextBeforeSeq: 3 } });
    expect(unknown).toContain('data-testid="remote-log-unknown"');
    expect(unknown).toContain("outcome unknown");
    expect(unknown).toContain('data-ok="false"');
    expect(unknown).toContain("The log was altered at entry 2.");
    expect(unknown).toContain('data-testid="remote-log-more"');
  });

  test("the Mac's name: Save is off while it is invalid or unchanged, with the reason", () => {
    expect(view()).toMatch(/data-testid="remote-mac-name-save"[^>]*disabled/);
    const bad = view({ nameDraft: "" });
    expect(bad).toContain("Give this Mac a name.");
    expect(bad).toMatch(/data-testid="remote-mac-name-save"[^>]*disabled/);
    const edited = view({ nameDraft: "New name" });
    expect(edited).not.toMatch(/data-testid="remote-mac-name-save"[^>]*disabled/);
  });

  test("an error is shown as an alert", () => {
    expect(view({ error: "the key helper is not installed" })).toContain('role="alert"');
  });

  test("semantic tokens only: no literal palette class", () => {
    expect(view()).not.toMatch(/\b(?:text|bg|border)-(?:red|rose|emerald|green|amber|yellow|blue|zinc|slate)-\d{2,3}\b/);
  });
});

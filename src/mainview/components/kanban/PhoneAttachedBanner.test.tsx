// Static-markup contract of the banner (no DOM in `bun test`): its words, the Detach button and what it does NOT show. The store logic is in
// lib/phone-terminal.test.ts; that a switch of task hides the other task's banner is the store lookup by task id plus `key={phone-banner-<id>}`.
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { applyPhoneTerminalEvent, getPhoneTerminal, resetPhoneTerminalsForTests } from "@/lib/phone-terminal";
import { PhoneAttachedBanner, PhoneAttachedBannerView } from "./PhoneAttachedBanner.tsx";

afterEach(() => resetPhoneTerminalsForTests());

describe("PhoneAttachedBannerView", () => {
  test("says 'Phone attached to <task>', names the phone and offers Detach", () => {
    const html = renderToStaticMarkup(<PhoneAttachedBannerView taskTitle="Fix login" deviceName="Ana's iPhone" busy={false} onDetach={() => {}} />);
    expect(html).toContain("Phone attached to");
    expect(html).toContain("Fix login");
    expect(html).toContain("Ana&#x27;s iPhone");
    expect(html).toContain('data-testid="phone-attached-detach"');
    expect(html).not.toMatch(/data-testid="phone-attached-detach"[^>]*disabled/);
  });
  test("Detach is disabled while a detach is in flight", () => {
    const html = renderToStaticMarkup(<PhoneAttachedBannerView taskTitle="t" deviceName="p" busy onDetach={() => {}} />);
    expect(html).toMatch(/data-testid="phone-attached-detach"[^>]*disabled/);
  });
  test("a phone's name is escaped, never rendered as markup", () => {
    const html = renderToStaticMarkup(<PhoneAttachedBannerView taskTitle="t" deviceName={"<img src=x onerror=1>"} busy={false} onDetach={() => {}} />);
    expect(html).not.toContain("<img");
  });
  test("semantic tokens only", () => {
    const html = renderToStaticMarkup(<PhoneAttachedBannerView taskTitle="t" deviceName="p" busy={false} onDetach={() => {}} />);
    expect(html).not.toMatch(/\b(?:text|bg|border)-(?:red|rose|emerald|green|amber|yellow|blue)-\d{2,3}\b/);
  });
});

describe("PhoneAttachedBanner (the container)", () => {
  test("nothing while no phone is attached to this task", () => {
    expect(renderToStaticMarkup(<PhoneAttachedBanner taskId="t1" taskTitle="Fix login" />)).toBe("");
  });
  test("an attach to ANOTHER task shows nothing here; the task's own attach is in the store", () => {
    applyPhoneTerminalEvent({ type: "phone_terminal", taskId: "t2", deviceId: "d", deviceName: "Ana", attached: true, since: 1, ts: 1 });
    expect(renderToStaticMarkup(<PhoneAttachedBanner taskId="t1" taskTitle="Fix login" />)).toBe("");
    expect(getPhoneTerminal("t2")?.deviceName).toBe("Ana");
    expect(getPhoneTerminal("t1")).toBeNull();
  });
});

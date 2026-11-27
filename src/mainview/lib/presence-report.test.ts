import { describe, expect, test } from "bun:test";
import { PRESENCE_BACKOFF_MS, PRESENCE_DEBOUNCE_MS, createPresenceReporter, type PresenceReport } from "./presence-report.ts";

/** A fake clock whose timers run when the test advances it. */
function rig(sendImpl?: (r: PresenceReport) => Promise<unknown>) {
  let t = 1000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sent: PresenceReport[] = [];
  const reporter = createPresenceReporter({
    send: (r) => {
      sent.push(r);
      return sendImpl ? sendImpl(r) : Promise.resolve({ ok: true });
    },
    now: () => t,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (h) => void timers.delete(h as number),
  });
  const advance = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      t = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
      await Promise.resolve();
      await Promise.resolve();
    }
    t = end;
  };
  return { reporter, sent, advance, pending: () => timers.size };
}

const a: PresenceReport = { focused: true, selectedTaskId: "t1", view: "run-panel" };

describe("presence reporter", () => {
  test("the first report goes out after the debounce, not before", async () => {
    const r = rig();
    r.reporter.update(a);
    await r.advance(PRESENCE_DEBOUNCE_MS - 1);
    expect(r.sent).toEqual([]);
    await r.advance(1);
    expect(r.sent).toEqual([a]);
  });

  test("a burst sends once, with the last state", async () => {
    const r = rig();
    r.reporter.update({ ...a, focused: false });
    await r.advance(100);
    r.reporter.update({ ...a, selectedTaskId: "t2" });
    await r.advance(100);
    r.reporter.update(a);
    await r.advance(PRESENCE_DEBOUNCE_MS);
    expect(r.sent).toEqual([a]);
  });

  test("an unchanged state is not sent again", async () => {
    const r = rig();
    r.reporter.update(a);
    await r.advance(PRESENCE_DEBOUNCE_MS);
    r.reporter.update({ ...a });
    await r.advance(PRESENCE_DEBOUNCE_MS * 2);
    expect(r.sent.length).toBe(1);
    // A change and back inside the debounce window sends nothing at all.
    r.reporter.update({ ...a, focused: false });
    await r.advance(50);
    r.reporter.update(a);
    await r.advance(PRESENCE_DEBOUNCE_MS * 2);
    expect(r.sent.length).toBe(1);
  });

  test("flush sends the latest state at once", async () => {
    const r = rig();
    r.reporter.update(a);
    r.reporter.flush();
    expect(r.sent).toEqual([a]);
    expect(r.pending()).toBe(0);
  });

  test("after an error nothing is sent for 5 seconds, then the latest state goes out", async () => {
    let fail = true;
    const r = rig(() => (fail ? Promise.reject(new Error("down")) : Promise.resolve({ ok: true })));
    r.reporter.update(a);
    await r.advance(PRESENCE_DEBOUNCE_MS);
    expect(r.sent.length).toBe(1);
    fail = false;
    r.reporter.update({ ...a, focused: false });
    await r.advance(PRESENCE_DEBOUNCE_MS);
    expect(r.sent.length).toBe(1); // still backing off
    r.reporter.update({ ...a, focused: false, selectedTaskId: "t9" });
    await r.advance(PRESENCE_BACKOFF_MS);
    expect(r.sent.length).toBe(2);
    expect(r.sent[1]).toEqual({ ...a, focused: false, selectedTaskId: "t9" });
  });

  test("a failed report is retried after the back-off even if nothing changed", async () => {
    let fail = true;
    const r = rig(() => (fail ? Promise.reject(new Error("down")) : Promise.resolve({ ok: true })));
    r.reporter.update(a);
    await r.advance(PRESENCE_DEBOUNCE_MS);
    fail = false;
    await r.advance(PRESENCE_BACKOFF_MS + 10);
    expect(r.sent).toEqual([a, a]);
  });

  test("after dispose nothing is sent", async () => {
    const r = rig();
    r.reporter.update(a);
    r.reporter.dispose();
    await r.advance(PRESENCE_DEBOUNCE_MS * 4);
    r.reporter.update({ ...a, focused: false });
    r.reporter.flush();
    expect(r.sent).toEqual([]);
  });
});

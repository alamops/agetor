// Agent discovery for a multi-repository composer (finding M7, issue #291):
// one `GET /agent-discovery` per repository must wait for the task's event
// stream and stay bounded, so opening a 16-repository task can't starve the
// stream in the webview's per-host connection budget. Drives
// `discoverAgentCapabilities` — the request half of `useAgentCapabilities` —
// with `api.listAgentCapabilities` spied (no React harness, house convention).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { api } from "@/lib/api";
import { MULTI_SCOPE_CONCURRENCY } from "@/lib/use-project-files";
import { discoverAgentCapabilities } from "./PromptComposer";

type Caps = Awaited<ReturnType<typeof api.listAgentCapabilities>>;

let spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

function manualStub() {
  const pending: Array<{ workdir: string; resolve: (c: Caps) => void }> = [];
  let inFlight = 0;
  let peak = 0;
  const spy = spyOn(api, "listAgentCapabilities").mockImplementation(((opts: { workdir?: string | null }) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    return new Promise<Caps>((resolve) => {
      pending.push({ workdir: opts.workdir ?? "", resolve: (c) => { inFlight -= 1; resolve(c); } });
    });
  }) as typeof api.listAgentCapabilities);
  spies.push(spy);
  return { spy, pending, get inFlight() { return inFlight; }, get peak() { return peak; } };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const caps = (name: string): Caps => ({ commands: [{ name } as Caps["commands"][number]], extensions: [] });
const dirs = (n: number) => Array.from({ length: n }, (_, i) => ({ dir: `/t/disc-${i}` }));

describe("discoverAgentCapabilities", () => {
  test("a multi-repository discovery waits on awaitReady, then keeps at most the cap in flight", async () => {
    const stub = manualStub();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const run = discoverAgentCapabilities("claude-code", dirs(5), { awaitReady: () => gate });
    await flush();
    expect(stub.spy).toHaveBeenCalledTimes(0);
    open();
    await flush();
    expect(stub.inFlight).toBe(MULTI_SCOPE_CONCURRENCY);
    while (stub.pending.length > 0) {
      expect(stub.inFlight).toBeLessThanOrEqual(MULTI_SCOPE_CONCURRENCY);
      const next = stub.pending.shift()!;
      next.resolve(caps(next.workdir));
      await flush();
    }
    const merged = await run;
    expect(stub.peak).toBe(MULTI_SCOPE_CONCURRENCY);
    // Scope order is preserved through the bounded fan-out.
    expect(merged?.commands.map((c) => c.name)).toEqual(dirs(5).map((d) => d.dir));
  });

  test("a discovery superseded while waiting on the gate sends nothing", async () => {
    const stub = manualStub();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let current = true;
    const run = discoverAgentCapabilities("claude-code", dirs(3), { awaitReady: () => gate, isCurrent: () => current });
    current = false;
    open();
    expect(await run).toBeNull();
    expect(stub.spy).toHaveBeenCalledTimes(0);
  });

  test("a single scope fetches at once and never waits on the gate", async () => {
    const stub = manualStub();
    const never = new Promise<void>(() => {});
    const run = discoverAgentCapabilities("claude-code", dirs(1), { awaitReady: () => never });
    await flush();
    expect(stub.spy).toHaveBeenCalledTimes(1);
    stub.pending.shift()!.resolve(caps("only"));
    expect((await run)?.commands.map((c) => c.name)).toEqual(["only"]);
  });

  test("a failed repository contributes nothing; the others still merge", async () => {
    const spy = spyOn(api, "listAgentCapabilities").mockImplementation((async (opts: { workdir?: string | null }) => {
      if (opts.workdir === "/t/disc-0") throw new Error("down");
      return caps(opts.workdir ?? "");
    }) as typeof api.listAgentCapabilities);
    spies.push(spy);
    const merged = await discoverAgentCapabilities("claude-code", dirs(3));
    expect(merged?.commands.map((c) => c.name)).toEqual(["/t/disc-1", "/t/disc-2"]);
  });
});

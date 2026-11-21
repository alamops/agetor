import { expect, test } from "bun:test";
import { PROBE_STDOUT_CAP_BYTES, runCapture, runJsonLineSession } from "./spawn-probe.ts";

// A CLI (or a wrapper earlier on PATH) that streams stdout without end and
// never prints a newline: ~13 MB/s, so it passes the cap well inside the
// budget. Perl, not a Bun script: a fake must start fast under load.
const FLOOD = ["/usr/bin/perl", "-e", '$|=1; while (1) { print "x" x 65536; select(undef, undef, undef, 0.005); }'];
const BUDGET_MS = 15_000;

test("runCapture stops reading and kills the child once stdout passes the cap, long before the budget", async () => {
  const started = Date.now();
  const res = await runCapture(FLOOD, { timeoutMs: BUDGET_MS });
  expect(res.ok).toBe(false);
  expect(Date.now() - started).toBeLessThan(BUDGET_MS / 2);
  expect(res.stdout.length).toBeLessThanOrEqual(PROBE_STDOUT_CAP_BYTES);
}, BUDGET_MS + 5_000);

test("runJsonLineSession gives up on an unbroken line past the cap, long before the budget", async () => {
  const started = Date.now();
  let messages = 0;
  const res = await runJsonLineSession({
    cmd: FLOOD,
    timeoutMs: BUDGET_MS,
    start() {},
    onMessage() {
      messages++;
    },
  });
  expect(res.timedOut).toBe(false);
  expect(messages).toBe(0);
  expect(Date.now() - started).toBeLessThan(BUDGET_MS / 2);
}, BUDGET_MS + 5_000);

test("runCapture still returns a normal answer whole", async () => {
  const res = await runCapture(["/bin/echo", "hello"], { timeoutMs: BUDGET_MS });
  expect(res).toEqual({ ok: true, stdout: "hello\n" });
});

test("writing to a child that already exited leaves no unhandled rejection (write and flush both swallow a broken pipe)", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => { unhandled.push(e); };
  process.on("unhandledRejection", onUnhandled);
  try {
    await runJsonLineSession({
      cmd: ["/usr/bin/true"],
      timeoutMs: 5_000,
      start(write) {
        // Keep writing after the child is gone: the broken pipe surfaces as a
        // rejected write or flush, which nobody awaits.
        const big = "x".repeat(1 << 16);
        for (let i = 0; i < 20; i++) setTimeout(() => write({ big }), 20 * i);
      },
      onMessage() {},
    });
    await new Promise((r) => setTimeout(r, 600));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  expect(unhandled).toEqual([]);
});

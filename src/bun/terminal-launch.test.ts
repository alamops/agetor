import { test, expect } from "bun:test";
import {
  awaitTerminalLaunch,
  terminalLaunchErrorMessage,
  TERMINAL_LAUNCH_WAIT_MS,
  type TerminalLaunchChild,
} from "./terminal-launch.ts";

// The wait contract of the two Terminal.app routes (open-tmux and the
// harness open-terminal). The headline case is the slow launch: osascript
// blocked on macOS's one-time Automation consent prompt must be left running
// (the window opens once the user allows it), never killed at the ceiling.

/** A fake osascript child whose exit the test controls. Any attempt to kill
 *  it fails the test: the module must never signal the child. */
function fakeChild(stderrText = "") {
  let finish!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { finish = resolve; });
  const child: TerminalLaunchChild & { kill: () => never } = {
    exited,
    stderr: new Response(stderrText).body!,
    kill: () => { throw new Error("the launch child must never be killed"); },
  };
  return { child, finish };
}

test("awaitTerminalLaunch — exit 0 within the ceiling is ok and logs nothing", async () => {
  const { child, finish } = fakeChild();
  const warnings: string[] = [];
  finish(0);
  const out = await awaitTerminalLaunch(child, { label: "testing", waitMs: 1000, warn: (m) => warnings.push(m) });
  expect(out).toEqual({ kind: "ok" });
  expect(warnings).toEqual([]);
});

test("awaitTerminalLaunch — a non-zero exit within the ceiling fails with osascript's stderr (Automation denied)", async () => {
  const { child, finish } = fakeChild("execution error: Not authorized to send Apple events to Terminal. (-1743)\n");
  const warnings: string[] = [];
  finish(1);
  const out = await awaitTerminalLaunch(child, { label: "opening a terminal", waitMs: 1000, warn: (m) => warnings.push(m) });
  expect(out).toEqual({
    kind: "failed",
    code: 1,
    detail: "execution error: Not authorized to send Apple events to Terminal. (-1743)",
  });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("osascript exited 1 while opening a terminal");
  expect(terminalLaunchErrorMessage(out as { code: number; detail: string })).toBe(
    "Couldn't open Terminal (osascript exited 1). execution error: Not authorized to send Apple events to Terminal. (-1743) Check System Settings → Privacy & Security → Automation.",
  );
});

test("awaitTerminalLaunch — still running at the ceiling is pending and the child is NOT killed (first-use consent prompt)", async () => {
  const { child, finish } = fakeChild();
  const warnings: string[] = [];
  // The fake's kill() throws, so any kill attempt would reject this await.
  const out = await awaitTerminalLaunch(child, { label: "attaching", waitMs: 20, warn: (m) => warnings.push(m) });
  expect(out).toEqual({ kind: "pending" });
  // The user answers the consent prompt after the route already replied: the
  // launch completes normally and nothing is logged.
  finish(0);
  await Bun.sleep(10);
  expect(warnings).toEqual([]);
});

test("awaitTerminalLaunch — a late non-zero exit after the ceiling is logged, with stderr", async () => {
  const { child, finish } = fakeChild("not authorized (-1743)");
  const warnings: string[] = [];
  const out = await awaitTerminalLaunch(child, { label: "attaching to tmux session \"agetor-x\"", waitMs: 20, warn: (m) => warnings.push(m) });
  expect(out).toEqual({ kind: "pending" });
  expect(warnings).toEqual([]);
  finish(1);
  await Bun.sleep(10);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("osascript exited 1 after 20ms while attaching to tmux session \"agetor-x\": not authorized (-1743)");
});

test("TERMINAL_LAUNCH_WAIT_MS keeps the 5 s ceiling the routes have always used", () => {
  expect(TERMINAL_LAUNCH_WAIT_MS).toBe(5000);
});

import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { AnswerOverlay } from "./AnswerOverlay.tsx";
import type { AgetorClient } from "../api-client.ts";
import type { AnyRequest } from "../../bun/interactions.ts";

const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const ENTER = "\r";
const SPACE = " ";
const ESC = String.fromCharCode(27);
const DOWN = String.fromCharCode(27) + "[B"; // ESC [ B
const UP = String.fromCharCode(27) + "[A"; // ESC [ A

function fakeClient(
  req: AnyRequest,
  capture: (a: unknown) => void,
  opts: { fxOk?: boolean } = {},
): AgetorClient {
  return {
    pendingInteractions: async () => [req],
    answerAskQuestions: async (id: string, answers: unknown) => {
      capture({ id, answers });
      return { ok: true };
    },
    answerTmuxPrompt: async (id: string, body: unknown) => {
      capture({ id, body });
      return { ok: true };
    },
    answerFxPermission: async (id: string, body: unknown) => {
      capture({ id, body });
      return { ok: opts.fxOk ?? true };
    },
  } as unknown as AgetorClient;
}

test("single-select: down then Enter submits the highlighted option", async () => {
  let captured: unknown = null;
  let done = "";
  const req = {
    kind: "ask_questions", id: "q1", taskId: "t1", runId: "r1", createdAt: 0,
    questions: [{ question: "Pick", options: [{ label: "A" }, { label: "B" }] }],
  } as unknown as AnyRequest;
  const { stdin } = render(
    <AnswerOverlay client={fakeClient(req, (a) => { captured = a; })} taskId="t1" onDone={(m) => { done = m; }} onCancel={() => {}} />,
  );
  await wait();
  stdin.write(DOWN);
  await wait();
  stdin.write(ENTER);
  await wait();
  expect(captured).toEqual({ id: "q1", answers: [{ selected: ["B"] }] });
  expect(done).toBe("✓ answered");
});

test("multi-select: space toggles, Enter submits the set in pick order", async () => {
  let captured: unknown = null;
  const req = {
    kind: "ask_questions", id: "q2", taskId: "t1", runId: "r1", createdAt: 0,
    questions: [{ question: "Pick many", multiSelect: true, options: [{ label: "X" }, { label: "Y" }, { label: "Z" }] }],
  } as unknown as AnyRequest;
  const { stdin } = render(
    <AnswerOverlay client={fakeClient(req, (a) => { captured = a; })} taskId="t1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  stdin.write(SPACE); // toggle X (index 0)
  await wait();
  stdin.write(DOWN);
  await wait();
  stdin.write(DOWN); // cursor at Z (index 2)
  await wait();
  stdin.write(SPACE); // toggle Z
  await wait();
  stdin.write(ENTER);
  await wait();
  expect(captured).toEqual({ id: "q2", answers: [{ selected: ["X", "Z"] }] });
});

test("tmux prompt: choosing a key sends { key }", async () => {
  let captured: unknown = null;
  const req = {
    kind: "tmux_prompt", id: "p1", taskId: "t1", runId: "r1", paneText: "Proceed?",
    choices: [{ key: "1", label: "Yes" }, { key: "2", label: "No" }],
  } as unknown as AnyRequest;
  const { stdin } = render(
    <AnswerOverlay client={fakeClient(req, (a) => { captured = a; })} taskId="t1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  stdin.write(ENTER); // cursor at 0 → "Yes"
  await wait();
  expect(captured).toEqual({ id: "p1", body: { key: "1" } });
});

test("tmux prompt: the trailing Reject entry sends { reject:true }", async () => {
  let captured: unknown = null;
  const req = {
    kind: "tmux_prompt", id: "p2", taskId: "t1", runId: "r1", paneText: "Proceed?",
    choices: [{ key: "1", label: "Yes" }, { key: "2", label: "No" }],
  } as unknown as AnyRequest;
  const { stdin } = render(
    <AnswerOverlay client={fakeClient(req, (a) => { captured = a; })} taskId="t1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  stdin.write(DOWN);
  await wait();
  stdin.write(DOWN); // choices = [Yes, No, Reject] → index 2
  await wait();
  stdin.write(ENTER);
  await wait();
  expect(captured).toEqual({ id: "p2", body: { reject: true } });
});

test("single-select Other → captures a free-text custom answer", async () => {
  let captured: unknown = null;
  const req = {
    kind: "ask_questions", id: "q3", taskId: "t1", runId: "r1", createdAt: 0,
    questions: [{ question: "Pick", options: [{ label: "A" }, { label: "B" }] }],
  } as unknown as AnyRequest;
  const { stdin } = render(
    <AnswerOverlay client={fakeClient(req, (a) => { captured = a; })} taskId="t1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  stdin.write(DOWN); // B
  await wait();
  stdin.write(DOWN); // ✎ Other (index 2)
  await wait();
  stdin.write(ENTER); // drop into the text field
  await wait();
  stdin.write("my own answer");
  await wait();
  stdin.write(ENTER); // submit
  await wait();
  expect(captured).toEqual({ id: "q3", answers: [{ selected: [], custom: "my own answer" }] });
});

test("multi-select Other + an option → submits both", async () => {
  let captured: unknown = null;
  const req = {
    kind: "ask_questions", id: "q4", taskId: "t1", runId: "r1", createdAt: 0,
    questions: [{ question: "Pick many", multiSelect: true, options: [{ label: "X" }, { label: "Y" }, { label: "Z" }] }],
  } as unknown as AnyRequest;
  // labels = [X, Y, Z, ✎ Other] → Other is index 3
  const { stdin } = render(
    <AnswerOverlay client={fakeClient(req, (a) => { captured = a; })} taskId="t1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  stdin.write(SPACE); // toggle X (index 0)
  await wait();
  stdin.write(DOWN);
  await wait();
  stdin.write(DOWN);
  await wait();
  stdin.write(DOWN); // cursor at Other (index 3)
  await wait();
  stdin.write(SPACE); // toggle Other
  await wait();
  stdin.write(ENTER); // drop into the text field
  await wait();
  stdin.write("extra");
  await wait();
  stdin.write(ENTER); // submit
  await wait();
  expect(captured).toEqual({ id: "q4", answers: [{ selected: ["X"], custom: "extra" }] });
});

test("multi-select: Enter with nothing picked shows a hint and submits nothing", async () => {
  let captured: unknown = null;
  const req = {
    kind: "ask_questions", id: "q5", taskId: "t1", runId: "r1", createdAt: 0,
    questions: [{ question: "Pick", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }],
  } as unknown as AnyRequest;
  const { stdin, lastFrame } = render(
    <AnswerOverlay client={fakeClient(req, (a) => { captured = a; })} taskId="t1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  stdin.write(ENTER); // nothing toggled → no submit
  await wait();
  expect(captured).toBeNull();
  expect(lastFrame() ?? "").toContain("pick an option");
});

test("single-select Other: a dragged path is sanitized into the custom answer", async () => {
  let captured: unknown = null;
  const req = {
    kind: "ask_questions", id: "qd", taskId: "t1", runId: "r1", createdAt: 0,
    questions: [{ question: "Pick", options: [{ label: "A" }] }],
  } as unknown as AnyRequest;
  const { stdin } = render(
    <AnswerOverlay client={fakeClient(req, (a) => { captured = a; })} taskId="t1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  stdin.write(DOWN); // A → ✎ Other (index 1)
  await wait();
  stdin.write(ENTER); // into the text field
  await wait();
  stdin.write("/Users/me/My\\ Shot.png"); // dropped path
  await wait();
  stdin.write(ENTER); // submit
  await wait();
  expect(captured).toEqual({ id: "qd", answers: [{ selected: [], custom: "/Users/me/My Shot.png" }] });
});

/* ── fx_permission ────────────────────────────────────────────────────── */

test("fx_permission: renders the tool call title, kind, mode, option names, and the Dismiss row", async () => {
  const req = {
    kind: "fx_permission", id: "fx1", taskId: "t1", runId: "r1", createdAt: 0,
    toolCall: { toolCallId: "tc1", title: "Write file", kind: "edit" },
    options: [{ optionId: "allow", name: "Allow once" }, { optionId: "always", name: "Allow always" }],
    mode: "ask",
  } as unknown as AnyRequest;
  const { lastFrame, unmount } = render(
    <AnswerOverlay client={fakeClient(req, () => {})} taskId="t1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Write file");
  expect(frame).toContain("[edit]");
  expect(frame).toContain("(ask)");
  expect(frame).toContain("Allow once");
  expect(frame).toContain("Allow always");
  expect(frame).toContain("Dismiss (reject)");
  unmount();
});

test("fx_permission: DOWN then Enter on an option answers with { optionId }", async () => {
  let captured: unknown = null;
  let done = "";
  const req = {
    kind: "fx_permission", id: "fx2", taskId: "t1", runId: "r1", createdAt: 0,
    toolCall: { toolCallId: "tc2", title: "Run command", kind: "execute" },
    options: [{ optionId: "allow", name: "Allow once" }, { optionId: "always", name: "Allow always" }],
    mode: "ask",
  } as unknown as AnyRequest;
  const { stdin, unmount } = render(
    <AnswerOverlay client={fakeClient(req, (a) => { captured = a; })} taskId="t1" onDone={(m) => { done = m; }} onCancel={() => {}} />,
  );
  await wait();
  stdin.write(DOWN); // cursor -> "Allow always" (index 1)
  await wait();
  stdin.write(ENTER);
  await wait();
  expect(captured).toEqual({ id: "fx2", body: { optionId: "always" } });
  expect(done).toContain("answered");
  unmount();
});

test("fx_permission: navigating to the Dismiss row + Enter sends { cancel: true }", async () => {
  let captured: unknown = null;
  let done = "";
  const req = {
    kind: "fx_permission", id: "fx3", taskId: "t1", runId: "r1", createdAt: 0,
    toolCall: { toolCallId: "tc3", title: "Delete file", kind: "delete" },
    options: [{ optionId: "allow", name: "Allow once" }],
    mode: "auto",
  } as unknown as AnyRequest;
  const { stdin, unmount } = render(
    <AnswerOverlay client={fakeClient(req, (a) => { captured = a; })} taskId="t1" onDone={(m) => { done = m; }} onCancel={() => {}} />,
  );
  await wait();
  // labels = ["Allow once", "Dismiss (reject)"] → index 1 is Dismiss.
  stdin.write(DOWN);
  await wait();
  stdin.write(ENTER);
  await wait();
  expect(captured).toEqual({ id: "fx3", body: { cancel: true } });
  expect(done).toContain("dismissed");
  unmount();
});

test("fx_permission: an { ok: false } response from the server surfaces 'already resolved'", async () => {
  let done = "";
  const req = {
    kind: "fx_permission", id: "fx4", taskId: "t1", runId: "r1", createdAt: 0,
    toolCall: { toolCallId: "tc4", title: "Write file", kind: "edit" },
    options: [{ optionId: "allow", name: "Allow once" }],
    mode: "ask",
  } as unknown as AnyRequest;
  const { stdin, unmount } = render(
    <AnswerOverlay
      client={fakeClient(req, () => {}, { fxOk: false })}
      taskId="t1"
      onDone={(m) => { done = m; }}
      onCancel={() => {}}
    />,
  );
  await wait();
  stdin.write(ENTER); // cursor at 0 -> "Allow once"
  await wait();
  expect(done).toBe("already resolved");
  unmount();
});

test("fx_permission: Esc closes the overlay without answering (interaction stays pending)", async () => {
  let captured: unknown = null;
  let cancelled = false;
  let done = "";
  const req = {
    kind: "fx_permission", id: "fx5", taskId: "t1", runId: "r1", createdAt: 0,
    toolCall: { toolCallId: "tc5", title: "Write file", kind: "edit" },
    options: [{ optionId: "allow", name: "Allow once" }],
    mode: "ask",
  } as unknown as AnyRequest;
  const { stdin, unmount } = render(
    <AnswerOverlay
      client={fakeClient(req, (a) => { captured = a; })}
      taskId="t1"
      onDone={(m) => { done = m; }}
      onCancel={() => { cancelled = true; }}
    />,
  );
  await wait();
  stdin.write(ESC);
  await wait();
  expect(cancelled).toBe(true);
  expect(captured).toBeNull();
  expect(done).toBe("");
  unmount();
});

test("fx_permission: zero options (defensive) renders only Dismiss, and arrow keys don't move past it", async () => {
  const req = {
    kind: "fx_permission", id: "fx6", taskId: "t1", runId: "r1", createdAt: 0,
    toolCall: { toolCallId: "tc6", title: "Mystery tool" },
    options: [],
    mode: "ask",
  } as unknown as AnyRequest;
  const { stdin, lastFrame, unmount } = render(
    <AnswerOverlay client={fakeClient(req, () => {})} taskId="t1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  expect(lastFrame() ?? "").toContain("Dismiss (reject)");
  // Cursor has nowhere to go but stays clamped at the single row — no crash.
  stdin.write(DOWN);
  await wait();
  stdin.write(DOWN);
  await wait();
  stdin.write(UP);
  await wait();
  stdin.write(UP);
  await wait();
  expect(lastFrame() ?? "").toContain("Dismiss (reject)");
  unmount();
});

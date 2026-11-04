import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { AnswerOverlay } from "./AnswerOverlay.tsx";
import { ApiError, type AgetorClient } from "../api-client.ts";
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

test("cursor duplicate labels submit the second option's id", async () => {
  let captured: unknown = null;
  const req = {
    kind: "ask_questions", id: "q-dup", taskId: "t1", runId: "r1", createdAt: 0,
    source: "cursor",
    questions: [{
      question: "Which Alpha?",
      options: [{ id: "a", label: "Alpha" }, { id: "a2", label: "Alpha" }],
    }],
  } as unknown as AnyRequest;
  const ui = render(
    <AnswerOverlay client={fakeClient(req, (a) => { captured = a; })} taskId="t1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  expect(ui.lastFrame() ?? "").toContain("Alpha (a2)");
  ui.stdin.write(DOWN);
  await wait();
  ui.stdin.write(ENTER);
  await wait();
  expect(captured).toEqual({
    id: "q-dup",
    answers: [{ selected: ["Alpha"], selectedOptionIds: ["a2"] }],
  });
  ui.unmount();
});

// Cross-agent contract (b): a pipeline parent's pending list aggregates its
// hidden step tasks' cards — the overlay names the step task the card
// belongs to when it isn't the task `g` was pressed on.
test("a card whose taskId differs from the overlay's taskId (a pipeline step's card) names that step task", async () => {
  const req = {
    kind: "ask_questions", id: "q1", taskId: "step-task-1abcdef", runId: "r1", createdAt: 0,
    questions: [{ question: "Pick", options: [{ label: "A" }] }],
  } as unknown as AnyRequest;
  const { lastFrame } = render(
    <AnswerOverlay client={fakeClient(req, () => {})} taskId="parent-1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  expect(lastFrame()).toContain("↳ on step task step-tas");
});

test("a cursor card shows args.title above the question", async () => {
  const req = {
    kind: "ask_questions", id: "q1", taskId: "t1", runId: "r1", createdAt: 0,
    source: "cursor", title: "Pick one",
    questions: [{ question: "Which option?", options: [{ label: "Alpha" }] }],
  } as unknown as AnyRequest;
  const { lastFrame } = render(
    <AnswerOverlay client={fakeClient(req, () => {})} taskId="t1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Pick one");
  expect(frame.indexOf("Pick one")).toBeLessThan(frame.indexOf("Which option?"));
});

test("a card on the overlay's own task carries no step-task note", async () => {
  const req = {
    kind: "ask_questions", id: "q1", taskId: "t1", runId: "r1", createdAt: 0,
    questions: [{ question: "Pick", options: [{ label: "A" }] }],
  } as unknown as AnyRequest;
  const { lastFrame } = render(
    <AnswerOverlay client={fakeClient(req, () => {})} taskId="t1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  expect(lastFrame()).not.toContain("on step task");
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

test("cursor ask: Skip posts { skip: true } and a claude card has no Skip row", async () => {
  let captured: unknown = null;
  let done = "";
  const cursorReq = {
    kind: "ask_questions", id: "q-cursor", taskId: "t1", runId: "r1", createdAt: 0,
    source: "cursor",
    questions: [{ question: "Which option?", options: [{ label: "Alpha" }, { label: "Beta" }] }],
  } as unknown as AnyRequest;
  const cursorUi = render(
    <AnswerOverlay client={fakeClient(cursorReq, (a) => { captured = a; })} taskId="t1" onDone={(m) => { done = m; }} onCancel={() => {}} />,
  );
  await wait();
  expect(cursorUi.lastFrame() ?? "").toContain("Skip");
  cursorUi.stdin.write(DOWN);
  await wait();
  cursorUi.stdin.write(DOWN);
  await wait();
  cursorUi.stdin.write(DOWN);
  await wait();
  cursorUi.stdin.write(ENTER);
  await wait();
  expect(captured).toEqual({ id: "q-cursor", answers: { skip: true } });
  expect(done).toBe("✓ skipped");
  cursorUi.unmount();

  const claudeReq = {
    kind: "ask_questions", id: "q-claude", taskId: "t1", runId: "r1", createdAt: 0,
    source: "scraper",
    questions: [{ question: "Pick", options: [{ label: "A" }] }],
  } as unknown as AnyRequest;
  const claudeUi = render(
    <AnswerOverlay client={fakeClient(claudeReq, () => {})} taskId="t1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  expect(claudeUi.lastFrame() ?? "").not.toContain("Skip");
  claudeUi.unmount();
});

test("cursor multi-select custom text stays on the card", async () => {
  let captured: unknown = null;
  let done = "";
  const req = {
    kind: "ask_questions", id: "q-multi-custom", taskId: "t1", runId: "r1", createdAt: 0,
    source: "cursor",
    questions: [{ question: "Which?", multiSelect: true, options: [{ label: "Alpha" }, { label: "Beta" }] }],
  } as unknown as AnyRequest;
  const { stdin, lastFrame } = render(
    <AnswerOverlay
      client={fakeClient(req, (a) => { captured = a; })}
      taskId="t1"
      onDone={(m) => { done = m; }}
      onCancel={() => {}}
    />,
  );
  await wait();
  stdin.write(SPACE); // toggle Alpha
  await wait();
  stdin.write(DOWN);
  await wait();
  stdin.write(DOWN); // Other
  await wait();
  stdin.write(SPACE); // toggle Other
  await wait();
  stdin.write(ENTER);
  await wait();
  stdin.write("typed");
  await wait();
  stdin.write(ENTER);
  await wait();
  expect(captured).toBeNull();
  expect(done).toBe("");
  expect(lastFrame() ?? "").toContain("Cursor cannot accept a custom answer");
  expect(lastFrame() ?? "").toContain("Which?");
});

test("cursor custom-only stays on the card", async () => {
  let captured: unknown = null;
  let done = "";
  const req = {
    kind: "ask_questions", id: "q-custom", taskId: "t1", runId: "r1", createdAt: 0,
    source: "cursor",
    questions: [{ question: "Which?", options: [{ label: "Alpha" }, { label: "Beta" }] }],
  } as unknown as AnyRequest;
  const { stdin, lastFrame } = render(
    <AnswerOverlay
      client={fakeClient(req, (a) => { captured = a; })}
      taskId="t1"
      onDone={(m) => { done = m; }}
      onCancel={() => {}}
    />,
  );
  await wait();
  stdin.write(DOWN);
  await wait();
  stdin.write(DOWN); // Other
  await wait();
  stdin.write(ENTER);
  await wait();
  stdin.write("typed");
  await wait();
  stdin.write(ENTER);
  await wait();
  expect(captured).toBeNull();
  expect(done).toBe("");
  expect(lastFrame() ?? "").toContain("Cursor cannot accept a custom answer");
  expect(lastFrame() ?? "").toContain("Which?");
});

test("cursor skip: a 400 leaves the overlay open", async () => {
  let done = "";
  const req = {
    kind: "ask_questions", id: "q-skip-400", taskId: "t1", runId: "r1", createdAt: 0,
    source: "cursor",
    questions: [{ question: "Which?", options: [{ label: "Alpha" }] }],
  } as unknown as AnyRequest;
  const client = {
    pendingInteractions: async () => [req],
    answerAskQuestions: async () => {
      throw new ApiError(400, { error: "run not found" }, "run not found");
    },
  } as unknown as AgetorClient;
  const { stdin, lastFrame } = render(
    <AnswerOverlay client={client} taskId="t1" onDone={(m) => { done = m; }} onCancel={() => {}} />,
  );
  await wait();
  stdin.write(DOWN); // Other
  await wait();
  stdin.write(DOWN); // Skip
  await wait();
  stdin.write(ENTER);
  await wait();
  expect(done).toBe("");
  expect(lastFrame() ?? "").toContain("run not found");
  expect(lastFrame() ?? "").toContain("Which?");
});

test("a cursor 400 leaves the overlay open", async () => {
  let done = "";
  const req = {
    kind: "ask_questions", id: "q-400", taskId: "t1", runId: "r1", createdAt: 0,
    source: "cursor",
    questions: [{ question: "Which?", options: [{ label: "Alpha" }] }],
  } as unknown as AnyRequest;
  const client = {
    pendingInteractions: async () => [req],
    answerAskQuestions: async () => {
      throw new ApiError(400, { error: "Cursor cannot accept a custom answer — pick an option" }, "Cursor cannot accept a custom answer — pick an option");
    },
  } as unknown as AgetorClient;
  const { stdin, lastFrame } = render(
    <AnswerOverlay client={client} taskId="t1" onDone={(m) => { done = m; }} onCancel={() => {}} />,
  );
  await wait();
  stdin.write(ENTER); // Alpha
  await wait();
  expect(done).toBe("");
  expect(lastFrame() ?? "").toContain("Cursor cannot accept a custom answer");
  expect(lastFrame() ?? "").toContain("Which?");
});

// ── OpenCode cards (docs/plans/opencode-server-driver.md T10) ─────────────

const ocPermission = {
  kind: "fx_permission", id: "oc-p", taskId: "t1", runId: "r1", createdAt: 0,
  toolCall: { toolCallId: "tc", title: "bash", kind: "execute" },
  options: [
    { optionId: "once", name: "Allow once" },
    { optionId: "always", name: "Always allow" },
    { optionId: "reject", name: "Reject" },
  ],
  mode: "ask", harness: "opencode", allowReason: true,
} as unknown as AnyRequest;

test("opencode permission: shows its own three options and no Dismiss row", async () => {
  const { lastFrame, unmount } = render(
    <AnswerOverlay client={fakeClient(ocPermission, () => {})} taskId="t1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Allow once");
  expect(frame).toContain("Reject");
  expect(frame).not.toContain("Dismiss");
  unmount();
});

test("opencode permission: Allow once posts { optionId: once } with no message", async () => {
  let captured: unknown = null;
  let done = "";
  const { stdin, unmount } = render(
    <AnswerOverlay client={fakeClient(ocPermission, (a) => { captured = a; })} taskId="t1" onDone={(m) => { done = m; }} onCancel={() => {}} />,
  );
  await wait();
  stdin.write(ENTER);
  await wait();
  expect(captured).toEqual({ id: "oc-p", body: { optionId: "once" } });
  expect(done).toBe("✓ answered");
  unmount();
});

test("opencode permission: Reject asks for a reason and sends it with reject", async () => {
  let captured: unknown = null;
  let done = "";
  const ui = render(
    <AnswerOverlay client={fakeClient(ocPermission, (a) => { captured = a; })} taskId="t1" onDone={(m) => { done = m; }} onCancel={() => {}} />,
  );
  await wait();
  ui.stdin.write(DOWN);
  await wait();
  ui.stdin.write(DOWN);
  await wait();
  ui.stdin.write(ENTER);
  await wait();
  expect(ui.lastFrame() ?? "").toContain("skips this action and the agent continues");
  expect(ui.lastFrame() ?? "").not.toContain("stops");
  expect(captured).toBeNull();
  ui.stdin.write("use dry-run");
  await wait();
  ui.stdin.write(ENTER);
  await wait();
  expect(captured).toEqual({ id: "oc-p", body: { optionId: "reject", message: "use dry-run" } });
  expect(done).toBe("✓ rejected with a reason");
  ui.unmount();
});

test("opencode permission: Reject with nothing typed sends a bare reject and says the agent continues", async () => {
  let captured: unknown = null;
  let done = "";
  const ui = render(
    <AnswerOverlay client={fakeClient(ocPermission, (a) => { captured = a; })} taskId="t1" onDone={(m) => { done = m; }} onCancel={() => {}} />,
  );
  await wait();
  ui.stdin.write(DOWN);
  await wait();
  ui.stdin.write(DOWN);
  await wait();
  ui.stdin.write(ENTER);
  await wait();
  ui.stdin.write(ENTER);
  await wait();
  expect(captured).toEqual({ id: "oc-p", body: { optionId: "reject" } });
  expect(done).toBe("✓ rejected — the agent continues without it");
  ui.unmount();
});

test("opencode permission: Esc at the reason prompt goes back to the list without answering", async () => {
  let captured: unknown = null;
  const ui = render(
    <AnswerOverlay client={fakeClient(ocPermission, (a) => { captured = a; })} taskId="t1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  ui.stdin.write(DOWN);
  await wait();
  ui.stdin.write(DOWN);
  await wait();
  ui.stdin.write(ENTER);
  await wait();
  ui.stdin.write(ESC);
  await wait(80);
  expect(captured).toBeNull();
  expect(ui.lastFrame() ?? "").toContain("Always allow");
  ui.unmount();
});

const ocQuestion = (over: Record<string, unknown> = {}) =>
  ({
    kind: "ask_questions", id: "oc-q", taskId: "t1", runId: "r1", createdAt: 0,
    source: "opencode", delivery: "live", allowReason: true, allowCustom: true,
    questions: [{
      id: "scope", question: "Which scope?", allowCustom: true,
      options: [{ id: "narrow", label: "Same" }, { id: "wide", label: "Same" }],
    }],
    ...over,
  }) as unknown as AnyRequest;

test("opencode question: two options with one label submit the second one's id", async () => {
  let captured: unknown = null;
  const ui = render(
    <AnswerOverlay client={fakeClient(ocQuestion(), (a) => { captured = a; })} taskId="t1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  ui.stdin.write(DOWN);
  await wait();
  ui.stdin.write(ENTER);
  await wait();
  expect(captured).toEqual({ id: "oc-q", answers: [{ selected: ["Same"], selectedOptionIds: ["wide"] }] });
  ui.unmount();
});

// A model-chosen option id can equal the picker's own sentinel strings.
const ocCollidingQuestion = (over: Record<string, unknown> = {}) =>
  ocQuestion({
    questions: [{
      id: "scope", question: "Which scope?", allowCustom: true, multiSelect: false,
      options: [{ id: "__agetor_custom__", label: "First" }, { label: "__opencode_skip__" }, { id: "__opencode_skip__", label: "Third" }],
      ...over,
    }],
  });

test("opencode question: an option whose id is the Other sentinel submits as that option (by position)", async () => {
  let captured: unknown = null;
  const ui = render(
    <AnswerOverlay client={fakeClient(ocCollidingQuestion(), (a) => { captured = a; })} taskId="t1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  ui.stdin.write(ENTER); // the first row, id "__agetor_custom__"
  await wait();
  expect(captured).toEqual({ id: "oc-q", answers: [{ selected: ["First"], selectedOptionIds: ["__agetor_custom__"] }] });
  ui.unmount();
});

test("opencode question: options named like the Skip sentinel are answers, not a skip", async () => {
  let captured: unknown = null;
  const ui = render(
    <AnswerOverlay client={fakeClient(ocCollidingQuestion(), (a) => { captured = a; })} taskId="t1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  ui.stdin.write(DOWN);
  await wait();
  ui.stdin.write(DOWN);
  await wait();
  ui.stdin.write(ENTER); // the third row, id "__opencode_skip__"
  await wait();
  expect(captured).toEqual({ id: "oc-q", answers: [{ selected: ["Third"], selectedOptionIds: ["__opencode_skip__"] }] });
  ui.unmount();
});

test("opencode question: multi-select with a sentinel-valued option keeps it and adds typed text", async () => {
  let captured: unknown = null;
  const ui = render(
    <AnswerOverlay client={fakeClient(ocCollidingQuestion({ multiSelect: true }), (a) => { captured = a; })} taskId="t1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  ui.stdin.write(" "); // toggle row 0 ("__agetor_custom__")
  await wait();
  ui.stdin.write(DOWN);
  await wait();
  ui.stdin.write(DOWN);
  await wait();
  ui.stdin.write(DOWN); // the Other row
  await wait();
  ui.stdin.write(" ");
  await wait();
  ui.stdin.write(ENTER);
  await wait();
  ui.stdin.write("extra");
  await wait();
  ui.stdin.write(ENTER);
  await wait();
  expect(captured).toEqual({ id: "oc-q", answers: [{ selected: ["First"], selectedOptionIds: ["__agetor_custom__"], custom: "extra" }] });
  ui.unmount();
});

test("opencode question: Other takes typed text where allowCustom, and is absent where it is not", async () => {
  let captured: unknown = null;
  const ui = render(
    <AnswerOverlay client={fakeClient(ocQuestion(), (a) => { captured = a; })} taskId="t1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  expect(ui.lastFrame() ?? "").toContain("Other");
  ui.stdin.write(DOWN);
  await wait();
  ui.stdin.write(DOWN);
  await wait();
  ui.stdin.write(ENTER); // the Other row
  await wait();
  ui.stdin.write("something else");
  await wait();
  ui.stdin.write(ENTER);
  await wait();
  expect(captured).toEqual({ id: "oc-q", answers: [{ selected: [], custom: "something else" }] });
  ui.unmount();

  const base = ocQuestion() as unknown as { questions: Array<Record<string, unknown>> };
  const noText = render(
    <AnswerOverlay
      client={fakeClient(ocQuestion({ allowCustom: false, questions: [{ ...base.questions[0], allowCustom: false }] }), () => {})}
      taskId="t1" onDone={() => {}} onCancel={() => {}}
    />,
  );
  await wait();
  const frame = noText.lastFrame() ?? "";
  expect(frame).not.toContain("Other");
  expect(frame).toContain("Skip");
  noText.unmount();
});

test("opencode question: Skip asks for a reason and sends { skip, message }; none sends a bare skip", async () => {
  let captured: unknown = null;
  let done = "";
  const ui = render(
    <AnswerOverlay client={fakeClient(ocQuestion(), (a) => { captured = a; })} taskId="t1" onDone={(m) => { done = m; }} onCancel={() => {}} />,
  );
  await wait();
  // rows: Same, Same, Other, Skip
  for (let i = 0; i < 3; i++) {
    ui.stdin.write(DOWN);
    await wait();
  }
  ui.stdin.write(ENTER);
  await wait();
  expect(ui.lastFrame() ?? "").toContain("Reason for skipping");
  ui.stdin.write("not needed");
  await wait();
  ui.stdin.write(ENTER);
  await wait();
  expect(captured).toEqual({ id: "oc-q", answers: { skip: true, message: "not needed" } });
  expect(done).toBe("✓ skipped");
  ui.unmount();

  captured = null;
  const bare = render(
    <AnswerOverlay client={fakeClient(ocQuestion(), (a) => { captured = a; })} taskId="t1" onDone={() => {}} onCancel={() => {}} />,
  );
  await wait();
  for (let i = 0; i < 3; i++) {
    bare.stdin.write(DOWN);
    await wait();
  }
  bare.stdin.write(ENTER);
  await wait();
  bare.stdin.write(ENTER);
  await wait();
  expect(captured).toEqual({ id: "oc-q", answers: { skip: true } });
  bare.unmount();
});

test("opencode question: card text with control characters is shown escaped", async () => {
  const base = ocQuestion() as unknown as { questions: Array<Record<string, unknown>> };
  const ui = render(
    <AnswerOverlay
      client={fakeClient(ocQuestion({ questions: [{ ...base.questions[0], question: "Which\u001b[2J scope?" }] }), () => {})}
      taskId="t1" onDone={() => {}} onCancel={() => {}}
    />,
  );
  await wait();
  const frame = ui.lastFrame() ?? "";
  expect(frame).not.toContain("\u001b[2J");
  expect(frame).toContain("\\u001b");
  ui.unmount();
});

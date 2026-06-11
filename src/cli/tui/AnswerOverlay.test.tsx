import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { AnswerOverlay } from "./AnswerOverlay.tsx";
import type { AgetorClient } from "../api-client.ts";
import type { AnyRequest } from "../../bun/interactions.ts";

const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const ENTER = "\r";
const SPACE = " ";
const DOWN = String.fromCharCode(27) + "[B"; // ESC [ B

function fakeClient(req: AnyRequest, capture: (a: unknown) => void): AgetorClient {
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

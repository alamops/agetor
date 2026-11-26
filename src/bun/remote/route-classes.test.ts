import { describe, expect, test } from "bun:test";
import type { RemotePolicy } from "../route-policy.ts";
import { classifyRoute, type ClassifyLookups } from "./route-classes.ts";

const POLICY = (over: Partial<RemotePolicy> = {}): RemotePolicy => ({ level: "respond", stepUp: "signed", rate: "normal", since: 1, ...over });

const PLAN_MODAL = "Would you like to proceed?\n 1. Yes, and use auto mode\n 2. Yes, manually approve edits\n 3. Tell Claude what to change";

const lookups = (over: Partial<ClassifyLookups> = {}): ClassifyLookups => ({
  tmuxPrompt: async (id) => {
    const cards: Record<string, { taskId: string; paneText: string; choices: Array<{ key: string; label: string }>; answerKind: string | null }> = {
      bash: { taskId: "t1", paneText: "Allow this command?", choices: [{ key: "1", label: "Yes" }, { key: "2", label: "Yes, and don't ask again for ls commands" }, { key: "3", label: "No, and tell Claude what to do differently" }, { key: "4", label: "Maybe" }], answerKind: null },
      plan: { taskId: "t1", paneText: PLAN_MODAL, choices: [{ key: "1", label: "Yes, and use auto mode" }, { key: "2", label: "Yes, manually approve edits" }, { key: "3", label: "Tell Claude what to change" }], answerKind: null },
      enter: { taskId: "t1", paneText: "Press Enter to continue", choices: [], answerKind: "enter" },
      code: { taskId: "t1", paneText: "Paste code here", choices: [], answerKind: "code" },
    };
    return cards[id] ?? null;
  },
  fxPermission: async (id) =>
    id === "fx1"
      ? { taskId: "t1", harness: "fx", options: [{ optionId: "a", kind: "allow_once" }, { optionId: "b", kind: "allow_always" }, { optionId: "c", kind: "reject_once" }, { optionId: "d", kind: "reject_always" }] }
      : id === "oc1"
        ? { taskId: "t1", harness: "opencode", options: [{ optionId: "once", kind: "allow_once" }, { optionId: "always", kind: "allow_always" }, { optionId: "reject", kind: "reject_once" }] }
        : null,
  runTask: async (id) => (id === "r1" ? "t1" : null),
  askQuestionTask: async (id) => (id === "q" ? "t1" : null),
  previewInScope: async (_t, path) => path.startsWith("/work/"),
  ...over,
});

const call = (method: string, route: string, params: Record<string, string>, body: unknown = null, query = "", policy = POLICY()) =>
  classifyRoute({ method, route, params, query: new URLSearchParams(query), body }, policy, lookups());

describe("reads and the preview scope (D15)", () => {
  test("a preview inside the task's folders stays at observe; outside it needs operate", async () => {
    const p = POLICY({ level: "observe", stepUp: "none", rate: "heavy" });
    expect((await call("GET", "/tasks/:id/files/preview", { id: "t1" }, null, "path=%2Fwork%2Fa.png", p)).level).toBe("observe");
    const out = await call("GET", "/tasks/:id/files/preview", { id: "t1" }, null, "path=%2Fetc%2Fhosts", p);
    expect(out).toMatchObject({ class: "read", level: "operate", stepUp: "none" });
    expect((await call("GET", "/tasks/:id/files/preview", { id: "t1" }, null, "", p)).level).toBe("operate");
  });

  test("a plain GET is a read at the route's level", async () => {
    expect(await call("GET", "/tasks/:id", { id: "t1" }, null, "", POLICY({ level: "observe", stepUp: "none" }))).toMatchObject({ class: "read", level: "observe", stepUp: "none" });
  });
});

describe("removals never need more than the session", () => {
  test("cancels and seen", async () => {
    for (const [m, r, params] of [["POST", "/runs/:id/cancel", { id: "r1" }], ["POST", "/tasks/:id/pipeline/cancel", { id: "t1" }], ["POST", "/tasks/:id/seen", { id: "t1" }], ["DELETE", "/tasks/:id/seen", { id: "t1" }], ["DELETE", "/tasks/:id/backlog/:itemId", { id: "t1", itemId: "i" }]] as const) {
      expect(await call(m, r, params, null, "", POLICY({ stepUp: "none", rate: "stop" })), `${m} ${r}`).toMatchObject({ class: "remove", stepUp: "none" });
    }
  });
  test("a cancel of a run names its task", async () => {
    expect((await call("POST", "/runs/:id/cancel", { id: "r1" })).taskId).toBe("t1");
  });
});

describe("content", () => {
  test("a follow-up, a backlog write and a plain answer are content behind the unlock window", async () => {
    expect(await call("POST", "/runs/:id/input", { id: "r1" }, { text: "go" }, "", POLICY({ stepUp: "unlock" }))).toMatchObject({ class: "content", stepUp: "unlock", taskId: "t1" });
    expect(await call("POST", "/tasks/:id/backlog", { id: "t1" }, {}, "", POLICY({ stepUp: "unlock" }))).toMatchObject({ class: "content", stepUp: "unlock" });
    expect(await call("POST", "/ask-questions/:id/answer", { id: "q" }, { answers: [] }, "", POLICY({ stepUp: "unlock" }))).toMatchObject({ class: "content", stepUp: "unlock" });
  });
  test("a follow-up into a run that is gone is refused as gone", async () => {
    expect(await call("POST", "/runs/:id/input", { id: "nope" }, {}, "", POLICY({ stepUp: "unlock" }))).toMatchObject({ class: "never", reason: "gone" });
  });
  test("D10: a Skip with a message is content, a bare Skip removes", async () => {
    const p = POLICY({ stepUp: "unlock" });
    expect(await call("POST", "/ask-questions/:id/answer", { id: "q" }, { skip: true, message: "do X instead" }, "", p)).toMatchObject({ class: "content", stepUp: "unlock" });
    expect(await call("POST", "/ask-questions/:id/answer", { id: "q" }, { skip: true }, "", p)).toMatchObject({ class: "remove", stepUp: "none" });
    expect(await call("POST", "/ask-questions/:id/answer", { id: "q" }, { skip: true, message: "   " }, "", p)).toMatchObject({ class: "remove" });
  });
  test("a plan edit is signed over the edited body AND needs the unlock window; dropping the edit removes", async () => {
    const c = await call("PATCH", "/tasks/:id/plans/:planId", { id: "t1", planId: "p1" }, { editedContent: "new text" });
    expect(c).toMatchObject({ class: "content", stepUp: "signed", alsoUnlock: true, target: { kind: "plan-edit", taskId: "t1", planId: "p1", body: "new text" } });
    expect(await call("PATCH", "/tasks/:id/plans/:planId", { id: "t1", planId: "p1" }, { editedContent: null })).toMatchObject({ class: "remove", stepUp: "none" });
    expect(await call("PATCH", "/tasks/:id/plans/:planId", { id: "t1", planId: "p1" }, {})).toMatchObject({ class: "never" });
  });
});

describe("tmux cards (D8, D9)", () => {
  const answer = (id: string, body: unknown) => call("POST", "/tmux-prompts/:id/answer", { id }, body);

  test("an exact 'Yes' is consent over the card; 'No' removes", async () => {
    expect(await answer("bash", { key: "1" })).toMatchObject({ class: "consent", stepUp: "signed", target: { kind: "tmux-card", taskId: "t1", promptId: "bash" } });
    expect(await answer("bash", { key: "3" })).toMatchObject({ class: "remove", stepUp: "none" });
    expect(await answer("bash", { reject: true })).toMatchObject({ class: "remove" });
  });
  test("an always-allow row and an unknown row are never", async () => {
    expect(await answer("bash", { key: "2" })).toMatchObject({ class: "never", reason: "answer this on your Mac" });
    expect(await answer("bash", { key: "4" })).toMatchObject({ class: "never" });
    expect(await answer("bash", { key: "9" })).toMatchObject({ class: "never" });
  });
  test("the OAuth code card is never, and an Enter-only card is consent", async () => {
    expect(await answer("code", { code: "abc" })).toMatchObject({ class: "never" });
    expect(await answer("enter", { enter: true })).toMatchObject({ class: "consent", stepUp: "signed" });
    expect(await answer("bash", { enter: true })).toMatchObject({ class: "never" });
  });
  test("more than one answer field, or none, is refused", async () => {
    expect((await answer("bash", { key: "1", reject: true })).class).toBe("never");
    expect((await answer("bash", {})).class).toBe("never");
  });
  test("a card that is gone is gone", async () => {
    expect(await answer("missing", { key: "1" })).toMatchObject({ class: "never", reason: "gone" });
  });
  test("Claude's plan modal: row 1 is operate + signed over the plan + unlock; row 2 is consent; row 3 is content", async () => {
    expect(await answer("plan", { key: "1" })).toMatchObject({ class: "consent", level: "operate", stepUp: "signed", alsoUnlock: "always", target: { kind: "claude-plan", row: "auto" } });
    expect(await answer("plan", { key: "2" })).toMatchObject({ class: "consent", level: "respond", stepUp: "signed", target: { kind: "claude-plan", row: "manual" } });
    expect(await answer("plan", { key: "3" })).toMatchObject({ class: "content", stepUp: "unlock" });
  });
});

describe("fx and OpenCode permission cards (D10)", () => {
  const answer = (id: string, body: unknown) => call("POST", "/fx-permissions/:id/answer", { id }, body);
  test("allow once is consent; allow always is never", async () => {
    expect(await answer("fx1", { optionId: "a" })).toMatchObject({ class: "consent", stepUp: "signed", target: { kind: "fx-permission", permissionId: "fx1" } });
    expect(await answer("fx1", { optionId: "b" })).toMatchObject({ class: "never" });
    expect(await answer("fx1", { optionId: "d" })).toMatchObject({ class: "never" });
    expect(await answer("oc1", { optionId: "once" })).toMatchObject({ class: "consent" });
    expect(await answer("oc1", { optionId: "always" })).toMatchObject({ class: "never" });
  });
  test("a bare reject removes; a reject with words is content; a reason on an allow is refused; cancel is never", async () => {
    expect(await answer("fx1", { optionId: "c" })).toMatchObject({ class: "remove", stepUp: "none" });
    expect(await answer("oc1", { optionId: "reject", message: "use the other API" })).toMatchObject({ class: "content", stepUp: "unlock" });
    expect(await answer("oc1", { optionId: "once", message: "ok" })).toMatchObject({ class: "never" });
    expect(await answer("fx1", { cancel: true })).toMatchObject({ class: "never" });
    expect(await answer("fx1", { optionId: "zzz" })).toMatchObject({ class: "never" });
  });
});

describe("consent routes", () => {
  test("a plan approval, an fx resume and a switch of account", async () => {
    expect(await call("POST", "/tasks/:id/plans/:planId/approve", { id: "t1", planId: "p1" })).toMatchObject({ class: "consent", stepUp: "signed", target: { kind: "plan", planId: "p1" } });
    expect(await call("POST", "/tasks/:id/fx-resume", { id: "t1" })).toMatchObject({ class: "consent", target: { kind: "fx-resume", taskId: "t1" } });
    expect(await call("POST", "/tasks/:id/switch-account", { id: "t1" }, {}, "", POLICY({ level: "operate", stepUp: "none" }))).toMatchObject({ class: "action", level: "operate", stepUp: "none" });
  });
  test("a gate review binds the decision and comment, and refuses a next-step subset or a resume mode", async () => {
    const body = { stepId: "g", seq: 2, decision: "return", comment: "redo the tests" };
    expect(await call("POST", "/tasks/:id/pipeline/review", { id: "t1" }, body)).toMatchObject({
      class: "consent", stepUp: "signed", target: { kind: "gate", taskId: "t1", stepId: "g", seq: 2 }, bound: { decision: "return", comment: "redo the tests" },
    });
    expect((await call("POST", "/tasks/:id/pipeline/review", { id: "t1" }, { ...body, nextStepIds: ["s2"] })).class).toBe("never");
    expect((await call("POST", "/tasks/:id/pipeline/review", { id: "t1" }, { ...body, mode: "resume" })).class).toBe("never");
    expect((await call("POST", "/tasks/:id/pipeline/review", { id: "t1" }, { ...body, decision: "maybe" })).class).toBe("never");
    expect((await call("POST", "/tasks/:id/pipeline/review", { id: "t1" }, { stepId: "g", seq: 1.5, decision: "accept" })).class).toBe("never");
  });
});

describe("fail closed", () => {
  test("a write route with no class rule is never; the base level is never lowered", async () => {
    expect(await call("POST", "/brand/new", { id: "x" })).toMatchObject({ class: "never", reason: "no class rule for this route" });
    expect((await call("POST", "/tasks/:id/switch-account", { id: "t1" }, {}, "", POLICY({ level: "configure", stepUp: "none" }))).level).toBe("configure");
  });
});

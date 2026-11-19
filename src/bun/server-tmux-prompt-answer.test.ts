import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";
import { makeScriptedClaudeTmux, type ScriptedConfig, type ScriptedSession } from "./test-scripted-claude-tmux.ts";

/* ────────────────────────────────────────────────────────────────────────── *
 * TT5 — docs/plans/claude-enter-to-confirm-prompts.md T10. `POST
 * /tmux-prompts/:id/answer` through the real `Bun.serve`, with the master and
 * the CLI token: a closed allow-list (exactly one of key / reject / enter /
 * code, each only on its own card kind), a fixed sentence per refusal that
 * never echoes the submitted value, and a status per drive result. `ROUTE_POLICY`
 * is unchanged (route-policy.test.ts stays green).
 * ────────────────────────────────────────────────────────────────────────── */

const testDataDir = mkdtempSync(path.join(tmpdir(), "agetor-tmux-answer-route-"));
process.env.AGETOR_DATA_DIR = testDataDir;
process.env.AGETOR_API_PORT = "4452";

const { startApiServer } = await import("./server.ts");
const { API_TOKEN, CLI_TOKEN } = await import("./api-config.ts");
const { __forTest, sessionNameFor } = await import("./claude-tmux.ts");
const { registerTmuxPrompt, findTmuxPromptById } = await import("./interactions.ts");

const server = startApiServer() as unknown as { stop: () => void };
const scripted = makeScriptedClaudeTmux();
const savedTmuxBin = process.env.AGETOR_TMUX_BIN;
process.env.AGETOR_TMUX_BIN = scripted.bin;
const cleanups: Array<() => void> = [];
afterAll(() => {
  server.stop();
  if (savedTmuxBin === undefined) delete process.env.AGETOR_TMUX_BIN;
  else process.env.AGETOR_TMUX_BIN = savedTmuxBin;
  scripted.cleanup();
  rmTestDataDir(testDataDir);
});
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const REPO_E = { kind: "add-dir" as const, repo: "repo-e", path: "/Users/me/.agetor/worktrees/4c34cf8f/repo-e" };

function post(id: string, body: unknown, token = API_TOKEN): Promise<Response> {
  return fetch(`http://127.0.0.1:4452/tmux-prompts/${id}/answer`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function card(cfg: ScriptedConfig, over: { withSession?: boolean } = {}) {
  const taskId = randomUUID();
  let session: ScriptedSession | null = null;
  if (over.withSession !== false) {
    const state = __forTest.installSession(taskId, path.join(testDataDir, `${taskId}.jsonl`));
    // The route checks `has-session` under the production name; keep both in step.
    state.sessionName = sessionNameFor(taskId);
    cleanups.push(() => __forTest.uninstallSession(taskId));
    session = scripted.add(state.sessionName, cfg);
    session.patch({ started: true, mountedAt: Date.now() - 5_000 });
    const lines = Bun.spawnSync([scripted.bin, "capture-pane", "-p", "-t", state.sessionName]).stdout.toString().trim().split("\n");
    const match = __forTest.pickScrapeMatch(lines.join("\n"), { paneWorking: false, paneIdle: false, watchdogArmed: false, boot: true })!;
    const reg = registerTmuxPrompt({
      taskId, runId: "run-route", paneText: match.paneText, choices: match.choices, cursorIndex: match.cursorIndex,
      nav: match.nav, fingerprint: match.fingerprint, hideKeys: match.hideKeys, answerKind: match.answerKind,
      confirmKey: match.confirmKey, identity: __forTest.identityOf(match),
    });
    return { taskId, session: session!, req: reg.req, answer: reg.answer };
  }
  const reg = registerTmuxPrompt({
    taskId, runId: "run-route", paneText: "Login successful. Press Enter to continue…", choices: [], fingerprint: "fp-nosession", answerKind: "enter",
  });
  return { taskId, session: null as unknown as ScriptedSession, req: reg.req, answer: reg.answer };
}

describe("body validation: a closed allow-list", () => {
  test("an empty body, or more than one member, is a 400", async () => {
    const c = card({ dialogs: [{ kind: "enter-only" }] });
    for (const body of [{}, "not json", { key: "1", enter: true }, { enter: true, code: "abc" }, { reject: true, key: "1" }]) {
      const res = await post(c.req.id, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("exactly one of key, reject, enter or code");
    }
    expect(c.session.keys()).toEqual([]);
    expect(findTmuxPromptById(c.req.id)).not.toBeNull();
  });

  test("enter is only for an enter card; code only for a code card; a key only for a choice card", async () => {
    const choice = card({ dialogs: [REPO_E] });
    expect((await post(choice.req.id, { enter: true })).status).toBe(400);
    expect((await post(choice.req.id, { code: "abc" })).status).toBe(400);
    const enter = card({ dialogs: [{ kind: "enter-only" }] });
    expect((await post(enter.req.id, { code: "abc" })).status).toBe(400);
    expect((await post(enter.req.id, { key: "1" })).status).toBe(400);
    expect((await post(enter.req.id, { enter: false })).status).toBe(400);
    const code = card({ dialogs: [{ kind: "paste-code" }] });
    expect((await post(code.req.id, { enter: true })).status).toBe(400);
    expect((await post(code.req.id, { key: "1" })).status).toBe(400);
    for (const c of [choice, enter, code]) expect(c.session.keys()).toEqual([]);
  });

  test("an unknown key is refused (no keystroke injection)", async () => {
    const c = card({ dialogs: [REPO_E] });
    const res = await post(c.req.id, { key: "9" });
    expect(res.status).toBe(400);
    expect(c.session.keys()).toEqual([]);
  });

  test("a code that fails validation gets a fixed sentence and the value is never echoed", async () => {
    const c = card({ dialogs: [{ kind: "paste-code" }] });
    const secret = "super-secret-value";
    const cases: Array<[unknown, string]> = [
      ["", "Paste the code first."],
      [`${secret}\nsecond line`, "The code must be a single line."],
      [`${secret}\u001b[31m`, "The code can't contain control characters."],
      ["x".repeat(513), "The code is longer than 512 characters."],
      [42, "The code must be text."],
    ];
    for (const [value, sentence] of cases) {
      const res = await post(c.req.id, { code: value });
      const text = await res.text();
      expect(res.status).toBe(400);
      expect(JSON.parse(text).error).toBe(sentence);
      expect(text).not.toContain(secret);
    }
    expect(c.session.keys()).toEqual([]);
  });
});

describe("drive results and tokens", () => {
  test("an Enter-only card: the master token types one Enter and the card resolves with the __enter__ sentinel", async () => {
    const c = card({ dialogs: [{ kind: "enter-only" }] });
    const res = await post(c.req.id, { enter: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(c.session.keys().map((k) => k.k)).toEqual(["Enter"]);
    expect(await c.answer).toEqual({ key: "__enter__" });
    expect(findTmuxPromptById(c.req.id)).toBeNull();
  });

  test("the CLI token is accepted for every shape", async () => {
    const enter = card({ dialogs: [{ kind: "enter-only" }] });
    expect((await post(enter.req.id, { enter: true }, CLI_TOKEN)).status).toBe(200);
    const choice = card({ dialogs: [REPO_E] });
    expect((await post(choice.req.id, { key: "2" }, CLI_TOKEN)).status).toBe(200);
    const code = card({ dialogs: [{ kind: "paste-code" }] });
    expect((await post(code.req.id, { code: "cli-typed-code" }, CLI_TOKEN)).status).toBe(200);
  });

  test("the OAuth code: typed with send-keys -l then Enter, the promise carries only __code__, and no response or card holds it", async () => {
    const c = card({ dialogs: [{ kind: "paste-code" }], echoTyped: true });
    const code = "test-code-123";
    const res = await post(c.req.id, { code });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: true });
    expect(text).not.toContain(code);
    expect(c.session.keys().map((k) => ({ k: k.k, literal: k.literal }))).toEqual([
      { k: code, literal: true },
      { k: "Enter", literal: false },
    ]);
    expect(c.session.state().submitted).toBe(code);
    const answered = await c.answer;
    expect(answered).toEqual({ key: "__code__" });
    expect(JSON.stringify(answered)).not.toContain(code);
    expect(JSON.stringify(c.req)).not.toContain(code);
  });

  test("the prompt changed on screen → 409, nothing typed, the card stays", async () => {
    const c = card({ dialogs: [{ kind: "enter-only" }, REPO_E] });
    c.session.patch({ i: 1 });
    const res = await post(c.req.id, { enter: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "the prompt changed on screen — the card will refresh" });
    expect(c.session.keys()).toEqual([]);
    expect(findTmuxPromptById(c.req.id)).not.toBeNull();
  });

  test("a session that is gone → 410 with the existing text", async () => {
    const c = card({ dialogs: [] }, { withSession: false });
    const res = await post(c.req.id, { enter: true });
    expect(res.status).toBe(410);
    expect((await res.json()).error).toBe("tmux session is gone — cancel the run and start a new one");
  });

  test("an unknown or already-resolved card answers { ok: false } (200), as before", async () => {
    const res = await post("no-such-card", { key: "1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });
  });

  test("a card swept while the add-dir drive verifies the dialog left still answers ok (the keys were delivered)", async () => {
    const { answerTmuxPrompt } = await import("./interactions.ts");
    const c = card({ dialogs: [REPO_E] });
    // The boot poller / scraper settles a card whose dialog is gone: land that
    // inside the drive's post-confirm verify window.
    const sweep = setTimeout(() => { answerTmuxPrompt(c.req.id, { key: "__external__" }); }, 450);
    cleanups.push(() => clearTimeout(sweep));
    const res = await post(c.req.id, { key: "2" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(c.session.keys().map((k) => k.k)).toEqual(["Down", "Enter"]);
  }, 20_000);

  test("two repositories, auto-trust off: answering the first card leaves the second to be carded, and each answer is ok", async () => {
    const REPO_F = { kind: "add-dir" as const, repo: "repo-f", path: "/Users/me/.agetor/worktrees/4c34cf8f/repo-f" };
    const c = card({ dialogs: [REPO_E, REPO_F] });
    const first = await post(c.req.id, { key: "2" });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect(c.session.state().i).toBe(1); // the second dialog is now on screen
    // The second card is registered from the live pane and answered the same way.
    const lines = Bun.spawnSync([scripted.bin, "capture-pane", "-p", "-t", sessionNameFor(c.taskId)]).stdout.toString();
    const match = __forTest.pickScrapeMatch(lines, { paneWorking: false, paneIdle: false, watchdogArmed: false, boot: true })!;
    const reg = registerTmuxPrompt({
      taskId: c.taskId, runId: "run-route", paneText: match.paneText, choices: match.choices, cursorIndex: match.cursorIndex,
      nav: match.nav, fingerprint: match.fingerprint, hideKeys: match.hideKeys, identity: __forTest.identityOf(match),
    });
    await new Promise((r) => setTimeout(r, 600)); // the new dialog's 500 ms arm window
    const second = await post(reg.req.id, { key: "2" });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true });
    expect(c.session.state().done).toBe(true);
  }, 30_000);

  // The production drive's two non-add-dir branches (the registered-cursor
  // `dismissTmuxPrompt` seam no longer covers what the route really runs).
  test("a y/N prompt: the literal key, then Enter, and nothing else", async () => {
    const c = card({ dialogs: [{ kind: "raw", text: " Overwrite the existing file? (y/N)\n" }] });
    expect(c.req.choices.map((x) => x.key)).toEqual(["y", "n"]);
    const res = await post(c.req.id, { key: "n" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(c.session.keys().map((k) => k.k)).toEqual(["n", "Enter"]);
    expect(findTmuxPromptById(c.req.id)).toBeNull();
  });

  test("the bare /model picker: arrows from the LIVE cursor, then `s` (session only) in place of Enter", async () => {
    const picker = [
      "   Select model",
      "   Switch between Claude models. Your pick becomes the default for new sessions.",
      "",
      "     1. Default (recommended)  Opus 5 with 1M context",
      "     2. Opus (1M context)      Opus 5 with 1M context",
      "     3. Fable                  Fable 5",
      "     4. Sonnet                 Sonnet 5",
      "     5. Haiku                  Haiku 4.5",
      "   ❯ 6. Opus 4.8 ✔             Newer version available",
      "",
      "   Enter to set as default · s to use this session only · Esc to cancel",
      "",
    ].join("\n");
    const c = card({ dialogs: [{ kind: "raw", text: picker }] });
    expect(c.req.confirmKey).toBe("s");
    const res = await post(c.req.id, { key: "4" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Cursor on row 6, target row 4: two Ups, then the session-only key. A plain
    // Enter here would rewrite the user's global default model.
    expect(c.session.keys().map((k) => k.k)).toEqual(["Up", "Up", "s"]);
  });

  test("a refused confirm re-cards: the response is ok + held, and a held card replaces the old one", async () => {
    const c = card({ dialogs: [REPO_E], refuseEnters: 1 });
    const res = await post(c.req.id, { key: "2" });
    expect(res.status).toBe(200);
    // `held` lets the CLI and TUI say claude is still waiting instead of "answered".
    expect(await res.json()).toEqual({ ok: true, held: true });
    expect(findTmuxPromptById(c.req.id)).toBeNull();
    const { activeTmuxPromptsForTask } = await import("./interactions.ts");
    const [held] = activeTmuxPromptsForTask(c.taskId);
    expect(held!.held).toBe(true);
  }, 20_000);
});

describe("reject, and one answer at a time", () => {
  test("{reject:true} sends one Escape and resolves the card, on a choice card and on an Enter-only card", async () => {
    for (const cfg of [{ dialogs: [REPO_E] }, { dialogs: [{ kind: "enter-only" as const }] }]) {
      const c = card(cfg);
      const res = await post(c.req.id, { reject: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(c.session.keys().map((k) => k.k)).toEqual(["Escape"]);
      expect(findTmuxPromptById(c.req.id)).toBeNull();
    }
  });

  test("reject must be exactly true: anything else is a 400 and nothing is typed", async () => {
    const c = card({ dialogs: [REPO_E] });
    for (const reject of [false, "x", 1]) {
      const res = await post(c.req.id, { reject });
      expect(res.status).toBe(400);
    }
    expect(c.session.keys()).toEqual([]);
    expect(findTmuxPromptById(c.req.id)).not.toBeNull();
  });

  test("{reject:true} with the session gone → 410 and the card stays", async () => {
    const c = card({ dialogs: [{ kind: "enter-only" }] }, { withSession: false });
    const res = await post(c.req.id, { reject: true });
    expect(res.status).toBe(410);
    expect(findTmuxPromptById(c.req.id)).not.toBeNull();
  });

  test("a second answer to the same card while the first is in flight is refused (409) and types nothing", async () => {
    const c = card({ dialogs: [{ kind: "enter-only" }] });
    const [a, b] = await Promise.all([post(c.req.id, { enter: true }), post(c.req.id, { enter: true })]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const refused = a.status === 409 ? a : b;
    expect((await refused.json()).error).toBe("this prompt is already being answered");
    expect(c.session.keys().map((k) => k.k)).toEqual(["Enter"]);
  });
});

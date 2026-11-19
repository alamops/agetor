import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";
import { makeScriptedClaudeTmux, type ScriptedConfig, type ScriptedSession } from "./test-scripted-claude-tmux.ts";

/* ────────────────────────────────────────────────────────────────────────── *
 * TT4 — docs/plans/claude-enter-to-confirm-prompts.md. `answerTmuxPromptInPane`
 * is the only path the answer route uses to type into a card's pane. Every key
 * is computed from a LIVE read of the same dialog, so a cursor that moved since
 * registration, a dialog that changed, or an unreadable cursor can never send
 * the wrong key (the two-row select wraps onto "No, exit"). Driven against the
 * scripted tmux, which refuses keys inside the add-dir select's arm window and
 * models its held footer.
 * ────────────────────────────────────────────────────────────────────────── */

const testDataDir = mkdtempSync(path.join(tmpdir(), "agetor-card-drive-"));
process.env.AGETOR_DATA_DIR = testDataDir;

const { __forTest, answerTmuxPromptInPane } = await import("./claude-tmux.ts");
const { registerTmuxPrompt, activeTmuxPromptsForTask, findTmuxPromptById } = await import("./interactions.ts");

const scripted = makeScriptedClaudeTmux();
const savedTmuxBin = process.env.AGETOR_TMUX_BIN;
process.env.AGETOR_TMUX_BIN = scripted.bin;
const cleanups: Array<() => void> = [];
afterAll(() => {
  if (savedTmuxBin === undefined) delete process.env.AGETOR_TMUX_BIN;
  else process.env.AGETOR_TMUX_BIN = savedTmuxBin;
  scripted.cleanup();
  rmTestDataDir(testDataDir);
});
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const REPO_E = { kind: "add-dir" as const, repo: "repo-e", path: "/Users/me/.agetor/worktrees/4c34cf8f/repo-e" };

interface Drive {
  taskId: string;
  session: ScriptedSession;
  chunks: Array<{ stream: string; data: string }>;
  pane(): string;
}

/** A live SessionState for the task, backed by a scripted session of the same name. */
function drive(cfg: ScriptedConfig, setup?: Partial<ReturnType<ScriptedSession["state"]>>): Drive {
  const taskId = randomUUID();
  const state = __forTest.installSession(taskId, path.join(testDataDir, `${taskId}.jsonl`));
  const session = scripted.add(state.sessionName, cfg);
  // The session is "up": the add-dir dialog mounted long enough ago to be armed.
  session.patch({ started: true, mountedAt: Date.now() - 5_000, ...(setup ?? {}) });
  const chunks: Array<{ stream: string; data: string }> = [];
  state.lastChunk = (stream, data) => { chunks.push({ stream, data }); };
  cleanups.push(() => __forTest.uninstallSession(taskId));
  const pane = (): string => {
    const r = Bun.spawnSync([scripted.bin, "capture-pane", "-p", "-t", state.sessionName]);
    // `tmux()` trims stdout; the drive and the scraper both see it that way.
    return r.stdout.toString().trim();
  };
  return { taskId, session, chunks, pane };
}

/** Register a card for what is on the pane right now, exactly as the scraper does. */
function cardFor(d: Drive, extra: { runId?: string } = {}) {
  const lines = d.pane().split("\n");
  const tail = lines.slice(Math.max(0, lines.length - 40)).join("\n");
  const match = __forTest.pickScrapeMatch(tail, { paneWorking: false, paneIdle: false, watchdogArmed: false, boot: true });
  if (!match) throw new Error("no card matches the scripted pane");
  return registerTmuxPrompt({
    taskId: d.taskId,
    runId: extra.runId ?? "run-card-drive",
    paneText: match.paneText,
    choices: match.choices,
    cursorIndex: match.cursorIndex,
    nav: match.nav,
    fingerprint: match.fingerprint,
    unparsable: match.unparsable,
    confirmKey: match.confirmKey,
    hideKeys: match.hideKeys,
    answerKind: match.answerKind,
    identity: __forTest.identityOf(match),
  }).req;
}

describe("answerTmuxPromptInPane — choice cards", () => {
  test("the cursor moved since registration: it is read live, so no Down is sent (Enter only)", async () => {
    const d = drive({ dialogs: [REPO_E] });
    const card = cardFor(d); // registered with the cursor on "No, exit"
    expect(card.cursorIndex).toBe(0);
    // The user pressed Down in the terminal after the card appeared: cursor on Yes.
    d.session.patch({ cursor: 1, lastKey: "down-counted" });
    const r = await answerTmuxPromptInPane(card, { kind: "choice", key: "2" });
    expect(r).toEqual({ ok: true });
    expect(d.session.keys().map((k) => k.k)).toEqual(["Enter"]);
    expect(d.session.state().done).toBe(true);
    expect(d.session.state().exited).toBeUndefined();
  });

  test("a click on Yes from the registered cursor: Down, then Enter ≥150 ms later, and the dialog is accepted", async () => {
    const d = drive({ dialogs: [REPO_E] });
    const card = cardFor(d);
    const r = await answerTmuxPromptInPane(card, { kind: "choice", key: "2" });
    expect(r).toEqual({ ok: true });
    const keys = d.session.keys();
    expect(keys.map((k) => k.k)).toEqual(["Down", "Enter"]);
    expect(keys[1]!.t - keys[0]!.t).toBeGreaterThanOrEqual(130);
    expect(d.session.state().done).toBe(true);
  });

  test("the dialog changed since registration: nothing is sent and the result says so", async () => {
    const d = drive({ dialogs: [REPO_E, { kind: "add-dir", repo: "repo-f", path: "/Users/me/.agetor/worktrees/4c34cf8f/repo-f" }] });
    const card = cardFor(d);
    d.session.patch({ i: 1, cursor: 0, mountedAt: Date.now() - 5_000 }); // the next repository's dialog
    const r = await answerTmuxPromptInPane(card, { kind: "choice", key: "2" });
    expect(r).toEqual({ ok: false, reason: "dialog-changed" });
    expect(d.session.keys()).toEqual([]);
  });

  test("the dialog is gone (an idle composer): nothing is sent", async () => {
    const d = drive({ dialogs: [REPO_E] });
    const card = cardFor(d);
    d.session.patch({ i: 1, done: true }); // every dialog accepted: the composer
    const r = await answerTmuxPromptInPane(card, { kind: "choice", key: "2" });
    expect(r).toEqual({ ok: false, reason: "dialog-changed" });
    expect(d.session.keys()).toEqual([]);
  });

  test("an unreadable cursor never sends a Down", async () => {
    const d = drive({ dialogs: [REPO_E] });
    const card = cardFor(d);
    // The same dialog, but claude is mid-repaint: no ❯ row on the pane.
    const noCursor = d.pane().replace(" ❯ No, exit", "   No, exit");
    d.session.patch({ cfg: { dialogs: [{ kind: "raw", text: noCursor }] } as never });
    const r = await answerTmuxPromptInPane(card, { kind: "choice", key: "2" });
    expect(r).toEqual({ ok: false, reason: "dialog-changed" });
    expect(d.session.keys()).toEqual([]);
  });

  test("claude refuses the confirm: the old card is settled and a held card replaces it", async () => {
    const d = drive({ dialogs: [REPO_E], refuseEnters: 1 });
    const card = cardFor(d, { runId: "run-held" });
    const r = await answerTmuxPromptInPane(card, { kind: "choice", key: "2" });
    expect(r).toEqual({ ok: true, recarded: true });
    expect(findTmuxPromptById(card.id)).toBeNull();
    const [held] = activeTmuxPromptsForTask(d.taskId);
    expect(held!.held).toBe(true);
    expect(held!.id).not.toBe(card.id);
    expect(held!.identity).toBe(card.identity);
    // A refusal puts the cursor back on "No, exit" (live spike 2026-11-17), so the
    // held card's own click reads it and walks Down, Enter.
    expect(held!.cursorIndex).toBe(0);
    const second = await answerTmuxPromptInPane(held!, { kind: "choice", key: "2" });
    expect(second).toEqual({ ok: true });
    expect(d.session.keys().map((k) => k.k)).toEqual(["Down", "Enter", "Down", "Enter"]);
    expect(d.session.state().done).toBe(true);
    expect(d.session.state().exited).toBeUndefined();
  }, 20_000);

  test("a held card plans from a fresh read after the arm wait: a cursor moved in the terminal meanwhile is respected", async () => {
    const d = drive({ dialogs: [REPO_E], refuseEnters: 1 });
    const card = cardFor(d, { runId: "run-held-moved" });
    expect(await answerTmuxPromptInPane(card, { kind: "choice", key: "2" })).toEqual({ ok: true, recarded: true });
    const [held] = activeTmuxPromptsForTask(d.taskId);
    expect(held!.cursorIndex).toBe(0);
    const captures = () => d.session.calls().filter((c) => c.argv[0] === "capture-pane").length;
    const before = captures();
    const answering = answerTmuxPromptInPane(held!, { kind: "choice", key: "2" });
    // Wait for the drive's first read (the arm wait starts right after it), so
    // the cursor provably moves BETWEEN the two reads, whatever the machine load.
    const deadline = Date.now() + 10_000;
    while (captures() === before && Date.now() < deadline) await Bun.sleep(5);
    expect(captures()).toBeGreaterThan(before);
    // During the 500 ms arm wait the user moves the cursor to "Yes, add it".
    d.session.patch({ cursor: 1 });
    expect(await answering).toEqual({ ok: true });
    // Planned from the live cursor (on Yes): the held safety net, Up, Down, Enter.
    // The stale cursor would have sent Down, which wraps onto "No, exit".
    expect(d.session.keys().map((k) => k.k)).toEqual(["Down", "Enter", "Up", "Down", "Enter"]);
    expect(d.session.state().done).toBe(true);
    expect(d.session.state().exited).toBeUndefined();
  }, 20_000);

  test("a pick that is not one of the card's choices sends nothing", async () => {
    const d = drive({ dialogs: [REPO_E] });
    const card = cardFor(d);
    const r = await answerTmuxPromptInPane(card, { kind: "choice", key: "9" });
    expect(r).toEqual({ ok: false, reason: "dialog-changed" });
    expect(d.session.keys()).toEqual([]);
  });

  test("a wrong action kind for the card is refused", async () => {
    const d = drive({ dialogs: [REPO_E] });
    const card = cardFor(d);
    expect(await answerTmuxPromptInPane(card, { kind: "enter" })).toEqual({ ok: false, reason: "wrong-kind" });
    expect(await answerTmuxPromptInPane(card, { kind: "code", code: "abc" })).toEqual({ ok: false, reason: "wrong-kind" });
    expect(d.session.keys()).toEqual([]);
  });

  test("no session for the task", async () => {
    const d = drive({ dialogs: [REPO_E] });
    const card = cardFor(d);
    __forTest.uninstallSession(d.taskId);
    expect(await answerTmuxPromptInPane(card, { kind: "choice", key: "2" })).toEqual({ ok: false, reason: "no-session" });
  });
});

describe("answerTmuxPromptInPane — Enter-only cards", () => {
  test("exactly one Enter, only when the live pane is the same screen", async () => {
    const d = drive({ dialogs: [{ kind: "enter-only" }] });
    const card = cardFor(d);
    expect(card.answerKind).toBe("enter");
    const r = await answerTmuxPromptInPane(card, { kind: "enter" });
    expect(r).toEqual({ ok: true });
    expect(d.session.keys().map((k) => k.k)).toEqual(["Enter"]);
  });

  test("the screen moved on: no Enter is sent", async () => {
    const d = drive({ dialogs: [{ kind: "enter-only" }, REPO_E] });
    const card = cardFor(d);
    d.session.patch({ i: 1, cursor: 0 }); // now a different dialog is on screen
    const r = await answerTmuxPromptInPane(card, { kind: "enter" });
    expect(r).toEqual({ ok: false, reason: "dialog-changed" });
    expect(d.session.keys()).toEqual([]);
  });
});

describe("answerTmuxPromptInPane — OAuth code cards", () => {
  test("types the code with send-keys -l -- then Enter, escapes a trailing semicolon, and leaks the code nowhere", async () => {
    const d = drive({ dialogs: [{ kind: "paste-code" }], echoTyped: false });
    const card = cardFor(d);
    expect(card.answerKind).toBe("code");
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const code = "test-code-123;";
    let result: unknown;
    try {
      result = await answerTmuxPromptInPane(card, { kind: "code", code });
      const sawCode = (spy: { mock: { calls: unknown[][] } }) => JSON.stringify(spy.mock.calls).includes("test-code-123");
      expect(sawCode(log as never)).toBe(false);
      expect(sawCode(warn as never)).toBe(false);
      expect(sawCode(error as never)).toBe(false);
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain("test-code-123");
    const keys = d.session.keys();
    expect(keys.map((k) => ({ k: k.k, literal: k.literal }))).toEqual([
      { k: "test-code-123\\;", literal: true },
      { k: "Enter", literal: false },
    ]);
    // The literal went in as one `send-keys -t <session> -l -- <text>` argv.
    const literalCall = d.session.calls().find((c) => c.argv.includes("-l"))!;
    expect(literalCall.argv.slice(-3, -1)).toEqual(["-l", "--"]);
    // No status/stdout chunk of the session carries it either.
    expect(JSON.stringify(d.chunks)).not.toContain("test-code-123");
  });

  test("the prompt is gone: nothing is typed", async () => {
    const d = drive({ dialogs: [{ kind: "paste-code" }, REPO_E] });
    const card = cardFor(d);
    d.session.patch({ i: 1 });
    const r = await answerTmuxPromptInPane(card, { kind: "code", code: "abc" });
    expect(r).toEqual({ ok: false, reason: "dialog-changed" });
    expect(d.session.keys()).toEqual([]);
  });
});

describe("the add-dir 'wrap hazard'", () => {
  test("cursor on Yes and target Yes sends no arrow (a Down would wrap onto 'No, exit')", async () => {
    const d = drive({ dialogs: [REPO_E] }, { cursor: 1, lastKey: "down-counted" });
    const card = cardFor(d);
    expect(card.cursorIndex).toBe(1);
    const r = await answerTmuxPromptInPane(card, { kind: "choice", key: "2" });
    expect(r).toEqual({ ok: true });
    expect(d.session.keys().map((k) => k.k)).toEqual(["Enter"]);
    expect(d.session.state().exited).toBeUndefined();
  });
});

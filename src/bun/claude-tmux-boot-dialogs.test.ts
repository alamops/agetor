import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";
import { makeScriptedClaudeTmux, type ScriptedConfig, type ScriptedSession } from "./test-scripted-claude-tmux.ts";

/* ────────────────────────────────────────────────────────────────────────── *
 * TT3 — docs/plans/claude-enter-to-confirm-prompts.md. The boot poller inside
 * `spawnClaudeViaTmux` had no end-to-end test: every case here drives the REAL
 * poller, tracker, matchers and deferred-paste loop against a scripted tmux
 * (`test-scripted-claude-tmux.ts`) that refuses keys sent inside the add-dir
 * select's 500 ms arm window and models its held footer.
 * ────────────────────────────────────────────────────────────────────────── */

const testDataDir = mkdtempSync(path.join(tmpdir(), "agetor-boot-dialogs-data-"));
process.env.AGETOR_DATA_DIR = testDataDir;

const {
  spawnClaudeViaTmux,
  dropSession,
  jsonlPathFor,
  setBootTimeoutMs,
  setDeferredPromptTimeoutMs,
  markTmuxPromptAnswered,
  sessionNameFor,
  claudeBootsInFlight,
  answerTmuxPromptInPane,
} = await import("./claude-tmux.ts");
const { activeTmuxPromptsForTask, answerTmuxPrompt, findTmuxPromptById } = await import("./interactions.ts");
const { tasks, runs } = await import("./db.ts");
const { makeTask } = await import("../cli/test-fixtures.ts");

// One scripted tmux for the whole file, installed once: boot pollers from an
// earlier test can still be unwinding, and they must only ever see their own session.
const scripted = makeScriptedClaudeTmux();
const savedTmuxBin = process.env.AGETOR_TMUX_BIN;
process.env.AGETOR_TMUX_BIN = scripted.bin;
afterAll(() => {
  // `bun test` runs every file in one process: leave the env as this file found it.
  if (savedTmuxBin === undefined) delete process.env.AGETOR_TMUX_BIN;
  else process.env.AGETOR_TMUX_BIN = savedTmuxBin;
  scripted.cleanup();
  rmTestDataDir(testDataDir);
});

interface Chunk { stream: string; data: string }

const WT = "/Users/me/.agetor/worktrees/4c34cf8f-a6fd-4f75-865c-92d7dbafa101";
const REPO_E = { kind: "add-dir" as const, repo: "repo-e", path: `${WT}/repo-e` };
const REPO_F = { kind: "add-dir" as const, repo: "repo-f", path: `${WT}/repo-f` };
const DIRS = [
  { name: "repo-e", paths: [REPO_E.path] },
  { name: "repo-f", paths: [REPO_F.path] },
];

const cleanups: Array<() => void> = [];
afterEach(() => {
  setBootTimeoutMs(null);
  setDeferredPromptTimeoutMs(null);
  for (const c of cleanups.splice(0)) c();
});

async function until(cond: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

interface Boot {
  taskId: string;
  tmux: ScriptedSession;
  chunks: Chunk[];
  jsonlPath: string;
  sessionId: string;
  fileReady: string[];
  statuses: () => string[];
  stderr: () => string;
  done: Promise<number>;
  stop: () => Promise<void>;
}

/** A boot still unwinding when its test ends would show up as a launch in
 *  flight to every later file in this process (`launch-settle.test.ts`): keep
 *  the window short and wait for it to finish in `stop()`. */
const DEFAULT_TEST_BOOT_TIMEOUT_MS = 3_000;

async function boot(
  cfg: Omit<ScriptedConfig, "jsonlPath">,
  o: {
    autoTrustDirectories?: Array<{ name: string; paths: string[] }>;
    deferredPrompt?: string;
    resume?: boolean;
    withRun?: boolean;
  } = {},
): Promise<Boot> {
  // The tmux session name keeps only the first 12 characters of the id.
  const taskId = randomUUID();
  const sessionId = randomUUID();
  const bootsBefore = claudeBootsInFlight();
  const timeoutOverride = setBootTimeoutMs(null);
  setBootTimeoutMs(timeoutOverride ?? DEFAULT_TEST_BOOT_TIMEOUT_MS);
  const cwd = mkdtempSync(path.join(tmpdir(), "agetor-boot-cwd-"));
  const jsonlPath = jsonlPathFor(cwd, sessionId, null);
  // The scratch config dir: keep the session file out of the real ~/.claude.
  const configDir = mkdtempSync(path.join(tmpdir(), "agetor-boot-cfg-"));
  const jsonl = jsonlPathFor(cwd, sessionId, configDir);
  mkdirSync(path.dirname(jsonl), { recursive: true });
  void jsonlPath;
  if (o.resume) writeFileSync(jsonl, "");
  const tmux = scripted.add(sessionNameFor(taskId), { ...cfg, jsonlPath: o.resume ? undefined : jsonl });
  if (o.withRun) {
    // The DB is one process-wide singleton shared by every test file: remove the
    // rows afterwards or a later file's reconcile sees this file's "running" run.
    cleanups.push(() => { try { tasks.delete(taskId); } catch { /* already gone */ } });
    const runId = `run-${taskId}`;
    tasks.insert(makeTask({ id: taskId, runId: null, column: "running" }));
    runs.insert({
      id: runId, taskId, agent: "claude-code", status: "running", startedAt: Date.now(), endedAt: null, exitCode: null,
      tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null,
      fxSessionId: null, antigravitySessionId: null,
    } as never);
    tasks.update(taskId, { runId });
  }
  const chunks: Chunk[] = [];
  const fileReady: string[] = [];
  const agent = await spawnClaudeViaTmux({
    taskId,
    argv: o.deferredPrompt ? ["claude", "--session-id", sessionId] : ["claude", "--session-id", sessionId, "hello"],
    env: {},
    cwd,
    onChunk: (stream, data) => { chunks.push({ stream, data }); },
    sessionId,
    configDir,
    mode: null,
    deferredPrompt: o.deferredPrompt,
    autoTrustDirectories: o.autoTrustDirectories,
    onSessionFileReady: (id) => { fileReady.push(id); },
  });
  const done = agent.done;
  done.catch(() => {});
  const stop = async (): Promise<void> => {
    await dropSession(taskId);
    // The boot wait ends at its (short) timeout once the session is gone.
    await until(() => claudeBootsInFlight() <= bootsBefore, 15_000, "the boot to unwind");
  };
  cleanups.push(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });
  return {
    taskId, tmux, chunks, jsonlPath: jsonl, sessionId, fileReady,
    statuses: () => chunks.filter((c) => c.stream === "status").map((c) => c.data),
    stderr: () => chunks.filter((c) => c.stream === "stderr").map((c) => c.data).join("\n"),
    done,
    stop,
  };
}

describe("boot poller — add-dir auto-confirm (preference on)", () => {
  test("two untrusted repositories: Down+Enter each, ≥500 ms after mount, ≥150 ms apart, a status line per repo, then ready", async () => {
    const b = await boot({ dialogs: [REPO_E, REPO_F] }, { autoTrustDirectories: DIRS });
    try {
      await until(() => b.statuses().some((s) => s.includes("ready (jsonl:")), 25_000, "ready status");
      // The last repository's line lands on the poller's next tick after the file appears.
      await until(() => b.statuses().filter((s) => s.startsWith("auto-confirmed Claude's")).length === 2, 5_000, "both status lines");
      const keys = b.tmux.keys();
      expect(keys.map((k) => k.k)).toEqual(["Down", "Enter", "Down", "Enter"]);
      expect(keys.every((k) => !k.literal)).toBe(true);
      // A clear gap before each Enter. (Keys inside the arm window would have been
      // refused by the stub and turned the footer held: the exact four keys
      // above are what proves none were sent there.)
      expect(keys[1]!.t - keys[0]!.t).toBeGreaterThanOrEqual(130);
      expect(keys[3]!.t - keys[2]!.t).toBeGreaterThanOrEqual(130);
      const lines = b.statuses().filter((s) => s.startsWith("auto-confirmed Claude's"));
      expect(lines).toEqual([
        `auto-confirmed Claude's "Adding a new directory" prompt for repo-e`,
        `auto-confirmed Claude's "Adding a new directory" prompt for repo-f`,
      ]);
      expect(activeTmuxPromptsForTask(b.taskId)).toEqual([]);
      expect(b.stderr()).not.toContain("never appeared");
      expect(b.fileReady).toEqual([b.sessionId]);
    } finally {
      await b.stop();
    }
  }, 40_000);

  test("claude ignoring the first Enter (held footer, cursor back on No): retried from the live cursor", async () => {
    const b = await boot({ dialogs: [REPO_E], refuseEnters: 1 }, { autoTrustDirectories: DIRS });
    try {
      await until(() => b.statuses().some((s) => s.includes("ready (jsonl:")), 30_000, "ready status");
      await until(() => b.statuses().some((s) => s.startsWith("auto-confirmed Claude's")), 5_000, "status line");
      const names = b.tmux.keys().map((k) => k.k);
      // 1st attempt: Down, Enter (refused → held, and claude puts the cursor back on
      // "No, exit": live spike 2026-11-17). The retry reads that cursor and walks
      // Down, Enter; it never repeats a bare Enter and never presses Down from Yes.
      expect(names).toEqual(["Down", "Enter", "Down", "Enter"]);
      expect(b.tmux.state().exited).toBeUndefined();
      expect(b.statuses().filter((s) => s.startsWith("auto-confirmed Claude's"))).toHaveLength(1);
    } finally {
      await b.stop();
    }
  }, 45_000);

  test("a repository not in the spawn's list is carded, never auto-confirmed", async () => {
    const b = await boot({ dialogs: [REPO_E] }, { autoTrustDirectories: [{ name: "other", paths: ["/Users/me/other"] }], withRun: true });
    try {
      await until(() => activeTmuxPromptsForTask(b.taskId).length === 1, 15_000, "a card");
      expect(b.tmux.keys()).toEqual([]);
      const [card] = activeTmuxPromptsForTask(b.taskId);
      expect(card!.choices.map((c) => c.label)).toEqual(["No, exit", "Yes, add it"]);
    } finally {
      await b.stop();
    }
  }, 30_000);

  test("preference off (no directories): every dialog is a card, and the second one is NOT suppressed after the first is answered", async () => {
    const b = await boot({ dialogs: [REPO_E, REPO_F] }, { withRun: true });
    try {
      await until(() => activeTmuxPromptsForTask(b.taskId).length === 1, 15_000, "first card");
      expect(b.tmux.keys()).toEqual([]);
      const first = activeTmuxPromptsForTask(b.taskId)[0]!;
      expect(first.paneText).toContain("repo-e");
      // The user answers it: the dialog advances, the fingerprint is stamped as just answered.
      b.tmux.patch({ i: 1, cursor: 0, held: false, mountedAt: Date.now() });
      markTmuxPromptAnswered(b.taskId, first.fingerprint);
      answerTmuxPrompt(first.id, { key: "2" });
      await until(() => activeTmuxPromptsForTask(b.taskId).some((r) => r.paneText.includes("repo-f")), 15_000, "second card");
      expect(b.statuses().filter((s) => s.includes("claude is asking a question on startup"))).toHaveLength(2);
    } finally {
      await b.stop();
    }
  }, 40_000);
});

describe("boot poller — identical follow-up dialog (defect 2)", () => {
  test("two identical (same-fingerprint) dialogs: the second is carded once the 3 s TTL passes, and the boot window stays open", async () => {
    setBootTimeoutMs(3_000);
    const b = await boot({ dialogs: [{ kind: "chrome" }, { kind: "chrome" }] }, { withRun: true });
    try {
      await until(() => activeTmuxPromptsForTask(b.taskId).length === 1, 15_000, "first card");
      const first = activeTmuxPromptsForTask(b.taskId)[0]!;
      b.tmux.patch({ i: 1, cursor: 0, mountedAt: Date.now() });
      markTmuxPromptAnswered(b.taskId, first.fingerprint);
      answerTmuxPrompt(first.id, { key: "2" });
      // Same fingerprint as the answered one: suppressed for ≤ 3 s, then carded.
      await until(() => activeTmuxPromptsForTask(b.taskId).length === 1, 15_000, "second card");
      const second = activeTmuxPromptsForTask(b.taskId)[0]!;
      expect(second.fingerprint).toBe(first.fingerprint);
      expect(second.id).not.toBe(first.id);
      // The boot timeout (3 s) elapsed more than once while the user was being asked: the run was not killed.
      expect(b.stderr()).not.toContain("never appeared");
    } finally {
      await b.stop();
    }
  }, 40_000);
});

describe("boot poller — Enter-only, code and theme screens", () => {
  test("the theme picker of a logged-out boot is a card after two sightings", async () => {
    const b = await boot({ dialogs: [{ kind: "theme" }] }, { withRun: true });
    try {
      await until(() => activeTmuxPromptsForTask(b.taskId).length === 1, 15_000, "theme card");
      const [card] = activeTmuxPromptsForTask(b.taskId);
      expect(card!.choices.map((c) => c.label)).toEqual(["Auto (match terminal)", "Dark mode", "Light mode"]);
      expect(card!.answerKind).toBeUndefined();
    } finally {
      await b.stop();
    }
  }, 30_000);

  test("'Press Enter to continue' becomes an enter card only after three stable sightings, with no keys sent", async () => {
    const b = await boot({ dialogs: [{ kind: "enter-only" }] }, { withRun: true });
    try {
      await until(() => activeTmuxPromptsForTask(b.taskId).length === 1, 15_000, "enter card");
      const [card] = activeTmuxPromptsForTask(b.taskId);
      expect(card!.answerKind).toBe("enter");
      expect(card!.choices).toEqual([]);
      expect(card!.unparsable).toBeUndefined();
      expect(b.tmux.keys()).toEqual([]); // never pressed automatically
    } finally {
      await b.stop();
    }
  }, 30_000);

  test("the OAuth code prompt becomes a code card", async () => {
    const b = await boot({ dialogs: [{ kind: "paste-code" }] }, { withRun: true });
    try {
      await until(() => activeTmuxPromptsForTask(b.taskId).length === 1, 15_000, "code card");
      const [card] = activeTmuxPromptsForTask(b.taskId);
      expect(card!.answerKind).toBe("code");
      expect(card!.choices).toEqual([]);
      expect(card!.paneText).toContain("Paste code here if prompted >");
      expect(b.tmux.keys()).toEqual([]);
    } finally {
      await b.stop();
    }
  }, 30_000);

  test("a boot-timeout pane dump masks a code typed after the OAuth prompt", async () => {
    setBootTimeoutMs(1_200);
    // Not a shape the driver cards (a `❯` row is on screen), so the boot is not
    // held open by a question and times out with the pane in the error.
    const text = " Paste code here if prompted > abc123-synthetic-code#xyz\n ❯ \n";
    const b = await boot({ dialogs: [{ kind: "raw", text }] }, { withRun: true });
    try {
      await expect(b.done).rejects.toThrow("jsonl-discovery-timeout");
      const dump = b.stderr();
      expect(dump).toContain("--- tmux pane ---");
      expect(dump).toContain("Paste code here if prompted > ••••");
      expect(dump).not.toContain("abc123-synthetic-code");
    } finally {
      await b.stop();
    }
  }, 30_000);
});

describe("boot poller — session file readiness (defect 4)", () => {
  test("onSessionFileReady fires once when the file appears, never on a boot timeout", async () => {
    setBootTimeoutMs(1_200);
    const never = await boot({ dialogs: [{ kind: "enter-only" }] });
    try {
      await expect(never.done).rejects.toThrow("jsonl-discovery-timeout");
      expect(never.fileReady).toEqual([]);
      expect(existsSync(never.jsonlPath)).toBe(false);
    } finally {
      await never.stop();
    }
    setBootTimeoutMs(null);
    const ok = await boot({ dialogs: [] });
    try {
      await until(() => ok.statuses().some((s) => s.includes("ready (jsonl:")), 15_000, "ready");
      expect(ok.fileReady).toEqual([ok.sessionId]);
    } finally {
      await ok.stop();
    }
  }, 40_000);
});

describe("boot poller — resume consent window", () => {
  test("a --resume launch (session file already there) still auto-confirms the re-asked add-dir dialogs, without carding them", async () => {
    const b = await boot({ dialogs: [REPO_E, REPO_F] }, { autoTrustDirectories: DIRS, resume: true, withRun: true });
    try {
      await until(() => b.tmux.state().done === true, 30_000, "both dialogs accepted");
      expect(b.tmux.keys().map((k) => k.k)).toEqual(["Down", "Enter", "Down", "Enter"]);
      expect(activeTmuxPromptsForTask(b.taskId)).toEqual([]);
      await until(
        () => b.statuses().filter((s) => s.startsWith("auto-confirmed Claude's")).length === 2,
        10_000,
        "two status lines",
      );
      // The session file existed at spawn, so the stamp fired at once.
      expect(b.fileReady).toEqual([b.sessionId]);
    } finally {
      await b.stop();
    }
  }, 50_000);
});

describe("boot poller — resume window waits behind a pending card", () => {
  test("a card still awaiting the user past the boot timeout keeps the window open, so a later add-dir dialog is still auto-confirmed", async () => {
    // After a harness-stack account swap claude re-asks workspace trust on
    // resume; that dialog is carded and the user may take longer than the boot
    // timeout. The add-dir dialogs queued behind it must still be handled.
    setBootTimeoutMs(2_500);
    const trust = [
      " Quick safety check: Is this a project you created or one you trust?",
      " ❯ No, exit",
      "   Yes, I trust this folder",
      " Enter to confirm · Esc to cancel",
    ].join("\n");
    const b = await boot({ dialogs: [{ kind: "raw", text: trust }] }, { autoTrustDirectories: DIRS, resume: true, withRun: true });
    try {
      // The runtime scraper cards the trust dialog; it stays pending well past
      // the 2.5 s window timeout while the user decides.
      await until(() => activeTmuxPromptsForTask(b.taskId).length === 1, 15_000, "the trust card");
      await new Promise((r) => setTimeout(r, 4_000));
      expect(activeTmuxPromptsForTask(b.taskId)).toHaveLength(1);
      // The user answers; claude moves on to the re-asked add-dir dialog.
      b.tmux.patch({ cfg: { dialogs: [REPO_E] }, i: 0, cursor: 0, held: false, mountedAt: Date.now() });
      await until(() => b.tmux.state().done === true, 15_000, "the add-dir dialog accepted");
      expect(b.tmux.keys().map((k) => k.k)).toEqual(["Down", "Enter"]);
    } finally {
      await b.stop();
    }
  }, 40_000);
});

describe("boot poller — resume window never acts on a quoted dialog", () => {
  test("a resumed pane whose transcript quotes the trust-folder and bypass dialogs above the idle composer gets no keys", async () => {
    // The old transcript of a resumed session can contain a pasted/quoted
    // consent dialog. The bypass / trust-folder matchers are not bottom
    // anchored, so without `addDirOnly` the tracker would type Down/Enter into
    // the live composer (Up+Enter can replay the previous prompt).
    const text = [
      " > what did the trust prompt say?",
      " Quick safety check: Is this a project you created or one you trust?",
      " ❯ No, exit",
      "   Yes, I trust this folder",
      " Enter to confirm · Esc to cancel",
      " WARNING: Claude Code running in Bypass Permissions mode",
      " ❯ 1. No, exit",
      "   2. Yes, I accept",
      "",
      "────────────────────────────────────────────────────────────────────────────────",
      "❯ ",
      "────────────────────────────────────────────────────────────────────────────────",
      "  ? for shortcuts",
    ].join("\n");
    const b = await boot({ dialogs: [{ kind: "raw", text }] }, { resume: true, withRun: true, autoTrustDirectories: DIRS });
    try {
      // Several poll periods (350 ms each): the tracker needs two sightings and
      // 500 ms before it would first press a key.
      await new Promise((r) => setTimeout(r, 2_500));
      expect(b.tmux.keys()).toEqual([]);
      expect(b.statuses().filter((s) => s.startsWith("auto-confirmed"))).toEqual([]);
    } finally {
      await b.stop();
    }
  }, 30_000);
});

describe("deferred prompt paste (defect 3)", () => {
  test("never pastes, and never says 'delivering prompt anyway', while a startup dialog is on the pane", async () => {
    setDeferredPromptTimeoutMs(700);
    const b = await boot({ dialogs: [REPO_E] }, { autoTrustDirectories: [], deferredPrompt: "a very large prompt", withRun: true });
    try {
      await until(() => activeTmuxPromptsForTask(b.taskId).length === 1, 15_000, "card");
      // Several readiness windows elapse with the dialog still up.
      await new Promise((r) => setTimeout(r, 2_500));
      expect(b.statuses().some((s) => s.includes("delivering prompt anyway"))).toBe(false);
      expect(b.stderr()).not.toContain("paste failed");
      expect(b.tmux.calls().some((c) => c.argv[0] === "paste-buffer" || c.argv[0] === "load-buffer")).toBe(false);
    } finally {
      await b.stop();
    }
  }, 40_000);
});

describe("deferred prompt paste during an auto-confirm (no card ever exists)", () => {
  test("the paste waits while the dialog is on the pane being auto-confirmed, then lands exactly once after it", async () => {
    // Short readiness windows, and a dialog that refuses two confirms: the
    // tracker retries for several seconds with NO card registered, so only the
    // "a dialog is on the pane" guard keeps the paste out of it.
    setDeferredPromptTimeoutMs(300);
    setBootTimeoutMs(15_000);
    const b = await boot({ dialogs: [REPO_E], refuseEnters: 2 }, { autoTrustDirectories: DIRS, deferredPrompt: "a very large prompt", withRun: true });
    const pastes = () => b.tmux.calls().filter((c) => c.argv[0] === "paste-buffer");
    try {
      await until(() => b.tmux.state().done, 30_000, "the dialog auto-confirmed");
      expect(activeTmuxPromptsForTask(b.taskId)).toHaveLength(0);
      const confirmedAt = b.tmux.keys().filter((k) => k.k === "Enter" && !k.literal).at(-1)!.t;
      await until(() => pastes().length === 1, 15_000, "the deferred paste");
      expect(pastes()[0]!.t).toBeGreaterThan(confirmedAt);
      expect(b.statuses().some((s) => s.includes("delivering prompt anyway"))).toBe(false);
    } finally {
      await b.stop();
    }
  }, 60_000);
});

/** What the answer route does once `answerTmuxPromptInPane` reports success. */
function settleLikeTheRoute(taskId: string, card: { id: string; fingerprint: string }, key: string, recarded?: boolean): void {
  markTmuxPromptAnswered(taskId, card.fingerprint);
  if (!recarded) answerTmuxPrompt(card.id, { key });
}

describe("deferred prompt paste lands once the startup card is answered (defect 3)", () => {
  test("the prompt waits behind the card through several readiness windows, then is pasted exactly once after the user answers it", async () => {
    setDeferredPromptTimeoutMs(700);
    const b = await boot({ dialogs: [REPO_E] }, { autoTrustDirectories: [], deferredPrompt: "a very large prompt", withRun: true });
    const pastes = () => b.tmux.calls().filter((c) => c.argv[0] === "paste-buffer");
    try {
      await until(() => activeTmuxPromptsForTask(b.taskId).length === 1, 15_000, "card");
      // Three readiness windows pass with the card unanswered: nothing is typed.
      await new Promise((r) => setTimeout(r, 2_200));
      expect(pastes()).toHaveLength(0);
      expect(b.statuses().some((s) => s.includes("delivering prompt anyway"))).toBe(false);

      // The user clicks "Yes, add it" on the card (the route's drive).
      const card = activeTmuxPromptsForTask(b.taskId)[0]!;
      const driven = await answerTmuxPromptInPane(card, { kind: "choice", key: "2" });
      expect(driven.ok).toBe(true);
      settleLikeTheRoute(b.taskId, card, "2", driven.ok ? driven.recarded : undefined);
      expect(b.tmux.state().done).toBe(true);

      // claude's composer is up: the deferred prompt is pasted, after the dialog's Enter.
      await until(() => pastes().length === 1, 15_000, "the deferred paste");
      const dialogEnter = b.tmux.keys().find((k) => k.k === "Enter" && !k.literal)!;
      expect(pastes()[0]!.t).toBeGreaterThan(dialogEnter.t);
      await until(() => b.statuses().some((s) => s.includes("ready (jsonl:")), 15_000, "ready status");
      // Exactly once: no second paste lands while the run settles.
      await new Promise((r) => setTimeout(r, 1_000));
      expect(pastes()).toHaveLength(1);
      expect(b.statuses().some((s) => s.includes("delivering prompt anyway"))).toBe(false);
      expect(b.stderr()).not.toContain("paste failed");
      expect(b.stderr()).not.toContain("never appeared");
      expect(b.fileReady).toEqual([b.sessionId]);
    } finally {
      await b.stop();
    }
  }, 50_000);
});

describe("boot poller — auto-confirm gives up and hands the dialog to a card", () => {
  test("claude refusing every confirm: 4 attempts, one 'answer it in the terminal' line, then a card the user answers and the boot proceeds", async () => {
    const b = await boot({ dialogs: [REPO_E], refuseEnters: 99 }, { autoTrustDirectories: DIRS, withRun: true });
    const enters = () => b.tmux.keys().filter((k) => k.k === "Enter").length;
    try {
      await until(() => activeTmuxPromptsForTask(b.taskId).length === 1, 40_000, "the give-up card");
      expect(enters()).toBe(4);
      expect(b.statuses().filter((s) => s.includes("could not be confirmed after 4 attempts"))).toEqual([
        "claude startup dialog could not be confirmed after 4 attempts (add-dir:repo-e) — answer it in the terminal",
      ]);
      expect(b.statuses().some((s) => s.startsWith("auto-confirmed Claude's"))).toBe(false);
      expect(b.tmux.state().exited).toBeUndefined();
      const card = activeTmuxPromptsForTask(b.taskId)[0]!;
      expect(card.choices.map((c) => c.label)).toEqual(["No, exit", "Yes, add it"]);

      // The poller stopped typing: the card is now the only way through, and the
      // boot (3 s timeout) stays open while it waits.
      await new Promise((r) => setTimeout(r, 4_000));
      expect(enters()).toBe(4);
      expect(b.stderr()).not.toContain("never appeared");
      expect(activeTmuxPromptsForTask(b.taskId).map((r) => r.id)).toEqual([card.id]);

      // claude takes the user's click.
      b.tmux.patch({ refuse: 0 });
      const driven = await answerTmuxPromptInPane(card, { kind: "choice", key: "2" });
      expect(driven.ok).toBe(true);
      settleLikeTheRoute(b.taskId, card, "2", driven.ok ? driven.recarded : undefined);
      await until(() => b.statuses().some((s) => s.includes("ready (jsonl:")), 15_000, "ready status");
      expect(b.tmux.state().done).toBe(true);
      expect(b.fileReady).toEqual([b.sessionId]);
      // The dialog the user confirmed is never reported as auto-confirmed.
      expect(b.statuses().some((s) => s.startsWith("auto-confirmed Claude's"))).toBe(false);
    } finally {
      await b.stop();
    }
  }, 70_000);
});

// Silence "unused" for helpers kept for readability in failures.
void findTmuxPromptById;

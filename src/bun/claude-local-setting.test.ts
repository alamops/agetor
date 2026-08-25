import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.ts opens its sqlite connection at module-load time, and orchestrator.ts
// (transitively, via claude-tmux.ts / codex-tmux.ts / …) imports db.ts. Set
// AGETOR_DATA_DIR before any of that loads — same pattern as
// orchestrator.test.ts / agents.test.ts — and drive claude through the fake
// in-process driver rather than a real tmux + CLI so `createTask`/`startTask`
// never touch the filesystem outside this mkdtemp dir.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-local-setting-test-"));
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";

const { claudeModelIdFromArg } = await import("./agents.ts");
const { parseClaudeLocalSetting, describeLocalSettingSync, describeUnrepresentableLocalSetting } =
  await import("./claude-local-setting.ts");
const { createTask, applyClaudeLocalSetting } = await import("./orchestrator.ts");
const { tasks, runs } = await import("./db.ts");
const { hasSessionState } = await import("./claude-tmux.ts");

// ---------------------------------------------------------------------------
// claudeModelIdFromArg (src/bun/agents.ts)
// ---------------------------------------------------------------------------

test("claudeModelIdFromArg resolves CLAUDE_MODEL_FLAG values back to their agetor ids", () => {
  expect(claudeModelIdFromArg("claude-opus-5")).toBe("opus-5");
  expect(claudeModelIdFromArg("claude-sonnet-4-6")).toBe("sonnet-4.6");
  expect(claudeModelIdFromArg("claude-haiku-4-5")).toBe("haiku-4.5");
});

test("claudeModelIdFromArg passes an unrecognized raw claude-* id through verbatim", () => {
  expect(claudeModelIdFromArg("claude-opus-6")).toBe("claude-opus-6");
});

test("claudeModelIdFromArg returns null for claude's own aliases and the empty string", () => {
  // "sonnet" / "opus" / "default" map many-to-one onto a model family and
  // can't be inverted losslessly from the arg alone (see the doc comment on
  // claudeModelIdFromArg) — callers must fall back to the stdout display
  // name instead (claudeModelIdFromDisplayName / parseClaudeLocalSetting).
  expect(claudeModelIdFromArg("sonnet")).toBeNull();
  expect(claudeModelIdFromArg("opus")).toBeNull();
  expect(claudeModelIdFromArg("default")).toBeNull();
  expect(claudeModelIdFromArg("")).toBeNull();
});

// ---------------------------------------------------------------------------
// parseClaudeLocalSetting — model (src/bun/claude-local-setting.ts)
// ---------------------------------------------------------------------------

test("model: an arg-less stdout display name resolves via AGENT_OPTIONS labels (ANSI bold stripped)", () => {
  const result = parseClaudeLocalSetting({
    setting: "model",
    args: "sonnet",
    stdout: "Set model to \x1b[1mSonnet 5\x1b[22m and saved as your default for new sessions",
  });
  // args="sonnet" doesn't resolve via claudeModelIdFromArg (it's an alias,
  // not a CLAUDE_MODEL_FLAG value), so this exercises the stdout fallback.
  expect(result).toEqual({ kind: "model", id: "sonnet-5" });
});

test("model: 'opus' arg + ANSI-wrapped stdout display name resolves to opus-5", () => {
  const result = parseClaudeLocalSetting({
    setting: "model",
    args: "opus",
    stdout: "Set model to \x1b[1mOpus 5\x1b[22m and saved as your default for new sessions",
  });
  expect(result).toEqual({ kind: "model", id: "opus-5" });
});

test("model: qualifiers like '(1M context)' and '(default)' are stripped before label matching", () => {
  const result = parseClaudeLocalSetting({
    setting: "model",
    args: "",
    stdout: "Set model to Opus 5 (1M context) (default) and saved as your default for new sessions",
  });
  expect(result).toEqual({ kind: "model", id: "opus-5" });
});

test("model: an arg matching CLAUDE_MODEL_FLAG wins over the stdout display name", () => {
  const result = parseClaudeLocalSetting({
    setting: "model",
    args: "claude-opus-4-8",
    stdout: "Set model to Opus 4.8 and saved as your default for new sessions",
  });
  expect(result).toEqual({ kind: "model", id: "opus-4.8" });
});

test("model: only the FIRST LINE of stdout is matched against 'Set model to …'", () => {
  // `.` doesn't match `\n`, so matching the full multi-line stdout against
  // `/^Set model to (.+?)(?: and saved\b|$)/` would fail to capture anything
  // once a second line (a note, a caveat) follows the "Set model to" line —
  // this pins the fix (splitting on "\n" first) rather than the bug.
  const result = parseClaudeLocalSetting({
    setting: "model",
    args: "",
    stdout: "Set model to Opus 5\nNote: this session was already using a compatible context window",
  });
  expect(result).toEqual({ kind: "model", id: "opus-5" });
});

test("model: 'Kept model as …' is a real outcome, not a no-op — it's synced like any other", () => {
  // This is the drift-correction case: e.g. the Task Details dropdown wrote
  // a new model onto the task row, claude popped "Switch model?", and the
  // user answered "No, go back" — claude's own record of what it actually
  // kept must win, not the row's already-written (and now wrong) value.
  const result = parseClaudeLocalSetting({
    setting: "model",
    args: "",
    stdout: "Kept model as Opus 4.8",
  });
  expect(result).toEqual({ kind: "model", id: "opus-4.8" });
});

test("model: a display name absent from AGENT_OPTIONS resolves to 'unrepresentable', not null", () => {
  // "Opus 6" isn't a curated AGENT_OPTIONS["claude-code"].models[].label
  // (today's list tops out at Opus 5) and doesn't start with "claude-", so
  // claudeModelIdFromDisplayName has nothing to match against. This is a
  // REAL value claude landed on that agetor simply can't store — it must be
  // surfaced (kind: "unrepresentable"), not silently dropped as if nothing
  // happened.
  const result = parseClaudeLocalSetting({
    setting: "model",
    args: "",
    stdout: "Set model to Opus 6 and saved as your default for new sessions",
  });
  expect(result).toEqual({ kind: "unrepresentable", setting: "model", raw: "Opus 6" });
});

test("model: a raw claude-<id> stdout display name passes through verbatim", () => {
  const result = parseClaudeLocalSetting({
    setting: "model",
    args: "",
    stdout: "Set model to claude-opus-6 and saved as your default for new sessions",
  });
  expect(result).toEqual({ kind: "model", id: "claude-opus-6" });
});

// ---------------------------------------------------------------------------
// parseClaudeLocalSetting — effort (outcome-first)
// ---------------------------------------------------------------------------

test("effort: stdout governs even when args is differently-cased — 'HIGH' arg + 'high' stdout resolves to 'high'", () => {
  // Verified bug this fixes: today's args-first, args-uppercase-untouched
  // logic returns null here because `CLAUDE_EFFORT_IDS.has("HIGH")` is
  // false (the set only holds lowercase ids) — even though claude's own
  // stdout plainly reports a valid, supported change.
  const result = parseClaudeLocalSetting({
    setting: "effort",
    args: "HIGH",
    stdout: "Set effort level to high (saved as your default for new sessions): …",
  });
  expect(result).toEqual({ kind: "effort", id: "high" });
});

test("effort: a declined confirm ('Cancelled') resolves to null even though args carries the typed value", () => {
  // Verified bug this fixes: today's "args wins" behavior would write
  // `low` here even though the stdout says the change never happened
  // (e.g. the user answered "No, go back" on "Change effort level?").
  const result = parseClaudeLocalSetting({ setting: "effort", args: "low", stdout: "Cancelled" });
  expect(result).toBeNull();
});

test("effort: parses 'Set effort level to <id>' from stdout when args is empty", () => {
  const result = parseClaudeLocalSetting({
    setting: "effort",
    args: "",
    stdout: "Set effort level to xhigh (saved as your default for new sessions): …",
  });
  expect(result).toEqual({ kind: "effort", id: "xhigh" });
});

test("effort: 'ultracode' (a slider label claude offers but agetor doesn't track) resolves to 'unrepresentable'", () => {
  const result = parseClaudeLocalSetting({
    setting: "effort",
    args: "",
    stdout: "Set effort level to ultracode (saved as your default for new sessions): …",
  });
  expect(result).toEqual({ kind: "unrepresentable", setting: "effort", raw: "ultracode" });
});

test("effort: 'Cancelled' (Esc out of the slider) resolves to null", () => {
  const result = parseClaudeLocalSetting({ setting: "effort", args: "", stdout: "Cancelled" });
  expect(result).toBeNull();
});

test("effort: garbage stdout resolves to null EVEN WITH a valid arg — outcome-first, not args-first", () => {
  // Was "effort: a non-empty arg wins over unparsable stdout" (expected
  // `{ effort: "medium" }`). Behavior changed on purpose: `args` reflects
  // what was TYPED, not what claude landed on, and unparsable stdout can't
  // confirm any change happened (this is the same class of bug as the
  // declined-confirm case above — the guard now bails on stdout FIRST,
  // regardless of args).
  const result = parseClaudeLocalSetting({ setting: "effort", args: "medium", stdout: "garbage" });
  expect(result).toBeNull();
});

test("effort: an arg that isn't a claude id (minimal — Cursor/Codex-only) also resolves to null via garbage stdout", () => {
  const result = parseClaudeLocalSetting({ setting: "effort", args: "minimal", stdout: "garbage" });
  expect(result).toBeNull();
});

// ---------------------------------------------------------------------------
// describeLocalSettingSync / describeUnrepresentableLocalSetting
// ---------------------------------------------------------------------------

test("describeLocalSettingSync formats the model breadcrumb", () => {
  expect(describeLocalSettingSync({ kind: "model", id: "opus-5" })).toBe("model synced from claude: opus-5");
});

test("describeLocalSettingSync formats the effort breadcrumb", () => {
  expect(describeLocalSettingSync({ kind: "effort", id: "high" })).toBe("effort synced from claude: high");
});

test("describeUnrepresentableLocalSetting formats the 'can't store' breadcrumb, current value shown as-is", () => {
  expect(
    describeUnrepresentableLocalSetting({ kind: "unrepresentable", setting: "effort", raw: "ultracode" }, "xhigh"),
  ).toBe(`claude is now on "ultracode", which agetor can't store — task effort left as xhigh`);
});

test("describeUnrepresentableLocalSetting shows 'unset' when the current value is null", () => {
  expect(
    describeUnrepresentableLocalSetting({ kind: "unrepresentable", setting: "model", raw: "Opus 6" }, null),
  ).toBe(`claude is now on "Opus 6", which agetor can't store — task model left as unset`);
});

// ---------------------------------------------------------------------------
// applyClaudeLocalSetting (src/bun/orchestrator.ts) — real temp db, isolation:
// "none" so no worktree/branch is ever created (see CLAUDE.md's worktree
// isolation warning).
// ---------------------------------------------------------------------------

async function makeClaudeTask(model: string, effort: string | null) {
  const created = await createTask({
    title: `local-setting sync ${crypto.randomUUID()}`,
    prompt: "noop",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
    model,
    effort,
  });
  if ("error" in created) throw new Error(created.error);
  return created.task;
}

/** Like `makeClaudeTask`, but also inserts a run row so `applyClaudeLocalSetting`
 *  has somewhere to attach its status breadcrumb — `runs.listForTask`
 *  otherwise comes back empty and `latestStatus` below finds nothing. */
async function makeClaudeTaskWithRun(model: string, effort: string | null) {
  const task = await makeClaudeTask(model, effort);
  runs.insert({
    id: crypto.randomUUID(),
    taskId: task.id,
    agent: "claude-code",
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
  });
  return task;
}

function latestStatus(taskId: string): string[] {
  const task = tasks.get(taskId);
  if (!task) return [];
  const run = runs.listForTask(taskId)[0];
  if (!run) return [];
  return runs.events(run.id).filter((e) => e.stream === "status").map((e) => e.data);
}

test("applyClaudeLocalSetting syncs task.model from a typed alias and advances updatedAt", async () => {
  const task = await makeClaudeTask("opus-4.8", "xhigh");
  // Give Date.now() room to tick so "updatedAt advanced" is unambiguous.
  await new Promise((r) => setTimeout(r, 5));

  const changed = applyClaudeLocalSetting(task.id, {
    setting: "model",
    args: "sonnet",
    stdout: "Set model to Sonnet 5 and saved as your default for new sessions",
  });

  expect(changed).toBe(true);
  const after = tasks.get(task.id);
  expect(after?.model).toBe("sonnet-5");
  // sonnet-5 supports xhigh, so the effort is left untouched.
  expect(after?.effort).toBe("xhigh");
  expect(after?.updatedAt).toBeGreaterThan(task.updatedAt);
});

test("applyClaudeLocalSetting is a no-op when the parsed model already matches the row", async () => {
  const task = await makeClaudeTask("sonnet-5", "xhigh");

  const changed = applyClaudeLocalSetting(task.id, {
    setting: "model",
    args: "sonnet",
    stdout: "Set model to Sonnet 5 and saved as your default for new sessions",
  });

  expect(changed).toBe(false);
  const after = tasks.get(task.id);
  expect(after?.model).toBe("sonnet-5");
  expect(after?.updatedAt).toBe(task.updatedAt); // no tasks.update call at all on the unchanged path
});

test("applyClaudeLocalSetting does not flip an already-equivalent model id reported via its claude arg", async () => {
  // NOTE: today's CLAUDE_MODEL_FLAG table is injective (no two agetor ids
  // map to the same claude flag), so the `toClaudeModelArg(next) ===
  // toClaudeModelArg(current)` half of the "unchanged" check in
  // applyClaudeLocalSetting is currently unreachable in practice — this case
  // is caught by the plain `next.model === task.model` branch instead. If a
  // future CLAUDE_MODEL_FLAG entry ever maps two agetor ids to one flag, the
  // alias check is what pins "the row keeps its original id" rather than
  // flipping to whichever id happened to round-trip through the flag.
  const task = await makeClaudeTask("opus-5", "xhigh");
  const changed = applyClaudeLocalSetting(task.id, {
    setting: "model",
    args: "claude-opus-5",
    stdout: "Set model to Opus 5 and saved as your default for new sessions",
  });
  expect(changed).toBe(false);
  expect(tasks.get(task.id)?.model).toBe("opus-5");
});

test("applyClaudeLocalSetting 'Kept model as' corrects a row that already drifted to a different value", async () => {
  // Simulates: the dropdown mirror already wrote "sonnet-5" onto the row
  // (the PATCH that triggered `reconcileTaskSession`'s /model mirror), but
  // the user answered "No, go back" on claude's "Switch model?" confirm —
  // so the live session actually kept "Opus 4.8". The row must be corrected
  // back to what claude actually kept, not left pointing at what was asked
  // for.
  const task = await makeClaudeTaskWithRun("sonnet-5", "xhigh");
  const changed = applyClaudeLocalSetting(task.id, {
    setting: "model",
    args: "",
    stdout: "Kept model as Opus 4.8",
  });
  expect(changed).toBe(true);
  expect(tasks.get(task.id)?.model).toBe("opus-4.8");
  expect(latestStatus(task.id).some((d) => d === "model synced from claude: opus-4.8")).toBe(true);
});

test("applyClaudeLocalSetting syncs task.effort; an unsupported claude id and a cancel are no-ops", async () => {
  const task = await makeClaudeTaskWithRun("opus-4.8", "medium");

  const changed = applyClaudeLocalSetting(task.id, {
    setting: "effort",
    args: "high",
    stdout: "Set effort level to high (saved as your default for new sessions): …",
  });
  expect(changed).toBe(true);
  expect(tasks.get(task.id)?.effort).toBe("high");

  const afterUnrepresentable = applyClaudeLocalSetting(task.id, {
    setting: "effort",
    args: "",
    stdout: "Set effort level to ultracode (saved as your default for new sessions): …",
  });
  expect(afterUnrepresentable).toBe(false);
  expect(tasks.get(task.id)?.effort).toBe("high"); // untouched
  expect(
    latestStatus(task.id).some((d) => d === `claude is now on "ultracode", which agetor can't store — task effort left as high`),
  ).toBe(true);

  const afterCancel = applyClaudeLocalSetting(task.id, {
    setting: "effort",
    args: "",
    stdout: "Cancelled",
  });
  expect(afterCancel).toBe(false);
  expect(tasks.get(task.id)?.effort).toBe("high"); // untouched
});

test("applyClaudeLocalSetting rejects an effort claude reports that isn't supported on the task's model", async () => {
  // sonnet-4.6 supports max/high/medium/low but NOT xhigh (MODEL_EFFORT_SUPPORT).
  // "xhigh" is a perfectly representable agetor id (unlike "ultracode"), but
  // this specific (model, effort) pair is one the RunPanel picker would
  // never allow — applyClaudeLocalSetting must reject it the same way
  // instead of silently widening the row past what the UI permits.
  const task = await makeClaudeTaskWithRun("sonnet-4.6", "medium");

  const changed = applyClaudeLocalSetting(task.id, {
    setting: "effort",
    args: "",
    stdout: "Set effort level to xhigh (saved as your default for new sessions): …",
  });

  expect(changed).toBe(false);
  expect(tasks.get(task.id)?.effort).toBe("medium"); // untouched
  expect(
    latestStatus(task.id).some((d) => d === `effort "xhigh" isn't supported on sonnet-4.6 in agetor — left as medium`),
  ).toBe(true);
});

test("applyClaudeLocalSetting adjusts an unsupported effort in the SAME update when the model sync causes it", async () => {
  // sonnet-5 supports xhigh; sonnet-4.6 does not (MODEL_EFFORT_SUPPORT).
  // Switching FROM a model that supports the saved effort TO one that
  // doesn't must land the effort fallback in the same tasks.update rather
  // than leaving an impossible (model, effort) pair on the row.
  const task = await makeClaudeTaskWithRun("sonnet-5", "xhigh");

  const changed = applyClaudeLocalSetting(task.id, {
    setting: "model",
    args: "",
    stdout: "Set model to Sonnet 4.6 and saved as your default for new sessions",
  });

  expect(changed).toBe(true);
  const after = tasks.get(task.id);
  expect(after?.model).toBe("sonnet-4.6");
  // DEFAULT_EFFORT["claude-code"] is "high", which sonnet-4.6 supports —
  // mirrors RunPanel's own effort-fallback effect exactly.
  expect(after?.effort).toBe("high");
  expect(
    latestStatus(task.id).some((d) => d === "model synced from claude: sonnet-4.6; effort adjusted to high (not supported on sonnet-4.6)"),
  ).toBe(true);
});

test("applyClaudeLocalSetting clears the effort in the SAME update when the new model accepts none at all", async () => {
  // haiku-4.5 has an EMPTY MODEL_EFFORT_SUPPORT entry — no effort id is
  // valid for it, so the fallback is null (cleared), not a substitute id.
  const task = await makeClaudeTaskWithRun("opus-4.8", "xhigh");

  const changed = applyClaudeLocalSetting(task.id, {
    setting: "model",
    args: "",
    stdout: "Set model to Haiku 4.5 and saved as your default for new sessions",
  });

  expect(changed).toBe(true);
  const after = tasks.get(task.id);
  expect(after?.model).toBe("haiku-4.5");
  expect(after?.effort).toBeNull();
  expect(
    latestStatus(task.id).some((d) => d === "model synced from claude: haiku-4.5; effort cleared (not supported on haiku-4.5)"),
  ).toBe(true);
});

test("applyClaudeLocalSetting: an unrepresentable model (unknown display name) is false + breadcrumb, row untouched", async () => {
  const task = await makeClaudeTaskWithRun("opus-4.8", "xhigh");

  const changed = applyClaudeLocalSetting(task.id, {
    setting: "model",
    args: "",
    stdout: "Set model to Opus 6 and saved as your default for new sessions",
  });

  expect(changed).toBe(false);
  const after = tasks.get(task.id);
  expect(after?.model).toBe("opus-4.8");
  expect(after?.effort).toBe("xhigh");
  expect(
    latestStatus(task.id).some((d) => d === `claude is now on "Opus 6", which agetor can't store — task model left as opus-4.8`),
  ).toBe(true);
});

test("applyClaudeLocalSetting no-ops for a non-claude-code task and leaves the row untouched", async () => {
  const created = await createTask({
    title: `codex task ${crypto.randomUUID()}`,
    prompt: "noop",
    agent: "codex",
    workdir: process.cwd(),
    isolation: "none",
    model: "gpt-5.5",
    effort: "medium",
  });
  if ("error" in created) throw new Error(created.error);
  const task = created.task;

  const changed = applyClaudeLocalSetting(task.id, {
    setting: "model",
    args: "sonnet",
    stdout: "Set model to Sonnet 5 and saved as your default for new sessions",
  });

  expect(changed).toBe(false);
  const after = tasks.get(task.id);
  expect(after?.model).toBe("gpt-5.5");
  expect(after?.effort).toBe("medium");
  expect(after?.updatedAt).toBe(task.updatedAt);
});

test("applyClaudeLocalSetting returns false for an unknown task id", () => {
  const changed = applyClaudeLocalSetting("no-such-task-id", {
    setting: "model",
    args: "sonnet",
    stdout: "Set model to Sonnet 5 and saved as your default for new sessions",
  });
  expect(changed).toBe(false);
});

test("applyClaudeLocalSetting appends a 'synced from claude' status breadcrumb to the task's most recent run", async () => {
  const task = await makeClaudeTask("opus-4.8", "xhigh");

  // Insert a run row directly via the `runs` module rather than starting a
  // real turn — applyClaudeLocalSetting only needs `runs.listForTask` to
  // find a row to attach the breadcrumb to; it never spawns anything.
  const run = runs.insert({
    id: crypto.randomUUID(),
    taskId: task.id,
    agent: "claude-code",
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
  });

  const changed = applyClaudeLocalSetting(task.id, {
    setting: "model",
    args: "sonnet",
    stdout: "Set model to Sonnet 5 and saved as your default for new sessions",
  });

  expect(changed).toBe(true);
  const events = runs.events(run.id);
  const statusEvents = events.filter((e) => e.stream === "status");
  expect(statusEvents.some((e) => e.data === "model synced from claude: sonnet-5")).toBe(true);
});

test("applyClaudeLocalSetting still returns true and updates the row (without throwing) when the task has no run row", async () => {
  const task = await makeClaudeTask("opus-4.8", "xhigh");
  expect(runs.listForTask(task.id)).toHaveLength(0);

  let changed: boolean | undefined;
  expect(() => {
    changed = applyClaudeLocalSetting(task.id, {
      setting: "model",
      args: "sonnet",
      stdout: "Set model to Sonnet 5 and saved as your default for new sessions",
    });
  }).not.toThrow();

  expect(changed).toBe(true);
  expect(tasks.get(task.id)?.model).toBe("sonnet-5");
});

test("applyClaudeLocalSetting never re-mirrors the change back into a live claude session", async () => {
  // Per the plan (docs/plans/model-effort-local-command-turns.md §10):
  // applyClaudeLocalSetting is the mirror image of reconcileTaskSession's
  // /model and /effort branch — that path pushes an agetor-side dropdown
  // change INTO a live tmux session via sendSlashCommand; this path pulls a
  // session-side change back ONTO the task row and must never call
  // sendSlashCommand / cycleToMode / reconcileTaskSession itself (that would
  // pop a spurious second "Switch model?"/"Change effort level?" confirm off
  // the very update being recorded). reconcileTaskSession is called from
  // exactly one place in this codebase: the PATCH /tasks/:id route
  // (server.ts), after the DB row is updated — never from
  // applyClaudeLocalSetting.
  //
  // applyClaudeLocalSetting is a plain (non-async) function that only calls
  // tasks.get/tasks.update/runs.listForTask/runs.appendEvent/emit — reading
  // its body confirms there is no tmux call site to spy on. As a runtime
  // regression guard: no in-memory SessionState exists for this task (we
  // never started a real session), so if a future edit accidentally routed
  // through sendSlashCommand/cycleToMode it would either no-op (both bail
  // out immediately when `sessions.get(taskId)` is undefined) or throw —
  // either way hasSessionState must stay false and the call must not throw.
  const task = await makeClaudeTask("opus-4.8", "xhigh");
  expect(hasSessionState(task.id)).toBe(false);

  expect(() => {
    applyClaudeLocalSetting(task.id, {
      setting: "effort",
      args: "high",
      stdout: "Set effort level to high (saved as your default for new sessions): …",
    });
  }).not.toThrow();

  expect(hasSessionState(task.id)).toBe(false);
});

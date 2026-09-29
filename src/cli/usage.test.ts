import { test, expect } from "bun:test";
import { USAGE, canonical, usageError, helpFor } from "./usage.ts";

const COMMANDS = [
  "add", "ls", "ps", "show", "start", "send", "commit", "answer", "commands", "logs",
  "files", "cancel", "attach", "shell", "edit", "move", "archive", "unarchive", "diff", "rm",
  "projects", "harness", "profile", "pipeline", "daemon", "info", "config",
];

test("every dispatched command has a USAGE block whose first line is its usage line", () => {
  for (const cmd of COMMANDS) {
    const block = USAGE[cmd];
    expect(block, cmd).toBeDefined();
    expect(block!.split("\n", 1)[0]!.startsWith(`usage: agetor ${cmd}`), cmd).toBe(true);
  }
});

test("canonical resolves aliases and passes real names through", () => {
  expect(canonical("mv")).toBe("move");
  expect(canonical("msg")).toBe("send");
  expect(canonical("inspect")).toBe("show");
  expect(canonical("tail")).toBe("logs");
  expect(canonical("delete")).toBe("rm");
  expect(canonical("harnesses")).toBe("harness");
  expect(canonical("profiles")).toBe("profile");
  expect(canonical("project")).toBe("projects");
  expect(canonical("sent")).toBe("files");
  expect(canonical("commit")).toBe("commit");
});

// docs/plans/task-details-agent-row.md D4: the CLI's `agent`/`agents`
// subcommand spelling was retired in favor of `profile`/`profiles` — `agent`
// in the CLI means the harness (`--agent <harness id>`), never the agent
// profile subcommand. `agent`/`agents` must resolve to nothing (index.ts's
// dispatcher then falls through to "unknown command"), while `profile` and
// its `profiles` alias are real.
test("the retired 'agent'/'agents' profile-subcommand spelling has no USAGE block; 'profile'/'profiles' replaces it", () => {
  expect(USAGE["agent"]).toBeUndefined();
  expect(USAGE["agents"]).toBeUndefined();
  expect(canonical("agent")).toBe("agent"); // not an alias — passes through unresolved
  expect(USAGE[canonical("agent")]).toBeUndefined();
  expect(USAGE["profile"]).toBeDefined();
  expect(canonical("profiles")).toBe("profile");
  expect(USAGE["profile"]!.split("\n", 1)[0]).toBe("usage: agetor profile <ls | show <ref> | add <name> … | edit <ref> … | rm <ref>>");
});

test("usageError throws only the concise first line, resolving aliases", () => {
  const e = usageError("commit");
  expect(e.message).toBe("usage: agetor commit <task-id>");
  expect(e.message.includes("\n")).toBe(false);
  expect(usageError("mv").message.startsWith("usage: agetor move")).toBe(true);
  expect(usageError("harness add").message).toBe(USAGE["harness add"]!.split("\n", 1)[0]!);
  expect(usageError("frobnicate").message).toContain("unknown command");
});

test("helpFor resolves command, subcommand, alias, and falls back", () => {
  expect(helpFor("edit", undefined)).toBe(USAGE["edit"]);
  expect(helpFor("mv", undefined)).toBe(USAGE["move"]); // alias
  expect(helpFor("harness", "add")).toBe(USAGE["harness add"]); // subcommand
  expect(helpFor("harness", "rm")).toBe(USAGE["harness"]); // unknown sub → command block
  expect(helpFor("projects", "add")).toBe(USAGE["projects add"]);
  expect(helpFor(undefined, undefined)).toBeUndefined();
  expect(helpFor("frobnicate", undefined)).toBeUndefined();
});

// T7 (CLI parity for pipelines, docs/plans/pipelines.md §3/D14): 'pipeline' /
// 'pipelines' mirror 'profile' / 'profiles''s alias + subcommand-block shape.
test("pipeline: 'pipelines' aliases to 'pipeline', with export/import subcommand blocks", () => {
  expect(canonical("pipelines")).toBe("pipeline");
  expect(USAGE["pipeline"]).toBeDefined();
  expect(USAGE["pipeline"]!.split("\n", 1)[0]).toBe(
    "usage: agetor pipeline <ls | show <ref> | rm <ref> | export <ref> [--out <file|->] [--force] | import <file|-> [--name <n>] | retry <task> [--from <task>] | advance <task> [--next <step>… | --finish] [--from <task>] | restart <task> | status <task>>",
  );
  expect(helpFor("pipelines", "export")).toBe(USAGE["pipeline export"]);
  expect(helpFor("pipeline", "import")).toBe(USAGE["pipeline import"]);
  expect(helpFor("pipeline", "rm")).toBe(USAGE["pipeline"]); // unknown sub → command block
  expect(usageError("pipeline").message).toBe(USAGE["pipeline"]!.split("\n", 1)[0]!);
});

// m7 review fix: retry/advance/restart/status are task-scoped subcommands
// (control a pipeline TASK's run), distinct from the pipeline-template
// subcommands above — each gets its own USAGE block, same shape as
// "pipeline export"/"pipeline import".
test("pipeline: retry/advance/restart/status each have their own subcommand block", () => {
  for (const sub of ["retry", "advance", "restart", "status"]) {
    const block = USAGE[`pipeline ${sub}`];
    expect(block, sub).toBeDefined();
    expect(block!.split("\n", 1)[0]!.startsWith(`usage: agetor pipeline ${sub} <task-id>`), sub).toBe(true);
    expect(helpFor("pipeline", sub)).toBe(block);
    expect(helpFor("pipelines", sub)).toBe(block); // alias resolves too
  }
});

// m7 review fix: `agetor cancel` routes a pipeline task through the pipeline
// cancel path instead of the generic "task is not running" error — pinned
// end to end in `src/cli/lifecycle.test.ts` (cmdCancel: parent →
// cancelPipeline, step/plain task → cancelRun). Documented here too.
test("cancel usage mentions pipeline-task routing", () => {
  expect(USAGE["cancel"]).toContain("pipeline task");
});

// ls/add doc lines reference the new --steps / --pipeline flags — a plain
// grep-style assertion so a future rewrite of either help block can't
// silently drop the flag's mention.
// L-CLI1/L-CLI2/L-CLI5: the retry block's usage line (what `usageError`
// prints on a bad flag) must mention --from; advance's precedence wording
// must match `resolveStepRef` (name → id → label); export documents
// `--out -`/`--force`; import documents the profile remap/warn behaviour.
test("pipeline subcommand blocks document --from, label matching, --out -/--force, and profile remapping", () => {
  expect(USAGE["pipeline retry"]!.split("\n", 1)[0]).toContain("[--from <step-task-id-or-prefix>]");
  expect(usageError("pipeline retry").message).toContain("--from");
  expect(USAGE["pipeline advance"]).toContain("step name, then step id, then an edge label");
  expect(USAGE["pipeline export"]).toContain("--force");
  expect(USAGE["pipeline export"]).toContain("'-' is stdout");
  expect(USAGE["pipeline import"]).toContain("profileName");
});

test("ls usage mentions --steps; add usage mentions --pipeline", () => {
  expect(USAGE["ls"]).toContain("--steps");
  expect(USAGE["add"]).toContain("--pipeline");
});

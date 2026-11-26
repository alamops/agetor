// R2-S3: the router's `planApprovalFlipsToAuto` lookup runs against the real task store and shares its rule with the approve route, so a
// Plan-to-Auto approval is classified (operate, signed, unlock window) by the very predicate the route acts on. Every other router test stubs
// the lookup; this one does not.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// `bun test` runs every file in one process, so what this file sets is put back after it (the data dir is the exception: `db.ts` keeps the
// first one it opened for the whole process).
const ENV_KEYS = ["AGETOR_DATA_DIR", "AGETOR_CLAUDE_DRIVER", "AGETOR_CLAUDE_BIN", "AGETOR_TMUX_BIN", "AGETOR_CLAUDE_ARGS"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-test-"));
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

async function newTask(title: string): Promise<string> {
  const { createTask } = await import("../orchestrator.ts");
  const created = await createTask({ title, prompt: "p", agent: "claude-code", workdir: mkdtempSync(path.join(tmpdir(), "agetor-plan-wd-")), isolation: "none" });
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}

test("the live lookup agrees with the shared predicate for every kind of task, and fails closed on an unknown one", async () => {
  const { tasks } = await import("../db.ts");
  const { createLiveLookups } = await import("./router.ts");
  const { planApprovalFlipsToAuto } = await import("../../shared/plan-approval.ts");
  const lookups = createLiveLookups();

  const plain = await newTask("plan, unbound");
  tasks.update(plain, { mode: "plan" });
  const bound = await newTask("plan, profile-bound");
  tasks.update(bound, { mode: "plan" });
  tasks.setAgentProfile(bound, "profile-x", { id: "profile-x", name: "Bound" } as never);
  const ask = await newTask("ask");
  tasks.update(ask, { mode: "ask" });

  expect(await lookups.planApprovalFlipsToAuto(plain)).toBe(true);
  expect(await lookups.planApprovalFlipsToAuto(bound)).toBe(false);
  expect(await lookups.planApprovalFlipsToAuto(ask)).toBe(false);
  expect(await lookups.planApprovalFlipsToAuto("no-such-task")).toBe(true);

  for (const id of [plain, bound, ask]) expect(await lookups.planApprovalFlipsToAuto(id)).toBe(planApprovalFlipsToAuto(tasks.get(id)!));
});

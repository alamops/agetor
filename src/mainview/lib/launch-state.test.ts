import { describe, expect, test } from "bun:test";
import {
  AGENT_OPTIONS,
  CODE_PLAN_MODE,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  defaultModeFor,
  type AgentKind,
  type AgentProfile,
  type AgentStatus,
} from "../../shared/types.ts";
import {
  buildModelOptions,
  resolveDefaultModel,
  resolveSeedModel,
} from "../../shared/model-catalog.ts";
import type { DiscoveredModel } from "../../shared/model-options.ts";
import {
  LAUNCH_KINDS,
  codeVariants,
  harnessStatusTone,
  initialPickCache,
  launchGate,
  modeForPrimary,
  primaryModeOf,
  rememberPickPrefs,
  resolveSeedOutcome,
  seedPickCache,
  submitPicks,
  switchPicks,
  type LaunchGateInput,
} from "./launch-state.ts";

const profile = (over: Partial<AgentProfile> = {}): AgentProfile =>
  ({
    id: "p1", name: "P", harness: "codex", mode: "ask", model: "gpt-x", effort: "high", speed: "fast", maxMode: true,
    ...over,
  }) as AgentProfile;

describe("initialPickCache / seedPickCache", () => {
  test("every kind starts on its own defaults", () => {
    const c = initialPickCache();
    for (const k of LAUNCH_KINDS) {
      expect(c[k].mode).toBe(defaultModeFor(k));
      expect(c[k].model).toBe(DEFAULT_MODEL[k]);
      expect(c[k].effort).toBe(DEFAULT_EFFORT[k]);
      expect(c[k].speed).toBe("off");
      expect(c[k].maxMode).toBe(false);
    }
  });

  test("a valid last* set seeds that kind, in one pass for every kind", () => {
    const claudeModel = AGENT_OPTIONS["claude-code"].models[1]!.id;
    const { cache, pending } = seedPickCache(initialPickCache(), {
      "lastMode:claude-code": "plan",
      "lastModel:claude-code": claudeModel,
      "lastSpeed:claude-code": "fast",
      "lastMaxMode:cursor": "true",
      "lastMode:gemini": "ask",
    });
    expect(cache["claude-code"].mode).toBe("plan");
    expect(cache["claude-code"].model).toBe(claudeModel);
    expect(cache["claude-code"].speed).toBe("fast");
    expect(cache.cursor.maxMode).toBe(true);
    expect(cache.gemini.mode).toBe("ask");
    expect(pending["claude-code"]).toBeUndefined();
  });

  test("an invalid mode or speed is ignored", () => {
    const { cache } = seedPickCache(initialPickCache(), {
      "lastMode:claude-code": "no-such-mode",
      "lastSpeed:claude-code": "warp",
      "lastMaxMode:cursor": "maybe",
    });
    expect(cache["claude-code"].mode).toBe(defaultModeFor("claude-code"));
    expect(cache["claude-code"].speed).toBe("off");
    expect(cache.cursor.maxMode).toBe(false);
  });

  test("a model the curated list lacks becomes a pending seed; so does any model of a CLI-authoritative kind", () => {
    const { cache, pending } = seedPickCache(initialPickCache(), {
      "lastModel:claude-code": "claude-from-the-catalog",
      "lastEffort:claude-code": "high",
      "lastModel:codex": AGENT_OPTIONS.codex.models[0]!.id,
    });
    expect(cache["claude-code"].model).toBe(DEFAULT_MODEL["claude-code"]);
    expect(pending["claude-code"]).toEqual({ model: "claude-from-the-catalog", effort: "high" });
    expect(pending.codex?.model).toBe(AGENT_OPTIONS.codex.models[0]!.id);
  });

  test("an effort the seeded model can't take collapses to the default, or null when the model takes none", () => {
    const { cache } = seedPickCache(initialPickCache(), { "lastEffort:claude-code": "not-an-effort" });
    expect(cache["claude-code"].effort).toBe(DEFAULT_EFFORT["claude-code"]);
  });
});

describe("switchPicks", () => {
  test("codex(X) → claude → codex restores X", () => {
    const start = initialPickCache();
    const x = { mode: "ask", model: "m-x", effort: "high", speed: "fast" as const, maxMode: false };
    const toClaude = switchPicks(start, "codex", x, "claude-code");
    expect(toClaude.next).toEqual(start["claude-code"]);
    const back = switchPicks(toClaude.cache, "claude-code", toClaude.next, "codex");
    expect(back.next).toEqual(x);
  });
  test("two accounts of one kind share one slot", () => {
    const start = initialPickCache();
    const y = { ...start["claude-code"], model: "m-y" };
    const r = switchPicks(start, "claude-code", y, "claude-code");
    expect(r.next).toEqual(y);
  });
});

describe("rememberPickPrefs", () => {
  test("writes exactly the five keys, omitting lastEffort when null", () => {
    const p = { mode: "auto", model: "m", effort: "high", speed: "fast" as const, maxMode: false };
    expect(rememberPickPrefs("claude-code", p).map(([k]) => k)).toEqual([
      "lastMode:claude-code", "lastModel:claude-code", "lastEffort:claude-code", "lastSpeed:claude-code", "lastMaxMode:claude-code",
    ]);
    expect(rememberPickPrefs("claude-code", { ...p, effort: null }).map(([k]) => k)).not.toContain("lastEffort:claude-code");
    expect(rememberPickPrefs("claude-code", p).find(([k]) => k.startsWith("lastSpeed"))![1]).toBe("fast");
  });
  test("lastMaxMode is true only for cursor", () => {
    const p = { mode: "auto", model: "m", effort: null, speed: "off" as const, maxMode: true };
    expect(rememberPickPrefs("codex", p).find(([k]) => k.startsWith("lastMaxMode"))![1]).toBe("false");
    expect(rememberPickPrefs("cursor", p).find(([k]) => k.startsWith("lastMaxMode"))![1]).toBe("true");
  });
});

describe("submitPicks (B1)", () => {
  const picks = { mode: "auto", model: "m", effort: "high", speed: "fast" as const, maxMode: true };
  test("Fast chosen for claude-code and codex is submitted, not dropped", () => {
    // The pre-fix expression was `kind === "cursor" || kind === "fx" ? speed : "off"`.
    expect(submitPicks({ kind: "claude-code", picks, profile: null }).speed).toBe("fast");
    expect(submitPicks({ kind: "codex", picks, profile: null }).speed).toBe("fast");
    expect(submitPicks({ kind: "cursor", picks, profile: null }).speed).toBe("fast");
    expect(submitPicks({ kind: "fx", picks, profile: null }).speed).toBe("fast");
  });
  test("Max Mode is submitted for cursor only", () => {
    expect(submitPicks({ kind: "cursor", picks, profile: null }).maxMode).toBe(true);
    for (const k of LAUNCH_KINDS.filter((x) => x !== "cursor")) {
      expect(submitPicks({ kind: k, picks, profile: null }).maxMode).toBe(false);
    }
  });
  test("a profile's values replace the manual picks", () => {
    expect(submitPicks({ kind: "claude-code", picks, profile: profile() })).toEqual({
      mode: "ask", model: "gpt-x", effort: "high", speed: "fast", maxMode: true,
    });
  });
});

describe("primary mode", () => {
  test("Plan is the kind's plan mode; every other id is Code", () => {
    for (const k of LAUNCH_KINDS) {
      expect(primaryModeOf(k, CODE_PLAN_MODE[k].plan)).toBe("plan");
      expect(primaryModeOf(k, CODE_PLAN_MODE[k].code)).toBe("code");
    }
    expect(primaryModeOf("claude-code", "acceptEdits")).toBe("code");
  });
  test("clicking Code while in a code variant is a no-op; Plan maps to the plan mode", () => {
    expect(modeForPrimary("claude-code", "acceptEdits", "code")).toBeNull();
    expect(modeForPrimary("claude-code", "auto", "code")).toBeNull();
    expect(modeForPrimary("claude-code", "auto", "plan")).toBe(CODE_PLAN_MODE["claude-code"].plan);
    expect(modeForPrimary("claude-code", "plan", "code")).toBe(CODE_PLAN_MODE["claude-code"].code);
    expect(modeForPrimary("codex", "auto", "plan")).toBe(CODE_PLAN_MODE.codex.plan);
  });
  test("codeVariants excludes the plan mode", () => {
    const v = codeVariants("claude-code", DEFAULT_MODEL["claude-code"]);
    expect(v.some((m) => m.id === CODE_PLAN_MODE["claude-code"].plan)).toBe(false);
    expect(v.length).toBeGreaterThan(1);
  });
});

describe("harnessStatusTone", () => {
  const st = (over: Partial<AgentStatus>): AgentStatus => ({ available: true, loggedIn: null, ...over }) as AgentStatus;
  test("error / warn / ok / unknown", () => {
    expect(harnessStatusTone(st({ available: false }))).toBe("error");
    expect(harnessStatusTone(st({ loggedIn: false }))).toBe("warn");
    expect(harnessStatusTone(st({ loggedIn: true }))).toBe("ok");
    expect(harnessStatusTone(st({ loggedIn: null }))).toBe("ok");
    expect(harnessStatusTone(undefined)).toBe("unknown");
  });
});

describe("launchGate", () => {
  const ok: LaunchGateInput = {
    title: "t", prompt: "p", requireTitle: true, reposCount: 1, worktreeValid: true, overage: false,
    effectiveLaunchable: true, effectiveHarnessLabel: "Claude Code", pipelineSelected: false, pipelineReady: true,
    pipelineState: "no-pipeline", pipelineProblem: null,
  };
  test("everything valid → both allowed, no reason", () => {
    expect(launchGate(ok)).toEqual({ canRun: true, canBacklog: true, runBlockedReason: null });
  });
  test("a missing title, prompt or project blocks both actions", () => {
    for (const bad of [{ title: " " }, { prompt: "" }, { reposCount: 0 }]) {
      const g = launchGate({ ...ok, ...bad });
      expect(g.canRun).toBe(false);
      expect(g.canBacklog).toBe(false);
    }
  });
  test("the reason names only what is missing", () => {
    expect(launchGate({ ...ok, title: " " }).runBlockedReason).toBe("Add a title");
    expect(launchGate({ ...ok, prompt: "" }).runBlockedReason).toBe("Add a prompt");
    expect(launchGate({ ...ok, reposCount: 0 }).runBlockedReason).toBe("Add a project");
    expect(launchGate({ ...ok, title: "", prompt: "" }).runBlockedReason).toBe("Add a title and a prompt");
    expect(launchGate({ ...ok, title: "", prompt: "", reposCount: 0 }).runBlockedReason).toBe("Add a title, a prompt and a project");
  });
  test("the dialogs don't need a title", () => {
    expect(launchGate({ ...ok, title: "", requireTitle: false }).canRun).toBe(true);
    expect(launchGate({ ...ok, title: "", requireTitle: false, prompt: "" }).runBlockedReason).toBe("Add a prompt");
    expect(launchGate({ ...ok, title: "", requireTitle: false, prompt: "", reposCount: 0 }).runBlockedReason).toBe("Add a prompt and a project");
  });
  test("an invalid worktree or an oversize prompt blocks both", () => {
    expect(launchGate({ ...ok, worktreeValid: false })).toMatchObject({ canRun: false, canBacklog: false });
    expect(launchGate({ ...ok, overage: true })).toMatchObject({ canRun: false, canBacklog: false });
  });
  test("an unavailable harness blocks only Run, with the harness and its reason", () => {
    const g = launchGate({ ...ok, effectiveLaunchable: false, effectiveHarnessLabel: "Copilot", effectiveReason: "copilot not installed" });
    expect(g.canRun).toBe(false);
    expect(g.canBacklog).toBe(true);
    expect(g.runBlockedReason).toBe("Copilot can't start: copilot not installed. Add it to the backlog or pick another harness");
  });
  test("a harness whose status hasn't arrived yet makes Run wait, not fail", () => {
    const g = launchGate({ ...ok, effectiveLaunchable: false, statusKnown: false, effectiveHarnessLabel: "Codex" });
    expect(g).toMatchObject({ canRun: false, canBacklog: true });
    expect(g.runBlockedReason).toBe("Checking Codex availability…");
  });
  test("a pipeline that is checking or blocked blocks only Run, with its own text", () => {
    const checking = launchGate({ ...ok, pipelineSelected: true, pipelineReady: false, pipelineState: "checking" });
    expect(checking).toMatchObject({ canRun: false, canBacklog: true });
    expect(checking.runBlockedReason).toContain("Checking");
    const blocked = launchGate({ ...ok, pipelineSelected: true, pipelineReady: false, pipelineState: "blocked", pipelineProblem: "Step 2 has no agent" });
    expect(blocked.runBlockedReason).toBe("Step 2 has no agent");
    expect(blocked.canBacklog).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Seeding characterization (S3): the unified (panel) seeding vs the dialogs'
// pre-unification seeding, which this test carries as an oracle. Every
// difference is an asserted, documented expectation; a NEW difference fails.
// ---------------------------------------------------------------------------

/** The dialogs' seeding before the unification (TaskLaunchPickers's open effect): the catalog is already loaded. */
function dialogOracleModel(kind: AgentKind, stored: string | undefined, discovered: DiscoveredModel[], loggedIn: boolean | null): string {
  const rows = buildModelOptions(kind, { discovered, loggedIn });
  return resolveSeedModel(kind, stored, rows) ?? resolveDefaultModel(kind, discovered, loggedIn);
}

/** The unified seeding: the cache seed, then the catalog arriving. */
function unifiedModel(kind: AgentKind, stored: string | undefined, discovered: DiscoveredModel[], loggedIn: boolean | null): string {
  const prefs = stored ? { [`lastModel:${kind}`]: stored } : {};
  const { cache, pending } = seedPickCache(initialPickCache(), prefs);
  let model = cache[kind].model;
  const rows = buildModelOptions(kind, { discovered, selected: model, loggedIn });
  const out = resolveSeedOutcome({ kind, currentModel: model, pending: pending[kind], rows, discovered, loggedIn });
  if (out.action === "apply" || out.action === "default") model = out.model;
  return model;
}

describe("seeding characterization: unified vs the dialogs' old seeding", () => {
  const catalog = (kind: AgentKind): DiscoveredModel[] => [
    { id: "catalog-only-model", label: "Catalog Only" },
    { id: AGENT_OPTIONS[kind].models[0]!.id, label: "first" },
    { id: "cli-default-model", label: "CLI default", cliDefault: true },
  ];
  type Case = { name: string; discovered: (k: AgentKind) => DiscoveredModel[]; loggedIn: boolean | null };
  const catalogs: Case[] = [
    { name: "empty", discovered: () => [], loggedIn: null },
    { name: "trusted", discovered: catalog, loggedIn: true },
    { name: "logged-out", discovered: catalog, loggedIn: false },
  ];
  const remembered: Array<{ name: string; pick: (k: AgentKind) => string | undefined }> = [
    { name: "none", pick: () => undefined },
    { name: "curated", pick: (k) => AGENT_OPTIONS[k].models[0]!.id },
    { name: "catalog-only", pick: () => "catalog-only-model" },
    { name: "unknown", pick: () => "retired-model-id" },
  ];

  // The documented differences, keyed `kind|remembered|catalog`. Each is the
  // unified result the PR body lists. Anything not listed must match the oracle.
  const KNOWN: Record<string, { unified: string; why: string }> = {};

  test("every kind × remembered × catalog agrees with the oracle except the documented rows", () => {
    const diffs: string[] = [];
    for (const kind of LAUNCH_KINDS) {
      for (const r of remembered) {
        for (const c of catalogs) {
          const stored = r.pick(kind);
          const d = c.discovered(kind);
          const want = dialogOracleModel(kind, stored, d, c.loggedIn);
          const got = unifiedModel(kind, stored, d, c.loggedIn);
          const key = `${kind}|${r.name}|${c.name}`;
          if (want === got) {
            expect(KNOWN[key]).toBeUndefined();
            continue;
          }
          const known = KNOWN[key];
          if (!known || known.unified !== got) diffs.push(`${key}: oracle=${want} unified=${got}`);
        }
      }
    }
    expect(diffs).toEqual([]);
  });

  test("a catalog-only remembered model is applied once a trusted catalog lands, and dropped while it is empty", () => {
    const d = catalog("claude-code");
    expect(unifiedModel("claude-code", "catalog-only-model", d, true)).toBe("catalog-only-model");
    expect(unifiedModel("claude-code", "catalog-only-model", [], null)).toBe(DEFAULT_MODEL["claude-code"]);
  });

  test("the default model follows a trusted catalog that lacks the owner's default", () => {
    const d: DiscoveredModel[] = [{ id: "only-model", label: "only", cliDefault: true }];
    expect(unifiedModel("claude-code", undefined, d, true)).toBe(resolveDefaultModel("claude-code", d, true));
  });
});

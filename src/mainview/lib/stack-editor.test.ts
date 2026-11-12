import { describe, expect, test } from "bun:test";
import {
  addMember,
  configRootKey,
  draftBlockers,
  draftFromStack,
  draftPatch,
  draftWarnings,
  emptyDraft,
  cooldownChips,
  formatUntil,
  groupHarnesses,
  guardedPatch,
  isMirrorRelevant,
  previewBody,
  previewSections,
  restoreSummary,
  memberPickerOptions,
  MIRROR_MODE_COPY,
  moveMember,
  removeMember,
  stackSaveFailure,
  virtualWindow,
} from "./stack-editor.ts";
import { ApiError } from "./api.ts";
import { ApiTransitError } from "./net-retry.ts";
import type { Harness, HarnessLimitState, HarnessStack, MirrorPreview } from "../../shared/types.ts";

const harness = (id: string, kind: Harness["kind"] = "claude-code", enabled = true): Harness => ({
  id,
  kind,
  label: id,
  isBuiltin: false,
  home: `/${id}`,
  bin: null,
  env: {},
  enabled,
});

const HARNESSES = [harness("a"), harness("b"), harness("c"), harness("x", "codex"), harness("off", "claude-code", false)];

describe("stack draft", () => {
  test("add, remove and reorder keep order and dedupe", () => {
    let draft = emptyDraft();
    draft = addMember(draft, "a");
    draft = addMember(draft, "b");
    draft = addMember(draft, "a");
    expect(draft.members).toEqual(["a", "b"]);
    draft = moveMember(draft, 0, 1);
    expect(draft.members).toEqual(["b", "a"]);
    draft = removeMember(draft, "b");
    expect(draft.members).toEqual(["a"]);
  });

  test("draftFromStack preserves the primary order and mirror mode", () => {
    const stack = {
      id: "s",
      label: "L",
      kind: "claude-code",
      mirrorMode: "safe",
      members: [
        { harnessId: "a", position: 0, label: "a", kind: "claude-code", enabled: true },
        { harnessId: "b", position: 1, label: "b", kind: "claude-code", enabled: true },
      ],
      createdAt: 1,
      updatedAt: 1,
      warnings: [],
    } satisfies HarnessStack;
    expect(draftFromStack(stack)).toEqual({ label: "L", kind: "claude-code", members: ["a", "b"], mirrorMode: "safe" });
  });

  test("draftPatch only sends what changed (a rename does not resend members)", () => {
    const stack = {
      id: "s",
      label: "L",
      kind: "claude-code",
      mirrorMode: "safe",
      members: [
        { harnessId: "a", position: 0, label: "a", kind: "claude-code", enabled: true },
        { harnessId: "b", position: 1, label: "b", kind: "claude-code", enabled: true },
      ],
      createdAt: 1,
      updatedAt: 1,
      warnings: [],
    } satisfies HarnessStack;

    expect(draftPatch(stack, { ...draftFromStack(stack), label: "Renamed" })).toEqual({ label: "Renamed" });
    expect(draftPatch(stack, { ...draftFromStack(stack), members: ["b", "a"] })).toEqual({ members: ["b", "a"] });
    expect(draftPatch(stack, { ...draftFromStack(stack), mirrorMode: "full" })).toEqual({ mirrorMode: "full" });
    expect(draftPatch(stack, draftFromStack(stack))).toEqual({});
  });

  test("blockers cover label, members, kind, unknown and prior membership", () => {
    const membership = new Map([["c", "other-stack"]]);
    const problems = draftBlockers(
      { label: "", kind: "claude-code", members: ["a", "x", "ghost", "c", "a"], mirrorMode: "full" },
      { harnesses: HARNESSES, stackId: null, membership },
    );
    const codes = problems.map((p) => p.code);
    expect(codes).toContain("no-label");
    expect(codes).toContain("duplicate-member");
    expect(codes).toContain("mixed-kinds");
    expect(codes).toContain("unknown-harness");
    expect(codes).toContain("already-in-stack");
    // Editing the stack that already owns the account is not a blocker.
    expect(
      draftBlockers(
        { label: "ok", kind: "claude-code", members: ["c"], mirrorMode: "full" },
        { harnesses: HARNESSES, stackId: "other-stack", membership },
      ),
    ).toEqual([]);
  });

  test("two members sharing a config directory are blocked like the server", () => {
    const sameHome = { ...harness("q"), home: "/a" };
    const problems = draftBlockers(
      { label: "L", kind: "claude-code", members: ["a", "q"], mirrorMode: "full" },
      { harnesses: [...HARNESSES, sameHome], stackId: null, membership: new Map() },
    );
    expect(problems.map((p) => p.code)).toContain("same-home");
    expect(problems.find((p) => p.code === "same-home")?.message).toContain("share the same config directory");
    // An explicit CLAUDE_CONFIG_DIR wins over `home`, exactly as the server's
    // `claudeConfigDirFor` precedence does.
    const envPinned = { ...harness("r"), home: "/elsewhere", env: { CLAUDE_CONFIG_DIR: "/a" } };
    expect(
      draftBlockers(
        { label: "L", kind: "claude-code", members: ["a", "r"], mirrorMode: "full" },
        { harnesses: [...HARNESSES, envPinned], stackId: null, membership: new Map() },
      ).map((p) => p.code),
    ).toContain("same-home");
    // Codex roots are `<home>/.codex`; distinct homes stay distinct.
    expect(
      draftBlockers(
        { label: "L", kind: "codex", members: ["x", "y"], mirrorMode: "full" },
        { harnesses: [...HARNESSES, harness("y", "codex")], stackId: null, membership: new Map() },
      ).map((p) => p.code),
    ).not.toContain("same-home");
  });

  describe("configRootKey follows the shared spawn precedence (N7)", () => {
    const homeless = (id: string, kind: Harness["kind"], env: Record<string, string>): Harness =>
      ({ ...harness(id, kind), home: null, env });
    const sameHomeCodes = (kind: HarnessStack["kind"], a: Harness, b: Harness) =>
      draftBlockers(
        { label: "L", kind, members: [a.id, b.id], mirrorMode: "full" },
        { harnesses: [a, b], stackId: null, membership: new Map() },
      ).map((p) => p.code);

    test("home-less accounts that differ only by env-map HOME do not share a config dir", () => {
      expect(sameHomeCodes("claude-code", homeless("h1", "claude-code", { HOME: "/u1" }), homeless("h2", "claude-code", { HOME: "/u2" })))
        .not.toContain("same-home");
      expect(sameHomeCodes("codex", homeless("c1", "codex", { HOME: "/u1" }), homeless("c2", "codex", { HOME: "/u2" })))
        .not.toContain("same-home");
      // An env-map HOME is not the default root either.
      expect(sameHomeCodes("claude-code", homeless("h1", "claude-code", { HOME: "/u1" }), homeless("h0", "claude-code", {})))
        .not.toContain("same-home");
      expect(configRootKey({ kind: "claude-code", home: null, env: { HOME: "/u1" } })).toBe("/u1/.claude");
      expect(configRootKey({ kind: "codex", home: null, env: { HOME: "/u1/" } })).toBe("/u1/.codex");
    });

    test("the same env-map CODEX_HOME / CLAUDE_CONFIG_DIR is one config dir, whatever HOME says", () => {
      expect(sameHomeCodes(
        "codex",
        homeless("c1", "codex", { CODEX_HOME: "/shared/codex", HOME: "/u1" }),
        homeless("c2", "codex", { CODEX_HOME: "/shared/codex/", HOME: "/u2" }),
      )).toContain("same-home");
      expect(sameHomeCodes(
        "claude-code",
        homeless("h1", "claude-code", { CLAUDE_CONFIG_DIR: "/shared/claude", HOME: "/u1" }),
        homeless("h2", "claude-code", { CLAUDE_CONFIG_DIR: "/shared/claude" }),
      )).toContain("same-home");
    });

    test("two default-root accounts still collide, and so does an explicit ~ path to that root", () => {
      expect(sameHomeCodes("claude-code", homeless("d1", "claude-code", {}), homeless("d2", "claude-code", {})))
        .toContain("same-home");
      expect(sameHomeCodes("codex", homeless("d1", "codex", {}), { ...harness("d2", "codex"), home: "~" }))
        .toContain("same-home");
      expect(sameHomeCodes("claude-code", homeless("d1", "claude-code", {}), { ...harness("d2"), home: "~/.claude" }))
        .toContain("same-home");
    });

    test("a blank env value is ignored, as the spawn ignores it", () => {
      expect(configRootKey({ kind: "claude-code", home: "/a", env: { CLAUDE_CONFIG_DIR: "  " } })).toBe("/a");
      expect(configRootKey({ kind: "codex", home: null, env: { CODEX_HOME: "", HOME: " " } }))
        .toBe(configRootKey({ kind: "codex", home: null, env: {} }));
    });
  });

  test("warnings cover <2, >10, full mirror and disabled", () => {
    const codes = draftWarnings(
      { label: "L", kind: "claude-code", members: ["a"], mirrorMode: "full" },
      { harnesses: HARNESSES },
    ).map((w) => w.code);
    expect(codes).toContain("too-few-members");
    expect(codes).toContain("full-mirror-hooks");
    expect(codes).not.toContain("member-disabled");
  });
});

describe("virtualWindow", () => {
  test("renders everything at or below the threshold", () => {
    expect(virtualWindow({ rowCount: 20, scrollTop: 400, rowHeight: 40, viewportHeight: 400 })).toEqual({
      start: 0,
      end: 20,
      leading: 0,
      trailing: 0,
      count: 20,
    });
  });

  test("above the threshold it renders the visible slice plus overscan", () => {
    const win = virtualWindow({ rowCount: 100, scrollTop: 40 * 20, rowHeight: 40, viewportHeight: 400, overscan: 2 });
    expect(win.start).toBe(18);
    expect(win.count).toBeLessThan(100);
    expect(win.leading).toBe(18);
    expect(win.end).toBeLessThanOrEqual(100);
    expect(win.end - win.start).toBe(win.count);
    // The bottom spacer keeps the scrollbar honest: leading + rows + trailing
    // must cover the whole list, or the list can never scroll to its end.
    expect(win.leading + win.count + win.trailing).toBe(100);
    expect(win.trailing).toBe(100 - win.end);
  });
});

describe("member picker (N5)", () => {
  const stackOf = (id: string, label: string, members: string[]): HarnessStack => ({
    id,
    label,
    kind: "claude-code",
    mirrorMode: "full",
    members: members.map((harnessId, position) => ({ harnessId, position, label: harnessId, kind: "claude-code", enabled: true })),
    createdAt: 1,
    updatedAt: 1,
    warnings: [],
  });

  test("a disabled account is selectable with a note, and the draft warns about it", () => {
    const draft = { label: "L", kind: "claude-code" as const, members: ["a"], mirrorMode: "safe" as const };
    const options = memberPickerOptions(draft, { harnesses: HARNESSES, stacks: [], membership: new Map() });
    const off = options.find((o) => o.harness.id === "off");
    expect(off).toEqual({ harness: HARNESSES[4]!, note: "disabled", selectable: true });
    // Already-chosen and other-kind accounts are not offered.
    expect(options.map((o) => o.harness.id)).toEqual(["b", "c", "off"]);
    const withOff = addMember(draft, "off");
    expect(draftBlockers(withOff, { harnesses: HARNESSES, stackId: null, membership: new Map() })).toEqual([]);
    expect(draftWarnings(withOff, { harnesses: HARNESSES })).toContainEqual({
      code: "member-disabled",
      harnessId: "off",
      message: "off is disabled.",
    });
  });

  test("an account in another stack is listed but not selectable", () => {
    const draft = { label: "L", kind: "claude-code" as const, members: [], mirrorMode: "full" as const };
    const options = memberPickerOptions(draft, {
      harnesses: HARNESSES,
      stacks: [stackOf("s2", "Other train", ["b"])],
      membership: new Map([["b", "s2"]]),
    });
    expect(options.find((o) => o.harness.id === "b")).toEqual({
      harness: HARNESSES[1]!,
      note: 'in stack "Other train"',
      selectable: false,
    });
    expect(options.find((o) => o.harness.id === "a")?.selectable).toBe(true);
  });
});

describe("mirror copy (S6)", () => {
  test("safe mode states exactly what it skips and what still mirrors", () => {
    expect(MIRROR_MODE_COPY.safe).toBe(
      "Safe skips settings hooks, permissions, status line and helper commands (Codex: notify); plugins and MCP servers are still mirrored.",
    );
  });

  test("the full-mirror warning names the same sections", () => {
    const warning = draftWarnings(
      { label: "L", kind: "claude-code", members: ["a", "b"], mirrorMode: "full" },
      { harnesses: HARNESSES },
    ).find((w) => w.code === "full-mirror-hooks");
    expect(warning?.message).toBe(
      "Full mirror copies settings hooks, permissions, status line and helper commands (Codex: notify) onto every backup.",
    );
  });
});

describe("stackSaveFailure (S21)", () => {
  test("a dropped connection may have saved the stack: say so and reload", () => {
    expect(stackSaveFailure(new ApiTransitError("request failed in transit"))).toEqual({
      message: "The connection dropped before agetor answered — the stack may have been saved — reloading.",
      reload: true,
    });
  });

  test("a server refusal is shown as-is with no reload", () => {
    expect(stackSaveFailure(new ApiError("b is already in another stack", 400, null))).toEqual({
      message: "b is already in another stack",
      reload: false,
    });
    expect(stackSaveFailure("boom")).toEqual({ message: "boom", reload: false });
  });
});

const stack3: HarnessStack = {
  id: "s",
  label: "L",
  kind: "claude-code",
  mirrorMode: "safe",
  members: ["a", "b"].map((id, position) => ({ harnessId: id, position, label: id, kind: "claude-code", enabled: true })),
  createdAt: 1,
  updatedAt: 42,
  warnings: [],
};

describe("guardedPatch and isMirrorRelevant (D16, D10)", () => {
  test("a changed field carries expectedUpdatedAt; no change is empty", () => {
    const draft = draftFromStack(stack3);
    expect(guardedPatch(stack3, { ...draft, label: "N" })).toEqual({ label: "N", expectedUpdatedAt: 42 });
    expect(guardedPatch(stack3, draft)).toEqual({});
  });

  test("order, members and mirror mode are mirror-relevant; a rename is not", () => {
    const draft = draftFromStack(stack3);
    expect(isMirrorRelevant(stack3, { ...draft, label: "N" })).toBe(false);
    expect(isMirrorRelevant(stack3, { ...draft, members: ["b", "a"] })).toBe(true);
    expect(isMirrorRelevant(stack3, { ...draft, mirrorMode: "full" })).toBe(true);
    expect(isMirrorRelevant(stack3, { ...draft, members: ["a"] })).toBe(false);
  });

  test("a new stack is relevant only with a backup", () => {
    expect(isMirrorRelevant(null, { ...emptyDraft(), members: ["a"] })).toBe(false);
    expect(isMirrorRelevant(null, { ...emptyDraft(), members: ["a", "b"] })).toBe(true);
  });

  test("previewBody carries the stack id only on an edit", () => {
    const draft = { ...draftFromStack(stack3) };
    expect(previewBody(draft, "s")).toEqual({ kind: "claude-code", members: ["a", "b"], mirrorMode: "safe", stackId: "s" });
    expect(previewBody(draft, null)).not.toHaveProperty("stackId");
  });
});

describe("previewSections", () => {
  const preview: MirrorPreview = {
    overwrites: true,
    plans: [
      {
        harnessId: "b",
        label: "B",
        files: { add: ["new.md"], update: ["settings.json"], remove: ["old.md"] },
        keys: [
          { file: ".claude.json", key: "mcpServers.x", action: "update" },
          { file: ".claude.json", key: "mcpServers.y", action: "add" },
          { file: ".claude.json", key: "mcpServers.z", action: "remove" },
        ],
        backups: ["settings.json"],
        kept: ["mine.md"],
        warnings: ["w"],
      },
      { harnessId: "c", label: "C", files: { add: ["a"], update: [], remove: [] }, keys: [], backups: [], kept: [], warnings: [] },
    ],
  };

  test("lists overwrites and removals only, plus backups, kept and warnings", () => {
    const sections = previewSections(preview);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toEqual({
      harnessId: "b",
      label: "B",
      overwrites: [
        "settings.json (overwritten)",
        "old.md (removed)",
        ".claude.json: mcpServers.x (overwritten)",
        ".claude.json: mcpServers.z (removed)",
      ],
      backedUp: ["settings.json"],
      kept: ["mine.md"],
      warnings: ["w"],
    });
  });
});

describe("cooldownChips (D13, D14)", () => {
  const now = new Date(2026, 10, 10, 12, 0).getTime();
  const row = (over: Partial<HarnessLimitState>): HarnessLimitState => ({
    harnessId: "a",
    reason: "quota",
    source: "claude-pane",
    message: "You've hit your limit",
    exhaustedUntilMs: new Date(2026, 10, 10, 14, 30).getTime(),
    updatedAt: now,
    model: null,
    ...over,
  });

  test("one chip per active row, soonest first, with the model and the provider message", () => {
    const chips = cooldownChips(
      [
        row({ model: "gpt-5", reason: "rate_limit", exhaustedUntilMs: new Date(2026, 10, 10, 15, 0).getTime() }),
        row({}),
        row({ harnessId: "b" }),
        row({ exhaustedUntilMs: now - 1, model: "old" }),
      ],
      "a",
      now,
    );
    expect(chips.map((c) => c.text)).toEqual([
      "usage limit · until 14:30",
      "rate limit · until 15:00 · for gpt-5",
    ]);
    expect(chips[0]!.message).toBe("You've hit your limit");
    expect(chips[1]!.model).toBe("gpt-5");
    expect(chips[1]!.ariaLabel).toBe("Cooling: rate limit for gpt-5, until 15:00");
  });

  test("a later day carries the date", () => {
    expect(formatUntil(new Date(2026, 10, 12, 9, 5).getTime(), now)).toMatch(/09:05$/);
    expect(formatUntil(new Date(2026, 10, 12, 9, 5).getTime(), now).length).toBeGreaterThan("09:05".length);
  });
});

describe("restoreSummary (D9)", () => {
  test("nothing to restore", () => {
    expect(restoreSummary({ harnessId: "a", restored: [], removed: [], kept: [], warnings: [] }))
      .toEqual({ empty: true, title: "Nothing to restore", description: "" });
  });

  test("counts and the first warnings", () => {
    const r = restoreSummary({
      harnessId: "a",
      restored: ["x", "y"],
      removed: ["z"],
      kept: [],
      warnings: ["w1", "w2", "w3", "w4"],
    });
    expect(r.empty).toBe(false);
    expect(r.description).toBe("2 restored, 1 removed, 0 kept (edited on this account); w1; w2; w3; …and 1 more");
  });
});

describe("groupHarnesses (D19)", () => {
  test("stack members in stack order, then the accounts in no stack", () => {
    const g = groupHarnesses(HARNESSES, [{ ...stack3, members: stack3.members.slice().reverse() }]);
    expect(g.stackGroups[0]!.members.map((h) => h.id)).toEqual(["b", "a"]);
    expect(g.others.map((h) => h.id)).toEqual(["c", "x", "off"]);
  });
});

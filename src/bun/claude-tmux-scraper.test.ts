import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Set data dir before db.ts is loaded transitively (claude-tmux.ts imports
// it now that the scraper looks up the task's runId).
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-scraper-"));

import { __forTest } from "./claude-tmux.ts";

const { matchNumberedModal, matchYesNoModal } = __forTest;

test("matchNumberedModal — claude plan-mode dialog (cursor on choice 1)", () => {
  const pane = `
  Edit file
    src/foo.ts
    1 line changed
  Do you want to make this edit to foo.ts?
  ❯ 1. Yes
    2. Yes, allow all
    3. No
`;
  const m = matchNumberedModal(pane);
  expect(m).not.toBeNull();
  expect(m!.choices.map((c) => c.key)).toEqual(["1", "2", "3"]);
  expect(m!.choices[0]!.label).toBe("Yes");
  expect(m!.choices[1]!.label).toBe("Yes, allow all");
  expect(m!.choices[2]!.label).toBe("No");
});

test("matchNumberedModal — alt cursor glyph (›)", () => {
  const pane = `Question?
› 1. Pick A
  2. Pick B`;
  const m = matchNumberedModal(pane);
  expect(m?.choices.length).toBe(2);
});

test("matchNumberedModal — no cursor anywhere means it's a printed list, not a modal", () => {
  const pane = `Here are the next steps:
  1. Install
  2. Configure
  3. Run`;
  expect(matchNumberedModal(pane)).toBeNull();
});

test("matchNumberedModal — only one numbered line → not a choice set", () => {
  const pane = `Foo
❯ 1. Just one`;
  expect(matchNumberedModal(pane)).toBeNull();
});

test("matchNumberedModal — same content yields a stable fingerprint", () => {
  const pane = `Q?
❯ 1. A
  2. B`;
  const a = matchNumberedModal(pane)!;
  const b = matchNumberedModal(pane + "\n   "); // trailing whitespace shouldn't change fp
  expect(a.fingerprint).toBe(b!.fingerprint);
});

test("matchNumberedModal — changing labels changes the fingerprint", () => {
  const a = matchNumberedModal(`❯ 1. A\n  2. B`)!;
  const b = matchNumberedModal(`❯ 1. A\n  2. C`)!;
  expect(a.fingerprint).not.toBe(b.fingerprint);
});

test("matchYesNoModal — (y/N) prompt on last line", () => {
  const pane = `Continue with the operation? (y/N)`;
  const m = matchYesNoModal(pane);
  expect(m).not.toBeNull();
  expect(m!.choices.map((c) => c.key)).toEqual(["y", "n"]);
});

test("matchYesNoModal — bracket variant [Y/n] with trailing colon", () => {
  const pane = `Proceed [Y/n]:`;
  const m = matchYesNoModal(pane);
  expect(m).not.toBeNull();
});

test("matchYesNoModal — ignores numbered modal pane (different signature)", () => {
  const pane = `❯ 1. Yes
  2. No`;
  expect(matchYesNoModal(pane)).toBeNull();
});

test("dispatchLine updates permissionMode BEFORE the dedup guard (reattach safety)", async () => {
  const { __forTest } = await import("./claude-tmux.ts");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir: t } = await import("node:os");
  const path2 = await import("node:path");
  const dir = mkdtempSync(path2.default.join(t(), "agetor-pm-"));
  const jsonl = path2.default.join(dir, "session.jsonl");
  writeFileSync(jsonl, "");
  const state = __forTest.installSession("t-pm-reattach", jsonl);
  // Simulate the reattach situation: the uuid is already in the dedup
  // set (the previous process persisted it to run_events), so any
  // SSE-emitting work would be skipped. The permission-mode update
  // must still apply because it lives ABOVE the dedup return.
  const uuid = "11111111-1111-1111-1111-111111111111";
  state.seenLineUuids.add(uuid);
  __forTest.dispatchLine(state, JSON.stringify({
    type: "permission-mode", uuid, permissionMode: "plan",
  }));
  expect(state.permissionMode).toBe("plan");
  __forTest.uninstallSession("t-pm-reattach");
});

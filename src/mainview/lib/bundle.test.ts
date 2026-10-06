import { describe, expect, test } from "bun:test";
import {
  EMPTY_IMPORT_OPTIONS,
  autoHarnessIds,
  bundleRequestBytes,
  BUNDLE_OPTIONS_HEADROOM_BYTES,
  bundleTextTooLarge,
  countsSummary,
  dragHasFiles,
  harnessChoices,
  harnessOptionLabel,
  importOptionsEdited,
  importOptionsReducer,
  importStatusText,
  importSuccessText,
  ownOption,
  pastedBundleTooLarge,
  pickBundleDropFile,
  previewOutdatedNote,
  pruneSelection,
  requestFailureText,
  lateImportConflictText,
  lateImportErrorText,
  importErrorPrefix,
  importErrorText,
  importRefusalText,
  lostImportLeftText,
  lostImportLanded,
  lostImportText,
  lostImportUnsettledText,
  lostImportVerdictText,
  rowFieldLabel,
  toImportOptions,
} from "./bundle.ts";
import { ApiTransitError, ApiUnreachableError } from "./net-retry.ts";
import { BUNDLE_MAX_BYTES, BUNDLE_MAX_REQUEST_BYTES } from "../../shared/bundle.ts";
import type { BundleLocalHarness, PlannedAgent } from "../../shared/bundle-import.ts";

function harness(id: string, over: Partial<BundleLocalHarness> = {}): BundleLocalHarness {
  return {
    id,
    kind: "claude-code",
    label: id,
    isBuiltin: false,
    enabled: true,
    available: null,
    loggedIn: null,
    reason: null,
    installHint: null,
    ...over,
  };
}

describe("summaries", () => {
  test("countsSummary pluralizes and skips zeros", () => {
    expect(countsSummary({ agents: 2, pipelines: 1 })).toBe("2 Agents, 1 Pipeline");
    expect(countsSummary({ agents: 1, pipelines: 0 })).toBe("1 Agent");
    expect(countsSummary({ agents: 0, pipelines: 3 })).toBe("3 Pipelines");
    expect(countsSummary({ agents: 0, pipelines: 0 })).toBe("nothing");
  });

  test("importSuccessText", () => {
    expect(importSuccessText({ agents: [{}, {}] as never, pipelines: [{}] as never })).toBe("Imported 2 Agents, 1 Pipeline");
  });
});

describe("importStatusText", () => {
  const plan = (agents: number, blocking: number) => ({
    agents: Array.from({ length: agents }, () => ({})) as never,
    pipelines: [] as never,
    blocking: Array.from({ length: blocking }, () => ({})) as never,
  });
  const base = {
    showPreview: true,
    pasteError: null,
    plan: plan(1, 0),
    planChanged: false,
    previewing: false,
    previewError: null,
    importing: false,
    importError: null,
  };

  test("a re-preview keeps the last plan's text, so it isn't re-announced", () => {
    expect(importStatusText(base)).toBe("Preview ready: 1 Agent, ready to import");
    expect(importStatusText({ ...base, previewing: true })).toBe("Preview ready: 1 Agent, ready to import");
    expect(importStatusText({ ...base, plan: plan(1, 2) })).toBe("Preview ready: 1 Agent, 2 blocking issues");
  });

  test("the first preview, failures, and the source step", () => {
    expect(importStatusText({ ...base, plan: null, previewing: true })).toBe("Reading the file…");
    expect(importStatusText({ ...base, previewError: { message: "boom" } })).toBe("Preview failed: boom");
    expect(importStatusText({ ...base, importing: true })).toBe("Importing…");
    expect(importStatusText({ ...base, importError: { message: "lost" } })).toBe(
      "Import failed: lost. Current plan: 1 Agent, ready to import",
    );
    // A refusal already says "Nothing was imported": no second lead-in.
    expect(
      importStatusText({ ...base, importError: { message: importRefusalText("import failed — nothing was imported: disk full") } }),
    ).toBe("Nothing was imported: disk full. Current plan: 1 Agent, ready to import");
    // A lost answer is never announced as "failed": it may have run.
    expect(importStatusText({ ...base, importError: { message: "checking", outcome: "unknown", lost: {} } })).toBe(
      "Import may have run: checking",
    );
    expect(importStatusText({ ...base, importError: { message: "ran", outcome: "ran" } })).toBe(
      "Import most likely ran: ran. Current plan: 1 Agent, ready to import",
    );
    expect(importStatusText({ ...base, importError: { message: "safe.", outcome: "not-run" } })).toBe(
      "Import didn't run: safe. Current plan: 1 Agent, ready to import",
    );
    expect(importStatusText({ ...base, plan: null, importError: { message: "x", outcome: "ran" } })).toBe(
      "Import most likely ran: x",
    );
    expect(importStatusText({ ...base, showPreview: false, pasteError: "too large" })).toBe("too large");
  });

  test("a failed preview is announced over an import error, and a pending verdict says it's still unknown", () => {
    const lost = { message: "The connection dropped. Checking it against a refreshed preview…", outcome: "unknown" as const, lost: {} };
    expect(importStatusText({ ...base, previewError: { message: "boom" }, importError: lost })).toBe(
      "Preview failed: boom. Whether the import ran is still unknown — retry the preview to find out.",
    );
    // A settled (sticky) verdict was already announced: the failure is the news.
    expect(
      importStatusText({ ...base, previewError: { message: "boom" }, importError: { message: "ran", outcome: "ran" } }),
    ).toBe("Preview failed: boom");
  });

  test("a sticky import warning still announces later plan changes", () => {
    const ran = { message: "Check your Agents.", outcome: "ran" as const };
    expect(importStatusText({ ...base, plan: plan(1, 1), importError: ran })).toBe(
      "Import most likely ran: Check your Agents. Current plan: 1 Agent, 1 blocking issue",
    );
    expect(importStatusText({ ...base, plan: plan(1, 0), importError: ran })).toBe(
      "Import most likely ran: Check your Agents. Current plan: 1 Agent, ready to import",
    );
    // An unsettled verdict (an edit dropped it) also keeps announcing the plan.
    expect(importStatusText({ ...base, plan: plan(1, 2), importError: { message: "may have run.", outcome: "unknown" } })).toBe(
      "Import may have run: may have run. Current plan: 1 Agent, 2 blocking issues",
    );
  });

  test("a refused import announces the updated plan, not a failure", () => {
    expect(importStatusText({ ...base, planChanged: true })).toBe(
      "Nothing was imported: the import changed since the preview. Updated plan: 1 Agent, ready to import",
    );
  });
});

describe("import options", () => {
  test("the reducer records names, harness picks and enable toggles", () => {
    let s = importOptionsReducer(EMPTY_IMPORT_OPTIONS, { type: "agent-name", key: "w", name: "New" });
    s = importOptionsReducer(s, { type: "pipeline-name", index: 0, name: "Flow" });
    s = importOptionsReducer(s, { type: "agent-harness", key: "w", harnessId: "claude-2" });
    s = importOptionsReducer(s, { type: "enable-harness", harnessId: "codex", enabled: true });
    s = importOptionsReducer(s, { type: "enable-harness", harnessId: "codex", enabled: true });
    expect(s).toEqual({
      agentNames: { w: "New" },
      pipelineNames: { "0": "Flow" },
      agentHarness: { w: "claude-2" },
      enableHarnesses: ["codex"],
    });
    expect(importOptionsEdited(s)).toBe(true);
    s = importOptionsReducer(s, { type: "enable-harness", harnessId: "codex", enabled: false });
    expect(s.enableHarnesses).toEqual([]);
    expect(importOptionsReducer(s, { type: "reset" })).toBe(EMPTY_IMPORT_OPTIONS);
    expect(importOptionsEdited(EMPTY_IMPORT_OPTIONS)).toBe(false);
  });

  test("a null harness drops the override, leaving the other Agents' alone", () => {
    let s = importOptionsReducer(EMPTY_IMPORT_OPTIONS, { type: "agent-harness", key: "w", harnessId: "claude-2" });
    s = importOptionsReducer(s, { type: "agent-harness", key: "__proto__", harnessId: "claude-code" });
    s = importOptionsReducer(s, { type: "agent-harness", key: "w", harnessId: null });
    expect(ownOption(s.agentHarness, "w")).toBeUndefined();
    expect(ownOption(s.agentHarness, "__proto__")).toBe("claude-code");
    s = importOptionsReducer(s, { type: "agent-harness", key: "__proto__", harnessId: null });
    expect(s.agentHarness).toEqual({});
    expect(importOptionsEdited(s)).toBe(false);
    // Dropping an override that isn't there changes nothing.
    expect(importOptionsReducer(s, { type: "agent-harness", key: "w", harnessId: null })).toBe(s);
  });

  test("autoHarnessIds records the planner's own picks and keeps them under an override", () => {
    const agent = (key: string, resolution: PlannedAgent["resolution"], harnessId: string | null) =>
      ({ key, resolution, harnessId }) as PlannedAgent;
    const first = autoHarnessIds({}, {
      agents: [agent("a", "exact", "claude-2"), agent("b", "fallback", "claude-code"), agent("c", "unresolved", null)],
    });
    expect(first).toEqual({ a: "claude-2", b: "claude-code", c: null });
    // With overrides in place (mapped/rebound) the planner's pick is kept.
    const second = autoHarnessIds(first, {
      agents: [agent("a", "mapped", "claude-code"), agent("b", "fallback", "claude-code"), agent("c", "rebound", "codex")],
    });
    expect(second).toBe(first);
    expect(Object.hasOwn(autoHarnessIds({}, { agents: [agent("__proto__", "exact", "x")] }), "__proto__")).toBe(true);
  });

  test("option reads never see Object.prototype members (an Agent named Constructor)", () => {
    // An exported Agent named "Constructor" gets the key "constructor".
    expect(ownOption(EMPTY_IMPORT_OPTIONS.agentNames, "constructor")).toBeUndefined();
    expect(ownOption(EMPTY_IMPORT_OPTIONS.agentHarness, "constructor")).toBeUndefined();
    expect(ownOption(EMPTY_IMPORT_OPTIONS.agentNames, "toString")).toBeUndefined();
    expect(ownOption(EMPTY_IMPORT_OPTIONS.agentNames, "__proto__")).toBeUndefined();
    let s = importOptionsReducer(EMPTY_IMPORT_OPTIONS, { type: "agent-name", key: "constructor", name: "Ctor" });
    s = importOptionsReducer(s, { type: "agent-name", key: "__proto__", name: "Proto" });
    s = importOptionsReducer(s, { type: "agent-harness", key: "constructor", harnessId: "claude-2" });
    expect(ownOption(s.agentNames, "constructor")).toBe("Ctor");
    expect(ownOption(s.agentNames, "__proto__")).toBe("Proto");
    expect(ownOption(s.agentHarness, "constructor")).toBe("claude-2");
    expect(ownOption(s.agentHarness, "__proto__")).toBeUndefined();
    expect(toImportOptions(s).agentNames).toEqual(JSON.parse('{"constructor":"Ctor","__proto__":"Proto"}'));
  });

  test("the reducer never mutates its input", () => {
    const before = { ...EMPTY_IMPORT_OPTIONS, agentNames: { a: "x" } };
    importOptionsReducer(before, { type: "agent-name", key: "a", name: "y" });
    expect(before.agentNames).toEqual({ a: "x" });
  });

  test("toImportOptions drops blank names and empty maps", () => {
    expect(toImportOptions(EMPTY_IMPORT_OPTIONS)).toEqual({});
    expect(
      toImportOptions({
        agentNames: { a: "  ", b: " Kept " },
        pipelineNames: { "0": "" },
        agentHarness: { a: "codex" },
        enableHarnesses: ["codex"],
      }),
    ).toEqual({ agentNames: { b: "Kept" }, agentHarness: { a: "codex" }, enableHarnesses: ["codex"] });
  });

  test("importOptionsEdited counts real changes, not keys: a name typed and cleared is no edit", () => {
    let s = importOptionsReducer(EMPTY_IMPORT_OPTIONS, { type: "agent-name", key: "w", name: "New" });
    expect(importOptionsEdited(s)).toBe(true);
    s = importOptionsReducer(s, { type: "agent-name", key: "w", name: "  " });
    expect(importOptionsEdited(s)).toBe(false);
    s = importOptionsReducer(s, { type: "enable-harness", harnessId: "codex", enabled: true });
    s = importOptionsReducer(s, { type: "enable-harness", harnessId: "codex", enabled: false });
    expect(importOptionsEdited(s)).toBe(false);
  });

  test("an empty or blank text is refused before any request", () => {
    expect(bundleTextTooLarge("", '"empty.agetor.json"')).toBe('"empty.agetor.json" is empty.');
    expect(bundleTextTooLarge(" \n\t", "it")).toBe("it is empty.");
    expect(pastedBundleTooLarge("")).toBe("The pasted JSON is empty.");
  });

  test("pastedBundleTooLarge counts UTF-8 bytes against the cap", () => {
    expect(pastedBundleTooLarge("{}")).toBeNull();
    expect(pastedBundleTooLarge("x".repeat(BUNDLE_MAX_BYTES))).toBeNull();
    expect(pastedBundleTooLarge("x".repeat(BUNDLE_MAX_BYTES + 1))).toContain("too large");
    expect(pastedBundleTooLarge("é".repeat(BUNDLE_MAX_BYTES / 2 + 1))).toContain("2 MB");
  });

  test("bundleRequestBytes measures the preview body as api.ts sends it", () => {
    const text = '{"a":"\u0001é"}';
    const body = JSON.stringify({ text, options: { agentNames: { w: "N" } } });
    expect(bundleRequestBytes(text, { agentNames: { w: "N" } })).toBe(new TextEncoder().encode(body).length);
    // A control character escapes to six bytes.
    expect(bundleRequestBytes("\u0001") - bundleRequestBytes("")).toBe(6);
  });

  test("text under 2 MB that escapes past the request cap is refused with its own copy", () => {
    // 1 MB of control characters: under the 2 MB text cap, ~6 MB once escaped.
    const controls = "\u0001".repeat(1024 * 1024);
    expect(bundleRequestBytes(controls)).toBeGreaterThan(BUNDLE_MAX_REQUEST_BYTES);
    const message = bundleTextTooLarge(controls, '"x.agetor.json"');
    expect(message).toContain("too large to send");
    expect(message).toContain('"x.agetor.json"');
    expect(message).not.toContain("the limit is");
    expect(pastedBundleTooLarge(controls)).toContain("The pasted JSON is too large to send");
    // Plain text right at the cap escapes to (almost) nothing more: allowed.
    expect(bundleTextTooLarge("x".repeat(BUNDLE_MAX_BYTES), "it")).toBeNull();
    // Room is kept for the options the user adds later: under the request
    // cap less that headroom once escaped is allowed …
    const budget = BUNDLE_MAX_REQUEST_BYTES - BUNDLE_OPTIONS_HEADROOM_BYTES;
    const fits = "\u0001".repeat(Math.floor((budget - 64) / 6));
    expect(bundleRequestBytes(fits)).toBeLessThanOrEqual(budget);
    expect(bundleTextTooLarge(fits, "it")).toBeNull();
    // … while a text that leaves no room for them is refused, even though its
    // empty-options body is still under the cap.
    const tight = "\u0001".repeat(Math.floor((BUNDLE_MAX_REQUEST_BYTES - 64) / 6));
    expect(bundleRequestBytes(tight)).toBeLessThanOrEqual(BUNDLE_MAX_REQUEST_BYTES);
    expect(bundleTextTooLarge(tight, "it")).toContain("too large to send");
    // The message names the budget enforced (the request cap less the
    // headroom), and a body just over it isn't rounded to the same figure.
    const justOver = "\u0001".repeat(Math.floor((budget - 20) / 6) + 3);
    expect(bundleRequestBytes(justOver)).toBeGreaterThan(budget);
    expect(bundleTextTooLarge(justOver, "it")).toBe(
      "it is too large to send: escaped for sending it comes to just over the 4 MB limit for sending — it likely holds many control characters.",
    );
    // Far over it, both figures are shown, and never the raw request cap.
    expect(message).toMatch(/comes to [\d.]+ MB, over the 4 MB limit for sending/);
    expect(message).not.toContain("4.1 MB");
    // Over 2 MB of text is the file limit, whatever it escapes to.
    expect(bundleTextTooLarge("x".repeat(BUNDLE_MAX_BYTES + 1), "it")).toBe("it is too large — the limit is 2 MB.");
  });

  test("harnessChoices keeps local order and only the candidates", () => {
    const plan = { localHarnesses: [harness("claude-code"), harness("codex", { kind: "codex" }), harness("claude-2")] };
    const agent = { candidateHarnessIds: ["claude-2", "claude-code"] } as PlannedAgent;
    expect(harnessChoices(agent, plan).map((h) => h.id)).toEqual(["claude-code", "claude-2"]);
  });

  test("harnessOptionLabel shows the label, the id when it differs, and a disabled marker", () => {
    expect(harnessOptionLabel(harness("claude-code", { label: "Claude Code" }))).toBe("Claude Code (claude-code)");
    expect(harnessOptionLabel(harness("codex", { enabled: false }))).toBe("codex — disabled");
  });
});

describe("dropped files", () => {
  test("dragHasFiles reads DataTransfer.types", () => {
    expect(dragHasFiles(["text/plain", "Files"])).toBe(true);
    expect(dragHasFiles(["text/plain"])).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
  });

  test("pickBundleDropFile takes a single .json file and refuses others", () => {
    const json = new File(["{}"], "x.agetor.json", { type: "application/json" });
    const txt = new File(["{}"], "notes.txt");
    expect(pickBundleDropFile([json])).toEqual({ file: json });
    expect(pickBundleDropFile([txt])).toEqual({ error: expect.stringContaining("isn't a .json file") });
    // Several files are refused outright — never silently only the first.
    expect(pickBundleDropFile([json, txt])).toEqual({ error: "Drop one file at a time — 2 files were dropped." });
    expect(pickBundleDropFile([json, json, json])).toEqual({ error: expect.stringContaining("3 files") });
    expect(pickBundleDropFile([])).toEqual({ error: expect.stringContaining("Drop a .json") });
    expect(pickBundleDropFile(null)).toEqual({ error: expect.stringContaining("Drop a .json") });
    const big = new File([new Uint8Array(BUNDLE_MAX_BYTES + 1)], "big.json");
    expect(pickBundleDropFile([big])).toEqual({ error: expect.stringContaining("too large") });
  });
});

describe("previewOutdatedNote", () => {
  test("points at Retry only when the failure is retryable", () => {
    expect(previewOutdatedNote({ retryable: true })).toBe("The preview is out of date — retry it to import");
    // A 400/413 renders no Retry button, so the note must not ask for one.
    expect(previewOutdatedNote({ retryable: false })).toBe("The preview is out of date — change the options to import");
  });
});

describe("lostImportText", () => {
  test("names the cause and that a refreshed preview will tell, without repeating its lead-in", () => {
    const text = lostImportText(new ApiTransitError("POST http://x/bundle/import failed — NOT retried"));
    expect(text).toStartWith("The connection to agetor's core dropped before it answered.");
    expect(text).toContain("refreshed preview");
    expect(text).not.toMatch(/may (already )?have run/);
    expect(text).not.toMatch(/NOT retried|http:/);
  });
});

describe("lostImportLanded", () => {
  test("an importable re-plan with the confirmed fingerprint proves it didn't run", () => {
    expect(lostImportLanded("fp1", { fingerprint: "fp1", canImport: true })).toBe(false);
  });

  test("a different fingerprint (the names were taken and renamed) reads as ran", () => {
    expect(lostImportLanded("fp1", { fingerprint: "fp2", canImport: true })).toBe(true);
    expect(lostImportLanded("fp1", { fingerprint: "fp2", canImport: false })).toBe(true);
  });

  test("a typed name keeps the fingerprint but now blocks as name-in-use: that ran too", () => {
    // The confirmed plan was importable; an identical fingerprint that can no
    // longer import means its typed names are taken — by this very import.
    expect(lostImportLanded("fp1", { fingerprint: "fp1", canImport: false })).toBe(true);
  });
});

describe("lostImportUnsettledText", () => {
  test("says why there's no verdict and where to look, without claiming one", () => {
    const text = lostImportUnsettledText("The connection dropped");
    expect(text).toStartWith("The connection dropped, and the options changed");
    expect(text).toContain("Check your Agents and Pipelines");
    expect(text).not.toMatch(/may (already )?have run/);
    expect(text).not.toMatch(/didn't run|most likely ran|safe to import/);
  });
});

describe("importErrorPrefix", () => {
  test("a plain failure says failed; a lost answer says what is known", () => {
    expect(importErrorPrefix(undefined)).toBe("Import failed:");
    expect(importErrorPrefix("unknown")).toBe("Import may have run:");
    expect(importErrorPrefix("ran")).toBe("Import most likely ran:");
    expect(importErrorPrefix("not-run")).toBe("Import didn't run:");
  });
});

describe("importErrorText", () => {
  test("a lost answer shows its lead-in; any other failure stands alone", () => {
    expect(importErrorText({ message: "Nothing was imported: x" })).toBe("Nothing was imported: x");
    expect(importErrorText({ message: "detail", outcome: "ran" })).toBe("Import most likely ran: detail");
    expect(importErrorText({ message: "detail", outcome: "unknown" })).toBe("Import may have run: detail");
  });

  test("lead-in plus verdict never repeats itself", () => {
    for (const landed of [true, false]) {
      const text = importErrorText({
        message: lostImportVerdictText("The connection dropped", landed),
        outcome: landed ? "ran" : "not-run",
      });
      expect(text.match(/\bran\b|didn't run/g)?.length).toBe(1);
    }
    const pending = importErrorText({ message: lostImportText(new ApiTransitError("x")), outcome: "unknown" });
    expect(pending.match(/may (already )?have run/g)?.length).toBe(1);
  });
});

describe("lostImportLeftText", () => {
  test("says it may have run and where to look", () => {
    const text = lostImportLeftText("The connection dropped");
    expect(text).toStartWith("The connection dropped, so the import may already have run");
    expect(text).toContain("check your Agents and Pipelines");
  });
});

describe("lostImportVerdictText", () => {
  test("a changed fingerprint reads as most likely ran; an identical one as safe to import again", () => {
    const landed = lostImportVerdictText("The connection dropped", true);
    expect(landed).toStartWith("The connection dropped, and the refreshed preview no longer matches");
    expect(landed).toContain("before importing again");
    expect(landed).not.toContain("safe to import again");
    const notLanded = lostImportVerdictText("The connection dropped", false);
    expect(notLanded).toStartWith("The connection dropped, but the refreshed preview matches");
    expect(notLanded).toContain("safe to import again");
  });
});

describe("rowFieldLabel", () => {
  test("field word first, and the row's position once there is more than one row", () => {
    expect(rowFieldLabel("Name", "Agent", "Reviewer", 0, 1)).toBe('Name: Agent "Reviewer"');
    expect(rowFieldLabel("Harness", "Agent", "Reviewer", 1, 3)).toBe('Harness: Agent "Reviewer" (2 of 3)');
    // Two rows of the same file name stay distinguishable.
    expect(rowFieldLabel("Name", "Pipeline", "Ship", 0, 2)).not.toBe(rowFieldLabel("Name", "Pipeline", "Ship", 1, 2));
  });
});

describe("lateImportConflictText", () => {
  test("picks blocked vs changed from the 409's plan, never pointing at a preview", () => {
    expect(lateImportConflictText({ canImport: false })).toBe("The import is blocked. Open Import again to see why.");
    const changed = lateImportConflictText({ canImport: true });
    expect(changed).toContain("changed since the preview");
    expect(lateImportConflictText(undefined)).toBe(changed);
    for (const t of [changed, lateImportConflictText({ canImport: false })]) {
      expect(t).not.toMatch(/review the new preview|Nothing was imported/i);
    }
  });

  test("an importable 409 plan identical to the confirmed one shows the core's reason, not 'changed'", () => {
    const sent = { fingerprint: "fp-1", message: "import failed — nothing was imported: name already taken" };
    expect(lateImportConflictText({ canImport: true, fingerprint: "fp-1" }, sent)).toBe(
      "name already taken. Open Import again to retry.",
    );
    // A different plan did change; a blocked one is blocked whatever its fingerprint.
    expect(lateImportConflictText({ canImport: true, fingerprint: "fp-2" }, sent)).toContain("changed since the preview");
    expect(lateImportConflictText({ canImport: false, fingerprint: "fp-1" }, sent)).toBe(
      "The import is blocked. Open Import again to see why.",
    );
  });
});

describe("lateImportErrorText", () => {
  test("drops the route's nothing-was-imported prefix the toast title already says", () => {
    expect(lateImportErrorText("import failed — nothing was imported: NOT NULL constraint failed")).toBe(
      "NOT NULL constraint failed. Open Import again to retry.",
    );
    expect(lateImportErrorText("request too large.")).toBe("request too large. Open Import again to retry.");
  });
});

describe("importRefusalText", () => {
  test("says nothing was imported exactly once", () => {
    expect(importRefusalText("import failed — nothing was imported: disk full")).toBe("Nothing was imported: disk full");
    expect(importRefusalText("Nothing was imported: the name is taken")).toBe("Nothing was imported: the name is taken");
    expect(importRefusalText("request too large")).toBe("Nothing was imported: request too large");
  });
});

describe("requestFailureText", () => {
  test("words a request with no HTTP answer for the user; keeps any other message", () => {
    const transit = new ApiTransitError(
      "request to http://127.0.0.1:4317/bundle/pick-file failed in transit (Load failed) — the server may have already processed it, so it was NOT retried because repeating it isn't safe.",
    );
    expect(requestFailureText(transit)).toBe("The connection to agetor's core dropped before it answered");
    const down = new ApiUnreachableError("cannot reach agetor API at http://x — Try restarting `bun run dev`.");
    expect(requestFailureText(down)).toBe("agetor's core isn't answering");
    for (const e of [transit, down]) {
      expect(requestFailureText(e)).not.toMatch(/NOT retried|bun run dev|http:/);
    }
    expect(requestFailureText(new Error("name in use"))).toBe("name in use");
    expect(requestFailureText("plain")).toBe("plain");
  });
});

describe("pruneSelection", () => {
  test("drops rows that left the list, and keeps the same set when none did", () => {
    const empty = new Set<string>();
    expect(pruneSelection(empty, [])).toBe(empty);
    const prev = new Set(["a", "b"]);
    expect(pruneSelection(prev, ["a", "b", "c"])).toBe(prev);
    expect([...pruneSelection(prev, ["b", "c"])]).toEqual(["b"]);
    expect(pruneSelection(prev, []).size).toBe(0);
    // A key that shadows Object.prototype is an ordinary id.
    expect([...pruneSelection(new Set(["constructor", "x"]), ["constructor"])]).toEqual(["constructor"]);
  });
});

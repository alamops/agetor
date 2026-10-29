import { expect, test } from "bun:test";
import {
  FX_PROVIDER_STATUS_PREFIX,
  FX_SESSION_TITLE_STATUS_PREFIX,
  FX_USAGE_STATUS_PREFIX,
  PERMISSION_MODE_STATUS_PREFIX,
  type Handoff,
  type PipelineStep,
  type RunEventStream,
} from "../../shared/types.ts";
import { composeStepPrompt } from "../../shared/pipeline.ts";
import {
  findMatchingEventIds,
  NO_MATCHES,
  resolveActiveMatchIndex,
  searchableEventText,
  stepMatchIndex,
} from "./event-search.ts";
import { AGETOR_PASTE_LEAD_IN } from "../../shared/user-message.ts";

type Ev = { stream: RunEventStream; data: string };

function ev(stream: RunEventStream, data: string): Ev {
  return { stream, data };
}

// ---------------------------------------------------------------------------
// searchableEventText
// ---------------------------------------------------------------------------

test("searchableEventText: passthrough streams return data verbatim", () => {
  const passthrough: RunEventStream[] = ["user", "assistant", "thinking", "status", "stderr", "stdout"];
  for (const stream of passthrough) {
    expect(searchableEventText(stream, "hello world")).toBe("hello world");
  }
});

test("searchableEventText: suppressed [Image: source: …] status breadcrumbs are never searchable", () => {
  // The log renderer emits no block for these (the attachment renders as a
  // thumbnail chip on the user bubble), so a match would navigate nowhere.
  expect(searchableEventText("status", "[Image: source: /Users/x/.agetor/screenshots/shot.png]")).toBeNull();
  // Historical rows truncated at the old 140-char status cap (lost `]`).
  expect(searchableEventText("status", "[Image: source: /Users/x/very/long/path/screensho…")).toBeNull();
  // Ordinary status text is unaffected.
  expect(searchableEventText("status", "background task: done")).toBe("background task: done");
});

test("searchableEventText: suppressed internal status sentinels are never searchable", () => {
  // RunPanel renders no DOM block for any of these (isInternalStatusSentinel),
  // so a match would navigate to an evid with no node.
  expect(searchableEventText("status", `${PERMISSION_MODE_STATUS_PREFIX}plan`)).toBeNull();
  expect(searchableEventText("status", `${FX_USAGE_STATUS_PREFIX}{"used":1234,"size":128000}`)).toBeNull();
  expect(searchableEventText("status", `${FX_PROVIDER_STATUS_PREFIX}gateway`)).toBeNull();
  // The title sentinel is human prose and would otherwise match real queries.
  expect(searchableEventText("status", `${FX_SESSION_TITLE_STATUS_PREFIX}Refactor the login flow`)).toBeNull();
  // Ordinary status text is unaffected.
  expect(searchableEventText("status", "session ended: tmux session gone")).toBe("session ended: tmux session gone");
});

test("searchableEventText: passthrough streams pass an empty string through unchanged", () => {
  expect(searchableEventText("assistant", "")).toBe("");
  expect(searchableEventText("stdout", "")).toBe("");
});

test("searchableEventText: interaction/interaction_resolved/subagent are never searchable", () => {
  expect(searchableEventText("interaction", '{"anything":"here"}')).toBeNull();
  expect(searchableEventText("interaction_resolved", '{"anything":"here"}')).toBeNull();
  expect(searchableEventText("subagent", '{"anything":"here"}')).toBeNull();
  // Even plain non-JSON text is still null — the stream itself is opaque, not the payload shape.
  expect(searchableEventText("subagent", "plain text")).toBeNull();
});

test("searchableEventText: tool_use joins name + input text", () => {
  const data = JSON.stringify({ id: "1", name: "Read", input: { file_path: "/a/b.ts" } });
  const text = searchableEventText("tool_use", data);
  expect(text).toBe(`Read ${JSON.stringify({ file_path: "/a/b.ts" })}`);
  expect(text).toContain("Read");
  expect(text).toContain("/a/b.ts");
});

test("searchableEventText: tool_use with a string input is used as-is (not re-stringified)", () => {
  const data = JSON.stringify({ id: "1", name: "Bash", input: "ls -la" });
  expect(searchableEventText("tool_use", data)).toBe("Bash ls -la");
});

test("searchableEventText: tool_use with only a name (no input) still surfaces the name", () => {
  const data = JSON.stringify({ id: "1", name: "Read" });
  expect(searchableEventText("tool_use", data)).toBe("Read");
});

test("searchableEventText: tool_use with a title matches on both title and name", () => {
  const data = JSON.stringify({ id: "1", name: "shell", title: "Run ls", input: { command: "ls" } });
  const text = searchableEventText("tool_use", data);
  expect(text).toContain("Run ls");
  expect(text).toContain("shell");
});

test("searchableEventText: tool_use without a title behaves as before (name + input only)", () => {
  const data = JSON.stringify({ id: "1", name: "Read", input: { file_path: "/a/b.ts" } });
  const text = searchableEventText("tool_use", data);
  expect(text).toBe(`Read ${JSON.stringify({ file_path: "/a/b.ts" })}`);
  expect(text).not.toContain("undefined");
});

test("searchableEventText: tool_use with a non-string title ignores it", () => {
  const data = JSON.stringify({ id: "1", name: "shell", title: 42, input: "ls" });
  expect(searchableEventText("tool_use", data)).toBe("shell ls");
});

test("searchableEventText: tool_use with an empty-string title ignores it", () => {
  const data = JSON.stringify({ id: "1", name: "shell", title: "", input: "ls" });
  expect(searchableEventText("tool_use", data)).toBe("shell ls");
});

test("searchableEventText: tool_use with empty name and input falls back to the raw payload", () => {
  const data = JSON.stringify({ id: "1", name: "", input: "" });
  expect(searchableEventText("tool_use", data)).toBe(data);
});

test("searchableEventText: tool_use with malformed JSON falls back to the raw string", () => {
  const data = "{not valid json";
  expect(searchableEventText("tool_use", data)).toBe(data);
});

test("searchableEventText: tool_use whose JSON parses to a non-object falls back to the raw string", () => {
  expect(searchableEventText("tool_use", "42")).toBe("42");
  expect(searchableEventText("tool_use", '"just a string"')).toBe('"just a string"');
  expect(searchableEventText("tool_use", "null")).toBe("null");
});

test("searchableEventText: tool_use with empty data falls back to the empty raw string", () => {
  expect(searchableEventText("tool_use", "")).toBe("");
});

test("searchableEventText: tool_result extracts string content", () => {
  const data = JSON.stringify({ toolUseId: "1", content: "the file contents" });
  expect(searchableEventText("tool_result", data)).toBe("the file contents");
});

test("searchableEventText: tool_result stringifies structured (non-string) content", () => {
  const content = [{ type: "text", text: "needle in the haystack" }];
  const data = JSON.stringify({ toolUseId: "1", content });
  const text = searchableEventText("tool_result", data);
  expect(text).toBe(JSON.stringify(content));
  expect(text).toContain("needle in the haystack");
});

test("searchableEventText: tool_result with content explicitly null returns an empty string", () => {
  const data = JSON.stringify({ toolUseId: "1", content: null });
  expect(searchableEventText("tool_result", data)).toBe("");
});

test("searchableEventText: tool_result missing the content key falls back to the raw payload", () => {
  const data = JSON.stringify({ toolUseId: "1" });
  expect(searchableEventText("tool_result", data)).toBe(data);
});

test("searchableEventText: tool_result with malformed JSON falls back to the raw string", () => {
  const data = "not json at all";
  expect(searchableEventText("tool_result", data)).toBe(data);
});

test("searchableEventText: tool_result whose JSON parses to a non-object falls back to the raw string", () => {
  expect(searchableEventText("tool_result", "[1,2,3]")).toBe("[1,2,3]");
});

test("searchableEventText: tool_result with empty data falls back to the empty raw string", () => {
  expect(searchableEventText("tool_result", "")).toBe("");
});

// ---------------------------------------------------------------------------
// findMatchingEventIds
// ---------------------------------------------------------------------------

test("findMatchingEventIds: case-insensitive substring match", () => {
  const events = [ev("assistant", "Hello WORLD"), ev("assistant", "goodbye")];
  expect(findMatchingEventIds(events, "world")).toEqual([0]);
  expect(findMatchingEventIds(events, "WORLD")).toEqual([0]);
  expect(findMatchingEventIds(events, "WoRlD")).toEqual([0]);
});

test("findMatchingEventIds: query is trimmed before matching", () => {
  const events = [ev("assistant", "hello world")];
  expect(findMatchingEventIds(events, "  world  ")).toEqual([0]);
});

test("findMatchingEventIds: blank query returns the NO_MATCHES sentinel", () => {
  const events = [ev("assistant", "hello world")];
  expect(findMatchingEventIds(events, "")).toBe(NO_MATCHES);
});

test("findMatchingEventIds: whitespace-only query returns the NO_MATCHES sentinel", () => {
  const events = [ev("assistant", "hello world")];
  expect(findMatchingEventIds(events, "   ")).toBe(NO_MATCHES);
});

test("findMatchingEventIds: empty events array returns the NO_MATCHES sentinel", () => {
  expect(findMatchingEventIds([], "anything")).toBe(NO_MATCHES);
});

test("findMatchingEventIds: zero matches returns the NO_MATCHES sentinel", () => {
  const events = [ev("assistant", "hello world"), ev("stdout", "goodbye")];
  expect(findMatchingEventIds(events, "xyz-not-present")).toBe(NO_MATCHES);
});

test("findMatchingEventIds: returned ids are positions in the events array", () => {
  const events = [
    ev("assistant", "no match here"),
    ev("assistant", "match one"),
    ev("assistant", "no match here either"),
    ev("assistant", "match two"),
  ];
  expect(findMatchingEventIds(events, "match")).toEqual([0, 1, 2, 3]);
  expect(findMatchingEventIds(events, "one")).toEqual([1]);
  expect(findMatchingEventIds(events, "two")).toEqual([3]);
});

test("findMatchingEventIds: non-searchable streams never match, even when the raw data contains the query", () => {
  const events = [
    ev("interaction", '{"question":"needle"}'),
    ev("interaction_resolved", '{"answer":"needle"}'),
    ev("subagent", '{"description":"needle"}'),
  ];
  expect(findMatchingEventIds(events, "needle")).toBe(NO_MATCHES);
});

test("findMatchingEventIds: a tool_use with a title matches queries for both the title and the name", () => {
  const events = [ev("tool_use", JSON.stringify({ id: "1", name: "shell", title: "Run ls", input: "ls" }))];
  expect(findMatchingEventIds(events, "Run ls")).toEqual([0]);
  expect(findMatchingEventIds(events, "shell")).toEqual([0]);
});

test("findMatchingEventIds: tool_result folds into an earlier owning tool_use and matches at the tool_use index", () => {
  const events = [
    ev("tool_use", JSON.stringify({ id: "abc", name: "Bash", input: "ls" })),
    ev("tool_result", JSON.stringify({ toolUseId: "abc", content: "needle output" })),
  ];
  // The match is on text that lives only in the folded result — the tool_use's
  // own text ("Bash ls") does not contain "needle".
  const matches = findMatchingEventIds(events, "needle");
  expect(matches).toEqual([0]);
  // The tool_result's own index must not also appear (no duplicate match).
  expect(matches).not.toContain(1);
});

test("findMatchingEventIds: a match present in both the tool_use text and the folded result text still appears once", () => {
  const events = [
    ev("tool_use", JSON.stringify({ id: "abc", name: "needle-tool", input: "x" })),
    ev("tool_result", JSON.stringify({ toolUseId: "abc", content: "needle output too" })),
  ];
  expect(findMatchingEventIds(events, "needle")).toEqual([0]);
});

test("findMatchingEventIds: orphan tool_result (no owning tool_use) matches at its own index", () => {
  const events = [
    ev("assistant", "unrelated"),
    ev("tool_result", JSON.stringify({ toolUseId: "does-not-exist", content: "needle output" })),
  ];
  expect(findMatchingEventIds(events, "needle")).toEqual([1]);
});

test("findMatchingEventIds: a forward-referencing tool_result (owner appears later) is not folded and stays independently matchable at its own index", () => {
  // Documented behavior: pass 2 only folds a tool_result into a tool_use whose
  // index is strictly earlier (`ownerIdx >= i` is excluded). A tool_use that
  // appears AFTER its tool_result in the array therefore never "owns" it — the
  // result behaves exactly like an orphan and keeps its own index.
  const events = [
    ev("tool_result", JSON.stringify({ toolUseId: "abc", content: "needle output" })),
    ev("tool_use", JSON.stringify({ id: "abc", name: "Bash", input: "ls" })),
  ];
  expect(findMatchingEventIds(events, "needle")).toEqual([0]);
});

test("findMatchingEventIds: a tool_use with an empty id never registers as an owner", () => {
  const events = [
    ev("tool_use", JSON.stringify({ id: "", name: "Bash", input: "ls" })),
    // toolUseId is also empty here, so this is really an orphan by the same rule,
    // but the point under test is that an empty-id tool_use never gets registered
    // in the owner map in the first place.
    ev("tool_result", JSON.stringify({ toolUseId: "", content: "needle output" })),
  ];
  expect(findMatchingEventIds(events, "needle")).toEqual([1]);
});

test("findMatchingEventIds: multiple tool_results folding into the same owner all contribute, none duplicate", () => {
  const events = [
    ev("tool_use", JSON.stringify({ id: "abc", name: "Bash", input: "ls" })),
    ev("tool_result", JSON.stringify({ toolUseId: "abc", content: "first needle" })),
    ev("assistant", "filler"),
    ev("tool_result", JSON.stringify({ toolUseId: "abc", content: "second needle" })),
  ];
  // Both results fold into the same owner (index 0); neither result index
  // (1 or 3) appears as its own match, and the owner appears only once.
  expect(findMatchingEventIds(events, "needle")).toEqual([0]);
  expect(findMatchingEventIds(events, "first")).toEqual([0]);
  expect(findMatchingEventIds(events, "second")).toEqual([0]);
});

// ---------------------------------------------------------------------------
// hidden (internal) tool events — D19
// ---------------------------------------------------------------------------

test("searchableEventText: an internal-stamped tool_use / tool_result is never searchable", () => {
  expect(searchableEventText("tool_use", JSON.stringify({ id: "t1", name: "needle_tool", input: {}, internal: true }))).toBeNull();
  expect(searchableEventText("tool_result", JSON.stringify({ toolUseId: "t1", content: "needle", internal: true }))).toBeNull();
});

test("searchableEventText: `internal: true` nested in input (not top-level) stays searchable", () => {
  const data = JSON.stringify({ id: "t1", name: "Bash", input: { internal: true, cmd: "needle" } });
  expect(searchableEventText("tool_use", data)).toContain("needle");
});

test("findMatchingEventIds: a hidden tool_use and its stamped result never match", () => {
  const events = [
    ev("assistant", "needle in prose"),
    ev("tool_use", JSON.stringify({ id: "t1", name: "needle_tool", input: { q: "needle" }, internal: true })),
    ev("tool_result", JSON.stringify({ toolUseId: "t1", content: "needle output", internal: true })),
  ];
  expect(findMatchingEventIds(events, "needle")).toEqual([0]);
  expect(findMatchingEventIds(events, "needle_tool")).toBe(NO_MATCHES);
});

test("findMatchingEventIds: an unstamped result answering a hidden tool_use is dropped with it, never an orphan match", () => {
  const events = [
    ev("tool_use", JSON.stringify({ id: "t1", name: "plumbing", input: {}, internal: true })),
    ev("tool_result", JSON.stringify({ toolUseId: "t1", content: "needle output" })),
  ];
  expect(findMatchingEventIds(events, "needle")).toBe(NO_MATCHES);
});

test("findMatchingEventIds: a stamped result under a visible tool_use adds no text to its owner", () => {
  const events = [
    ev("tool_use", JSON.stringify({ id: "t1", name: "Bash", input: "ls" })),
    ev("tool_result", JSON.stringify({ toolUseId: "t1", content: "needle", internal: true })),
  ];
  expect(findMatchingEventIds(events, "needle")).toBe(NO_MATCHES);
  expect(findMatchingEventIds(events, "bash")).toEqual([0]);
});

test("findMatchingEventIds: a visible tool call next to a hidden one still matches at its own index", () => {
  const events = [
    ev("tool_use", JSON.stringify({ id: "h1", name: "plumbing", input: "needle", internal: true })),
    ev("tool_result", JSON.stringify({ toolUseId: "h1", content: "needle", internal: true })),
    ev("tool_use", JSON.stringify({ id: "v1", name: "Read", input: "x" })),
    ev("tool_result", JSON.stringify({ toolUseId: "v1", content: "needle found" })),
  ];
  expect(findMatchingEventIds(events, "needle")).toEqual([2]);
});

// ---------------------------------------------------------------------------
// stepMatchIndex
// ---------------------------------------------------------------------------

test("stepMatchIndex: zero matches always returns -1", () => {
  expect(stepMatchIndex(0, -1, 1)).toBe(-1);
  expect(stepMatchIndex(0, -1, -1)).toBe(-1);
  expect(stepMatchIndex(0, 0, 1)).toBe(-1);
});

test("stepMatchIndex: unseeded current (-1) forward lands on the first match", () => {
  expect(stepMatchIndex(5, -1, 1)).toBe(0);
});

test("stepMatchIndex: unseeded current (-1) backward lands on the last match", () => {
  expect(stepMatchIndex(5, -1, -1)).toBe(4);
});

test("stepMatchIndex: any negative current is treated as unseeded", () => {
  expect(stepMatchIndex(5, -7, 1)).toBe(0);
  expect(stepMatchIndex(5, -7, -1)).toBe(4);
});

test("stepMatchIndex: forward wraps from the last match back to the first", () => {
  expect(stepMatchIndex(3, 2, 1)).toBe(0);
});

test("stepMatchIndex: backward wraps from the first match back to the last", () => {
  expect(stepMatchIndex(3, 0, -1)).toBe(2);
});

test("stepMatchIndex: forward/backward step within bounds without wrapping", () => {
  expect(stepMatchIndex(5, 1, 1)).toBe(2);
  expect(stepMatchIndex(5, 3, -1)).toBe(2);
});

test("stepMatchIndex: single-match list always resolves back to position 0", () => {
  expect(stepMatchIndex(1, -1, 1)).toBe(0);
  expect(stepMatchIndex(1, -1, -1)).toBe(0);
  expect(stepMatchIndex(1, 0, 1)).toBe(0);
  expect(stepMatchIndex(1, 0, -1)).toBe(0);
});

// ---------------------------------------------------------------------------
// resolveActiveMatchIndex
// ---------------------------------------------------------------------------

test("resolveActiveMatchIndex: empty matches always resolves to -1, regardless of prevActiveId", () => {
  expect(resolveActiveMatchIndex([], null)).toBe(-1);
  expect(resolveActiveMatchIndex([], 3)).toBe(-1);
});

test("resolveActiveMatchIndex: null prevActiveId defaults to the first match (position 0)", () => {
  expect(resolveActiveMatchIndex([5, 8, 12], null)).toBe(0);
});

test("resolveActiveMatchIndex: prevActiveId still present keeps pointing at its (possibly shifted) position", () => {
  expect(resolveActiveMatchIndex([5, 8, 12], 12)).toBe(2);
  expect(resolveActiveMatchIndex([5, 8, 12], 5)).toBe(0);
  // Position shifted from a previous recompute (12 used to be first, now last)
  // but the same event id (12) stays selected via its new position.
  expect(resolveActiveMatchIndex([8, 5, 12], 12)).toBe(2);
});

test("resolveActiveMatchIndex: prevActiveId no longer present defaults to the first match (position 0)", () => {
  expect(resolveActiveMatchIndex([5, 8, 12], 999)).toBe(0);
});

// ---------------------------------------------------------------------------
// user events match their DISPLAYED text (docs/plans/pasted-content-tags.md)
// ---------------------------------------------------------------------------

const PASTED_TWIN =
  `${AGETOR_PASTE_LEAD_IN}\n\n\n<pasted_content id="0a7d">\nplease rename the billing module\n</pasted_content id="0a7d">\n`;

test("searchableEventText: a pasted user twin is reduced to the body the bubble shows", () => {
  expect(searchableEventText("user", PASTED_TWIN)).toBe("please rename the billing module");
  // Bare-CR body newlines (tmux paste-buffer artifact) are normalized like the bubble does.
  expect(searchableEventText("user", `\n\n<pasted_content id="1b6a">\nline one\rline two\n</pasted_content id="1b6a">\n`))
    .toBe("line one\nline two");
});

test("findMatchingEventIds: wrapper markup and the lead-in never match; the body does, at its own index", () => {
  const events = [ev("assistant", "earlier reply"), ev("user", PASTED_TWIN), ev("assistant", "done")];
  expect(findMatchingEventIds(events, "pasted_content")).toBe(NO_MATCHES);
  expect(findMatchingEventIds(events, "0a7d")).toBe(NO_MATCHES);
  expect(findMatchingEventIds(events, "sent from Agetor")).toBe(NO_MATCHES);
  expect(findMatchingEventIds(events, "billing module")).toEqual([1]);
});

test("findMatchingEventIds: only the USER stream is normalized — an assistant quoting the wrapper still matches", () => {
  const events = [ev("assistant", "claude wraps pastes in <pasted_content id=\"0a7d\"> tags")];
  expect(findMatchingEventIds(events, "pasted_content")).toEqual([0]);
});

test("searchableEventText: a compaction_summary event is searchable by its body text", () => {
  const body = "This session is being continued from a previous conversation.\n\n## Pending work\n- wire the frobnicator";
  expect(searchableEventText("compaction_summary", body)).toBe(body);
  const events = [ev("user", "hi"), ev("compaction_summary", body), ev("assistant", "ok")];
  expect(findMatchingEventIds(events, "frobnicator")).toEqual([1]);
});

// ---------------------------------------------------------------------------
// handoffCards (formatted handoff card search, D10 / A4)
// ---------------------------------------------------------------------------

const SAMPLE_HANDOFF: Handoff = {
  schemaVersion: 1,
  purpose: "Purpose-words",
  summary: "Summary-words",
  reason: "Reason-words",
  next: "Beta",
  artifacts: ["docs/artifact-words.md"],
  openQuestions: ["Question-words?"],
};
const SAMPLE_BLOCK = `<handoff>${JSON.stringify(SAMPLE_HANDOFF)}</handoff>`;

test("handoffCards: assistant block is searched by values, not by JSON keys", () => {
  const data = `Prose-before ${SAMPLE_BLOCK} Prose-after`;
  const events = [ev("assistant", data)];
  const opts = { handoffCards: true };
  expect(findMatchingEventIds(events, "schemaVersion", opts)).toEqual(NO_MATCHES);
  expect(findMatchingEventIds(events, "openQuestions", opts)).toEqual(NO_MATCHES);
  expect(findMatchingEventIds(events, "summary-words", opts)).toEqual([0]);
  expect(findMatchingEventIds(events, "reason-words", opts)).toEqual([0]);
  expect(findMatchingEventIds(events, "artifact-words", opts)).toEqual([0]);
  expect(findMatchingEventIds(events, "question-words", opts)).toEqual([0]);
  expect(findMatchingEventIds(events, "prose-before", opts)).toEqual([0]);
  expect(findMatchingEventIds(events, "prose-after", opts)).toEqual([0]);
});

test("handoffCards off: a non-step task still matches the raw text", () => {
  const events = [ev("assistant", `x ${SAMPLE_BLOCK}`)];
  expect(findMatchingEventIds(events, "schemaVersion")).toEqual([0]);
  expect(findMatchingEventIds(events, "schemaVersion", { handoffCards: false })).toEqual([0]);
  expect(searchableEventText("assistant", `x ${SAMPLE_BLOCK}`)).toBe(`x ${SAMPLE_BLOCK}`);
});

test("handoffCards: invalid block falls back to its raw inner text; no block is verbatim", () => {
  const bad = "before <handoff>raw-inner-token not json</handoff> after";
  const text = searchableEventText("assistant", bad, { handoffCards: true })!;
  expect(text).toContain("before");
  expect(text).toContain("raw-inner-token");
  expect(text).toContain("after");
  expect(text).not.toContain("<handoff>");
  expect(searchableEventText("assistant", "no block here", { handoffCards: true })).toBe("no block here");
});

test("handoffCards: a block quoted in code stays raw text", () => {
  const quoted = `see \`${SAMPLE_BLOCK}\``;
  expect(searchableEventText("assistant", quoted, { handoffCards: true })).toBe(quoted);
});

test("handoffCards: only the last block is formatted; earlier blocks stay raw", () => {
  const first = `<handoff>${JSON.stringify({ ...SAMPLE_HANDOFF, summary: "first-block-summary" })}</handoff>`;
  const data = `${first}\n${SAMPLE_BLOCK}`;
  const text = searchableEventText("assistant", data, { handoffCards: true })!;
  expect(text).toContain("first-block-summary");
  expect(text).toContain("Summary-words");
});

test("handoffCards: non-assistant streams are unchanged", () => {
  expect(searchableEventText("stdout", SAMPLE_BLOCK, { handoffCards: true })).toBe(SAMPLE_BLOCK);
  expect(searchableEventText("thinking", SAMPLE_BLOCK, { handoffCards: true })).toBe(SAMPLE_BLOCK);
});

function stepPrompt(handoff: Handoff | null, filePath: string | null = null, inlineHandoff = true): string {
  const step: PipelineStep = {
    id: "s2",
    name: "Second",
    instructions: "Instruction-words",
    agentProfileId: null,
    position: { x: 0, y: 0 },
    subagents: { profileIds: [], cap: null },
    transition: "choose",
    join: "any",
  };
  return composeStepPrompt({
    pipelineName: "P",
    step,
    stepIndex: 2,
    stepCap: 25,
    goal: "Goal-words",
    previous: [{ stepName: "First Step", handoff, filePath }],
    outgoing: [],
    transition: "choose",
    subagentProfiles: [],
    subagentCap: null,
    inlineHandoff,
    parallelSiblings: [],
    nonce: "a1b2c3d4",
  });
}

test("handoffCards: a user prompt's untrusted span matches values, not keys", () => {
  const prompt = stepPrompt(SAMPLE_HANDOFF);
  // Raw search sees the key (the prompt's contract text and the JSON both carry it).
  expect(findMatchingEventIds([ev("user", prompt)], "purpose-words")).toEqual([0]);
  const opts = { handoffCards: true };
  const events = [ev("user", prompt)];
  expect(findMatchingEventIds(events, "summary-words", opts)).toEqual([0]);
  expect(findMatchingEventIds(events, "first step", opts)).toEqual([0]);
  expect(findMatchingEventIds(events, "instruction-words", opts)).toEqual([0]);
  // The span's JSON is gone from the formatted text (the prompt's own contract
  // text still names the keys, so assert on this handoff's serialized values).
  expect(prompt).toMatch(/"summary":\s*"Summary-words"/);
  const formatted = searchableEventText("user", prompt, { handoffCards: true })!;
  expect(formatted).not.toMatch(/"summary":\s*"Summary-words"/);
  expect(formatted).toContain("Summary-words");
  expect(formatted).not.toContain("--- BEGIN untrusted handoff");
});

test("handoffCards: a prompt placeholder span contributes the step name and file path", () => {
  const prompt = stepPrompt(SAMPLE_HANDOFF, "/data/pipeline-runs/p1/handoff-abc-1-from-0.json", false);
  const events = [ev("user", prompt)];
  expect(findMatchingEventIds(events, "handoff-abc-1-from-0", { handoffCards: true })).toEqual([0]);
  expect(findMatchingEventIds(events, "first step", { handoffCards: true })).toEqual([0]);
});

test("handoffCards: a prompt with no span (or the flag off) is byte-identical", () => {
  const plain = "just a message";
  expect(searchableEventText("user", plain, { handoffCards: true })).toBe(plain);
  const prompt = stepPrompt(SAMPLE_HANDOFF);
  expect(searchableEventText("user", prompt)).toBe(prompt);
});

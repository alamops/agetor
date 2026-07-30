import { expect, test } from "bun:test";
import type { RunEventStream } from "../../shared/types.ts";
import {
  findMatchingEventIds,
  NO_MATCHES,
  resolveActiveMatchIndex,
  searchableEventText,
  stepMatchIndex,
} from "./event-search.ts";

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

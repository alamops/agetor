import { describe, expect, test } from "bun:test";
import { createInteractionRefetchTracker, mergeRefetchedInteractions } from "./interaction-refetch.ts";

interface Card { id: string; v?: string }
const c = (id: string, v?: string): Card => ({ id, v });

describe("mergeRefetchedInteractions", () => {
  test("keeps cards that arrived during the refetch, after the server list", () => {
    expect(mergeRefetchedInteractions([c("a"), c("b")], [c("c")], new Set())).toEqual([c("a"), c("b"), c("c")]);
  });

  test("drops cards resolved during the refetch, from both lists", () => {
    expect(mergeRefetchedInteractions([c("a"), c("b")], [c("c")], new Set(["b", "c"]))).toEqual([c("a")]);
  });

  test("dedupes by id and the server copy wins", () => {
    expect(mergeRefetchedInteractions([c("a", "server")], [c("a", "sse"), c("a", "sse2")], new Set())).toEqual([c("a", "server")]);
  });

  test("empty inputs", () => {
    expect(mergeRefetchedInteractions([], [], new Set())).toEqual([]);
  });
});

describe("createInteractionRefetchTracker", () => {
  test("finish returns what arrived and resolved during the refetch", () => {
    const t = createInteractionRefetchTracker<Card>();
    const token = t.begin();
    t.noteArrived(c("x"));
    t.noteResolved("y");
    const res = t.finish(token);
    expect(res?.arrived).toEqual([c("x")]);
    expect([...(res?.resolvedIds ?? [])]).toEqual(["y"]);
  });

  test("a stale token (newer begin) returns null and the newer refetch is unaffected", () => {
    const t = createInteractionRefetchTracker<Card>();
    const old = t.begin();
    t.noteArrived(c("old"));
    const next = t.begin();
    t.noteArrived(c("new"));
    expect(t.finish(old)).toBeNull();
    expect(t.finish(next)?.arrived).toEqual([c("new")]);
  });

  test("cancel makes the in-flight token stale", () => {
    const t = createInteractionRefetchTracker<Card>();
    const token = t.begin();
    t.cancel();
    expect(t.finish(token)).toBeNull();
  });

  test("a token can only be finished once", () => {
    const t = createInteractionRefetchTracker<Card>();
    const token = t.begin();
    expect(t.finish(token)).not.toBeNull();
    expect(t.finish(token)).toBeNull();
  });

  test("notes outside a refetch are ignored and do not leak into the next one", () => {
    const t = createInteractionRefetchTracker<Card>();
    t.noteArrived(c("before"));
    t.noteResolved("before");
    const token = t.begin();
    t.noteArrived(c("during"));
    const res = t.finish(token);
    expect(res?.arrived).toEqual([c("during")]);
    expect(res?.resolvedIds.size).toBe(0);
    t.noteArrived(c("after"));
    const again = t.begin();
    expect(t.finish(again)?.arrived).toEqual([]);
  });

  test("a card resolved then re-sent under the same id counts as live", () => {
    const t = createInteractionRefetchTracker<Card>();
    const token = t.begin();
    t.noteResolved("a");
    t.noteArrived(c("a"));
    const res = t.finish(token)!;
    expect(mergeRefetchedInteractions([], res.arrived, res.resolvedIds)).toEqual([c("a")]);
  });
});

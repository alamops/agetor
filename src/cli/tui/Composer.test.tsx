import { test, expect, mock, afterAll } from "bun:test";
import { render } from "ink-testing-library";
import { Composer } from "./Composer.tsx";
import { buildFileEntries } from "../../shared/at-file-filter.ts";

// Snapshot the real `at-complete.ts` exports into a plain object BEFORE
// mocking (same pattern as `Dashboard.test.tsx`'s `../sse.ts` mock) so a spy
// on `suggestAtEntries` (memoization regression test below) can be reverted
// after this file's tests finish. This snapshot copy is load-bearing, not
// cosmetic: `mock.module` replaces the live module record in place, so if
// the wrapped `suggestAtEntries` below called back through the live
// `realAtComplete` namespace instead of this frozen copy, it would end up
// calling ITSELF (infinite recursion) once the mock is installed.
import * as realAtComplete from "./at-complete.ts";
const realAtCompleteSnapshot = { ...realAtComplete };
let suggestCalls = 0;
mock.module("./at-complete.ts", () => ({
  ...realAtCompleteSnapshot,
  suggestAtEntries: (...args: Parameters<typeof realAtComplete.suggestAtEntries>) => {
    suggestCalls++;
    return realAtCompleteSnapshot.suggestAtEntries(...args);
  },
}));
afterAll(() => {
  mock.module("./at-complete.ts", () => realAtCompleteSnapshot);
});

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const ENTER = "\r";
const TAB = "\t";
const BACKSPACE = String.fromCharCode(127); // DEL
const ESC = String.fromCharCode(27);
const UP = ESC + "[A"; // xterm up-arrow sequence
const DOWN = ESC + "[B"; // xterm down-arrow sequence

const fileEntries = buildFileEntries(["README.md", "docs/my notes.md", "src/bun/db.ts"]);

test("Composer submits typed text on Enter", async () => {
  let submitted: string | null = null;
  const { stdin } = render(
    <Composer active label="→" onSubmit={(t) => { submitted = t; }} onCancel={() => {}} />,
  );
  await wait();
  stdin.write("hello");
  await wait();
  stdin.write(ENTER);
  await wait();
  expect(submitted as string | null).toBe("hello");
});

test("Composer backspace deletes the last char", async () => {
  let submitted: string | null = null;
  const { stdin } = render(
    <Composer active label="→" onSubmit={(t) => { submitted = t; }} onCancel={() => {}} />,
  );
  await wait();
  stdin.write("hi!");
  await wait();
  stdin.write(BACKSPACE);
  await wait();
  stdin.write(ENTER);
  await wait();
  expect(submitted as string | null).toBe("hi");
});

test("Composer ignores an empty Enter and trims on submit", async () => {
  let calls = 0;
  let submitted = "";
  const { stdin } = render(
    <Composer active label="→" onSubmit={(t) => { calls++; submitted = t; }} onCancel={() => {}} />,
  );
  await wait();
  stdin.write(ENTER); // empty → no submit
  await wait();
  stdin.write("  spaced  ");
  await wait();
  stdin.write(ENTER);
  await wait();
  expect(calls).toBe(1);
  expect(submitted).toBe("spaced");
});

test("Composer cancels on Esc", async () => {
  let cancelled = false;
  const { stdin } = render(
    <Composer active label="→" onSubmit={() => {}} onCancel={() => { cancelled = true; }} />,
  );
  await wait();
  stdin.write(ESC);
  await wait();
  expect(cancelled).toBe(true);
});

test("a dragged path (one paste chunk) is sanitized before it lands in the message", async () => {
  let submitted: string | null = null;
  const { stdin } = render(
    <Composer active label="→" onSubmit={(t) => { submitted = t; }} onCancel={() => {}} />,
  );
  await wait();
  stdin.write("/Users/me/My\\ Shot.png"); // dropped path: escaped space, delivered as one chunk
  await wait();
  stdin.write(ENTER);
  await wait();
  expect(submitted as string | null).toBe("/Users/me/My Shot.png");
});

// ── @ file autocomplete (fileEntries prop) ──────────────────────────────────

test("with no fileEntries prop, typing @ never renders a popover (unchanged behavior)", async () => {
  const { stdin, lastFrame } = render(
    <Composer active label="→" onSubmit={() => {}} onCancel={() => {}} />,
  );
  await wait();
  stdin.write("look at @RE");
  await wait();
  expect(lastFrame() ?? "").not.toContain("accept");
});

test("typing @RE with fileEntries opens a popover suggesting README.md", async () => {
  const { stdin, lastFrame } = render(
    <Composer active label="→" fileEntries={fileEntries} onSubmit={() => {}} onCancel={() => {}} />,
  );
  await wait();
  stdin.write("look at @RE");
  await wait();
  const frame = lastFrame() ?? "";
  expect(frame).toContain("README.md");
  expect(frame).toContain("tab/enter accept");
});

test("Tab accepts the highlighted file suggestion, appending a trailing space and closing the popover", async () => {
  let submitted: string | null = null;
  const { stdin, lastFrame } = render(
    <Composer
      active
      label="→"
      fileEntries={fileEntries}
      onSubmit={(t) => { submitted = t; }}
      onCancel={() => {}}
    />,
  );
  await wait();
  stdin.write("@README");
  await wait();
  stdin.write(TAB);
  await wait();
  // Popover closed (no active query left — the token is finished, followed by a space).
  expect(lastFrame() ?? "").not.toContain("tab/enter accept");
  stdin.write("done");
  await wait();
  stdin.write(ENTER);
  await wait();
  expect(submitted as string | null).toBe("@README.md done");
});

test("Enter accepts the suggestion instead of submitting while the popover is open", async () => {
  let submitted: string | null = null;
  const { stdin } = render(
    <Composer
      active
      label="→"
      fileEntries={fileEntries}
      onSubmit={(t) => { submitted = t; }}
      onCancel={() => {}}
    />,
  );
  await wait();
  stdin.write("@README");
  await wait();
  stdin.write(ENTER); // accepts, does NOT submit
  await wait();
  expect(submitted as string | null).toBeNull();
  stdin.write(ENTER); // now submits the accepted text
  await wait();
  expect(submitted as string | null).toBe("@README.md");
});

test("Tab on a directory descends and keeps the popover open for the next keystroke", async () => {
  const { stdin, lastFrame } = render(
    <Composer active label="→" fileEntries={fileEntries} onSubmit={() => {}} onCancel={() => {}} />,
  );
  await wait();
  stdin.write("@sr");
  await wait();
  stdin.write(TAB); // "src/" is the only directory match
  await wait();
  const frame = lastFrame() ?? "";
  // Still open, now listing src/'s contents (db.ts under src/bun/).
  expect(frame).toContain("tab/enter accept");
  expect(frame).toContain("src/bun/");
});

test("Esc dismisses the popover without cancelling the composer; a second Esc cancels", async () => {
  let cancelled = false;
  const { stdin, lastFrame } = render(
    <Composer
      active
      label="→"
      fileEntries={fileEntries}
      onSubmit={() => {}}
      onCancel={() => { cancelled = true; }}
    />,
  );
  await wait();
  stdin.write("@RE");
  await wait();
  stdin.write(ESC);
  await wait();
  expect(lastFrame() ?? "").not.toContain("tab/enter accept");
  expect(cancelled).toBe(false); // first Esc only dismissed the popover
  stdin.write(ESC);
  await wait();
  expect(cancelled).toBe(true); // second Esc, nothing open, falls through to cancel
});

test("suggestions are memoized: an unrelated re-render (arrow-key nav) doesn't recompute them", async () => {
  suggestCalls = 0;
  const { stdin } = render(
    <Composer active label="→" fileEntries={fileEntries} onSubmit={() => {}} onCancel={() => {}} />,
  );
  await wait();
  stdin.write("@RE");
  await wait();
  const afterTyping = suggestCalls;
  expect(afterTyping).toBeGreaterThan(0);
  // Up/down arrow only moves the highlighted row (`sel` state) — `text` and
  // `fileEntries` are unchanged, so the memoized suggestions must not be
  // recomputed even though the component re-renders.
  stdin.write(DOWN);
  await wait();
  stdin.write(UP);
  await wait();
  expect(suggestCalls).toBe(afterTyping);
});

// ── remoteSearch (monorepo fallback, CLAUDE.md §12) ─────────────────────────

test("remoteSearch replaces the local rows once its debounced answer matches the current query", async () => {
  const remoteSearch = async (_q: string) => [{ path: "deep/dir/zzz-target.ts", isDirectory: false }];
  const { stdin, lastFrame } = render(
    <Composer active label="→" fileEntries={fileEntries} remoteSearch={remoteSearch} onSubmit={() => {}} onCancel={() => {}} />,
  );
  await wait();
  stdin.write("@RE");
  await wait();
  // Before the debounce fires, the local rows (README.md matches "RE") are
  // still what's shown — remoteSearch hasn't answered yet.
  expect(lastFrame() ?? "").toContain("README.md");
  // Let the 200ms debounce fire and the fake remoteSearch resolve.
  await wait(300);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("deep/dir/zzz-target.ts");
  expect(frame).not.toContain("README.md");
});

test("a stale remoteSearch answer for an old query is discarded once a newer query has taken over", async () => {
  let resolveFirst: ((entries: { path: string; isDirectory: boolean }[]) => void) | null = null;
  let calls = 0;
  const remoteSearch = (_q: string) =>
    new Promise<{ path: string; isDirectory: boolean }[]>((resolve) => {
      calls++;
      if (calls === 1) resolveFirst = resolve;
      else resolve([{ path: "src/bun/newer-query-result.ts", isDirectory: false }]);
    });
  const { stdin, lastFrame } = render(
    <Composer active label="→" fileEntries={fileEntries} remoteSearch={remoteSearch} onSubmit={() => {}} onCancel={() => {}} />,
  );
  await wait();
  stdin.write("@RE");
  await wait(300); // let the first debounce fire (its promise stays pending — resolveFirst captured)
  expect(calls).toBe(1);
  stdin.write("A"); // narrows the query to "REA" — a newer, distinct query key
  await wait(300); // let the second debounce fire and its (different) promise resolve
  expect(calls).toBe(2);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("newer-query-result.ts");
  // Now let the FIRST (stale) request resolve late.
  resolveFirst!([{ path: "should-never-render.ts", isDirectory: false }]);
  await wait();
  const after = lastFrame() ?? "";
  expect(after).not.toContain("should-never-render.ts");
  expect(after).toContain("newer-query-result.ts");
});

test("a null (errored) remoteSearch answer keeps the local rows instead of blanking the popover", async () => {
  const remoteSearch = async (_q: string): Promise<{ path: string; isDirectory: boolean }[] | null> => null;
  const { stdin, lastFrame } = render(
    <Composer active label="→" fileEntries={fileEntries} remoteSearch={remoteSearch} onSubmit={() => {}} onCancel={() => {}} />,
  );
  await wait();
  stdin.write("@RE");
  await wait(300); // let the debounce fire and resolve to null
  const frame = lastFrame() ?? "";
  // The local `suggestAtEntries` rows (README.md matches "RE") are still
  // shown — a `null` answer must never be treated as an authoritative
  // "zero matches" that blanks the popover.
  expect(frame).toContain("README.md");
});

test("remoteSearch is never invoked for a sub-2-char query (bare @ or a single char)", async () => {
  let calls = 0;
  const remoteSearch = async (_q: string) => {
    calls++;
    return [];
  };
  const { stdin } = render(
    <Composer active label="→" fileEntries={fileEntries} remoteSearch={remoteSearch} onSubmit={() => {}} onCancel={() => {}} />,
  );
  await wait();
  stdin.write("@"); // bare @, query length 0
  await wait(300); // well past the debounce window
  expect(calls).toBe(0);
  stdin.write("R"); // query length 1
  await wait(300);
  expect(calls).toBe(0);
  stdin.write("E"); // query length 2 — now it should fire
  await wait(300);
  expect(calls).toBe(1);
});

test("without remoteSearch, behavior is unchanged — only the local rows ever render", async () => {
  const { stdin, lastFrame } = render(
    <Composer active label="→" fileEntries={fileEntries} onSubmit={() => {}} onCancel={() => {}} />,
  );
  await wait();
  stdin.write("@RE");
  await wait(300);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("README.md");
});

test("Esc dismisses, then typing past it and backspacing back to the same query reopens the popover", async () => {
  const { stdin, lastFrame } = render(
    <Composer active label="→" fileEntries={fileEntries} onSubmit={() => {}} onCancel={() => {}} />,
  );
  await wait();
  stdin.write("@src");
  await wait();
  expect(lastFrame() ?? "").toContain("tab/enter accept"); // open on "src"
  stdin.write(ESC);
  await wait();
  expect(lastFrame() ?? "").not.toContain("tab/enter accept"); // dismissed for "src"
  stdin.write("x");
  await wait();
  stdin.write(BACKSPACE); // back to "src" — the exact key that was dismissed
  await wait();
  expect(lastFrame() ?? "").toContain("tab/enter accept"); // reopens, not stuck closed
});

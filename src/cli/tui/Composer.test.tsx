import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Composer } from "./Composer.tsx";
import { buildFileEntries } from "../../shared/at-file-filter.ts";

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const ENTER = "\r";
const TAB = "\t";
const BACKSPACE = String.fromCharCode(127); // DEL
const ESC = String.fromCharCode(27);

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

import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Composer } from "./Composer.tsx";

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const ENTER = "\r";
const BACKSPACE = String.fromCharCode(127); // DEL
const ESC = String.fromCharCode(27);

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

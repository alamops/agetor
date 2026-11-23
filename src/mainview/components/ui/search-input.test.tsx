// Static contract of SearchInput (no DOM in `bun test`): the clear (×) button
// renders only while there is text, and the box keeps the identifier props.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchInput } from "./search-input.tsx";

const noop = () => {};

describe("SearchInput", () => {
  test("no clear button while empty", () => {
    const html = renderToStaticMarkup(<SearchInput testId="s" value="" onValueChange={noop} aria-label="Search projects" />);
    expect(html).toContain('data-testid="s"');
    expect(html).toContain('aria-label="Search projects"');
    expect(html).not.toContain('data-testid="s-clear"');
  });
  test("a labelled clear button once there is text", () => {
    const html = renderToStaticMarkup(<SearchInput testId="s" value="ag" onValueChange={noop} aria-label="Search projects" />);
    expect(html).toMatch(/<button[^>]*data-testid="s-clear"[^>]*aria-label="Clear search"|<button[^>]*aria-label="Clear search"[^>]*data-testid="s-clear"/);
    expect(html).toContain('type="button"');
  });
  test("spreads the identifier-input props (no autocorrect on a search box)", () => {
    const html = renderToStaticMarkup(<SearchInput value="" onValueChange={noop} />);
    expect(html).toContain('autoCorrect="off"');
    expect(html).toContain('spellCheck="false"');
  });
});

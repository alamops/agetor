// Static contract of ExtensionPicker's two variants: the launch surfaces get a
// full-width trigger with no Agents group; RunPanel's toolbar keeps the compact one.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ExtensionPicker } from "./ExtensionPicker.tsx";

const base = { extensions: [], value: "", onChange: () => {}, textareaRef: { current: null } };

describe("ExtensionPicker variants", () => {
  test("launch: full-width trigger, no Agents in its label", () => {
    const html = renderToStaticMarkup(<ExtensionPicker {...base} variant="launch" />);
    expect(html).toContain("MCP · Skills · Plugins · Prompts");
    expect(html).not.toContain("Agents");
    expect(html).toMatch(/data-testid="extension-picker-trigger"[^>]*class="(?:[^"]*\s)?w-full[\s"]/);
  });
  test("toolbar (default): the compact trigger keeps Agents", () => {
    const html = renderToStaticMarkup(<ExtensionPicker {...base} />);
    expect(html).toContain("MCP · Skills · Plugins · Agents · Prompts");
    expect(html).not.toMatch(/data-testid="extension-picker-trigger"[^>]*class="(?:[^"]*\s)?w-full[\s"]/);
  });
});

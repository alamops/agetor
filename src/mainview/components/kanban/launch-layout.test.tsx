// Static contract of the launch layout parts: LaunchSection, MoreOptions, LaunchFooter.
// Interactive behavior (persistence across reload, keyboard) lives in e2e/launch-layout.spec.ts
// and e2e/launch-keyboard.spec.ts.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LaunchSection, MoreOptions } from "./LaunchSection.tsx";
import { LaunchFooter } from "./LaunchFooter.tsx";

describe("LaunchSection", () => {
  const html = renderToStaticMarkup(
    <LaunchSection id="agent" surface="panel" title="Agent" summary="Claude Code · Opus · High · Code" more={{ notes: ["Speed: Fast"], children: <i>rare</i> }}>
      <b>frequent</b>
    </LaunchSection>,
  );
  test("the toggle carries aria-expanded and aria-controls pointing at the body", () => {
    expect(html).toContain('data-testid="launch-section-agent-toggle"');
    expect(html).toContain('aria-expanded="true"');
    const controls = /aria-controls="([^"]+)"/.exec(html)![1]!;
    expect(html).toContain(`id="${controls}"`);
  });
  test("the summary renders only while collapsed; the body (frequent fields) while open", () => {
    expect(html).not.toContain("launch-section-agent-summary");
    expect(html).toContain("<b>frequent</b>");
  });
  test("More options is closed by default and announces the non-default note", () => {
    expect(html).toContain('data-testid="launch-more-agent"');
    expect(html).toContain("Speed: Fast");
    expect(html).not.toContain("<i>rare</i>");
  });
  test("a danger-toned MoreOptions marks its note", () => {
    const more = renderToStaticMarkup(
      <MoreOptions surface="panel" section="workspace" notes={["Branch name is invalid"]} tone="danger">
        <i />
      </MoreOptions>,
    );
    expect(more).toContain('data-tone="danger"');
    expect(more).toContain("Branch name is invalid");
  });
});

describe("LaunchFooter", () => {
  const base = { label: "Run task", onClick: () => {}, testId: "launch-run" };
  test("Run's accessible text is exactly 'Run task': the shortcut hint is aria-hidden", () => {
    const html = renderToStaticMarkup(<LaunchFooter primary={base} />);
    expect(html).toContain("Run task");
    expect(html).toMatch(/<kbd[^>]*aria-hidden="true"/);
    expect(html).toMatch(/aria-keyshortcuts="(Meta|Control)\+Enter"/);
    const withoutHidden = html.replace(/<kbd[\s\S]*?<\/kbd>/g, "").replace(/<[^>]+>/g, "").trim();
    expect(withoutHidden).toBe("Run task");
  });
  test("the blocked reason is visible text, tied to Run, and only while Run is disabled", () => {
    const blocked = renderToStaticMarkup(<LaunchFooter primary={{ ...base, disabled: true }} reason="Add a title, a prompt and a project" />);
    expect(blocked).toContain('data-testid="launch-run-blocked-reason"');
    expect(blocked).toContain("Add a title, a prompt and a project");
    expect(blocked).toContain('aria-describedby="launch-run-blocked-reason"');
    const ok = renderToStaticMarkup(<LaunchFooter primary={base} reason="stale" />);
    expect(ok).not.toContain("launch-run-blocked-reason");
  });
  test("renders the secondary, cancel and error", () => {
    const html = renderToStaticMarkup(
      <LaunchFooter
        primary={base}
        secondary={{ label: "Add to backlog", onClick: () => {}, testId: "launch-backlog" }}
        cancel={{ label: "Cancel", onClick: () => {}, testId: "launch-cancel" }}
        error="boom"
      />,
    );
    expect(html).toContain("Add to backlog");
    expect(html).toContain('data-testid="launch-cancel"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("boom");
  });
  test("a busy primary shows 'Running…'", () => {
    expect(renderToStaticMarkup(<LaunchFooter primary={{ ...base, busy: true }} />)).toContain("Running…");
  });
});

// The RunPanel card for a `tmux_prompt` that is not a menu
// (docs/plans/claude-enter-to-confirm-prompts.md T11, SC6, SC7): an Enter-only
// screen gets a "Continue (press Enter)" button, the OAuth paste-code prompt a
// one-line box that keeps the code out of autofill and spellcheck. Rendered to
// static markup, like SwitchAccountControl.test.tsx, since there is no DOM
// harness; the click → route → card-gone flow is the e2e
// (e2e/claude-tmux-prompt-actions.spec.ts).
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TmuxPromptAnswerControls } from "./TmuxPromptAnswerControls.tsx";
import type { PendingTmuxPrompt } from "@/lib/api";
import { OAUTH_CODE_INPUT_MAX_LEN } from "@/lib/tmux-prompt";

function req(over: Partial<PendingTmuxPrompt>): PendingTmuxPrompt {
  return {
    kind: "tmux_prompt",
    id: "tp-1",
    taskId: "t1",
    runId: "r1",
    paneText: " Login successful. Press Enter to continue…",
    choices: [],
    fingerprint: "fp",
    createdAt: 1,
    ...over,
  };
}

const html = (r: PendingTmuxPrompt): string =>
  renderToStaticMarkup(<TmuxPromptAnswerControls req={r} onResolved={() => {}} />);

/** The attributes of the one `<input>` in the markup. */
function inputAttrs(markup: string): string {
  const m = markup.match(/<input[^>]*>/g) ?? [];
  expect(m).toHaveLength(1);
  return m[0]!;
}

describe("TmuxPromptAnswerControls — Enter-only card", () => {
  test("shows the screen, a Continue (press Enter) button and Open in Terminal, and no text box", () => {
    const markup = html(req({ answerKind: "enter" }));
    expect(markup).toContain('data-testid="tmux-prompt-enter-card"');
    expect(markup).toContain("Claude is waiting for Enter");
    expect(markup).toContain("Login successful. Press Enter to continue…");
    expect(markup).toContain('data-testid="tmux-prompt-continue"');
    expect(markup).toContain("Continue (press Enter)");
    expect(markup).toContain("Open in Terminal");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain('data-testid="tmux-prompt-code-card"');
    // Nothing is in flight on first paint: the button is live.
    expect(markup).not.toMatch(/<button[^>]*data-testid="tmux-prompt-continue"[^>]*disabled/);
  });

  test("no held hint unless the card was re-registered after a refused keypress", () => {
    expect(html(req({ answerKind: "enter" }))).not.toContain('data-testid="tmux-prompt-held-hint"');
    expect(html(req({ answerKind: "enter", held: true }))).toContain('data-testid="tmux-prompt-held-hint"');
  });
});

describe("TmuxPromptAnswerControls — OAuth code card", () => {
  const codeReq = req({
    answerKind: "code",
    paneText: " Browser didn't open? Use the url below to sign in\n\n Paste code here if prompted > ••••",
  });

  test("a one-line box with no autofill, no spellcheck and the shared length cap, plus Submit code", () => {
    const markup = html(codeReq);
    expect(markup).toContain('data-testid="tmux-prompt-code-card"');
    expect(markup).toContain("Claude is waiting for a sign-in code");
    const input = inputAttrs(markup);
    expect(input).toContain('type="text"');
    expect(input).toContain('autoComplete="off"');
    expect(input).toContain('spellCheck="false"');
    expect(input).toContain(`maxLength="${OAUTH_CODE_INPUT_MAX_LEN}"`);
    expect(OAUTH_CODE_INPUT_MAX_LEN).toBe(512);
    expect(input).toContain('value=""');
    expect(markup).toContain('data-testid="tmux-prompt-code-submit"');
    expect(markup).toContain("Submit code");
    // Not a menu and not an Enter card: no Continue button.
    expect(markup).not.toContain('data-testid="tmux-prompt-continue"');
  });

  test("Submit code is disabled until a valid code is typed", () => {
    expect(html(codeReq)).toMatch(/<button[^>]*disabled[^>]*data-testid="tmux-prompt-code-submit"|<button[^>]*data-testid="tmux-prompt-code-submit"[^>]*disabled/);
  });

  test("the pane text is shown as the server masked it", () => {
    const markup = html(codeReq);
    expect(markup).toContain("Paste code here if prompted &gt; ••••");
  });

  test("the held hint follows the flag", () => {
    expect(html(codeReq)).not.toContain('data-testid="tmux-prompt-held-hint"');
    expect(html({ ...codeReq, held: true })).toContain('data-testid="tmux-prompt-held-hint"');
  });
});

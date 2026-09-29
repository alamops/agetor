import { describe, expect, test } from "bun:test";
import { cleanMessageText } from "./message-history.ts";
import { AGETOR_PASTE_LEAD_IN } from "../../shared/user-message.ts";
import { composeLaunchPrompt } from "../../shared/agent-profile.ts";
import { HANDOFF_REMINDER_MARKER, composeHandoffReminder } from "../../shared/pipeline.ts";

/** Build claude's own `<pasted_content>` wrapper shape (the `oKe` function in
 *  the 2.1.277 binary — see docs/plans/pasted-content-tags.md §2 and the
 *  identical helper in src/shared/user-message.test.ts): a leading "\n\n",
 *  the open tag, `body` (padded with a trailing "\n" when it doesn't already
 *  end with one), then the close tag and a trailing "\n". */
function wrapPastedContent(id: string, body: string): string {
  const padded = body.endsWith("\n") ? body : `${body}\n`;
  return `\n\n<pasted_content id="${id}">\n${padded}</pasted_content id="${id}">\n`;
}

describe("cleanMessageText", () => {
  test("L-A5: agetor's automatic handoff reminder (marker on the first line) is dropped — never offered for resend", () => {
    const reminder = composeHandoffReminder({
      stepName: "Implement",
      reason: "handoff-missing",
      detail: null,
      outgoing: [{ name: "Review", label: "" }],
      transition: "choose",
    });
    expect(reminder.startsWith(HANDOFF_REMINDER_MARKER)).toBe(true);
    expect(cleanMessageText(reminder)).toBe("");
    // The original spelling, as persisted by earlier releases.
    expect(cleanMessageText("[agetor handoff reminder]\nYour last message ended without a <handoff> block.")).toBe("");
    // A claude step receives the reminder by paste, so its JSONL twin is
    // wrapped — the marker is only the first line once unwrapped.
    expect(cleanMessageText(wrapPastedContent("ab12", reminder))).toBe("");
    // A user who merely MENTIONS the marker mid-message is not a reminder.
    expect(cleanMessageText(`please resend the ${HANDOFF_REMINDER_MARKER} text`)).toBe(
      `please resend the ${HANDOFF_REMINDER_MARKER} text`,
    );
  });

  test("ordinary prose passes through trimmed", () => {
    expect(cleanMessageText("hello world")).toBe("hello world");
  });

  test("live echo and lead-in+wrapped JSONL twin of a pasted send clean to the same string", () => {
    const body = "line one\nline two";
    const echo = body;
    const twin = `${AGETOR_PASTE_LEAD_IN}${wrapPastedContent("0a7d", body)}`;
    expect(cleanMessageText(echo)).toBe(cleanMessageText(twin));
    expect(cleanMessageText(twin)).toBe(body);
  });

  test("lead-in with claude's wrapping gate off (no wrapper) reduces to the typed-after-lead-in text", () => {
    const twin = `${AGETOR_PASTE_LEAD_IN}\nplain pasted body`;
    expect(cleanMessageText(twin)).toBe("plain pasted body");
  });

  test("a launched-from-profile preamble reduces to the bare prompt", () => {
    const composed = composeLaunchPrompt({ instructions: "Be nice", skills: ["a"] }, "do the thing");
    expect(cleanMessageText(composed)).toBe("do the thing");
  });

  test("a pasted first prompt wraps the ENTIRE agent-instructions preamble (>4KB deferred-paste shape) — still reduces to the bare prompt", () => {
    const composed = composeLaunchPrompt({ instructions: "Be nice", skills: ["a"] }, "do the thing");
    const twin = `${AGETOR_PASTE_LEAD_IN}${wrapPastedContent("c0de", composed)}`;
    expect(cleanMessageText(twin)).toBe("do the thing");
  });

  test("a machine-emitted tagged message (forked-skill-launch pair) is dropped", () => {
    const text =
      "<local-command-stdout>Running in the background as @code-review</local-command-stdout>\n" +
      '<forked-skill-launch>{"agentId":"a7db6829e09d1ba9b","skillName":"code-review","description":"/code-review"}</forked-skill-launch>';
    expect(cleanMessageText(text)).toBe("");
  });

  test("local-command-stdout output alone is dropped (not user-authored)", () => {
    expect(cleanMessageText("<local-command-stdout>some output</local-command-stdout>")).toBe("");
  });

  test("a slash-command XML expansion reduces to the plain '/cmd args' echo", () => {
    const xml = "<command-name>/implement</command-name>\n<command-args>do the thing</command-args>";
    expect(cleanMessageText(xml)).toBe("/implement do the thing");
  });

  test("user-authored tags mixed with prose are kept verbatim (not machine-emitted)", () => {
    const text = "<context>hello</context> please use this";
    expect(cleanMessageText(text)).toBe(text);
  });

  test("a trailing 'Referenced files/folders:' block is stripped", () => {
    const text = "look at this\n\nReferenced files/folders:\n- /a/b.txt";
    expect(cleanMessageText(text)).toBe("look at this");
  });

  test("CRLF/CR newlines are normalized before parsing", () => {
    expect(cleanMessageText("hello\r\nworld")).toBe("hello\nworld");
  });
});

# Grill — Cursor questions in the Claude ask card

| Field | Value |
| --- | --- |
| Date | 2026-10-29 |
| Source | `docs/plans/cursor-questions-investigation.md`, then the owner's answers in chat (the structured question form was auto-rejected by Cursor print mode with the same skip string the investigation measured) |
| Mode | interactive, answered by the owner |
| Flags | none |

## One-way doors

1. **Replace the Cursor stream-json driver with `cursor-agent acp`.** The owner chose ACP so `cursor/ask_question` blocks and the tool result is the real answer. This supersedes D26 in `docs/plans/fx-0.0.14-and-cursor-updates-grill.md` ("stay on the CLI; `agent acp` is a separate ticket") for this feature. Session resume, plan approval, thinking, and usage have to keep working on the new driver, or the replacement is a regression.

## Decisions

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| D1 | Delivery | How should an answer reach Cursor? Print mode rejects `askQuestionToolCall` in ~57 ms and never reads stdin (`docs/plans/cursor-questions-investigation.md` §2). | **ACP.** Agetor launches `cursor-agent acp` and implements the `cursor/ask_question` extension. The process blocks until the user answers or skips. The tool result is that outcome. Not a follow-up message on `-p`, and not an Ink TUI scrape. The permission-request fallback is not the path: it drops multi-select, and D5 requires multi-select. | owner (1B) + evidence (investigation §1–§2) |
| D2 | Scope | Are Codex, OpenCode, and fx in this change? | **Cursor only.** Codex `request_user_input`, OpenCode `question`, and fx `ask_user_question` are a later ticket. Gemini, Copilot, and Antigravity stay out until a binary is installed to check. `switchMode`'s print-mode auto-reject is not a question card. | owner (2A) + accepted defaults |
| D3 | Card lifetime | How long does a Cursor card stay askable? | **Until answered or skipped, including across an Agetor restart, rebuilt from the stored question.** Stop, archive, and delete clear it. A normal settle does not, but under D1 the asking turn does not settle while `cursor/ask_question` is blocked. The 21 already-rejected historical calls are not cards: they already have a completed `result.rejected`. Rebuild only a question that has no completed result and no stored resolution. Answer, skip, stop, archive, and delete must persist that resolution, or a restart would show the card again. | owner (3A) + accepted defaults |
| D4 | Skip | Can the user dismiss without answering? | **Yes. Skip closes the card and the model hears it.** On the live ACP call that means completing `cursor/ask_question` with outcome `skipped` (the extension waits for answered, skipped, or cancelled). It does not also send a user-message follow-up: that wording was the `-p` mechanism for the same intent, and D1 removed that channel. Stop, archive, and delete cancel the run (the child dies); they do not send `skipped`. They still persist a resolution so D3 does not resurrect the card. | owner (4C), mapped onto the ACP outcome in the investigation |
| D5 | Free-text and multi-select | Custom answer, or Cursor's Other row? | **Keep the Claude card's "Custom answer" field and show the model's options unchanged.** `allowMultiple` uses the existing checkboxes. The card talks labels; the ACP answer talks option ids. | owner (5A) + accepted default |
| D6 | Transcript | Should the historical tool block render the questions? | **Yes.** The `askQuestionToolCall` block shows title, prompts, and options, separate from the live card, the way `AskUserQuestion` already gets a structured body. It does not itself ask the user. | owner (6A) |
| D7 | Card copy and kind | What does the card say, and which interaction kind is it? | **Reuse `kind: "ask_questions"`** so the board Answer button, notifications, the TUI overlay, and `agetor answer` work without a second card. The header is not "Claude is asking" and it does not say Cursor already continued. It says Cursor is waiting. Submit delivers the ACP `answered` outcome. A new `source` (not `"scraper"`) selects that delivery; the Claude keystroke path stays as it is. One card per tool call. A second question does not replace the first. Show `args.title` when set. The question text is `prompt`; if `prompt` is empty and `promptMarkdown` is set, show `promptMarkdown`. No feature flag. | accepted defaults, with the 1A "already continued" copy dropped because D1 waits |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| Cursor driver moves from `cursor-agent -p` stream-json to `cursor-agent acp`, including session resume, plan approval, thinking, and usage | in this change | owner (D1). Dropping those is a regression, not a smaller ticket |
| `cursor/ask_question` registration, the ask card, and `POST /ask-questions/:id/answer` completing the ACP request | in this change | owner (D1, D7) |
| Skip as ACP `skipped` | in this change | owner (D4) |
| Persist a resolution for answer, skip, stop, archive, and delete, and rebuild an unresolved question after restart | in this change | owner (D3) |
| Structured `askQuestionToolCall` body in the transcript (webview, and the same text on `agetor logs` / the TUI if those already render tool blocks) | in this change | owner (D6). A history view that stays a JSON dump after the webview is fixed would be unfinished |
| Claude pane scrape, keystroke drive, and `source: "scraper"` | out of scope | different path; D7 says leave it |
| Codex `request_user_input`, OpenCode `question`, fx `ask_user_question` | owner-deferred | owner (D2): later ticket |
| Gemini, Copilot, Antigravity question tools | out of scope | no binary was installed to verify (D2) |
| `switchMode` and other print-mode interaction rejects | out of scope | not a question card (D2) |
| The 21 historical `result.rejected` calls as live cards | out of scope | accepted default under D3: they already have a completed result |
| Feature flag | out of scope | accepted default (D7) |
| `@cursor/sdk` | out of scope | D1 is the CLI's ACP server, not the SDK. D26's "stay on `-p`" is what this feature overturns |

## Assumptions still open

- **Restart delivery.** D3 rebuilds the card after a restart. D1's answer channel is a blocked ACP request, and a restart kills that child (fx has the same shape: no reattach of a live process). Whether `cursor-agent acp` can resume a session that is still waiting on `cursor/ask_question` was not spiked. The plan must spike it. If resume restores the pending question, Submit and Skip complete that request. If it does not, Submit and Skip on the rebuilt card send the picks, or an explicit skip, as the next user message, and the card says the wait ended when Agetor restarted. What changes if that fallback is rejected: the rebuilt card is display-only and the user has to ask again.
- **Custom text on the extension.** The protobuf success result has `freeformText`. The investigation's ACP `answered` payload quotes only `{ questionId, selectedOptionIds }`. D5 keeps Custom answer. The plan must confirm the extension accepts freeform text (or the CLI's `__freeform_other__` mapping). If it accepts neither, Custom answer cannot be delivered as the tool result, and that is a plan change, not a silent drop.
- **`runAsync`.** None of the 21 stored calls set it. A call that arrives with `runAsync: true` is still one card and still answers the live ACP request. What changes if the CLI does not block on that flag: the card would be showing a question the model already left, and D1's premise fails for that call only.

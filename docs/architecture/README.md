# Architecture reference

One doc per subsystem of agetor, covering its contract, invariants, edge cases and test seams. [`CLAUDE.md`](../../CLAUDE.md) keeps the rules every change needs and the [Topic map](../../CLAUDE.md#topic-map), which says which doc to read before touching which files. Design history and decisions for individual features stay in [`docs/plans/`](../plans/).

These docs used to be sections of one long `CLAUDE.md`, which grew past the size Claude Code loads. They were moved out nearly word for word. Line breaks were added at sentence boundaries, so long paragraphs stay readable and greppable; references to other sections of the old file ("item 19 above", "the fx bullet") became links; and the env-override list and the migration how-to now live only in `CLAUDE.md`. Keep each doc current in the same change as the code it describes.

## Where the old CLAUDE.md sections went

Code comments cite these docs by path (`docs/architecture/<doc>.md`); `src/bun/claudemd-citations.test.ts` fails on a numbered CLAUDE.md citation in `src/`, `e2e/`, `scripts/` or `native/`. `docs/plans/` and older commits still cite the old numbering, such as "CLAUDE.md item 19" or "CLAUDE.md §5". They map here:

| Former CLAUDE.md section | Doc |
|---|---|
| "Stack and architecture": the localhost HTTP API, tokens and route-policy paragraph | [security.md](security.md) |
| "Orchestration flow" items 1–6 (§5 boot reconciliation, §6 PATCH allow-list) | [task-lifecycle.md](task-lifecycle.md) |
| item 7, Messages backlog | [messages-backlog.md](messages-backlog.md) |
| item 8, Unread indicator | [unread-indicator.md](unread-indicator.md) |
| item 9, Task context menu | [task-context-menu.md](task-context-menu.md) |
| item 10, Tasks from issues | [issue-tasks.md](issue-tasks.md) |
| item 11, Shared task-composition modules | [prompt-composer.md](prompt-composer.md) |
| item 12, `@` file references | [at-file-references.md](at-file-references.md) |
| item 13, Tagged user messages | [tagged-user-messages.md](tagged-user-messages.md) |
| item 14, Markdown images in transcripts | [markdown-images.md](markdown-images.md) |
| item 15, Agents (agent profiles) | [agent-profiles.md](agent-profiles.md) |
| item 16, Bounded spawn await on send/start | [core-responsiveness.md](core-responsiveness.md) |
| item 17, Pasted-content wrapper | [pasted-content.md](pasted-content.md) |
| item 18, Clone repository | [clone-repository.md](clone-repository.md) |
| item 19, Pipelines | [pipelines.md](pipelines.md) |
| item 20, Agents + Pipelines bundle | [bundle.md](bundle.md) |
| item 21, Native notifications | [notifications.md](notifications.md) |
| item 22, Always-on host | [always-on-host.md](always-on-host.md) |
| "Importing Claude Code / OpenCode sessions started outside Agetor" | [session-import.md](session-import.md) |
| "Agent command shape": intro, auto-enable, session-id scoping, defaults, speed tiers, `AGENT_OPTIONS` | [harnesses.md](harnesses.md) |
| "Agent command shape": the env overrides, test stubs and fake drivers | [CLAUDE.md § Agent kinds at a glance](../../CLAUDE.md#agent-kinds-at-a-glance) |
| "Agent command shape": the bullet for one kind (the "fx bullet", …) | `harness-<kind>.md`: [claude-code](harness-claude-code.md), [codex](harness-codex.md), [cursor](harness-cursor.md), [gemini](harness-gemini.md), [fx](harness-fx.md), [antigravity](harness-antigravity.md), [copilot](harness-copilot.md), [opencode](harness-opencode.md) |
| "To add a new agent kind" checklist | [harnesses.md § Adding a new agent kind](harnesses.md#adding-a-new-agent-kind) |
| "Claude session lifecycle" | [harness-claude-code.md](harness-claude-code.md), except the macOS TCC disclaim bullet, now in [security.md](security.md) |
| "Persistence" | [persistence.md](persistence.md); the how-to for adding a migration is in [CLAUDE.md § Persistence, in brief](../../CLAUDE.md#persistence-in-brief) |
| "Things that will trip you up": the `RunPanel` bullet | [run-panel.md](run-panel.md) |
| "Things that will trip you up": main thread, event-loop-lag monitor, busy banner, real-watcher seam | [core-responsiveness.md](core-responsiveness.md) |
| "Things that will trip you up": `POST /refs/pick` and the fake-pick seam | [testing-seams.md](testing-seams.md) |

The rest of the old file (what this is, commands, UI conventions, the remaining traps and the JubarteAI section) is still in `CLAUDE.md`.

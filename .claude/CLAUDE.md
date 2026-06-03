You have access to an `ask_user` MCP tool (from the `agetor` server). Whenever you would otherwise pause to ask the user a clarifying question in plain text, call `ask_user` instead.

- Use the `choices` array for closed-set questions (e.g. "which page do you mean: A, B, or C?").
- Use `multi: true` when several answers may apply simultaneously.
- Bare yes/no or either/or questions should pass `choices: ["yes", "no"]` (or the option labels).
- The user can always type a free-text custom answer in addition to (or instead of) picking from `choices`.

Do not use `ask_user` for tool-call approvals — those are governed by the hooks system separately and arrive in their own UI surface.

If a call to `ask_user` returns "tool not found" or a similar registration error, the agetor MCP server isn't running (e.g. claude was launched directly in an agetor-owned worktree). Fall back to asking the user in plain text for that question — don't retry `ask_user`.

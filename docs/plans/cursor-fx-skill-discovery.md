# Plan — Cursor and fx skill autocomplete

| Field | Value |
| --- | --- |
| Date | 2026-10-06 |
| Source | `/implement` — cursor skills missing from the New Task composer, the task-details composer, and the Agent skill box; the Agent skill box also fails to match a leading `/`. Same gap checked on the other harnesses. |
| Config | `AGENTS_CONFIG.yml` (old balanced preset, no `version:`; `/implement --update` exists and was not run) |
| Flags | none |
| Gates | grilled + approved by owner |
| Branch | `fix/fix-cursor-autocomplete-skills` |
| Base SHA | `39f2a4618c342be8486d397a1f2565578af50b83` |

## 1. Objective & success criteria

Cursor and fx skill autocomplete works on every surface that already works for Claude Code: the New Task prompt, the task-details / RunPanel composer, the Create-from-issue and Resolve-conflicts composers, the Agent skill box, `agetor commands`, and the TUI. Those surfaces all read `GET /agent-discovery`, so fixing discovery fixes them together.

Done means:

- A Cursor harness lists skills from the same directories cursor-agent `2026.10.01-14929f9` scans, at user level and in the project (branch-scoped when a ref is set). Built-ins under `~/.cursor/skills-cursor` are included and lose to a same-named skill the user wrote.
- An fx harness lists every skill root the installed `fx` binary advertises, user and project.
- In the Agent skill box, typing `/implement` matches the skill shown as `/implement`, and the saved name is still `implement` with no slash. The same filter applies for every harness.
- Claude Code and Codex discovery stay as they are.
- An additional-account Cursor or fx harness reads skills from the same `HOME` the spawn uses. An explicit `HOME` in `harness.env` wins, otherwise `HOME` is `harness.home`, otherwise the process home. That home is used instead of the machine default.

## 2. Context & constraints

Skills and slash commands are one walk. `listAvailableCommands` (`src/bun/commands.ts`) returns commands; `listAgentCapabilities` derives skill extensions by stripping one leading `/` from each skill command (`name: c.name.replace(/^\//, "")`, `insert: c.name`). `SlashAutocomplete` and `SkillsPicker` are both fed by that response. The route (`src/bun/server.ts`, `GET /agent-discovery`) passes `agent: harness.kind`, `workdir`, `branch`, `harness.home`, and `harness.env`.

`discoverSkills` lists one directory level and treats a child folder that contains `SKILL.md` as a skill named `"/" + folder`. It does not recurse, so a nested `.system/` directory is skipped on its own. Symlinked skill directories are followed by the directory read, which is how Claude already sees `~/.claude/skills` when those entries are links.

Dedupe keeps the first entry, except a project entry replaces a user entry of the same name. Built-ins must be pushed last or a user skill of the same name cannot win. Claude already does this.

Project files at a git ref come from `loadRefProjectTree`. `resolveProjectTree` does not pass pathspecs, so the default is `[".claude", ".codex", ".mcp.json"]` (`src/bun/ref-tree.ts`). `isDiscoveredCapabilityPath` then refuses to read anything outside `CAPABILITY_READ_PATTERNS`. A new project skill directory is invisible on a branch until both the pathspec and the read pattern include it. With no branch, the live disk tree is used and pathspecs do not apply. An unknown ref yields an empty project tree; user and builtin rows still show.

Cursor and fx additional accounts isolate with `HOME` (`harnessEnv` in `src/bun/agents.ts`). That helper sets `HOME` from `harness.home`, then the stored `harness.env` map overwrites it, so an explicit env `HOME` wins. Claude's `harness.home` is a config directory (`CLAUDE_CONFIG_DIR`), not a home. The new scans must not reuse the Claude interpretation.

**Cursor, measured** in cursor-agent `2026.10.01-14929f9` (`index.js`, skill-root table `Gn` plus builtin `$n`):

| Scope | Directory |
| --- | --- |
| User and project | `.cursor/skills`, `.claude/skills`, `.codex/skills`, `.grok/skills`, `.agents/skills` |
| Built-in, user home only | `.cursor/skills-cursor` |

On this machine `~/.cursor/skills` does not exist. Real user skills live in `~/.agents/skills` and are linked from `~/.claude/skills`. Built-ins (`create-skill`, `review`, and the rest) are real `SKILL.md` trees under `~/.cursor/skills-cursor`.

**fx, measured** from strings in `~/.local/bin/fx` (Sep 13 build):

| Scope | Directories |
| --- | --- |
| User | `~/.fx/skills`, `~/.config/opencode/skills`, `~/.codex/skills`, `~/.claude/skills`, `~/.agents/skills`, `~/.claw/skills` |
| Project | `.fx/skills`, `skills/`, `.opencode/skills`, `.codex/skills`, `.claude/skills`, `.agents/skills`, `.claw/skills` |

Global opencode is `~/.config/opencode/skills`. Project opencode is `.opencode/skills`. There is no `~/.opencode/skills` in the binary. `~/.fx/skills` on this machine is symlinks into `~/.agents/skills`.

**Codex** already scans user `prompts` and `skills`, project `.codex/prompts` and `.codex/skills`, and `skills/.system`. Leave that walk alone.

**Gemini** has no `gemini` binary on `PATH` and no skills tree under `~/.gemini`. The existing comment in `listAvailableCommands` is right: custom commands are TOML, not `SKILL.md`.

**Antigravity** is an `AgentKind` with no discovery branch, no `agy` binary, and no home directory on this machine.

**The slash bug is only in `SkillsPicker`.** The composer autocomplete already searches the text after `/` (`SlashAutocomplete`). The skill box stores names with the slash stripped (`normalizeSkillName`, `SKILL_NAME_LEAD_RE = /^[\s/]+/`) and renders `/{name}`, but filters with the raw input. `"implement".includes("/implement")` is false. Commit of a bare `/` already normalizes to empty; `e2e/agent-profiles-settings.spec.ts` depends on Tab of `/` committing nothing and moving focus. The filter change must not change that commit.

Host for this run is Cursor (native Task tool, no Claude Code Agent tool). `investigate` / `implementation` / `tests_*` are configured as `type: claude` model `sonnet`. `claude -p` is installed (`2.1.292`) and refused with the weekly limit, resetting Oct 10, 2026 8am America/New_York. That is a quota failure, not a fallback trigger. Phase 1 was done in this session. Later Claude-runner phases will hit the same wall and must be announced rather than silently rerouted.

## 3. Approach & key decisions

Reuse `discoverSkills` and the existing project-overrides-user dedupe. Add a Cursor branch and an fx branch in `listAvailableCommands`. Do not invent a second skill parser.

**Cursor roots** (owner: full set, built-ins shown). User home, in cursor-agent's `Gn` order, then the same relative paths on the project tree, then `skills-cursor` last with source `builtin`:

1. `<home>/.cursor/skills`
2. `<home>/.claude/skills`
3. `<home>/.codex/skills`
4. `<home>/.grok/skills`
5. `<home>/.agents/skills`
6. project `.cursor/skills`, `.claude/skills`, `.codex/skills`, `.grok/skills`, `.agents/skills`
7. `<home>/.cursor/skills-cursor` (never from the git ref)

`<home>` is `harness.env`'s `HOME` when that is set, otherwise `harness.home`, otherwise `os.homedir()`. That matches spawn: `harnessEnv` writes `HOME` from `harness.home` and then lets the env map overwrite it. A same-named skill in two user roots keeps the first (`.cursor` before `.claude` before `.codex` before `.grok` before `.agents`). A project skill replaces a user skill of the same name. A built-in replaces nothing that was already found.

**fx roots** (owner: full set). User roots first, in the order listed in §2, then project roots in that same table order, so a project skill replaces a user skill. No built-in list. `<home>` resolves the same way as Cursor: env `HOME`, then `harness.home`, then `os.homedir()`. `~/.config/opencode/skills` is `path.join(home, ".config", "opencode", "skills")`. The bare project directory is `skills`, one level, same `SKILL.md` rule.

**Slash filter** (owner: every harness, save without the slash). In `SkillsPicker`, strip leading whitespace and slashes from the query with `SKILL_NAME_LEAD_RE` before `includes` against the stored name and the description. An empty result after stripping shows the full list, which is what a lone `/` should do. `commit` keeps calling `normalizeSkillName`. Do not change `SlashAutocomplete`, stored names, or the chip display.

**Branch scope.** Extend `DEFAULT_PATHSPECS` with `.cursor`, `.agents`, `.grok`, `.fx`, `.opencode`, `.claw`, and `skills`. Extend `CAPABILITY_READ_PATTERNS` so the only new files read are `*/SKILL.md` one directory under each of those skill roots (and `skills/*/SKILL.md` for the bare fx root). Do not read `.cursor/rules`, skills-cursor from a ref, or other files those pathspecs happen to list. The ref-tree test that lists the repo root only asserts `.claude`, `.codex`, and `.mcp.json` are present and that `README.md` / `src` are absent; it does not pin the pathspec list to exactly three names. Update it only if a fixture assertion starts failing.

**What stays put.** Codex's own walk. Claude's own walk. Cursor MCP parsing (`discoverMcpAndPluginExtensions` still returns nothing for cursor). `CURSOR_BUILTINS` stays empty; the built-in skills come from disk, not from a hardcoded command list. Gemini's TOML commands. Antigravity.

## 4. Work breakdown — implementation tasks

### I1 — Cursor and fx skill discovery

- **Goal:** `listAvailableCommands` returns cursor and fx skills from the roots in §3, including harness-home isolation and branch-scoped project skills.
- **Owns:** `src/bun/commands.ts`, `src/bun/ref-tree.ts` (`DEFAULT_PATHSPECS` only), and the two comments that would become false: the cursor "no discovery" sentence in `commands.ts`, and the matching cursor-skills sentence in `CLAUDE.md` (skills only; leave the MCP sentence).
- **Depends on:** nothing.
- **Acceptance:**
  - Cursor with a temp home sees a skill in each user root and in `skills-cursor`.
  - A user or project skill named the same as a built-in wins, and the built-in still appears when no collision exists.
  - The same skill linked from two user roots appears once.
  - fx with a temp home sees a skill in each user root, including `~/.config/opencode/skills`, and a project skill in `.fx/skills`, bare `skills/`, `.opencode/skills`, and `.claw/skills`.
  - A project skill replaces the user skill of the same name for both harnesses.
  - With `branch` set, a skill that exists only in that ref is offered and an uncommitted skill on disk is not.
  - An explicit harness-env `HOME` wins over `harness.home` for both. With no env `HOME`, `harness.home` is the home. Claude's config-dir meaning is unchanged.
  - Codex and Claude tests that already pass keep passing.
  - No `TODO` / `FIXME` standing in for a root from §3.

### I2 — Leading-slash skill search

- **Goal:** the Agent skill box matches a query that starts with `/`, and still saves the name without it.
- **Owns:** `src/mainview/components/kanban/SkillsPicker.tsx`, and a pure helper if the filter is extracted so it can be unit-tested without jsdom. Prefer `skillQueryText` next to `normalizeSkillName` in `src/shared/agent-profile.ts` (strip via `SKILL_NAME_LEAD_RE`, no other change to stored names).
- **Depends on:** nothing. Disjoint from I1.
- **Acceptance:** query `/implement` matches name `implement`; `//implement` and ` /implement` do too; a lone `/` is an empty query (full list); commit of `/` is still empty; commit of `/implement` stores `implement`; description search still works after the strip.

## 5. Work breakdown — test tasks

E2e applies to the skill box, because the slash filter is user-visible and the repo already drives that box in Playwright. Discovery itself is covered by unit tests against temp homes and a temp git repo, which is how `commands.test.ts` already tests Claude and Codex. An e2e that planted skills in the real `~/.cursor` would depend on this machine and is not part of the recipe.

Recipe:

- Unit: `bun test src/bun/commands.test.ts src/bun/ref-tree.test.ts src/shared/agent-profile.test.ts`
- Typecheck: `bun run typecheck`
- E2e: `bunx playwright test e2e/agent-profiles-settings.spec.ts` (the skills-picker block). The Playwright harness starts its own backend; no extra credentials. Do not point it at the developer's live `~/.agetor`.

### T1 — Discovery tests (covers I1)

- **Owns:** `src/bun/commands.test.ts`, and `src/bun/ref-tree.test.ts` only if a default-pathspec assertion must name a new root.
- **Cases:** cursor user roots; builtin loses to a same-named user skill and shows when it does not collide; fx user roots including `~/.config/opencode/skills`; fx project roots including bare `skills/` and `.opencode/skills`; project overrides user; harness env `HOME` overrides `harness.home`; branch ref offers the committed skill and hides the uncommitted one; Claude and Codex cases untouched.

### T2 — Slash-filter tests (covers I2)

- **Owns:** `src/shared/agent-profile.test.ts` for the pure helper, and `e2e/agent-profiles-settings.spec.ts` for the box.
- **Cases:** helper strips a leading `/` and whitespace and nothing else. In the existing skills-picker flow, filling `/code` shows the `code-review` row (the builtin the spec already relies on), and the existing "Tab on `/` commits nothing" assertion still holds.

## 6. Execution waves

| Wave | Tasks | Barrier |
| --- | --- | --- |
| 1 | I1 and I2 in parallel | Disjoint files. Wait for both before review. |
| 2 | Review of the wave-1 diff | No tests in that diff by design. |
| 3 | T1 and T2 in parallel | Disjoint files. |
| 4 | Run unit tests, typecheck, and the skills-picker e2e | Fix loop only if something fails. |

One agent per task. The configured implementation runner is Claude Sonnet via `claude -p`. That CLI is over its weekly limit until Oct 10, 2026 8am America/New_York. Phase 4 will not pretend Sonnet ran. The quota error will be reported, and any substitute runner will be named before it writes.

## 7. Blast radius & risks

- **Callers of `listAvailableCommands` / `listAgentCapabilities`:** the discovery route, `agetor commands`, the TUI, `PromptComposer` (New Task, RunPanel, issue dialog, resolve-conflicts), and `SkillsPicker`. All of them pick up new rows with no client change except the skill-box filter. Empty directories stay empty; a missing home directory adds nothing.
- **Dedupe across linked roots.** `~/.agents/skills` and `~/.claude/skills` are the same files on this machine. First-user-wins collapses them to one row. A description mismatch between two real copies of the same name is resolved by scan order, not merged.
- **Wider `git ls-tree`.** Every branch-scoped discovery, including Claude, will list the new pathspecs. Reads stay limited to `SKILL.md`. A repo with a large top-level `skills/` directory costs a longer listing and no extra file reads.
- **Built-ins in the slash menu.** `skills-cursor` entries are skills, so they also appear as `/create-skill`, `/review`, and the rest in the prompt composer. That is the same list the skill box shows. They lose to a same-named user or project skill.
- **Cursor scanning `.claude/skills` and `.codex/skills`.** Those directories are already scanned for their own harnesses. Scanning them again for Cursor does not change Claude or Codex results.
- **Rollback.** No migration and no stored-data change. Revert the branch.
- **Comments.** The "Cursor has no skill discovery" lines become false and are updated in I1. The MCP-discovery gap stays documented because this run does not parse Cursor MCP config.

## 8. Open questions / assumptions

Owner answers:

| Question | Answer | Source | Confidence |
| --- | --- | --- | --- |
| Which Cursor directories, and are built-ins hidden? | Same set cursor-agent scans, user and project. Built-ins in `~/.cursor/skills-cursor` show and lose to a same-named skill you wrote. | Owner, this thread | High |
| fx roots: only `~/.fx/skills` and `.fx/skills`, or every root the binary advertises? | Full set, including `.opencode`, `.claw`, and bare `skills/`. | Owner, this thread | High |
| Leading `/` in the Agent skill box? | Ignore leading slashes while filtering, on every harness. Save the name without the slash. | Owner, this thread | High |

Assumption, not an owner answer: Gemini and Antigravity stay out of this run. Gemini commands are TOML and there is no skills tree to scan; Antigravity has no discovery layout in the repo and no binary on this machine. Say so at approval if either should be pulled in.

Codex needs no scan change. Its behavior is the reference for "project overrides user," not a gap.

## 9. Completeness ledger

| Candidate | Disposition |
| --- | --- |
| Cursor user roots `.cursor`, `.claude`, `.codex`, `.grok`, `.agents` | In this run — I1 |
| Cursor project roots, branch-scoped | In this run — I1 |
| Cursor built-ins in `skills-cursor`, losing to a same name | In this run — I1 |
| Cursor/fx home: env `HOME` wins, else `harness.home` | In this run — I1 |
| fx user and project roots from the binary, including opencode, claw, and bare `skills/` | In this run — I1 |
| Pathspecs and read patterns so a ref can see the new project dirs | In this run — I1 |
| Stale "no Cursor skill discovery" comments in `commands.ts` and `CLAUDE.md` | In this run — I1 |
| Leading-slash filter on every harness's skill box, commit unchanged | In this run — I2 |
| Unit tests for the new roots, precedence, home, and ref | In this run — T1 |
| Unit plus e2e for the slash filter, including the existing bare-`/` Tab case | In this run — T2 |
| Composer, issue dialog, resolve-conflicts, CLI, TUI | In this run — they call the same discovery function; no separate UI task |
| Codex scan changes | Out of scope — already works; a different change |
| Gemini TOML command discovery | Out of scope — different format, no local skills tree, not what was asked |
| Antigravity skill discovery | Out of scope — no layout and no binary; a different ticket once a layout exists |
| Cursor MCP / plugin config parsing | Out of scope — pre-existing documented gap, not the skill walk |
| Hardcoded `CURSOR_BUILTINS` command list | Out of scope — built-in skills come from `skills-cursor` on disk |
| Changing stored skill names or `normalizeSkillName` | Out of scope — the filter is display-search only; storage is already correct |

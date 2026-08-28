# Plan — Fix vulnerable transitive `shell-quote` in bun.lock (issue #197) + clear remaining `bun audit` findings

| Field | Value |
| --- | --- |
| Date | 2026-08-27 |
| Source | GitHub issues alamops/agetor#197 and #196 (RedGem scanner reports on the same `shell-quote.8.3` pin — #197: CVE-2026-13311 parse() DoS; #196: CVE-2026-9277 quote() newline; 0 comments each) + conversation |
| Config | AGENTS_CONFIG.yml (balanced: investigate/implement/tests sonnet, review opus, test-run haiku, planning self) |
| Flags | none |
| Gates | grilled + approved by owner (2 grill answers; plan approved 2026-08-27, "Approve, go ahead") |
| Branch | `feature/issue-197-possible-fix-deps-2-vulnerable` (agetor-created; not the default branch) |
| Base SHA | `7c85f87` (tree clean at start) |

## 1. Objective & success criteria

Remove the vulnerable `shell-quote@1.8.3` from `bun.lock` (the two advisories the scanner collapsed into "2 vulnerable dependencies"), prove the regression is closed with a test, and — per the owner's grill answer — clear the *rest* of the `bun audit` report in a separate, droppable commit.

Done means:
- `bun audit` no longer lists `shell-quote`; every `shell-quote@…` resolution in `bun.lock` is ≥ 1.9.0.
- `src/bun/lockfile-advisories.test.ts` exists, **fails on the pre-fix lockfile** (captured), passes after.
- Commit 1 (`Fixes #197`) contains only the shell-quote fix + the guard test. Commit 2 (`chore(deps)`) contains only the in-range bumps of the other audit-flagged packages, and lands only if typecheck + `bun test` + `vite build` + Playwright e2e stay green.
- Nothing pushed; both commits local.

## 2. Context & constraints (grounded findings)

- **`shell-quote` is not a direct dependency.** `package.json` has no `shell-quote` entry, so the issue's `package.json` diff cannot be applied. It enters via two paths (`bun.lock:641`, `bun.lock:1301`):
  - `concurrently@9.2.1` → `"shell-quote": "1.8.3"` (**exact pin**, devDependency; only used by the `dev:hmr` script, `package.json:9`).
  - `react-devtools-core@6.1.5` → `"shell-quote": "^1.6.1"` (a peer required by `ink@7` — `peerDependencies.react-devtools-core: ">=6.1.2"` — added in da8c2cd for the CLI; ink only loads it when `DEV=true`).
  - No file under `src/` or `scripts/` imports `shell-quote`. **Real exposure is nil**; this is dependency hygiene + scanner noise.
- **Advisories (GitHub Advisory DB, fetched 2026-08-27):**
  - GHSA-395f-4hp3-45gv / **CVE-2026-13311** (high) — quadratic `parse()`; vulnerable **≤ 1.8.4**. So the floor is **1.9.0** — the issue's `^1.9.0` is correct and 1.8.4 is *not* enough.
  - GHSA-w7jw-789q-3m8p / CVE-2026-9277 (critical; **issue #196**) — `quote()` doesn't escape newlines in `.op`; vulnerable ≥1.1.0 ≤1.8.3 (fixed 1.8.4). #196 suggests 1.8.4, which would still leave the parse() DoS open — the ≥1.9.0 floor closes both issues with one change.
  - Registry: `shell-quote` latest is **1.10.0**; 1.8.4, 1.9.0, 1.10.0 all published.
- **Spike verdict (reproduced, scratchpad only, bun 1.3.10):** `parse("a ".repeat(n))`
  - 1.8.3: 5k → 37.6 ms, 10k → 58.8 ms, 20k → 195.6 ms, 40k → 625.7 ms (≈3.2× per doubling: quadratic).
  - 1.10.0: 5k → 11.0 ms, 10k → 7.9 ms, 20k → 12.5 ms, 40k → 33.3 ms (linear).
  - Artifact: `<scratchpad>/spikes/shell-quote-dos/{old,new}/bench.ts`.
- **~~No override needed.~~ Superseded by §9 — an override IS required for the `react-devtools-core` path.** `concurrently@9.2.4` (published after 10.0.x as a backport, inside our `^9.2.1` range) pins `shell-quote: 1.9.0`; 9.2.3 pins 1.8.4 (still vulnerable); 10.0.5 pins 1.9.0 but is out of range. `react-devtools-core`'s `^1.6.1` only re-resolves on a full lockfile regeneration — never on any `bun update` variant (§9) — which is why `overrides.shell-quote` is what actually moves that path.
- **Rest of `bun audit` (26 findings: 1 critical, 6 high, 14 moderate, 5 low; 2 are shell-quote):** all are in-range bumps of the flagged package itself — `postcss` 8.5.14 (direct `^8.5.14`, fix ≤8.5.22→8.5.26), `vite` 8.0.12 (direct `^8.0.12`, in-range latest 8.2.2), `nanoid` 3.3.12 (`^3.3.11`, fix 3.3.16), `ip-address` 10.2.0 (`^10.1.1`, vulnerable ≤10.3.0), `dompurify` 3.4.3 (`^3.3.1`, vulnerable ≤3.4.5), `mermaid` 11.15.0 (`^11.14.0`, fix 11.16.1). Excluded on purpose: `electrobun` (2.x is a major; the app runtime), `tailwindcss` (4.x major), `@lobehub/*` / `lucide-react` / `ink` / `react` (not flagged; not needed to move the flagged transitives).
- **Test conventions:** bun tests live under `src/` (`bunfig.toml` `[test] root = "src"`); `src/bun/dev-defaults.test.ts` is the house pattern for "guard a repo file against drift" (JSON import of `../../package.json`, a *Why this exists* comment block). `bun.lock` is JSONC (trailing commas) — read as text, not JSON-imported. Every resolution, nested or hoisted, is a tuple whose first element is `"<name>@<version>"` (e.g. `bun.lock` tail: `"yargs/string-width/strip-ansi/ansi-regex": ["ansi-regex@5.0.1", …]`), so matching `"shell-quote@X"` catches all paths.
- **Runnability:** no CI and no audit step exist in the repo. `bun test` (124 files under `src/bun` alone), `bun run typecheck`, `vite build`; Playwright e2e via `bun node_modules/@playwright/test/cli.js test` (`bunx playwright` is broken per fleet knowledge), whose `webServer` starts `bun run hmr` (vite dev server) itself. Agent shells need `PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"` (bun + tmux) or daemon tests fail with ENOENT (fleet knowledge, environmental).
- `node_modules` was installed from the frozen lockfile during investigation (untracked; no tracked file changed).

## 3. Approach & key decisions

| Decision | Choice | Why | Basis |
| --- | --- | --- | --- |
| How to move `shell-quote` | `overrides.shell-quote = "^1.9.0"` + `concurrently ^9.2.4` (amended, see §9) | Scratchpad tests showed bun 1.3.10 never re-resolves a transitive edge unless its dependent's version changes, so `bun update` (targeted or full) cannot fix the `react-devtools-core` path; the override is the only targeted fix and doubles as a permanent floor. concurrently 9.2.4 takes the upstream fix so the override is not load-bearing for that path. | Tests A/A2/C (§9) |
| Floor | ≥ 1.9.0 | CVE-2026-13311 is vulnerable through 1.8.4 | advisory DB |
| Reproduction | spike timing + failing guard test | The issue asks for a failing test or reproduced steps; both are cheap and durable | spike (§2) |
| Second commit | full lockfile regeneration (`rm bun.lock && bun install`), separate commit (amended, see §9) | The other 24 findings are nested edges of unchanged packages; only a regeneration (or six sticky overrides, rejected) clears them. Ranges in `package.json` are untouched; the resolved versions move to latest-in-range. Owner chose this over skipping. | Test C + dry run 3a (§9) |
| Guard test | `src/bun/lockfile-advisories.test.ts`, table-driven floors | Only automated backstop (no CI); one-line to add future floors | grill Q2 |
| Who runs the lockfile commands | orchestrator, inline | Two deterministic shell steps whose diff must be audited line-by-line anyway; a sub-agent adds a "ran `--latest`" risk without saving time | cost/risk |

Alternatives rejected: ~~`overrides: { "shell-quote": "^1.9.0" }` (works, but unnecessary and sticky)~~ — adopted after all once §9 showed it is the only targeted mechanism; bumping `concurrently` to 10.x (major, out of range); a test that shells out to `bun audit` (network in tests).

## 4. Work breakdown — implementation tasks

| ID | Goal | Owns (exact files) | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Guard test: parse `bun.lock`, assert every `shell-quote@…` resolution ≥ 1.9.0; table-driven `{ name, min, advisories[] }`; assert ≥1 resolution found; `Bun.semver.satisfies` for the compare; plus (review fix) a `package.json` check that the `overrides` range still admits `min` and rejects `lastVulnerable`, a non-registry/prerelease partition, and a lazy lockfile read; house-style *Why this exists* header | `src/bun/lockfile-advisories.test.ts` (new) | — | `bun test src/bun/lockfile-advisories.test.ts` **fails** on the current lockfile with a message naming the offending version; typecheck clean |
| T2 | Shell-quote fix (amended §9): set `concurrently ^9.2.4` and `overrides.shell-quote ^1.9.0` in `package.json`, then `bun install`; verify the lockfile diff touches only the workspace range, the `overrides` block, and the `concurrently` / `shell-quote` entries; `bun audit` drops shell-quote; T1 passes; smoke `concurrently -n a,b "echo a" "echo b"`; **commit 1** with `Fixes #197` | `package.json`, `bun.lock` | T1 done (fail-first evidence captured before the lockfile moves) | commit exists; `git show --stat` = package.json + bun.lock + the test file + this plan |
| T3 | Audit sweep (amended §9): `rm bun.lock && bun install` — full regeneration, every resolution to latest-in-range, `package.json` untouched; `bun audit` clean (residuals reported, not hidden); `bun run typecheck`; `bunx vite build`; `bun test`; **commit 2** `chore(deps)` | `bun.lock` | T2 committed | green gates; commit exists |

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Notes |
| --- | --- | --- | --- |
| T1 | unit (bun test) | T2 (and any future lockfile regression) | Is both the reproduction and the regression guard |
| R1 | full unit suite | T2, T3 | `bun test` |
| R2 | typecheck + bundle | T3 | `bun run typecheck`, `bunx vite build` |
| R3 | e2e (Playwright) | T3 only | **Applies as a toolchain gate**: the sweep moves vite/postcss, and the e2e `webServer` is vite itself. Recipe: `PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH" bun node_modules/@playwright/test/cli.js test` (starts `bun run hmr` on 5173, fake drivers, no credentials). Flaky-on-load: re-run a failing spec once before diagnosing. Not applicable to commit 1 (no product code changed). |

## 6. Execution waves

1. **Wave 1** — T1 (sonnet `general-purpose` agent). Must finish and report the failing run before anything touches `bun.lock`.
2. **Wave 2** — T2 then T3, sequential (same file `bun.lock`), orchestrator inline. Commit after each.
3. **Wave 3** — Phase 5 review (opus agent, read-only) on `git diff 7c85f87...HEAD`, in parallel with Phase 7 test run (haiku agent, background: R1 + R2 + R3).
4. **Wave 4** — Phase 8 fixes only if review/test findings require; re-run.

## 7. Blast radius & risks

- `concurrently` 9.2.1 → 9.2.4: dev-only (`dev:hmr`). Smoke-tested in T2.
- `shell-quote` 1.8.3 → 1.9.0/1.10.0: dev-only consumers; 1.x API (`parse`/`quote`) unchanged.
- `overrides.shell-quote ^1.9.0` REPLACES every dependent's declared range (bun semantics): `concurrently.2.4`'s exact `1.9.0` pin is force-fed 1.10.0 (benign — 1.x `parse`/`quote` API is stable and `dev:hmr` only quotes two literal strings), and the caret imposes a `<2.0.0` ceiling. **Removal condition:** drop the override once every dependent's own range floors at >=1.9.0 (today only `react-devtools-core`'s `^1.6.1` does not); revisit when shell-quote 2.x ships, since a dependent moving to `^2` would be silently pinned back to 1.x. The guard test enforces the floor in both files but is structurally blind to the ceiling.
- `vite` 8.0.12 → 8.2.2 and `postcss` 8.5.14 → 8.5.26: webview build/dev toolchain. Gated by `vite build` + e2e. Fallback if red: pin vite to the first patched 8.0.x instead.
- `nanoid`/`dompurify`/`mermaid`/`ip-address`: transitive (postcss / @lobehub/ui / electrobun's proxy-agent). None imported by agetor code directly.
- Rollback: each commit reverts independently; `git revert <commit2>` leaves #197 fixed.
- Risk: `bun update <transitive>` might not move a nested resolution on bun 1.3.10 → fallback is deleting the stale entries from `bun.lock` and running `bun install`. Risk: `ip-address` may have no patched release inside `^10.1.1` → reported as a residual, not forced.

## 8. Open questions / assumptions

- "2 vulnerable dependencies" in the issue title is read as the two shell-quote advisories (or the two dependency paths) — the body only names shell-quote and the audit shows exactly two advisories for it.
- Owner answers (grill, 2026-08-27): sweep the rest in a separate commit — **yes**; add the guard test — **yes**.
- Not asked (my call, reversible): stay within semver ranges everywhere (no `--latest`), keep `react-devtools-core` on 6.x (7.x is unrelated to the fix), don't add a CI audit step (no CI exists; a different ticket).

## 9. Amendments after approval (mechanism changes, owner-confirmed 2026-08-27)

Scratchpad dry runs on copies of `package.json` + `bun.lock` (bun 1.3.10) overturned the plan's assumption that `bun update` could move the transitive pins:

| Test | Command | Result |
| --- | --- | --- |
| 1 | `bun update concurrently shell-quote` | Adds `shell-quote` to `package.json` as a **direct** dep, rewrites `concurrently` to `^9.2.4`, and leaves `react-devtools-core/shell-quote` nested at **1.8.3**. Same for `nanoid` (→ v6 direct!), `mermaid`, `dompurify`, `ip-address`. |
| 3a/3b | delete entries from `bun.lock` + `bun install` | Not targeted: bun re-resolves everything (567 changed package lines); a second edit produced `Error loading lockfile: InvalidPackageInfo`. |
| A | `bun update concurrently react-devtools-core` | `react-devtools-core` is already latest 6.x → its edge is not re-resolved; 1.8.3 survives. |
| C | full in-range `bun update` | 136 changed lines, yet shell-quote 1.8.3, postcss 8.5.14, nanoid 3.3.12, dompurify 3.4.3, ip-address 10.2.0, mermaid 11.15.0 all survive as nested edges. |
| A2 | `overrides.shell-quote` + `bun install` | **2 lockfile package lines change**, single `shell-quote@1.10.0`, `--frozen-lockfile` consistent, `bun audit` no longer lists shell-quote. |
| 3a (audit) | `rm bun.lock && bun install` | `bun audit` → "No vulnerabilities found". |

Owner decisions (asked as one pass):
- **Commit 1:** override floor `^1.9.0` + `concurrently ^9.2.4` — chosen over "no override, rely on commit 2".
- **Commit 2:** full lockfile regeneration (every resolution → latest inside its existing range; `package.json` ranges untouched; e.g. `@lobehub/icons` 5.8→5.16, `lucide-react` 1.14→1.34, `ink` 7.0.5→7.1.1, `react` 19.2.6→19.2.8, `vite` 8.0.12→8.2.2) — chosen over "skip commit 2" and "six overrides". Still gated on typecheck + `bun test` + `vite build` + Playwright e2e; owner to eyeball icons/TUI before pushing.

Fleet knowledge captured: "bun 1.3.10: `bun update` never re-resolves a transitive edge whose dependent version didn't change".

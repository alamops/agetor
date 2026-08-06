# Plan — Consolidate git-host discovery + bound the Settings host scan

| Field | Value |
| --- | --- |
| Date | 2026-08-05 |
| Source | Deferred findings from the opus review of the bitbucket alias-host fix (docs/plans/fix-bitbucket-alias-host-credentials.md) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/bitbucket-git-integration-not-loading-pr |
| Base SHA | cb0c40c (tip after test wave) |
| Mode | Autonomous — gates bypassed; assumptions in §8 |

## 1. Objective & success criteria

1. One source of truth for "supported provider host": `remoteHostsForDirs` moves
   into `src/bun/git-provider.ts`, implemented over `providerRepoForDir`, and
   the duplicated `SUPPORTED_PROVIDER_HOSTS` set + inline remote-walk in
   `src/bun/github.ts` is deleted. Adding a 4th provider then requires editing
   only `providerForHost`.
2. Opening Settings no longer spawns an unbounded `2N+` subprocess burst:
   the scan runs through a small concurrency pool, and repeat calls within a
   short window (GET followed by PUT save) reuse a cached result.

Success = typecheck green, full `bun test` green (modulo known flakes), the
moved function behaviorally identical (same sorted raw-host output), existing
alias-host tests still pass.

## 2. Context & constraints

- `remoteHostsForDirs` currently in `src/bun/github.ts` (added provider-generic
  in commit 1c4174d) with a local `SUPPORTED_PROVIDER_HOSTS` set duplicating
  `providerForHost` (`src/bun/git-provider.ts:36-47`); the walk duplicates
  `providerRepoForDir` (`git-provider.ts:56-78`). The duplication existed only
  because github.ts cannot import git-provider.ts (git-provider imports
  github.ts). Moving the function INTO git-provider.ts is cycle-free:
  `server.ts` already imports both (`server.ts:135` imports it from github.ts
  today; switch to git-provider.ts).
- Consumers: only `server.ts` GET/PUT `/github/tokens` handlers
  (`server.ts:2494`, `:2506`) — the Settings detected-hosts datalist.
- Test added in the previous wave: github.test.ts has a `remoteHostsForDirs`
  multi-provider test — move it to `git-provider.test.ts` (or re-import) so
  coverage follows the function.
- Perf: each dir costs one `git remote` + up to one `git remote get-url` per
  remote. Projects list is user-bounded but can be dozens; today it's
  `Promise.all` over all dirs (unbounded burst). PUT recomputes the identical
  scan immediately after GET.

## 3. Approach & key decisions

- Move + reimplement over `providerRepoForDir` (returns `ProviderRepoInfo`
  with `remoteHost`) — behavior identical: distinct raw hosts, sorted, dirs
  without a supported remote tolerated silently.
- Concurrency pool of 6 over dirs (plain worker-pool helper local to
  git-provider.ts; no new deps).
- TTL cache (10s) keyed on the sorted joined dirs list, storing the promise —
  GET→PUT within the window reuses it; different dir sets (tests use unique
  mkdtemp dirs) never collide. Exported `clearRemoteHostsCache()` for tests
  (or accept `{ fresh: true }`) — pick whichever matches file idiom; tests
  must be able to bypass staleness deterministically.
- Keep the exported name `remoteHostsForDirs`; github.ts stops exporting it
  (delete there) — single-consumer switch in server.ts.

## 4. Work breakdown — implementation tasks

Single task (T1, one sonnet agent — files are small and interdependent, no
useful partition): owns `src/bun/git-provider.ts`, `src/bun/github.ts`,
`src/bun/server.ts`, `src/bun/git-provider.test.ts`, `src/bun/github.test.ts`.

## 5. Work breakdown — test tasks

Folded into T1 (move the existing multi-provider test; add a cache-reuse test
and a concurrency-pool sanity test if cheap). E2e: not applicable — bun-side
refactor with identical observable behavior; existing network/unit layers
cover it.

## 6. Execution waves

1. T1 → typecheck + targeted tests → commit.
2. Opus review of diff vs cb0c40c → fixes if must-fix.
3. Full suite run (haiku).

## 7. Blast radius & risks

- Settings datalist is the only consumer; identical output shape.
- Cache staleness: a newly-added project's host may not appear for ≤10s in the
  detected list — cosmetic, self-heals on next Settings open. Token resolution
  paths never consume this function.
- Import cycle risk: git-provider.ts already imports github.ts; the move adds
  no github.ts → git-provider.ts import. server.ts import switch only.

## 8. Open questions / assumptions

- A1: 10s TTL + pool of 6 chosen without owner input (values are cheap to tune).
- A2: PUT keeps returning `detectedHosts` (no API-shape change); it just reuses
  the cached scan.

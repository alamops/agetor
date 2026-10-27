// Reading agent-writable files in the core without following a planted symlink
// (docs/plans/master-token-agent-read.md, D26).
//
// The core tails and scans files an agent can rewrite: Claude Code session
// transcripts and their subagent files under a config dir's `projects/`, the
// `sessions/` registry, the codex/cursor/gemini/antigravity run logs and exit
// files under the data dir. Agents run as the same user, so one can replace
// such a file with a symlink into a macOS-protected folder (~/Documents, another
// app's ~/Library/Application Support). The core would then open it in its own
// process, under Agetor's TCC identity — exactly what disclaiming every spawn
// is meant to prevent. Every one of those files is written as a regular file
// by the CLI or by Agetor, so the final path component is opened with
// O_NOFOLLOW: a symlink there fails with ELOOP, which every caller already
// treats as "unreadable".
//
// Scope: the final component only. A symlinked parent directory is still
// followed (a user's own `~/.claude` → dotfiles link keeps working); the
// directory walks that list agent-writable dirs (`claude-session-scan.ts`)
// skip symlinked entries with `lstat` themselves.

import { closeSync, constants, openSync, readFileSync } from "node:fs";

/** `open(2)` flags for reading a file whose final component must not be a symlink. */
export const READ_NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW;

/** `openSync(p, "r")`, refusing a symlink at `p` (ELOOP). */
export function openReadNoFollow(p: string): number {
  return openSync(p, READ_NOFOLLOW);
}

/** `readFileSync(p, "utf8")`, refusing a symlink at `p` (ELOOP). Throws like
 *  `readFileSync` on any other failure. */
export function readTextNoFollow(p: string): string {
  const fd = openReadNoFollow(p);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

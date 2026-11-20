/**
 * The "Auto-trust a task's repositories" preference.
 *
 * Claude Code 2.1.326 asks `Adding a new directory:` for every `--add-dir`
 * whose source repository it has not trusted, on every launch and every
 * `--resume`. A multi-repository task passes one `--add-dir` per checkout it
 * created, so agetor answers that dialog itself, but only for those paths and
 * only while this preference is on. Off brings back a card per dialog.
 *
 * Default on (the stored value is absent until the user flips it). The
 * preference is a request, not a boundary: the SQLite file is agent-writable,
 * so the real guard is the path equality in `matchAddDirAutoTrust`
 * (docs/architecture/security.md, "Multiple repositories in one task").
 */
export const CLAUDE_AUTO_TRUST_PREF = "claude_auto_trust_repositories";

/** True unless the stored value is an explicit off (`"0"`, `"false"`, `"off"`). */
export function isClaudeAutoTrustOn(stored: string | undefined | null): boolean {
  if (stored === undefined || stored === null) return true;
  const v = stored.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

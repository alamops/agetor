// Pure derivation behind PromptComposer's live on-disk `@`-token rescue
// (issue #291 review). A multi-repository task's merged listing only contains
// paths INSIDE each repository, but the agent's cwd is the workspace root, so
// an unprefixed token (`@notes.md`, a file the agent left at the root) really
// does expand at send time. This maps every unlisted token to the directory
// whose stat can prove it: the token's own repository scope for a prefixed
// token, or the workspace root for an unprefixed one.
import { splitNamedScopePath } from "../../shared/file-scope.ts";
import { isSafeClientRelPath } from "./at-highlight.ts";

/** One `POST /refs/resolve` batch: a directory plus repo-local path → token key. */
export interface AtScopeStatTarget {
  dir: string;
  /** Repo-local path (what gets joined onto `dir` for the stat) → the full
   *  token path the warning layer checks. Keying by the stat argument is what
   *  lets the response be mapped back to the token that produced it. */
  paths: Map<string, string>;
}

/** Namespace key for the workspace-root target; repository slugs are
 *  filesystem-safe and can never contain NUL. */
const WORKSPACE_TARGET_KEY = "\u0000workspace";

/**
 * The stat targets for a multi-repository composer's unlisted tokens.
 *
 * - A token prefixed with a repository name stats inside that repository,
 *   with the prefix stripped (`frontend/src/a.ts` → `<frontend dir>/src/a.ts`).
 * - A token with no known prefix stats against `workspaceRoot` (the agent's
 *   cwd) — NOT skipped, which is what made a root-level file warn falsely.
 * - A ref scope (`{ dir, ref }`, a not-yet-materialized worktree) lists
 *   exactly what the worktree will contain, so it is skipped: a stat against
 *   the source repo could rescue a file the worktree will not have.
 * - No workspace root (never-started multi task) means an unprefixed token
 *   genuinely cannot resolve yet — the caller keeps the listing verdict.
 *
 * Safe relative paths only; the server route stats, it does not sandbox a
 * client-supplied `..`.
 */
export function multiScopeStatTargets(
  tokens: readonly { path: string }[],
  scopes: readonly { name: string; dir: string; ref?: string | null }[] | null | undefined,
  workspaceRoot: string | null | undefined,
): AtScopeStatTarget[] {
  const targets = new Map<string, AtScopeStatTarget>();
  const workspaceDir = workspaceRoot?.trim() ?? "";

  /** `tokenKey` is the full token path the warning layer checks; `local` is
   *  the repo-relative path that is actually joined onto `dir`. Keeping them
   *  distinct is what makes a prefixed token (`frontend/src/a.ts`) stat
   *  `<frontend dir>/src/a.ts` instead of `<frontend dir>/frontend/src/a.ts`. */
  const add = (key: string, dir: string, tokenKey: string, local: string): void => {
    let target = targets.get(key);
    if (!target) {
      target = { dir, paths: new Map() };
      targets.set(key, target);
    }
    target.paths.set(local, tokenKey);
  };

  for (const token of tokens) {
    const local = token.path.replace(/\/+$/, "");
    if (!local || !isSafeClientRelPath(local)) continue;
    const split = splitNamedScopePath(scopes, token.path);
    if (!split) {
      if (workspaceDir) add(WORKSPACE_TARGET_KEY, workspaceDir, local, local);
      continue;
    }
    if ((split.scope.ref ?? "").trim()) continue;
    const dir = split.scope.dir.trim();
    const scopedLocal = split.path.replace(/\/+$/, "");
    // A token that names only the repository (`@frontend/`) has no inner path
    // to stat; the listing already offers the synthesized root row.
    if (!dir || !scopedLocal || !isSafeClientRelPath(scopedLocal)) continue;
    add(split.scope.name, dir, local, scopedLocal);
  }

  return [...targets.values()].filter((target) => target.paths.size > 0);
}

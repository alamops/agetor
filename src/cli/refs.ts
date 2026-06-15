import { statSync, existsSync } from "node:fs";
import path from "node:path";
import { c, errln } from "./output.ts";
import type { TaskReference } from "../shared/types.ts";

/**
 * Resolve `--ref` CLI paths into TaskReferences. Paths are made ABSOLUTE
 * because the agent runs in the task's worktree, not your shell's cwd — a
 * relative ref would never resolve for it (and image refs wouldn't attach).
 * statSync marks directories; the server trusts the client's `isDirectory` and
 * doesn't re-stat, and a missing path degrades to a file ref.
 */
export function resolveRefs(paths: string[]): TaskReference[] {
  return paths.map((p) => {
    const abs = path.resolve(p);
    try {
      return { path: abs, isDirectory: statSync(abs).isDirectory() };
    } catch {
      return { path: abs, isDirectory: false };
    }
  });
}

/** The refs whose path doesn't exist on disk — a typo'd `--ref`, or a message
 *  word mistakenly consumed as one. Pure; the warning lives in warnMissingRefs. */
export function missingRefs(refs: TaskReference[]): TaskReference[] {
  return refs.filter((r) => !existsSync(r.path));
}

/** Warn (non-fatal, stderr) about any ref whose path doesn't exist, so a typo'd
 *  attachment doesn't silently turn into a dead reference. */
export function warnMissingRefs(refs: TaskReference[]): void {
  for (const r of missingRefs(refs)) errln(c.dim(`! ref not found: ${r.path}`));
}

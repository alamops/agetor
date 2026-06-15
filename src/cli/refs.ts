import { statSync } from "node:fs";
import path from "node:path";
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

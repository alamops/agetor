// Display-only path shortening for transcript user bubbles. Send-time
// expansion (orchestrator startTask/sendInput) rewrites `@rel` mentions into
// absolute paths — the worktree file for isolated tasks — so the echoed
// `user` event carries long `/Users/…/.agetor/worktrees/<id>/src/db.ts`
// strings. This folds any path under one of the task's own roots back to the
// `@rel` mention form the user typed. STRICTLY presentational: nothing the
// app acts on (attachment chips, previews, copies of the raw event) may go
// through this — they need the real absolute paths.
import { formatAtToken } from "../../shared/at-refs.ts";

/** Sentence punctuation that trails a bare mention without belonging to it —
 *  the same set the tokenizer's bare form strips (see shared/at-refs.ts). */
const TRAILING_PUNCT = /[.,;:!?)\]}>'"]+$/;
const REGEX_ESC = /[.*+?^${}()|[\]\\]/g;

/**
 * Rewrite absolute paths that live under any of `roots` (the task's
 * `worktreePath` / `workdir`; falsy entries are dropped, longest root wins on
 * nesting) back to `@rel` / `@"rel with spaces"` via `formatAtToken`. Two
 * shapes, mirroring what expansion emits: a double-quoted absolute path
 * (spaced paths are quoted on expansion) and a bare whitespace/BOF-anchored
 * run, whose trailing sentence punctuation stays outside the mention.
 * Directories keep their trailing `/`. Paths under no listed root — refs the
 * picker attached from elsewhere on disk, paths the agent itself printed —
 * are left untouched.
 */
export function shortenTaskPaths(
  text: string,
  roots: ReadonlyArray<string | null | undefined>,
): string {
  if (!text.includes("/")) return text;
  const cleaned = [...new Set(
    roots
      .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
      .map((r) => r.replace(/\/+$/, "")),
  )].sort((a, b) => b.length - a.length);
  let out = text;
  for (const root of cleaned) {
    if (!out.includes(`${root}/`)) continue;
    const esc = root.replace(REGEX_ESC, "\\$&");
    // Quoted form first — after this pass the bare regex below can't reach
    // into remaining quoted strings (it requires whitespace/BOF before the
    // root, and a `"` is neither).
    out = out.replace(
      new RegExp(`"${esc}/([^"\n]+)"`, "g"),
      (_m, rel: string) => formatAtToken(rel),
    );
    out = out.replace(
      new RegExp(`(^|\\s)${esc}/(\\S+)`, "g"),
      (m: string, pre: string, run: string) => {
        const tail = run.match(TRAILING_PUNCT)?.[0] ?? "";
        const rel = tail ? run.slice(0, -tail.length) : run;
        if (!rel) return m;
        return `${pre}${formatAtToken(rel)}${tail}`;
      },
    );
  }
  return out;
}

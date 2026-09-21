/**
 * ELI5 explainer task text for the Clone repository flow. Pure and
 * runtime-import-free (no `node:*`, no Bun) so both the Bun process
 * (`src/bun/clone.ts`, `src/bun/server.ts`) and the webview
 * (`src/mainview/lib/api.ts` and friends, e.g. for the gemini argv-overage
 * pre-check against the real prompt) can import it directly.
 */

/** Filename the ELI5 task writes at the repo root. */
export const ELI5_FILENAME = "ELI5.md";

export const eli5TaskTitle = (repo: string): string => `ELI5: ${repo}`;

/**
 * Prompt for the auto-created explainer task. The task runs with
 * isolation "none" so the file lands directly in the fresh clone's root
 * (the project "home") instead of on a branch in a worktree.
 */
export function buildEli5Prompt(repo: string): string {
  return (
    `Explore this repository ("${repo}") and write a file named ${ELI5_FILENAME} at the repository root.\n\n` +
    `The file is an "explain like I'm five" guide for someone who has never seen this codebase. In plain language, cover:\n` +
    `1. What this project is and what problem it solves, in two or three sentences a non-programmer could follow.\n` +
    `2. How it is organized: the main directories and what lives in each, as a short annotated list.\n` +
    `3. How the main pieces talk to each other: the one core flow from input to output, described step by step.\n` +
    `4. How to run it: install, start, and test commands, taken from the repo's own README/package files (do not invent commands).\n` +
    `5. Three or four terms or names a newcomer will keep seeing in this codebase, each explained in one sentence.\n\n` +
    `Rules: write ONLY ${ELI5_FILENAME} — do not modify any other file, do not commit, do not push. ` +
    `Keep it under roughly 150 lines. Prefer simple words over jargon; when a technical term is unavoidable, explain it in parentheses the first time.`
  );
}

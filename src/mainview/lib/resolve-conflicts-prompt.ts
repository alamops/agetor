export interface ResolveConflictsPromptInput {
  repo: string;
  number: number;
  /** PR/MR title, when known. Null when the caller only has mergeability
   *  data (which doesn't carry a title) — the first line drops the
   *  `— "title"` clause in that case. */
  title: string | null;
  headRef: string;
  baseRef: string;
}

export function buildResolveConflictsPrompt(input: ResolveConflictsPromptInput): string {
  const { repo, number, title, headRef, baseRef } = input;
  const firstLine =
    typeof title === "string" && title.length > 0
      ? `Resolve the merge conflicts blocking ${repo} PR #${number} — "${title}".`
      : `Resolve the merge conflicts blocking ${repo} PR #${number}.`;
  return [
    firstLine,
    `You're already on the PR's head branch (\`${headRef}\`). Run \`git fetch origin\` first, then merge \`origin/${baseRef}\` into \`${headRef}\` (the branch currently checked out).`,
    "Both branches' changes matter here — this is a real merge, not a rebase you can shortcut by favoring one side. For every conflict, read both versions closely enough to understand what each side was trying to do, then combine them so both intents survive. Never resolve a conflict by blindly taking \"ours\" or \"theirs\" wholesale; if the two changes are genuinely incompatible, pick the combination that best preserves the goals of both, and say so in the commit message.",
    "Once every conflict marker is gone, verify the result — run a quick typecheck, build, or the fastest relevant test subset if the repo makes that practical, so you're not committing a merge that doesn't compile.",
    `Commit the merge locally with a clear message that references PR #${number} and summarizes how the conflicts were resolved.`,
    "Do not push. Leave the commit local — the user will review your resolution and push it themselves.",
  ].join("\n\n");
}

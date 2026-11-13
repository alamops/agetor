export interface ResolveConflictsPromptInput {
  repo: string;
  number: number;
  /** PR/MR title, when known. Null when the caller only has mergeability
   *  data (which doesn't carry a title) — the first line drops the
   *  `— "title"` clause in that case. */
  title: string | null;
  headRef: string;
  baseRef: string;
  /**
   * A multi-repository task's checkout for the PR's repository. The agent's
   * cwd is the task's workspace root there — NOT a git repository — so the
   * prompt must name the repository subdirectory and run git inside it.
   * Null/omitted for a single-repository task, whose cwd already IS the
   * checkout on `headRef` (the pre-#291 prompt, kept byte-identical).
   */
  repositoryPath?: string | null;
  /** The repository's workspace subdirectory name, used only to make the
   *  multi-repository instruction easier to follow. Optional. */
  repositoryName?: string | null;
}

/** POSIX single-quote escaping for a value pasted into a shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildResolveConflictsPrompt(input: ResolveConflictsPromptInput): string {
  const { repo, number, title, headRef, baseRef } = input;
  const firstLine =
    typeof title === "string" && title.length > 0
      ? `Resolve the merge conflicts blocking ${repo} PR #${number} — "${title}".`
      : `Resolve the merge conflicts blocking ${repo} PR #${number}.`;

  // Multi-repository task (#291): the run's cwd is the workspace root, which
  // has no `.git`. Telling the agent it is "already on the PR's head branch"
  // there made every git command fail (or worse, read a different repo) and
  // invited a bogus resolution. Name the checkout explicitly and make every
  // command run inside it. A single-repository task keeps the original
  // wording — its cwd is exactly that checkout.
  const repositoryPath = input.repositoryPath?.trim() || null;
  const checkoutLine = repositoryPath
    ? [
        `This task's working directory is a multi-repository workspace root, which is not itself a git repository. The ${repo} checkout is at \`${repositoryPath}\`${input.repositoryName ? ` (workspace subdirectory \`${input.repositoryName}\`)` : ""}, and it is on the PR's head branch \`${headRef}\`. Run every git command inside that directory — for example, \`cd ${shellQuote(repositoryPath)} && git fetch origin\` — then merge \`origin/${baseRef}\` into \`${headRef}\`.`,
      ].join("\n\n")
    : `You're already on the PR's head branch (\`${headRef}\`). Run \`git fetch origin\` first, then merge \`origin/${baseRef}\` into \`${headRef}\` (the branch currently checked out).`;

  return [
    firstLine,
    checkoutLine,
    "Both branches' changes matter here — this is a real merge, not a rebase you can shortcut by favoring one side. For every conflict, read both versions closely enough to understand what each side was trying to do, then combine them so both intents survive. Never resolve a conflict by blindly taking \"ours\" or \"theirs\" wholesale; if the two changes are genuinely incompatible, pick the combination that best preserves the goals of both, and say so in the commit message.",
    "Once every conflict marker is gone, verify the result — run a quick typecheck, build, or the fastest relevant test subset if the repo makes that practical, so you're not committing a merge that doesn't compile.",
    `Commit the merge locally with a clear message that references PR #${number} and summarizes how the conflicts were resolved.`,
    "Do not push. Leave the commit local — the user will review your resolution and push it themselves.",
  ].join("\n\n");
}

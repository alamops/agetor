import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { c, out, printJson } from "../output.ts";
import { usageError } from "../usage.ts";
import { flagValue } from "../args.ts";
import { isMultiRepoTask, repositoriesForTask } from "../../shared/multi-repo.ts";
import type { DiffFile, TaskDiff } from "../../shared/types.ts";
import { escapeControlChars, escapeFreeText } from "../../shared/terminal-text.ts";

/**
 * `agetor diff <task-id> [--repo <name>]`.
 *
 * A single-repository task prints its one diff exactly as before. A
 * multi-repository task has no single worktree — its `workdir` is the
 * non-git workspace root — so printing `repositories[0]` alone hid every
 * sibling repository's changes. Without `--repo` it now prints one labelled
 * section per repository (JSON: an array of the per-repo `TaskDiff`s, with a
 * `{ repo, error }` entry for a repository whose diff failed — the command
 * then exits non-zero); `--repo <name>` narrows it to one and keeps the
 * single-object shape.
 */
export async function cmdDiff(args: string[], flags: Flags): Promise<void> {
  // `--repo` takes a value that must not be mistaken for the positional task
  // ref — the `shell` command's parser handles the same shape.
  const repoIdx = args.indexOf("--repo");
  const repoFlag = repoIdx >= 0 ? flagValue(args, repoIdx + 1, "--repo") : null;
  const ref = args.find((a, i) => !a.startsWith("-") && (repoIdx < 0 || i !== repoIdx + 1));
  if (!ref) throw usageError("diff");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);

  // `repositoriesForTask` derives the one entry a single-repository (or
  // legacy) row doesn't store, so the `--repo` validation works on both
  // shapes without a special case.
  const repos = repositoriesForTask(task);
  if (repoFlag && !repos.some((r) => r.name === repoFlag)) {
    throw new Error(
      `no repository "${repoFlag}" on this task (have: ${repos.map((r) => r.name).join(", ") || "none"})`,
    );
  }

  if (!isMultiRepoTask(task)) {
    // Byte-identical to the pre-multi output: one diff, one JSON object. A
    // multi task left with one repository keeps the labelled, per-repository
    // form below (issue #291).
    const diff = await client.getDiff(task.id);
    if (flags.json) return printJson(diff);
    printDiff(diff);
    return;
  }

  if (repoFlag) {
    // One repository: its error is the command's error, as for a single task.
    const diff = await client.getDiff(task.id, repoFlag);
    if (flags.json) return printJson(diff);
    printDiff(diff);
    return;
  }

  // Settled, not `Promise.all`: one repository whose diff fails (a removed
  // worktree, a git error) must not hide every sibling's changes. Its section
  // names the error instead, and the command still exits non-zero.
  const results = await Promise.allSettled(repos.map((repo) => client.getDiff(task.id, repo.name)));
  const failed = results.some((r) => r.status === "rejected");
  if (failed) process.exitCode = 1;

  if (flags.json) {
    return printJson(
      results.map((r, i) =>
        r.status === "fulfilled" ? r.value : { repo: repos[i]!.name, error: errorMessage(r.reason) },
      ),
    );
  }
  results.forEach((r, i) => {
    if (i > 0) out("");
    out(c.dim(`── ${escapeControlChars(repos[i]!.name)} ──`));
    if (r.status === "fulfilled") printDiff(r.value);
    else out(c.red(`! diff failed: ${escapeFreeText(errorMessage(r.reason))}`));
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function printDiff(diff: TaskDiff): void {
  if (diff.note) {
    out(c.dim(diff.note));
    return;
  }
  if (diff.files.length === 0) {
    out(c.dim("no changes"));
    return;
  }

  out(
    c.dim(
      `diff vs ${diff.base ?? "base"} — ${diff.files.length} file${diff.files.length === 1 ? "" : "s"}`,
    ),
  );
  for (const f of diff.files) {
    out("");
    out(fileHeader(f));
    if (f.binary) {
      out(c.dim("  (binary)"));
      continue;
    }
    for (const line of f.hunks.replace(/\n$/, "").split("\n")) out(colorDiffLine(line));
    if (f.truncated) out(c.dim("  … (diff truncated)"));
  }
}

function fileHeader(f: DiffFile): string {
  const tag =
    f.status === "added"
      ? c.green("A")
      : f.status === "deleted"
        ? c.red("D")
        : f.status === "renamed"
          ? c.cyan("R")
          : c.yellow("M");
  const path = f.status === "renamed" && f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
  return `${tag} ${c.bold(path)}  ${c.green("+" + f.additions)} ${c.red("-" + f.deletions)}`;
}

function colorDiffLine(line: string): string {
  if (line.startsWith("@@")) return c.cyan(line);
  if (line.startsWith("+")) return c.green(line);
  if (line.startsWith("-")) return c.red(line);
  return line;
}

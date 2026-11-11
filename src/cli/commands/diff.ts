import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { c, out, printJson } from "../output.ts";
import { usageError } from "../usage.ts";
import { flagValue } from "../args.ts";
import { repositoriesForTask } from "../../shared/multi-repo.ts";
import type { DiffFile, TaskDiff } from "../../shared/types.ts";

/**
 * `agetor diff <task-id> [--repo <name>]`.
 *
 * A single-repository task prints its one diff exactly as before. A
 * multi-repository task has no single worktree — its `workdir` is the
 * non-git workspace root — so printing `repositories[0]` alone hid every
 * sibling repository's changes. Without `--repo` it now prints one labelled
 * section per repository (JSON: an array of the per-repo `TaskDiff`s);
 * `--repo <name>` narrows it to one and keeps the single-object shape.
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

  if (repos.length <= 1) {
    // Byte-identical to the pre-multi output: one diff, one JSON object.
    const diff = await client.getDiff(task.id);
    if (flags.json) return printJson(diff);
    printDiff(diff);
    return;
  }

  const selected = repoFlag ? repos.filter((r) => r.name === repoFlag) : repos;
  const diffs = await Promise.all(selected.map((repo) => client.getDiff(task.id, repo.name)));

  if (flags.json) return printJson(repoFlag ? diffs[0]! : diffs);
  diffs.forEach((diff, i) => {
    if (i > 0) out("");
    if (!repoFlag) out(c.dim(`── ${selected[i]!.name} ──`));
    printDiff(diff);
  });
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

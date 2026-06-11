import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { c, out, printJson } from "../output.ts";
import type { DiffFile } from "../../shared/types.ts";

export async function cmdDiff(args: string[], flags: Flags): Promise<void> {
  const ref = args.find((a) => !a.startsWith("-"));
  if (!ref) throw new Error("usage: agetor diff <task-id>");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const diff = await client.getDiff(task.id);

  if (flags.json) return printJson(diff);
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

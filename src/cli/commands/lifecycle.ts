import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { c, out, printJson } from "../output.ts";

export async function cmdStart(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw new Error("usage: agetor start <task-id>");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const res = await client.startTask(task.id);
  if (flags.json) return printJson(res);
  out(`${c.cyan("▸")} started ${c.dim(task.id.slice(0, 8))} — run ${res.runId.slice(0, 8)}`);
}

export async function cmdSend(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  const message = args.slice(1).join(" ").trim();
  if (!ref || !message) throw new Error("usage: agetor send <task-id> <message…>");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  if (!task.runId) {
    throw new Error(`task has no run yet — start it first: agetor start ${ref}`);
  }
  const res = await client.sendInput(task.runId, message);
  if (!res.delivered) throw new Error(res.reason ?? "message was not delivered");
  if (flags.json) return printJson(res);
  out(`${c.green("→")} sent to ${c.dim(task.id.slice(0, 8))}`);
}

export async function cmdCancel(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw new Error("usage: agetor cancel <task-id>");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  if (!task.runId) throw new Error("task has no active run to cancel");
  const res = await client.cancelRun(task.runId);
  if (flags.json) return printJson(res);
  out(`${c.yellow("■")} cancel requested for ${c.dim(task.id.slice(0, 8))}`);
}

export async function cmdRm(args: string[], flags: Flags): Promise<void> {
  const positionals = args.filter((a) => !a.startsWith("-"));
  const ref = positionals[0];
  const yes = args.includes("--yes") || args.includes("-y") || flags.json;
  if (!ref) throw new Error("usage: agetor rm <task-id> [--yes]");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  if (!yes) {
    out(
      c.yellow(
        `refusing to delete without --yes. Would delete "${task.title}" (${task.id.slice(0, 8)}) ` +
          "and its worktree + branch.",
      ),
    );
    process.exitCode = 1;
    return;
  }
  await client.deleteTask(task.id);
  if (flags.json) return printJson({ deleted: task.id });
  out(`${c.red("✗")} deleted ${c.dim(task.id.slice(0, 8))}`);
}

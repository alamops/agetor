import { readFileSync } from "node:fs";
import { getClient, type Flags } from "../context.ts";
import { resolveTask } from "../resolve.ts";
import { c, out, printJson } from "../output.ts";
import type { PatchTaskInput } from "../api-client.ts";
import { COLUMNS } from "../../shared/types.ts";
import { flagValue } from "../args.ts";

const COLUMN_IDS = COLUMNS.map((col) => col.id);

export async function cmdEdit(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) {
    throw new Error(
      "usage: agetor edit <task-id> [--title …] [--prompt …|--prompt-file …] " +
        "[--agent …] [--workdir …] [--model …] [--mode …] [--effort …] [--type …] [--column …]",
    );
  }
  const patch: PatchTaskInput = {};
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    const val = (allowDash = false) => flagValue(args, ++i, a, allowDash);
    switch (a) {
      case "--title": patch.title = val(); break;
      case "--prompt": patch.prompt = val(); break;
      case "--prompt-file": {
        const f = val(true);
        patch.prompt = f === "-" ? (await Bun.stdin.text()).trim() : readFileSync(f, "utf8");
        break;
      }
      case "--agent": patch.agent = val(); break;
      case "--workdir": patch.workdir = val(); break;
      case "--model": patch.model = val(); break;
      case "--mode": patch.mode = val(); break;
      case "--effort": patch.effort = val(); break;
      case "--type": patch.taskType = val(); break;
      case "--column": patch.column = val(); break;
      default: break;
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new Error(
      "nothing to edit — pass at least one of --title/--prompt/--agent/--workdir/--model/--mode/--effort/--type/--column",
    );
  }
  if (patch.column && !COLUMN_IDS.includes(patch.column as (typeof COLUMN_IDS)[number])) {
    throw new Error(`unknown column "${patch.column}" — one of: ${COLUMN_IDS.join(", ")}`);
  }
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const updated = await client.patchTask(task.id, patch);
  if (flags.json) return printJson(updated);
  // model/mode/effort changes are forwarded to a live claude session by the
  // server (reconcileTaskSession sends /model, /effort, cycles mode).
  out(`${c.green("✓")} updated ${c.dim(updated.id.slice(0, 8))} — ${Object.keys(patch).join(", ")}`);
}

export async function cmdMove(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  const column = args[1];
  if (!ref || !column) {
    throw new Error(`usage: agetor move <task-id> <column>   (columns: ${COLUMN_IDS.join(", ")})`);
  }
  if (!COLUMN_IDS.includes(column as (typeof COLUMN_IDS)[number])) {
    throw new Error(`unknown column "${column}" — one of: ${COLUMN_IDS.join(", ")}`);
  }
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const updated = await client.patchTask(task.id, { column });
  if (flags.json) return printJson(updated);
  out(`${c.cyan("→")} moved ${c.dim(updated.id.slice(0, 8))} → ${column}`);
}

export async function cmdArchive(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw new Error("usage: agetor archive <task-id>");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const updated = await client.archiveTask(task.id);
  if (flags.json) return printJson(updated);
  out(`${c.gray("archived")} ${c.dim(updated.id.slice(0, 8))}`);
}

export async function cmdUnarchive(args: string[], flags: Flags): Promise<void> {
  const ref = args[0];
  if (!ref) throw new Error("usage: agetor unarchive <task-id>");
  const client = await getClient(flags);
  const task = await resolveTask(client, ref);
  const updated = await client.unarchiveTask(task.id);
  if (flags.json) return printJson(updated);
  out(`${c.green("unarchived")} ${c.dim(updated.id.slice(0, 8))}`);
}

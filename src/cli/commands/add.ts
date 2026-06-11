import { readFileSync, statSync } from "node:fs";
import * as p from "@clack/prompts";
import { getClient, type Flags } from "../context.ts";
import { c, out, printJson, isTTY } from "../output.ts";
import type { AgetorClient, CreateTaskInput } from "../api-client.ts";

interface AddOpts {
  title?: string;
  prompt?: string;
  promptFile?: string;
  agent?: string;
  model?: string;
  mode?: string;
  effort?: string;
  workdir?: string;
  isolation?: "worktree" | "none";
  baseRef?: string;
  type?: string;
  start?: boolean;
  refs: string[];
}

function parseAdd(args: string[]): AddOpts {
  const o: AddOpts = { refs: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    switch (a) {
      case "--title": o.title = next(); break;
      case "--prompt": o.prompt = next(); break;
      case "--prompt-file": o.promptFile = next(); break;
      case "--agent": o.agent = next(); break;
      case "--model": o.model = next(); break;
      case "--mode": o.mode = next(); break;
      case "--effort": o.effort = next(); break;
      case "--workdir": o.workdir = next(); break;
      case "--isolation": o.isolation = next() === "none" ? "none" : "worktree"; break;
      case "--base-ref": o.baseRef = next(); break;
      case "--type": o.type = next(); break;
      case "--ref": { const r = next(); if (r) o.refs.push(r); break; }
      case "--start": o.start = true; break;
      default: break;
    }
  }
  return o;
}

export async function cmdAdd(args: string[], flags: Flags): Promise<void> {
  const o = parseAdd(args);
  let prompt = o.prompt;
  if (o.promptFile) {
    prompt = o.promptFile === "-" ? (await Bun.stdin.text()).trim() : readFileSync(o.promptFile, "utf8");
  }

  const client = await getClient(flags);

  let input: CreateTaskInput | null;
  if (o.title && prompt) {
    input = baseInput(o, o.title, prompt);
  } else if (isTTY && !flags.json) {
    input = await wizard(client, o, prompt);
  } else {
    throw new Error(
      "agetor add needs --title and --prompt (or --prompt-file) when not run interactively",
    );
  }
  if (!input) {
    out("cancelled");
    return;
  }

  // Match the app's "Run task": create in "ready" when starting immediately.
  if (o.start) input.column = "ready";

  const task = await client.createTask(input);

  let started = false;
  if (o.start) {
    try {
      await client.startTask(task.id);
      started = true;
    } catch {
      started = false;
    }
  }
  if (flags.json) return printJson({ task, started });
  out(
    `${c.green("✓")} created ${c.dim(task.id.slice(0, 8))} — ${task.title}` +
      (started ? c.cyan("  ▸ started") : ""),
  );
  if (!started) out(c.dim(`  start it: agetor start ${task.id.slice(0, 8)}`));
}

function baseInput(o: AddOpts, title: string, prompt: string): CreateTaskInput {
  return {
    title,
    prompt,
    agent: o.agent,
    model: o.model,
    mode: o.mode,
    effort: o.effort,
    workdir: o.workdir,
    isolation: o.isolation,
    baseRef: o.baseRef,
    taskType: o.type,
    references: o.refs.map((path) => {
      // Stat so directory refs are typed correctly — the server trusts the
      // client's isDirectory (it doesn't re-stat in POST /tasks).
      try {
        return { path, isDirectory: statSync(path).isDirectory() };
      } catch {
        return { path, isDirectory: false };
      }
    }),
  };
}

async function wizard(
  client: AgetorClient,
  o: AddOpts,
  prefilledPrompt: string | undefined,
): Promise<CreateTaskInput | null> {
  p.intro(c.cyan("New Agetor task"));

  const title =
    o.title ??
    (await p.text({
      message: "Title",
      validate: (v) => (v && v.trim() ? undefined : "required"),
    }));
  if (p.isCancel(title)) return cancelled();

  const prompt =
    prefilledPrompt ??
    (await p.text({
      message: "Prompt",
      validate: (v) => (v && v.trim() ? undefined : "required"),
    }));
  if (p.isCancel(prompt)) return cancelled();

  let agent = o.agent;
  if (!agent) {
    const harnesses = (await client.listHarnesses().catch(() => [])) as Array<{
      id: string;
      label?: string;
      kind?: string;
      enabled?: boolean;
    }>;
    const enabled = harnesses.filter((h) => h.enabled !== false);
    if (enabled.length > 0) {
      const pick = await p.select({
        message: "Agent",
        options: enabled.map((h) => ({ value: h.id, label: h.label ?? h.id, hint: h.kind })),
      });
      if (p.isCancel(pick)) return cancelled();
      agent = pick;
    }
  }

  let workdir = o.workdir;
  if (!workdir) {
    const projects = (await client.listProjects().catch(() => [])) as Array<{
      path: string;
      name?: string;
    }>;
    const pick = await p.select({
      message: "Working directory",
      options: [
        ...projects.map((pr) => ({ value: pr.path, label: pr.name ?? pr.path, hint: pr.path })),
        { value: "__other__", label: "Other (type a path)…" },
      ],
    });
    if (p.isCancel(pick)) return cancelled();
    if (pick === "__other__") {
      const typed = await p.text({ message: "Path", placeholder: process.cwd() });
      if (p.isCancel(typed)) return cancelled();
      workdir = typed.trim() || process.cwd();
    } else {
      workdir = pick;
    }
  }

  const start = await p.confirm({ message: "Start it now?", initialValue: false });
  if (p.isCancel(start)) return cancelled();
  o.start = start;

  p.outro(c.green("creating…"));
  return baseInput({ ...o, agent, workdir }, title, prompt);
}

function cancelled(): null {
  p.cancel("cancelled");
  return null;
}

import { readFileSync } from "node:fs";
import * as p from "@clack/prompts";
import { getClient, type Flags } from "../context.ts";
import { c, out, printJson, isTTY } from "../output.ts";
import type { AgetorClient, CreateTaskInput } from "../api-client.ts";
import { flagValue } from "../args.ts";
import { resolveRefs } from "../refs.ts";
import {
  AGENT_OPTIONS,
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  supportedEfforts,
  type AgentKind,
  type AgentOption,
} from "../../shared/types.ts";

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
    const a = args[i]!;
    const val = (allowDash = false) => flagValue(args, ++i, a, allowDash);
    switch (a) {
      case "--title": o.title = val(); break;
      case "--prompt": o.prompt = val(); break;
      case "--prompt-file": o.promptFile = val(true); break;
      case "--agent": o.agent = val(); break;
      case "--model": o.model = val(); break;
      case "--mode": o.mode = val(); break;
      case "--effort": o.effort = val(); break;
      case "--workdir": o.workdir = val(); break;
      case "--isolation": o.isolation = val() === "none" ? "none" : "worktree"; break;
      case "--base-ref": o.baseRef = val(); break;
      case "--type": o.type = val(); break;
      case "--ref": o.refs.push(val()); break;
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
    references: resolveRefs(o.refs),
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

  // Load harnesses + saved preferences once, for the agent / model / mode /
  // effort defaults — so the common picks are a single Enter.
  const { harnesses } = await client
    .listHarnesses()
    .catch(() => ({ harnesses: [], statuses: [] }));
  const prefs = await client.getPreferences().catch(() => ({}) as Record<string, string>);
  const discovered = await client.agentModels().catch(() => ({}) as Record<string, string[]>);

  let agent = o.agent;
  if (!agent) {
    const enabled = harnesses.filter((h) => h.enabled !== false);
    if (enabled.length > 0) {
      const def = prefs.defaultHarness;
      const pick = await p.select({
        message: "Agent",
        options: enabled.map((h) => ({ value: h.id, label: h.label, hint: h.kind })),
        initialValue: enabled.some((h) => h.id === def) ? def : undefined,
      });
      if (p.isCancel(pick)) return cancelled();
      agent = pick;
    }
  }

  const kind: AgentKind = harnesses.find((h) => h.id === agent)?.kind ?? "claude-code";

  let model = o.model;
  if (!model) {
    const options = mergeModels(AGENT_OPTIONS[kind].models, discovered[kind] ?? []);
    const picked = await pickOption("Model", options, prefs[`lastModel:${kind}`] ?? DEFAULT_MODEL[kind]);
    if (picked === null) return cancelled();
    model = picked;
  }
  let mode = o.mode;
  if (!mode) {
    const picked = await pickOption("Mode", AGENT_OPTIONS[kind].modes, prefs[`lastMode:${kind}`] ?? AGENT_OPTIONS[kind].modes[0]?.id);
    if (picked === null) return cancelled();
    mode = picked;
  }
  let effort = o.effort;
  if (!effort) {
    const efforts = supportedEfforts(kind, model ?? null);
    if (efforts.length > 0) {
      const picked = await pickOption("Effort", efforts, prefs[`lastEffort:${kind}`] ?? DEFAULT_EFFORT[kind]);
      if (picked === null) return cancelled();
      effort = picked;
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

  // Remember the picks so the next `add` defaults to them.
  await persistPrefs(client, kind, { model, mode, effort });

  p.outro(c.green("creating…"));
  return baseInput({ ...o, agent, model, mode, effort, workdir }, title, prompt);
}

/** Curated model list + any discovered ids not already curated (tagged
 *  "discovered"), so a newer model shows up without a code change. */
export function mergeModels(curated: AgentOption[], discovered: string[]): AgentOption[] {
  const known = new Set(curated.map((m) => m.id));
  return [
    ...curated,
    ...discovered
      .filter((id) => !known.has(id))
      .map((id) => ({ id, label: id, hint: "discovered" })),
  ];
}

/** A select that returns the chosen value (or null on cancel), pre-selecting
 *  `initial` when it's a valid option. */
async function pickOption(
  message: string,
  opts: AgentOption[],
  initial: string | undefined,
): Promise<string | null> {
  const pick = await p.select({
    message,
    options: opts.map((opt) => ({ value: opt.id, label: opt.label, hint: opt.hint })),
    initialValue: opts.some((opt) => opt.id === initial) ? initial : opts[0]?.id,
  });
  return p.isCancel(pick) ? null : (pick as string);
}

/** Persist the chosen model/mode/effort as the per-kind last-used defaults. */
export async function persistPrefs(
  client: AgetorClient,
  kind: AgentKind,
  picks: { model?: string; mode?: string; effort?: string },
): Promise<void> {
  const writes: Array<Promise<unknown>> = [];
  if (picks.model) writes.push(client.setPreference(`lastModel:${kind}`, picks.model));
  if (picks.mode) writes.push(client.setPreference(`lastMode:${kind}`, picks.mode));
  if (picks.effort) writes.push(client.setPreference(`lastEffort:${kind}`, picks.effort));
  await Promise.allSettled(writes);
}

function cancelled(): null {
  p.cancel("cancelled");
  return null;
}

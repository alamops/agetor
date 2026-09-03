import { readFileSync } from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import { getClient, type Flags } from "../context.ts";
import { c, out, printJson, isTTY } from "../output.ts";
import type { AgetorClient, CreateTaskInput } from "../api-client.ts";
import { flagValue } from "../args.ts";
import { resolveRefs, warnMissingRefs } from "../refs.ts";
import {
  parseIssueUrl,
  sameIssueUrl,
  issueTaskTitle,
  renderIssueThreadMarkdown,
  buildIssueTaskPrompt,
  inferTaskTypeFromLabels,
} from "../../shared/issue-task.ts";
import {
  AGENT_OPTIONS,
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  CATALOG_SCOPED_KINDS,
  supportedEfforts,
  cursorModelIdCoveredByCatalog,
  type AgentKind,
} from "../../shared/types.ts";
import { mergeModelOptions, type DiscoveredModel } from "../../shared/model-options.ts";

interface AddOpts {
  title?: string;
  prompt?: string;
  promptFile?: string;
  agent?: string;
  model?: string;
  mode?: string;
  effort?: string;
  fast?: boolean;
  maxMode?: boolean;
  workdir?: string;
  isolation?: "worktree" | "none";
  baseRef?: string;
  type?: string;
  start?: boolean;
  refs: string[];
  /** Seed title/prompt from a GitHub/GitLab/Bitbucket issue + its comment
   *  thread — resolved against `--workdir` (or cwd) in `cmdAdd`. */
  issue?: string;
}

export function parseAdd(args: string[]): AddOpts {
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
      case "--fast": o.fast = true; break;
      case "--no-fast": o.fast = false; break;
      case "--max-mode": o.maxMode = true; break;
      case "--no-max-mode": o.maxMode = false; break;
      case "--workdir": o.workdir = val(); break;
      case "--isolation": o.isolation = val() === "none" ? "none" : "worktree"; break;
      case "--base-ref": o.baseRef = val(); break;
      case "--type": o.type = val(); break;
      case "--ref": o.refs.push(val()); break;
      case "--start": o.start = true; break;
      case "--issue": o.issue = val(); break;
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

  // Captured BEFORE the `--issue` block below fills in title/prompt
  // fallbacks — otherwise every `--issue` invocation would look "explicit"
  // and `chooseAddPath` would always skip the wizard (see fix #3).
  const explicit = Boolean(o.title) && Boolean(prompt);

  const client = await getClient(flags);

  // `--issue <url>` seeds title/prompt from the issue + its comment thread
  // (same route the app's issue dialogs and New Task form use) and stamps
  // `issueUrl`/`issueSnapshot` onto the created task. Resolved against
  // `--workdir` (or cwd) since the thread fetch needs a repo to match against.
  let issueUrl: string | undefined;
  let issueSnapshot: string | undefined;
  // Set from `thread.commentsError` when the issue loaded but its comment
  // thread couldn't be fetched (e.g. GitLab's 401-to-anonymous `/notes` even
  // on a public project) — surfaced as a terminal warning below, and folded
  // into the `--json` result's `warnings` array instead of the plain-text
  // print, matching the dialog/form's non-blocking treatment of the same
  // signal.
  let issueWarning: string | undefined;
  if (o.issue) {
    const parsed = parseIssueUrl(o.issue);
    if (!parsed) throw new Error("--issue: not a recognized GitHub/GitLab/Bitbucket issue URL");
    // Resolve relative to the CLI's cwd (not the daemon's — see `baseInput`'s
    // comment) so the thread fetch and the eventual task both land on the
    // same absolute path the user meant.
    const workdir = path.resolve(o.workdir ?? process.cwd());
    o.workdir = workdir;
    const thread = await client.getIssueThread(workdir, parsed.number);
    if (!sameIssueUrl(thread.item.htmlUrl, o.issue)) {
      throw new Error("--issue: that issue belongs to a different repository than --workdir");
    }
    o.title ??= issueTaskTitle(thread.item);
    prompt ??= buildIssueTaskPrompt({ ...thread, snapshotAttached: true }).prompt;
    // An explicit `--type` stays authoritative; only fill it from the
    // issue's own labels (e.g. `bug`, `kind/defect`, `spike`) when the user
    // didn't pass one — mirrors the "Work on this with Agetor" dialog's
    // Type-picker seeding (`CreateTaskFromIssueDialog`). Checked with
    // `?.trim()` rather than `??=`: `flagValue` returns `""` for a bare
    // `--type ""`, which `??=` would leave alone, silently falling through
    // to the server's default type instead of the issue's labels.
    if (!o.type?.trim()) o.type = inferTaskTypeFromLabels(thread.item.labels);
    issueUrl = thread.item.htmlUrl;
    issueSnapshot = renderIssueThreadMarkdown(thread);
    if (thread.commentsError) {
      issueWarning = thread.commentsError;
      if (!flags.json) out(c.yellow("⚠ comments not fetched — " + thread.commentsError));
    }
  }

  let input: CreateTaskInput | null;
  if (chooseAddPath({ explicit, isTTY, json: flags.json }) === "non-interactive") {
    if (!(o.title && prompt)) {
      throw new Error(
        "agetor add needs --title and --prompt (or --prompt-file), or --issue <url>, when not run interactively",
      );
    }
    input = baseInput(o, o.title, prompt);
  } else {
    input = await wizard(client, o, prompt);
  }
  if (!input) {
    out("cancelled");
    return;
  }
  if (issueUrl) {
    input.issueUrl = issueUrl;
    input.issueSnapshot = issueSnapshot;
  }
  if (input.references?.length) warnMissingRefs(input.references);

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
  if (flags.json) {
    return printJson(issueWarning ? { task, started, warnings: [issueWarning] } : { task, started });
  }
  out(
    `${c.green("✓")} created ${c.dim(task.id.slice(0, 8))} — ${task.title}` +
      (started ? c.cyan("  ▸ started") : ""),
  );
  if (!started) out(c.dim(`  start it: agetor start ${task.id.slice(0, 8)}`));
}

/** Pure decision of whether `agetor add` should run non-interactively (a
 *  ready-made title+prompt already in hand) or launch the interactive
 *  wizard — factored out of `cmdAdd` so the branching (fix for `--issue`
 *  wrongly bypassing the wizard) is testable without driving `@clack/prompts`.
 *
 *  Non-interactive whenever: the user explicitly supplied both `--title` and
 *  a prompt (`--prompt`/`--prompt-file`) themselves — `explicit` must be
 *  computed BEFORE any `--issue`-derived fallback fills those in, otherwise
 *  every `--issue` invocation would look "explicit" — or this isn't a real
 *  terminal (`!isTTY`), or `--json` output was requested (the wizard has no
 *  JSON rendering). Otherwise (a TTY, no `--json`, and the user didn't fully
 *  spell it out — e.g. `--issue` alone) the wizard runs, prefilled with
 *  whatever the caller already resolved (issue-derived title/prompt, etc). */
export function chooseAddPath(input: {
  explicit: boolean;
  isTTY: boolean;
  json: boolean;
}): "non-interactive" | "wizard" {
  return input.explicit || !input.isTTY || input.json ? "non-interactive" : "wizard";
}

function baseInput(o: AddOpts, title: string, prompt: string): CreateTaskInput {
  return {
    title,
    prompt,
    agent: o.agent,
    model: o.model,
    mode: o.mode,
    effort: o.effort,
    fast: o.fast,
    maxMode: o.maxMode,
    // Resolve relative to the CLI's cwd (not the daemon's — it may be a
    // long-lived detached process with a stale/unrelated cwd) so a typed or
    // `--workdir`-flagged relative path lands on disk where the user meant,
    // matching `projects add`'s path.resolve(target).
    workdir: o.workdir ? path.resolve(o.workdir) : o.workdir,
    isolation: o.isolation,
    baseRef: o.baseRef,
    taskType: o.type,
    references: resolveRefs(o.refs),
  };
}

/** Seed for the interactive model picker: the stored `lastModel:<kind>` pref
 *  when it is still offerable — a curated row for the kind, or an id the
 *  harness's discovered catalog actually lists (fx accounts can carry
 *  discovered-only ids) — else the kind's default. Mirrors the two webview
 *  pickers' validation so a retired id (e.g. gemini-3-pro-preview, shut down
 *  2026-03-09 and cleared by migration 049) can't be re-offered as the
 *  pre-selected default via mergeModelOptions' unlisted-row rule. `loggedIn`
 *  mirrors mergeModelOptions rule 7: a logged-out harness's discovered
 *  catalog is untrustworthy (an expired login reads back the unauthenticated
 *  catalog), so it is not consulted — only curated rows can keep the pref. */
export function resolveInitialModel(
  kind: AgentKind,
  stored: string | undefined | null,
  discovered: readonly DiscoveredModel[],
  loggedIn: boolean | null = null,
): string {
  const offerable = loggedIn === false ? [] : discovered;
  if (
    stored &&
    (AGENT_OPTIONS[kind].models.some((m) => m.id === stored) || offerable.some((m) => m.id === stored))
  ) {
    return stored;
  }
  return DEFAULT_MODEL[kind];
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
  const { harnesses, statuses } = await client
    .listHarnesses()
    .catch(() => ({ harnesses: [], statuses: [] }));
  const prefs = await client.getPreferences().catch(() => ({}) as Record<string, string>);
  // Kind-level catalog (older-daemon-safe fallback) and per-harness catalog
  // (what the app's pickers actually use — a second fx harness with its own
  // account sees its own list). Each is independently `.catch`-guarded so a
  // daemon that hasn't landed `/agent-models/harnesses` yet (or either probe
  // failing outright) degrades to the kind map instead of crashing the
  // wizard — see plan §3 D6.
  const discovered = await client
    .agentModels()
    .catch(() => ({}) as Record<string, DiscoveredModel[]>);
  const harnessModels = await client
    .harnessModels()
    .catch(() => ({ ready: true, byHarness: {} as Record<string, DiscoveredModel[]> }));

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
    // Prefer the per-harness catalog (keyed by harness id, e.g. distinguishes
    // an additional `fx-2` account from the built-in `fx`); fall back to the
    // kind-level map for an older daemon without `/agent-models/harnesses`.
    // Spec'd cursor models show as one base row + effort dropdown, not N
    // suffixed rows — same filter as the webview pickers (NewTaskForm.tsx).
    const catalog: DiscoveredModel[] = ((agent && harnessModels.byHarness[agent]) || discovered[kind] || []).filter(
      (m) => kind !== "cursor" || !cursorModelIdCoveredByCatalog(m.id),
    );
    const loggedIn = statuses.find((s) => s.harnessId === agent)?.loggedIn ?? null;
    const initial = resolveInitialModel(kind, prefs[`lastModel:${kind}`], catalog, loggedIn);
    const options = mergeModelOptions({
      curated: AGENT_OPTIONS[kind].models,
      discovered: catalog,
      selected: initial,
      scoped: CATALOG_SCOPED_KINDS.has(kind),
      loggedIn,
    });
    const picked = await pickOption("Model", options, initial);
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

/** A select that returns the chosen value (or null on cancel), pre-selecting
 *  `initial` when it's a valid option. Structurally typed (`id`/`label`/
 *  optional `hint`) rather than `AgentOption[]` so it accepts both plain
 *  curated rows (modes, efforts) and `mergeModelOptions`'s `ModelOption[]`
 *  (models) without a cast — both shapes carry the fields this cares about
 *  and nothing else is read. */
async function pickOption(
  message: string,
  opts: ReadonlyArray<{ id: string; label: string; hint?: string }>,
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

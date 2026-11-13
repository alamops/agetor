import { getClient, type Flags } from "../context.ts";
import { c, out, printJson, table, isTTY } from "../output.ts";
import { flagValue } from "../args.ts";
import { ApiError, type HarnessPatchInput } from "../api-client.ts";
import type { AgentKind, Harness, HarnessLimitState, HarnessQuota, HarnessStack, HarnessStatus, MirrorPreview } from "../../shared/types.ts";
import { formatHarnessSwapEvent, stackPositionText, memberStateText } from "../../shared/harness-stack.ts";
import { usageError } from "../usage.ts";
import { escapeControlChars, escapeFreeText } from "../../shared/terminal-text.ts";
import { resolveStack } from "../resolve-stack.ts";
import { coolingText, limitRowsFor, printMirrorPreview, quotaText } from "../stack-display.ts";

/** The latest quota snapshots (`GET /usage`). A failed or missing route only
 *  loses the quota cells — it never fails the listing. */
async function fetchQuota(client: Awaited<ReturnType<typeof getClient>>): Promise<HarnessQuota[]> {
  if (typeof client.getUsage !== "function") return [];
  return client.getUsage().catch(() => []);
}

/** Printed under an fx harness whose own saved profile starts in Ask mode
 *  (`fx status --json` `permission_mode`, fx ≥0.0.14). Neutral on purpose:
 *  agetor can't tell whether it or the user set that value. Same copy as the
 *  Settings → Harnesses hint. */
export const FX_ASK_PROFILE_HINT =
  "fx's own profile starts in Ask mode. Agetor sets each task's mode itself; to change fx's default, run `/permissions` inside fx.";

export async function cmdHarness(args: string[], flags: Flags): Promise<void> {
  const sub = args[0] ?? "ls";
  const client = await getClient(flags);
  switch (sub) {
    case "ls":
    case "list": {
      const { harnesses, statuses, stacks = [], limitStates = [] } = await client.listHarnesses();
      const quota = await fetchQuota(client);
      if (flags.json) return printJson({ harnesses, statuses, stacks, limitStates, quota });
      const byId = new Map(statuses.map((s) => [s.harnessId, s]));
      const quotaById = new Map(quota.map((q) => [q.harnessId, q]));
      const stackPosition = new Map<string, string>();
      for (const stack of stacks) {
        // A one-member stack has no backups: `stackPositionText` is null, so
        // name the role without a `1/1`.
        stack.members.forEach((m, i) => {
          const pos = stackPositionText(stack, m.harnessId);
          stackPosition.set(m.harnessId, pos === null ? "primary" : `${pos}${i === 0 ? " primary" : ""}`);
        });
      }
      const rows = harnesses.map((h) => {
        const st = byId.get(h.id);
        return [
          h.enabled ? c.green("✓") : c.gray("·"),
          c.bold(escapeControlChars(h.id)),
          c.gray(h.kind),
          // The route stores a label as typed, control characters included.
          escapeControlChars(h.label),
          st?.available ? c.green("ready") : c.red(st?.reason ?? "unavailable"),
          st?.version ?? "",
          // fx only (absent ⇒ on); meaningless for every other kind.
          h.kind === "fx" ? (h.profileMcpServers !== false ? "on" : c.gray("off")) : c.dim("-"),
          stackPosition.get(h.id) ?? "-",
          coolingCell(limitStates, h.id),
          quotaText(quotaById.get(h.id)),
          h.isBuiltin ? c.dim("built-in") : "",
        ];
      });
      out(table(["", "id", "kind", "label", "status", "version", "profile-mcp", "stack", "cooling", "quota", "note"], rows));
      // Logged-out state rides alongside availability rather than inside the
      // table cell (a login probe result, not an install/PATH problem) — one
      // extra line per affected harness, same red-text treatment as the
      // table's own unavailable/reason cell above.
      for (const h of harnesses) {
        const st = byId.get(h.id);
        if (st?.loggedIn === false) {
          out(`  ${c.red("!")} ${c.bold(escapeControlChars(h.id))} not logged in — ${st.authHelp ?? "run its login command"}`);
        }
        if (h.kind === "fx" && st?.fxProfilePermissionMode === "ask") {
          out(`  ${c.dim("i")} ${c.bold(escapeControlChars(h.id))} ${FX_ASK_PROFILE_HINT}`);
        }
        for (const line of harnessNoticeLines(h.id, st)) out(line);
      }
      return;
    }
    case "add": {
      const id = args[1];
      if (!id || id.startsWith("-")) {
        throw usageError("harness add");
      }
      const f = parseHarnessFlags(args.slice(2));
      const created = await client.createHarness({
        id,
        kind: (f.kind ?? "claude-code") as AgentKind,
        label: f.label ?? id,
        home: f.home,
        bin: f.bin,
        env: f.env,
        ...(f.profileMcpServers !== undefined ? { profileMcpServers: f.profileMcpServers } : {}),
      });
      if (flags.json) return printJson(created);
      out(`${c.green("✓")} created harness ${c.bold(created.id)} (${created.kind})`);
      return;
    }
    case "edit": {
      const id = args[1];
      if (!id) {
        throw usageError("harness edit");
      }
      const f = parseHarnessFlags(args.slice(2));
      const patch: HarnessPatchInput = {};
      if (f.label !== undefined) patch.label = f.label;
      if (f.homeSet) patch.home = f.home ?? null;
      if (f.binSet) patch.bin = f.bin ?? null;
      if (f.env) patch.env = f.env;
      if (f.profileMcpServers !== undefined) patch.profileMcpServers = f.profileMcpServers;
      if (Object.keys(patch).length === 0) {
        throw new Error("nothing to edit — pass --label / --home / --bin / --env / --profile-mcp / --no-profile-mcp");
      }
      let updated: Harness;
      try {
        updated = await client.patchHarness(id, f.yes ? { ...patch, confirmMirrorDrop: true } : patch);
      } catch (e) {
        // The edit moves the account away from a folder the config mirror
        // keeps records and saved originals for: like a stack save whose
        // preview overwrites, it needs `--yes`.
        if (e instanceof ApiError && e.status === 409 && e.code === "mirror-records") {
          if (flags.json) printJson({ saved: false, refusal: e.body });
          throw new Error(`${escapeFreeText(e.message)} Re-run with --yes to save anyway.`);
        }
        throw e;
      }
      if (flags.json) return printJson(updated);
      out(`${c.green("✓")} updated harness ${c.bold(escapeControlChars(updated.id))}`);
      return;
    }
    case "enable":
    case "disable": {
      const id = args[1];
      if (!id) throw usageError("harness");
      const updated = await client.patchHarness(id, { enabled: sub === "enable" });
      if (flags.json) return printJson(updated);
      out(`${sub === "enable" ? c.green("enabled") : c.gray("disabled")} ${c.bold(escapeControlChars(id))}`);
      return;
    }
    case "rm":
    case "remove": {
      const id = args[1];
      if (!id) throw usageError("harness");
      try {
        await client.deleteHarness(id);
      } catch (e) {
        // 409 = harness in use; surface the blocking task ids and — since
        // agent profiles reference a harness too (see `HarnessInUseError`'s
        // `profileIds`) — the blocking agent ids, so the user knows which
        // Settings → Agents rows to repoint or remove first.
        if (e instanceof ApiError && e.status === 409) {
          const body = (e.body ?? {}) as { taskIds?: string[]; profileIds?: string[] };
          const ids = body.taskIds ?? [];
          const profileIds = body.profileIds ?? [];
          const parts: string[] = [];
          if (ids.length) parts.push(`tasks: ${ids.map((t) => t.slice(0, 8)).join(", ")}`);
          if (profileIds.length) parts.push(`agents: ${profileIds.map((p) => p.slice(0, 8)).join(", ")}`);
          throw new Error(`${e.message}${parts.length ? ` (${parts.join("; ")})` : ""}`);
        }
        throw e;
      }
      if (flags.json) return printJson({ removed: id });
      out(`${c.red("✗")} removed harness ${c.bold(escapeControlChars(id))}`);
      return;
    }
    case "stack": {
      await cmdHarnessStack(client, args.slice(1), flags);
      return;
    }
    case "cooldown": {
      await cmdHarnessCooldown(client, args.slice(1), flags);
      return;
    }
    case "restore": {
      await cmdHarnessRestore(client, args.slice(1), flags);
      return;
    }
    case "shell": {
      const id = args[1];
      if (!id) throw usageError("harness shell");
      if (!isTTY) {
        throw new Error("agetor harness shell needs an interactive terminal (TTY)");
      }
      const { env, binDir, launch, kind } = await client.harnessShellEnv(id);
      const shell = process.env.SHELL || "/bin/zsh";
      const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
      if (binDir) childEnv.PATH = `${binDir}:${process.env.PATH ?? ""}`;
      const loginHint = harnessShellLoginHint(kind, launch);
      out(`${c.green("●")} harness ${c.bold(escapeControlChars(id))} — env applied. ${loginHint} · Ctrl-D to exit`);
      const proc = Bun.spawn([shell], {
        env: childEnv,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      process.exitCode = (await proc.exited) ?? 0;
      return;
    }
    default:
      throw new Error(
        `unknown harness subcommand: ${sub} (use ls | add | edit | enable | disable | rm | stack | cooldown | restore | shell)`,
      );
  }
}

/** The cooling cell of `harness ls`: every cooldown row of the account (an
 *  account-wide one and/or per-model ones), reason and reset via the shared
 *  {@link coolingText}. */
function coolingCell(states: readonly HarnessLimitState[], harnessId: string): string {
  const rows = limitRowsFor(states, harnessId);
  return rows.length === 0 ? "" : c.yellow(rows.map(coolingText).join("; "));
}

/** The harness id a ref names: an exact id, else the harness of that kind (the
 *  core resolves `/harnesses/:ref/...` the same way). Falls back to the ref
 *  itself when the list is unavailable or has no match. */
async function resolveHarnessId(client: Awaited<ReturnType<typeof getClient>>, ref: string): Promise<string> {
  if (typeof client.listHarnesses !== "function") return ref;
  const payload = await client.listHarnesses().catch(() => null);
  const list = payload?.harnesses ?? [];
  return (list.find((h) => h.id === ref) ?? list.find((h) => h.kind === ref))?.id ?? ref;
}

/** `agetor harness cooldown clear <account> [--model <m>]` (D13). */
async function cmdHarnessCooldown(
  client: Awaited<ReturnType<typeof getClient>>,
  args: string[],
  flags: Flags,
): Promise<void> {
  if (args[0] !== "clear") throw usageError("harness cooldown");
  const id = args[1];
  if (!id || id.startsWith("-")) throw usageError("harness cooldown");
  let model: string | undefined;
  for (let i = 2; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--model") model = flagValue(args, ++i, a);
    else throw new Error(`unknown flag ${escapeControlChars(a)}`);
  }
  const resolved = await resolveHarnessId(client, id);
  const result = await client.clearHarnessCooldown(resolved, { model: model ?? null });
  if (flags.json) return printJson(result);
  const name = escapeControlChars(resolved);
  out(
    `${c.green("✓")} cleared ${model ? "the cooldown" : "every cooldown"} on ${c.bold(name)}` +
      `${model ? ` for ${escapeControlChars(model)}` : " (pass --model to clear one model's only)"}`,
  );
  const rearmed = (result as { rearmed?: number }).rearmed ?? 0;
  if (rearmed > 0) out(`  re-armed ${rearmed} waiting task(s)`);
  const left = limitRowsFor(result.limitStates, resolved);
  for (const s of left) out(`  ${c.yellow("still cooling:")} ${coolingText(s)}`);
  if (left.length === 0) out(c.dim(`  no cooldown remains on ${name}`));
  out(c.dim("  the provider may still refuse until its own reset"));
}

/** `agetor harness restore <account> [--yes]` (D9). */
async function cmdHarnessRestore(
  client: Awaited<ReturnType<typeof getClient>>,
  args: string[],
  flags: Flags,
): Promise<void> {
  const id = args[0];
  if (!id || id.startsWith("-")) throw usageError("harness restore");
  let yes = false;
  for (const a of args.slice(1)) {
    if (a === "--yes" || a === "-y") yes = true;
    else throw new Error(`unknown flag ${escapeControlChars(a)}`);
  }
  // A current backup member is re-mirrored on the next swap or stack save, so
  // a restore would be undone: ask first.
  if (!yes) {
    const resolved = await resolveHarnessId(client, id);
    const { stacks } = await client.listHarnessStacks();
    const stack = stacks.find((s) => s.members.length >= 2 && s.members.findIndex((m) => m.harnessId === resolved) >= 1);
    if (stack) {
      throw new Error(
        `${escapeControlChars(id)} is a backup in stack "${escapeControlChars(stack.label)}": the next mirror will re-apply the primary's config — re-run with --yes to restore anyway`,
      );
    }
  }
  const result = await client.restoreHarnessMirror(id);
  if (flags.json) return printJson(result);
  out(`${c.green("✓")} restored ${c.bold(escapeControlChars(id))}`);
  const lists: Array<[string, string[]]> = [
    ["restored", result.restored],
    ["removed", result.removed],
    ["kept (edited since the mirror wrote them)", result.kept],
  ];
  for (const [label, items] of lists) {
    if (items.length === 0) continue;
    out(`  ${label} ${items.length}: ${items.slice(0, 5).map((p) => escapeControlChars(p)).join(", ")}${items.length > 5 ? ` (+${items.length - 5} more)` : ""}`);
  }
  if (result.restored.length + result.removed.length + result.kept.length === 0) out(c.dim("  nothing to restore"));
  for (const w of result.warnings) out(`  ${c.yellow("!")} ${escapeFreeText(w)}`);
}

/** The neutral notices a harness status carries (OpenCode's "no credentials"
 *  and "OpenCode 2 is available" lines, `HarnessStatus.notices`), one dim
 *  line each under the harness rows of `agetor harness ls`. They come from
 *  the core, which can quote CLI output, so each is escaped as free text. */
export function harnessNoticeLines(harnessId: string, status: Pick<HarnessStatus, "notices"> | undefined): string[] {
  return (status?.notices ?? [])
    .filter((n) => n.trim() !== "")
    .map((n) => c.dim(`  i ${escapeControlChars(harnessId)} ${escapeFreeText(n)}`));
}

/** The `agetor harness shell` banner's login hint. Only the commands we've
 *  verified are asserted (`claude /login`, `cursor-agent login`, `copilot
 *  login`, `opencode auth login`); any other kind keeps the generic wording. */
export function harnessShellLoginHint(kind: AgentKind, launch: string): string {
  if (kind === "claude-code") return `run ${c.cyan(`${launch} /login`)} to authenticate`;
  if (kind === "cursor" || kind === "copilot") return `run ${c.cyan(`${launch} login`)} to authenticate`;
  if (kind === "opencode") return `run ${c.cyan(`${launch} auth login`)} to authenticate`;
  return `log in to ${c.cyan(launch)} here`;
}

interface HarnessFlags {
  kind?: string;
  label?: string;
  home?: string | null;
  homeSet?: boolean;
  bin?: string | null;
  binSet?: boolean;
  env?: Record<string, string>;
  /** fx only: `--profile-mcp` / `--no-profile-mcp` (last one wins). */
  profileMcpServers?: boolean;
  /** `edit` only: save even when the edit drops the account's config-mirror
   *  records (the core's `mirror-records` refusal). */
  yes?: boolean;
}

export function parseHarnessFlags(args: string[]): HarnessFlags {
  const f: HarnessFlags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const val = () => flagValue(args, ++i, a);
    switch (a) {
      case "--kind": f.kind = val(); break;
      case "--label": f.label = val(); break;
      case "--home": { const v = val(); f.home = v === "none" ? null : v; f.homeSet = true; break; }
      case "--bin": { const v = val(); f.bin = v === "none" ? null : v; f.binSet = true; break; }
      case "--profile-mcp": f.profileMcpServers = true; break;
      case "--no-profile-mcp": f.profileMcpServers = false; break;
      case "--yes":
      case "-y": f.yes = true; break;
      case "--env": {
        const v = val();
        const eq = v.indexOf("=");
        if (eq < 1) throw new Error(`--env must be KEY=VALUE (got "${v}")`);
        (f.env ??= {})[v.slice(0, eq)] = v.slice(eq + 1);
        break;
      }
      default: break;
    }
  }
  return f;
}

type Client = Awaited<ReturnType<typeof getClient>>;

/** `{ stack, warnings, mirror }` of a stack create/edit. */
type StackWrite = Awaited<ReturnType<Client["createHarnessStack"]>>;

/** Printed for a 409 `stack-changed` on `stack edit` (D16). */
export const STACK_CHANGED_MESSAGE = "the stack changed since it was read — re-run the command";

const OVERWRITE_REFUSAL =
  "this would overwrite or remove files on a backup account (originals are backed up); re-run with --yes";

/**
 * `agetor harness stack …` — create/list/edit/remove a same-kind account
 * train. Members are ordered; position 1 is the primary and is labelled as
 * such. Free text (labels, warnings) is escaped like every other CLI surface.
 * Every `<stack>` argument resolves id → label → unique id prefix.
 */
async function cmdHarnessStack(client: Client, args: string[], flags: Flags): Promise<void> {
  const sub = args[0] ?? "ls";
  switch (sub) {
    case "ls":
    case "list": {
      const { stacks, limitStates } = await client.listHarnessStacks();
      const quota = await fetchQuota(client);
      if (flags.json) return printJson({ stacks, limitStates, quota });
      const quotaById = new Map(quota.map((q) => [q.harnessId, q]));
      const rows = stacks.map((stack) => [
        c.bold(escapeControlChars(stack.id)),
        escapeControlChars(stack.label),
        c.gray(stack.kind),
        stack.members
          .map((m, i) => {
            const pos = stackPositionText(stack, m.harnessId);
            const role = i === 0 ? c.cyan("primary") : c.dim(pos ?? `${i + 1}`);
            const cool = limitRowsFor(limitStates, m.harnessId);
            const q = quotaText(quotaById.get(m.harnessId));
            return `${role} ${escapeControlChars(m.label)}` +
              (cool.length ? c.yellow(` (cooling: ${cool.map(coolingText).join("; ")})`) : "") +
              (q ? c.dim(` [${q}]`) : "");
          })
          .join(" · "),
        stack.mirrorMode,
      ]);
      out(table(["id", "label", "kind", "members", "mirror"], rows));
      if (stacks.length === 0) out(c.dim("no stacks — create one with `agetor harness stack create <label> --member <id>...`"));
      return;
    }
    case "create": {
      // The label is either the first positional token or `--label <text>`.
      // They are alternatives, not two spellings that silently compete: if
      // both are passed, refuse instead of letting one win and dropping the
      // other (the old `positional ?? parsed.label` ignored `--label`).
      const positional = args[1] !== undefined && !args[1].startsWith("-") ? args[1] : undefined;
      const parsed = parseStackFlags(positional ? args.slice(2) : args.slice(1));
      if (positional !== undefined && parsed.label !== undefined) {
        throw new Error("pass the stack label once — either positionally or with --label, not both");
      }
      const label = parsed.label ?? positional;
      if (!label || label.startsWith("-")) {
        throw usageError("harness stack create");
      }
      const kind = parsed.kind ?? "claude-code";
      const gate = await previewGate(client, flags, parsed, {
        kind,
        members: parsed.members,
        ...(parsed.mirror ? { mirrorMode: parsed.mirror } : {}),
      });
      if (gate === "dry-run") return;
      const result = await client.createHarnessStack({
        label,
        kind,
        members: parsed.members,
        ...(parsed.mirror ? { mirrorMode: parsed.mirror } : {}),
      });
      if (flags.json) return printJson(result);
      out(`${c.green("✓")} created stack ${c.bold(escapeControlChars(result.stack.id))} (${result.stack.kind})`);
      printStackWriteNotes(result);
      return;
    }
    case "show": {
      const ref = args[1];
      if (!ref) throw usageError("harness stack show");
      const resolved = await resolveStack(client, ref);
      const { stack, limitStates } = await client.getHarnessStack(resolved.id);
      const quota = await fetchQuota(client);
      if (flags.json) return printJson({ stack, limitStates, quota });
      const quotaById = new Map(quota.map((q) => [q.harnessId, q]));
      out(`${c.bold(escapeControlChars(stack.label))} ${c.gray(`(${stack.kind}, ${stack.mirrorMode})`)}  ${c.dim(escapeControlChars(stack.id))}`);
      stack.members.forEach((m, i) => {
        const pos = stackPositionText(stack, m.harnessId);
        const role = i === 0 ? c.cyan("primary") : c.dim(`backup ${pos ?? i + 1}`);
        out(`  ${role} ${escapeControlChars(m.label)} ${c.gray(escapeControlChars(m.harnessId))}`);
        for (const s of limitRowsFor(limitStates, m.harnessId)) {
          out(`    ${c.yellow(`cooling: ${coolingText(s)}`)}`);
          const msg = memberStateText(s).message;
          if (msg) out(`      ${c.dim(escapeFreeText(msg))}`);
        }
        const q = quotaText(quotaById.get(m.harnessId));
        if (q) out(`    ${c.dim(`quota: ${q}`)}`);
      });
      for (const w of stack.warnings) out(`  ${c.yellow("!")} ${escapeFreeText(w.message)}`);
      return;
    }
    case "preview": {
      const ref = args[1];
      if (!ref) throw usageError("harness stack preview");
      const stack = await resolveStack(client, ref);
      const preview = await client.previewHarnessMirror({
        kind: stack.kind,
        members: stack.members.map((m) => m.harnessId),
        mirrorMode: stack.mirrorMode,
        stackId: stack.id,
      });
      if (flags.json) return printJson(preview);
      printMirrorPreview(preview);
      return;
    }
    case "history": {
      const ref = args[1];
      if (!ref || ref.startsWith("-")) throw usageError("harness stack history");
      let limit: number | undefined;
      let before: string | undefined;
      for (let i = 2; i < args.length; i++) {
        const a = args[i]!;
        if (a === "--limit") {
          const raw = flagValue(args, ++i, a);
          const n = Number(raw);
          if (!Number.isInteger(n) || n < 1) throw new Error("--limit must be a positive whole number");
          limit = n;
        } else if (a === "--before") before = flagValue(args, ++i, a);
        else throw new Error(`unknown flag ${escapeControlChars(a)}`);
      }
      const stack = await resolveStack(client, ref);
      const page = await client.getHarnessStackHistory(stack.id, { limit, before });
      if (flags.json) return printJson(page);
      if (page.events.length === 0) out(c.dim("no swap history"));
      for (const e of page.events) {
        const task = e.taskId
          ? ` ${c.dim(`(task ${escapeControlChars(e.taskId.slice(0, 8))}${e.taskTitle ? ` "${escapeFreeText(e.taskTitle)}"` : ""})`)}`
          : "";
        out(`${c.dim(new Date(e.at).toLocaleString())}  ${escapeFreeText(formatHarnessSwapEvent(e))}${task}`);
      }
      if (page.nextCursor) out(c.dim(`more: --before ${escapeControlChars(page.nextCursor)}`));
      return;
    }
    case "edit": {
      const ref = args[1];
      if (!ref || ref.startsWith("-")) throw usageError("harness stack edit");
      const parsed = parseStackFlags(args.slice(2), { partial: true });
      const hasOps = parsed.ops.length > 0;
      if (hasOps && parsed.members.length > 0) {
        throw new Error("--member replaces the whole list; it cannot be combined with --add / --remove / --move");
      }
      if (
        parsed.members.length === 0 && !hasOps
        && parsed.label === undefined && parsed.kind === undefined && parsed.mirror === undefined
      ) {
        throw new Error("nothing to edit — pass --label / --kind / --member / --add / --remove / --move / --mirror");
      }
      // Always read the stack first: its `updatedAt` rides along as
      // `expectedUpdatedAt`, so an edit made elsewhere in between is refused
      // (409 `stack-changed`) instead of overwritten (D16).
      const stack = await resolveStack(client, ref);
      const currentIds = stack.members.map((m) => m.harnessId);
      // `--kind` is honoured, not silently dropped. The server validates it
      // against the members (a stack is one harness kind), so an impossible
      // edit fails loudly instead of leaving the row unchanged.
      const patch = stackEditPatch(stack, {
        label: parsed.label,
        kind: parsed.kind,
        mirrorMode: parsed.mirror,
        members: parsed.members.length > 0 ? parsed.members : hasOps ? applyMemberOps(stack, parsed.ops) : undefined,
      });
      if (Object.keys(patch).length === 0) {
        // Every flag already matches the stack: send nothing, so nothing is
        // mirrored and `--dry-run` has nothing to hide.
        if (flags.json) return printJson({ saved: false, unchanged: true, preview: null, stack });
        out(c.dim(`no changes — stack ${escapeControlChars(stack.label)} already matches${parsed.dryRun ? "; nothing saved" : ""}`));
        return;
      }
      // The same rule the server applies to the PATCH body: a members, kind or
      // mirror-mode field re-runs the mirror.
      const mirrorRelevant =
        patch.members !== undefined || patch.kind !== undefined || patch.mirrorMode !== undefined;
      const gate = await previewGate(
        client,
        flags,
        parsed,
        {
          kind: patch.kind ?? stack.kind,
          members: patch.members ?? currentIds,
          mirrorMode: patch.mirrorMode ?? stack.mirrorMode,
          stackId: stack.id,
        },
        mirrorRelevant,
      );
      if (gate === "dry-run") return;
      let result: StackWrite;
      try {
        result = await client.patchHarnessStack(stack.id, { ...patch, expectedUpdatedAt: stack.updatedAt });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.code === "stack-changed") {
          throw new Error(STACK_CHANGED_MESSAGE);
        }
        throw e;
      }
      if (flags.json) return printJson(result);
      out(`${c.green("✓")} updated stack ${c.bold(escapeControlChars(result.stack.id))}`);
      printStackWriteNotes(result);
      return;
    }
    case "rm":
    case "remove": {
      const ref = args[1];
      if (!ref) throw usageError("harness stack rm");
      const stack = await resolveStack(client, ref);
      await client.deleteHarnessStack(stack.id);
      if (flags.json) return printJson({ removed: stack.id });
      out(`${c.red("✗")} removed stack ${c.bold(escapeControlChars(stack.id))} — its account-switch history is deleted too`);
      return;
    }
    default:
      throw new Error(
        `unknown harness stack subcommand: ${escapeControlChars(sub)} (use ls | create | show | edit | preview | history | rm)`,
      );
  }
}

type StackEditFields = { label?: string; kind?: "claude-code" | "codex"; members?: string[]; mirrorMode?: "full" | "safe" };

/**
 * The PATCH body of `harness stack edit`: only the fields that differ from the
 * stored stack. The server re-runs the mirror whenever `members`, `kind` or
 * `mirrorMode` is present, whatever its value, so a field already at its value
 * (`--mirror full` on a full stack, `--member` with the current order) must be
 * left out, or the save would mirror without the preview or the `--yes` check.
 * Same rule as the webview's `draftPatch` (src/mainview/lib/stack-editor.ts),
 * plus `kind`, which only the CLI can edit.
 */
export function stackEditPatch(
  stack: Pick<HarnessStack, "label" | "kind" | "mirrorMode" | "members">,
  wanted: StackEditFields,
): StackEditFields {
  const patch: StackEditFields = {};
  if (wanted.label !== undefined && wanted.label !== stack.label) patch.label = wanted.label;
  if (wanted.kind !== undefined && wanted.kind !== stack.kind) patch.kind = wanted.kind;
  if (wanted.mirrorMode !== undefined && wanted.mirrorMode !== stack.mirrorMode) patch.mirrorMode = wanted.mirrorMode;
  const currentIds = stack.members.map((m) => m.harnessId);
  if (
    wanted.members !== undefined
    && (wanted.members.length !== currentIds.length || wanted.members.some((id, i) => id !== currentIds[i]))
  ) {
    patch.members = wanted.members;
  }
  return patch;
}

function printStackWriteNotes(result: StackWrite): void {
  for (const w of result.warnings) out(`  ${c.yellow("!")} ${escapeFreeText(w.message)}`);
  for (const w of result.mirror.warnings) out(`  ${c.yellow("mirror:")} ${escapeFreeText(w)}`);
}

/**
 * The save-time mirror preview (D10). Returns "dry-run" when the command
 * must stop without saving (`--dry-run`), "save" when it may proceed.
 *
 * - A change that is not mirror-relevant (`relevant === false`) skips the
 *   preview; `--dry-run` then just says so.
 * - `--dry-run` prints the preview and saves nothing.
 * - A preview that would overwrite or remove something on a backup refuses
 *   (exit 1, after printing it) unless `--yes` was passed.
 */
async function previewGate(
  client: Client,
  flags: Flags,
  parsed: StackFlags,
  draft: { kind: "claude-code" | "codex"; members: string[]; mirrorMode?: "full" | "safe"; stackId?: string },
  relevant = true,
): Promise<"dry-run" | "save"> {
  if (!relevant) {
    if (!parsed.dryRun) return "save";
    if (flags.json) printJson({ saved: false, preview: null });
    else out(c.dim("dry run: no mirror-relevant change — nothing would be copied, nothing saved"));
    return "dry-run";
  }
  const preview: MirrorPreview = await client.previewHarnessMirror(draft);
  if (parsed.dryRun) {
    if (flags.json) printJson({ saved: false, preview });
    else {
      printMirrorPreview(preview);
      out(c.dim("dry run: nothing saved"));
    }
    return "dry-run";
  }
  if (preview.overwrites && !parsed.yes) {
    if (flags.json) printJson({ saved: false, preview });
    else printMirrorPreview(preview);
    throw new Error(OVERWRITE_REFUSAL);
  }
  if (preview.overwrites && !flags.json) printMirrorPreview(preview);
  return "save";
}

type MemberOp =
  | { op: "add"; account: string }
  | { op: "remove"; account: string }
  | { op: "move"; account: string; position: number };

/** Apply `--add` / `--remove` / `--move` in order to the stack's current
 *  member ids. A remove/move names a current member by id (or its exact,
 *  unique label); an add is an account id like `--member`. */
export function applyMemberOps(stack: Pick<HarnessStack, "members">, ops: readonly MemberOp[]): string[] {
  const list = stack.members.map((m) => ({ id: m.harnessId, label: m.label }));
  const find = (ref: string): number => {
    const byId = list.findIndex((m) => m.id === ref);
    if (byId >= 0) return byId;
    const byLabel = list.map((m, i) => (m.label === ref ? i : -1)).filter((i) => i >= 0);
    if (byLabel.length === 1) return byLabel[0]!;
    if (byLabel.length > 1) throw new Error(`"${escapeControlChars(ref)}" matches ${byLabel.length} members — use the account id`);
    throw new Error(`"${escapeControlChars(ref)}" is not a member of this stack`);
  };
  for (const o of ops) {
    if (o.op === "add") {
      if (list.some((m) => m.id === o.account)) throw new Error(`"${escapeControlChars(o.account)}" is already a member of this stack`);
      list.push({ id: o.account, label: o.account });
    } else if (o.op === "remove") {
      list.splice(find(o.account), 1);
      if (list.length === 0) throw new Error("cannot remove the last member — use 'agetor harness stack rm' to delete the stack");
    } else {
      if (o.position < 1 || o.position > list.length) {
        throw new Error(`--move position must be between 1 and ${list.length} (got ${o.position})`);
      }
      const [m] = list.splice(find(o.account), 1);
      list.splice(o.position - 1, 0, m!);
    }
  }
  return list.map((m) => m.id);
}

interface StackFlags {
  /** Undefined until `--kind` is passed: `create` defaults to `claude-code`,
   *  while `edit` must leave the field out of its PATCH. */
  kind?: "claude-code" | "codex";
  label?: string;
  members: string[];
  mirror?: "full" | "safe";
  /** `edit` only: `--add` / `--remove` / `--move`, in command-line order. */
  ops: MemberOp[];
  dryRun: boolean;
  yes: boolean;
}

function parseStackFlags(args: string[], opts: { partial?: boolean } = {}): StackFlags {
  const f: StackFlags = { members: [], ops: [], dryRun: false, yes: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const val = () => flagValue(args, ++i, a);
    switch (a) {
      case "--kind": {
        const kind = val();
        if (kind !== "claude-code" && kind !== "codex") {
          throw new Error("--kind must be claude-code or codex");
        }
        f.kind = kind;
        break;
      }
      case "--label": f.label = val(); break;
      case "--member": f.members.push(val()); break;
      case "--add":
      case "--remove":
      case "--move": {
        if (!opts.partial) throw new Error(`unknown flag ${a}`);
        const v = val();
        if (a === "--add") f.ops.push({ op: "add", account: v });
        else if (a === "--remove") f.ops.push({ op: "remove", account: v });
        else {
          const colon = v.lastIndexOf(":");
          const position = colon > 0 && /^\d+$/.test(v.slice(colon + 1)) ? Number(v.slice(colon + 1)) : NaN;
          if (!Number.isInteger(position) || position < 1) {
            throw new Error("--move must be <account>:<position> with a 1-based position (1 = primary)");
          }
          f.ops.push({ op: "move", account: v.slice(0, colon), position });
        }
        break;
      }
      case "--mirror": {
        const mirror = val();
        if (mirror !== "full" && mirror !== "safe") throw new Error("--mirror must be full or safe");
        f.mirror = mirror;
        break;
      }
      case "--dry-run": f.dryRun = true; break;
      case "--yes":
      case "-y": f.yes = true; break;
      default:
        throw new Error(`unknown flag ${escapeControlChars(a)}`);
    }
  }
  if (!opts.partial && f.members.length === 0) throw new Error("--member is required at least once");
  return f;
}

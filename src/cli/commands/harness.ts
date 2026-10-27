import { getClient, type Flags } from "../context.ts";
import { c, out, printJson, table, isTTY } from "../output.ts";
import { flagValue } from "../args.ts";
import { ApiError, type HarnessPatchInput } from "../api-client.ts";
import type { AgentKind, HarnessStatus } from "../../shared/types.ts";
import { usageError } from "../usage.ts";
import { escapeControlChars, escapeFreeText } from "../../shared/terminal-text.ts";

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
      const { harnesses, statuses } = await client.listHarnesses();
      if (flags.json) return printJson({ harnesses, statuses });
      const byId = new Map(statuses.map((s) => [s.harnessId, s]));
      const rows = harnesses.map((h) => {
        const st = byId.get(h.id);
        return [
          h.enabled ? c.green("✓") : c.gray("·"),
          c.bold(h.id),
          c.gray(h.kind),
          // The route stores a label as typed, control characters included.
          escapeControlChars(h.label),
          st?.available ? c.green("ready") : c.red(st?.reason ?? "unavailable"),
          st?.version ?? "",
          // fx only (absent ⇒ on); meaningless for every other kind.
          h.kind === "fx" ? (h.profileMcpServers !== false ? "on" : c.gray("off")) : c.dim("-"),
          h.isBuiltin ? c.dim("built-in") : "",
        ];
      });
      out(table(["", "id", "kind", "label", "status", "version", "profile-mcp", ""], rows));
      // Logged-out state rides alongside availability rather than inside the
      // table cell (a login probe result, not an install/PATH problem) — one
      // extra line per affected harness, same red-text treatment as the
      // table's own unavailable/reason cell above.
      for (const h of harnesses) {
        const st = byId.get(h.id);
        if (st?.loggedIn === false) {
          out(`  ${c.red("!")} ${c.bold(h.id)} not logged in — ${st.authHelp ?? "run its login command"}`);
        }
        if (h.kind === "fx" && st?.fxProfilePermissionMode === "ask") {
          out(`  ${c.dim("i")} ${c.bold(h.id)} ${FX_ASK_PROFILE_HINT}`);
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
      const updated = await client.patchHarness(id, patch);
      if (flags.json) return printJson(updated);
      out(`${c.green("✓")} updated harness ${c.bold(updated.id)}`);
      return;
    }
    case "enable":
    case "disable": {
      const id = args[1];
      if (!id) throw usageError("harness");
      const updated = await client.patchHarness(id, { enabled: sub === "enable" });
      if (flags.json) return printJson(updated);
      out(`${sub === "enable" ? c.green("enabled") : c.gray("disabled")} ${c.bold(id)}`);
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
      out(`${c.red("✗")} removed harness ${c.bold(id)}`);
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
      out(`${c.green("●")} harness ${c.bold(id)} — env applied. ${loginHint} · Ctrl-D to exit`);
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
        `unknown harness subcommand: ${sub} (use ls | add | edit | enable | disable | rm | shell)`,
      );
  }
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
 *  verified are asserted (`claude /login`, `cursor-agent login`, `opencode
 *  auth login`); any other kind keeps the generic wording. */
export function harnessShellLoginHint(kind: AgentKind, launch: string): string {
  if (kind === "claude-code") return `run ${c.cyan(`${launch} /login`)} to authenticate`;
  if (kind === "cursor") return `run ${c.cyan(`${launch} login`)} to authenticate`;
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

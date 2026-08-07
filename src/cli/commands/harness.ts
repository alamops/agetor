import { getClient, type Flags } from "../context.ts";
import { c, out, printJson, table, isTTY } from "../output.ts";
import { flagValue } from "../args.ts";
import { ApiError, type HarnessPatchInput } from "../api-client.ts";
import type { AgentKind } from "../../shared/types.ts";
import { usageError } from "../usage.ts";

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
          h.label,
          st?.available ? c.green("ready") : c.red(st?.reason ?? "unavailable"),
          st?.version ?? "",
          h.isBuiltin ? c.dim("built-in") : "",
        ];
      });
      out(table(["", "id", "kind", "label", "status", "version", ""], rows));
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
      if (Object.keys(patch).length === 0) {
        throw new Error("nothing to edit — pass --label / --home / --bin / --env");
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
        // 409 = harness in use; surface the blocking task ids.
        if (e instanceof ApiError && e.status === 409) {
          const ids = (e.body as { taskIds?: string[] })?.taskIds ?? [];
          throw new Error(
            `${e.message}${ids.length ? ` (tasks: ${ids.map((t) => t.slice(0, 8)).join(", ")})` : ""}`,
          );
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
      // Only claude's and cursor's login commands are certain (`claude /login`,
      // `cursor-agent login`); keep the fallback for any future kind generic
      // rather than assert a command we haven't verified.
      const loginHint =
        kind === "claude-code"
          ? `run ${c.cyan(`${launch} /login`)} to authenticate`
          : kind === "cursor"
            ? `run ${c.cyan(`${launch} login`)} to authenticate`
            : `log in to ${c.cyan(launch)} here`;
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

interface HarnessFlags {
  kind?: string;
  label?: string;
  home?: string | null;
  homeSet?: boolean;
  bin?: string | null;
  binSet?: boolean;
  env?: Record<string, string>;
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

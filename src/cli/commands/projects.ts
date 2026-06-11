import path from "node:path";
import { getClient, type Flags } from "../context.ts";
import { c, out, printJson, table } from "../output.ts";
import { flagValue } from "../args.ts";

export async function cmdProjects(args: string[], flags: Flags): Promise<void> {
  const sub = args[0] ?? "ls";
  const client = await getClient(flags);
  switch (sub) {
    case "ls":
    case "list": {
      const projects = await client.listProjects();
      if (flags.json) return printJson(projects);
      if (projects.length === 0) {
        out(c.dim("no projects registered"));
        return;
      }
      out(table(["name", "path"], projects.map((pr) => [c.bold(pr.name), c.dim(pr.path)])));
      return;
    }
    case "add": {
      const target = args[1];
      if (!target || target.startsWith("-")) {
        throw new Error("usage: agetor projects add <path> [--name <name>]");
      }
      let name: string | undefined;
      for (let i = 2; i < args.length; i++) {
        const a = args[i]!;
        if (a === "--name") name = flagValue(args, ++i, a);
      }
      const project = await client.addProject(path.resolve(target), name);
      if (flags.json) return printJson(project);
      out(`${c.green("✓")} registered ${c.bold(project.name)} ${c.dim(project.path)}`);
      return;
    }
    case "rm":
    case "remove": {
      const target = args[1];
      if (!target) throw new Error("usage: agetor projects rm <path>");
      const abs = path.resolve(target);
      await client.removeProject(abs);
      if (flags.json) return printJson({ removed: abs });
      out(`${c.gray("removed")} ${c.dim(abs)}`);
      return;
    }
    case "branches": {
      const target = args[1];
      if (!target) throw new Error("usage: agetor projects branches <path>");
      const branches = await client.listBranches(path.resolve(target));
      if (flags.json) return printJson(branches);
      if (branches.length === 0) {
        out(c.dim("no branches"));
        return;
      }
      for (const b of branches) {
        const marker = b.current ? c.green("* ") : "  ";
        out(`${marker}${b.remote ? c.dim(b.name) : b.name}`);
      }
      return;
    }
    default:
      throw new Error(`unknown projects subcommand: ${sub} (use ls | add | rm | branches)`);
  }
}

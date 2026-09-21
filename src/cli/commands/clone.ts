import path from "node:path";
import { getClient, type Flags } from "../context.ts";
import { c, out, errln, printJson } from "../output.ts";
import { flagValue } from "../args.ts";
import { usageError } from "../usage.ts";
import { isGitProvider } from "../../shared/clone-input.ts";
import { PROVIDER_CAPS, type GitProvider } from "../../shared/types.ts";

/**
 * `agetor clone <url> [--provider github|gitlab|bitbucket] [--dest <path>]
 * [--no-eli5]` — clone a GitHub/GitLab/Bitbucket repo as a new registered
 * project, via the same `POST /projects/clone` route the app's "Clone
 * repository" dialog uses (plan `docs/plans/clone-repository-all-providers.md`
 * §3 D8). `--provider` only disambiguates bare `owner/repo` shorthand — a
 * full URL's own detected provider wins server-side regardless of what's
 * passed here. `--dest` is resolved against the CLI's own cwd (the daemon
 * may be a long-lived detached process with an unrelated one) since the
 * route requires an absolute path. `--no-eli5` skips creating + starting the
 * explainer task the route otherwise launches by default.
 */
export async function cmdClone(args: string[], flags: Flags): Promise<void> {
  const url = args[0];
  if (!url || url.startsWith("-")) throw usageError("clone");

  let provider: GitProvider | undefined;
  let dest: string | undefined;
  let eli5 = true;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--provider": {
        const v = flagValue(args, ++i, a);
        if (!isGitProvider(v)) {
          throw new Error("--provider must be one of github, gitlab, bitbucket");
        }
        provider = v;
        break;
      }
      case "--dest":
        dest = path.resolve(flagValue(args, ++i, a));
        break;
      case "--no-eli5":
        eli5 = false;
        break;
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }

  const client = await getClient(flags);
  if (!flags.json) errln(c.dim(`cloning ${url}…`));

  const result = await client.cloneProject({ url, provider, dest, eli5 });

  if (flags.json) return printJson(result);

  const { project, provider: resolvedProvider, eli5TaskId, eli5Error } = result;
  out(`${c.green("✓")} cloned ${c.bold(project.name)} ${c.dim(project.path)}`);
  out(c.dim(`provider: ${PROVIDER_CAPS[resolvedProvider].providerName}`));
  if (eli5TaskId) {
    out(`explainer task started: ${eli5TaskId} — agetor logs ${eli5TaskId}`);
  }
  if (eli5Error) {
    out(c.yellow(`clone succeeded, but the explainer task failed: ${eli5Error}`));
  }
}

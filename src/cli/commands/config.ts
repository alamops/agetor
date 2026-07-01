import { getClient, type Flags } from "../context.ts";
import { c, out, printJson, table } from "../output.ts";

/**
 * View / set the core's cross-session preferences (the same store the app's
 * settings use). `config` lists, `config <key>` gets, `config <key> <value…>`
 * sets. Common keys: defaultHarness, lastModel:<kind>, lastMode:<kind>,
 * lastEffort:<kind>.
 */
export async function cmdConfig(args: string[], flags: Flags): Promise<void> {
  const client = await getClient(flags);
  const key = args[0];
  const rest = args.slice(1);

  // list
  if (!key || key === "ls" || key === "list") {
    const prefs = await client.getPreferences();
    if (flags.json) return printJson(prefs);
    const keys = Object.keys(prefs).sort();
    if (keys.length === 0) {
      out(c.dim("no preferences set"));
      return;
    }
    out(table(["key", "value"], keys.map((k) => [c.bold(k), prefs[k] ?? ""])));
    return;
  }

  // set: config <key> <value…>
  if (rest.length > 0) {
    const value = rest.join(" ");
    await client.setPreference(key, value);
    if (flags.json) return printJson({ [key]: value });
    out(`${c.green("✓")} ${c.bold(key)} = ${value}`);
    return;
  }

  // get: config <key>
  const prefs = await client.getPreferences();
  const value = prefs[key];
  if (value === undefined) {
    if (flags.json) return printJson({ [key]: null });
    out(c.dim(`${key} is not set`));
    return;
  }
  if (flags.json) return printJson({ [key]: value });
  out(value);
}

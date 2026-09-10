import { getClient, type Flags } from "../context.ts";
import { c, out, printJson, table } from "../output.ts";

/**
 * View / set the core's cross-session preferences (the same store the app's
 * settings use). `config` lists, `config <key>` gets, `config <key> <value…>`
 * sets. Common keys: defaultHarness, lastModel:<kind>, lastMode:<kind>,
 * lastEffort:<kind>, and the fx auto-resume pair from `docs/plans/
 * fx-recovery-follow-ups.md` — `fxAutoResume` (`"on"` | `"off"`, default on)
 * and `fxAutoResumeDelaySec` (integer seconds, clamped 10..3600, default
 * 120; see `FX_AUTO_RESUME_PREF`/`FX_AUTO_RESUME_DELAY_PREF` in
 * `src/shared/types.ts`). This command is generic over the k/v store, so no
 * logic here is specific to those two keys — they round-trip like any other.
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

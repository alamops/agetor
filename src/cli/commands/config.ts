import { ApiError } from "../api-client.ts";
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
 * `src/shared/types.ts`), and `archivedHistoryRetentionDays` (`"off"` or
 * whole days 1..3650, default 30 — the core refuses anything else and stores
 * an off-word like `0` as `"off"`). This command is generic over the k/v
 * store, so no logic here is specific to any key — it prints the value the
 * core stored, and a refused write fails with the core's own message.
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
    // A refused value (e.g. an out-of-range `archivedHistoryRetentionDays`)
    // throws the core's own 400 message, printed by the CLI's error handler.
    try {
      await client.setPreference(key, value);
    } catch (e) {
      // A value the CLI token may not set (today `disclaimSpawnedAgents false`,
      // D4/D11) is a 403 `desktop-only`: say so plainly and point at the one
      // place that can change it, instead of a bare "error: <sentence>".
      if (e instanceof ApiError && e.status === 403 && e.code === "desktop-only") {
        throw new Error(`${e.message}\nchange it in Settings → General`);
      }
      throw e;
    }
    // Echo what the core actually stored: a validated key may be normalized
    // on write (`archivedHistoryRetentionDays 0` is stored as "off").
    const stored = (await client.getPreferences())[key] ?? value;
    if (flags.json) return printJson({ [key]: stored });
    out(`${c.green("✓")} ${c.bold(key)} = ${stored}`);
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

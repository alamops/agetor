/**
 * Speed tiers (`off | fast | ultrafast`) — the pure helpers both processes
 * share. `speed` replaced the cursor-only `fast` boolean (migration 072);
 * the API and CLI still accept `fast` as an alias (`resolveSpeedInput`) and
 * every Task / AgentProfile response carries a derived `fast` for older
 * clients. Zero runtime imports outside `src/shared/`.
 *
 * Which tiers a launch can pick (`supportedSpeeds`):
 * - cursor folds Fast into the model id, so it offers `fast` exactly when
 *   `cursorModelSupportsFast(model, effort)` says the model/effort pair has a
 *   Fast variant;
 * - fx exposes `fast` / `ultrafast` as ACP session options per model; which
 *   models carry them is only known from discovery (`models --json` ≥0.0.14
 *   `models[].fast` / `.ultrafast`), so fx offers them only when the
 *   selected model option says so;
 * - every other kind offers `off` only.
 */
import { cursorModelSupportsFast, SPEEDS, type AgentKind, type AgentOption, type Speed } from "./types";

export function isSpeed(v: unknown): v is Speed {
  return typeof v === "string" && (SPEEDS as readonly string[]).includes(v);
}

/** Legacy boolean → tier: `true` → `"fast"`, anything else → `"off"`. */
export function speedFromFast(fast: boolean): Speed {
  return fast === true ? "fast" : "off";
}

/**
 * Reads a request body's `speed` / legacy `fast` pair. `speed` wins when both
 * are present. Neither present → `{}` (the caller keeps its default/row
 * value). `undefined` counts as absent; `null` does not.
 */
export function resolveSpeedInput(body: { speed?: unknown; fast?: unknown }): { speed?: Speed } | { error: string } {
  if (body.speed !== undefined) {
    if (!isSpeed(body.speed)) return { error: "speed must be one of off, fast, ultrafast" };
    return { speed: body.speed };
  }
  if (body.fast !== undefined) {
    if (typeof body.fast !== "boolean") return { error: "fast must be a boolean" };
    return { speed: speedFromFast(body.fast) };
  }
  return {};
}

/** The speed option flags a merged model option carries (`ModelOption.fast`
 *  / `.ultrafast`, copied from discovery by `mergeModelOptions` rule 8). */
export interface SpeedOptionFlags {
  fast?: boolean;
  ultrafast?: boolean;
}

/** The tiers a kind/model/effort offers, always starting with `"off"`. */
export function supportedSpeeds(
  kind: AgentKind,
  model: string | null,
  effort: string | null,
  option?: SpeedOptionFlags,
): Speed[] {
  if (kind === "cursor") return cursorModelSupportsFast(model, effort) ? ["off", "fast"] : ["off"];
  if (kind === "fx") {
    const out: Speed[] = ["off"];
    if (option?.fast === true) out.push("fast");
    if (option?.ultrafast === true) out.push("ultrafast");
    return out;
  }
  return ["off"];
}

export const SPEED_OPTIONS: AgentOption[] = [
  { id: "off", label: "Off", hint: "Standard speed." },
  { id: "fast", label: "Fast", hint: "Faster model variant / Gateway lane where the model offers one." },
  { id: "ultrafast", label: "Ultrafast", hint: "Faster Gateway lane — costs more per token than Fast" },
];

/** Display label for a tier (`"Off"` / `"Fast"` / `"Ultrafast"`). */
export function speedLabel(speed: Speed): string {
  return SPEED_OPTIONS.find((o) => o.id === speed)?.label ?? speed;
}

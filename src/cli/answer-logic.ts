/** Sentinel option value for the "type a free-text answer" choice — distinctive
 *  enough that it can't collide with a real option label. Used by `agetor
 *  answer` as the @clack option value; the dashboard overlay handles "Other"
 *  via its own row + text field and never puts the sentinel in its picks. */
export const CUSTOM_OPTION = "__agetor_custom__";

/**
 * Assemble one AskUserQuestion answer from picked option labels plus optional
 * custom free-text. Strips the {@link CUSTOM_OPTION} sentinel from `picks` and
 * trims the custom text. Returns `null` when the result would be empty — the
 * contract requires at least one of `selected` / `custom` per question.
 */
export function buildAskAnswer(
  picks: string[],
  custom: string | null,
): { selected: string[]; custom?: string } | null {
  const selected = picks.filter((p) => p !== CUSTOM_OPTION);
  const text = custom?.trim() ?? "";
  if (selected.length === 0 && text === "") return null;
  return text ? { selected, custom: text } : { selected };
}

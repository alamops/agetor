import type { SavedPrompt } from "../../shared/types.ts";

/** Case-insensitive substring match on name OR content; blank query returns all. */
export function filterPromptsForPicker(prompts: SavedPrompt[], query: string): SavedPrompt[] {
  const q = query.trim().toLowerCase();
  if (!q) return prompts;
  return prompts.filter((p) => (p.name + " " + p.content).toLowerCase().includes(q));
}

/** Case-insensitive name match, mirroring SlashAutocomplete's command filter (a prefix match is a subset of substring, so `includes` covers both); blank query returns all. */
export function filterPromptsForSlash(prompts: SavedPrompt[], query: string): SavedPrompt[] {
  const q = query.trim().toLowerCase();
  if (!q) return prompts;
  return prompts.filter((p) => p.name.toLowerCase().includes(q));
}

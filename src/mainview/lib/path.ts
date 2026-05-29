/** Last path segment, with trailing slashes stripped and both `/` and `\`
 *  treated as separators. Returns the whole string if there's no separator
 *  (handles bare filenames coming from the picker fallback). */
export function refBasename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) || trimmed : trimmed;
}

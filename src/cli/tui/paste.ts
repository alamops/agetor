/**
 * A file dragged onto the terminal is pasted as its path — often single/double
 * quoted, or with backslash-escaped spaces (and parens, etc.). When a pasted
 * chunk is an ABSOLUTE path with such escaping, normalize it so claude can
 * attach it; anything that isn't a recognizable dropped path (normal typing /
 * pasted prose) is returned untouched. Shared by the dashboard composer and the
 * inline answer text field.
 */
export function sanitizeDrop(chunk: string): string {
  const trimmed = chunk.trim();
  const unquoted =
    trimmed.length >= 2 &&
    ((trimmed[0] === "'" && trimmed.endsWith("'")) ||
      (trimmed[0] === '"' && trimmed.endsWith('"')))
      ? trimmed.slice(1, -1)
      : trimmed;
  const unescaped = unquoted.replace(/\\(.)/g, "$1");
  return unescaped.startsWith("/") && unescaped !== chunk ? unescaped : chunk;
}

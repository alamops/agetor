/**
 * Shell quoting for commands agetor prints for a user to copy-paste. Pure,
 * zero runtime imports, so both the Bun side and the CLI use it.
 */

/** Single-quotes a shell argument, escaping any embedded single quote as
 *  the standard POSIX `'\''` (close quote, escaped literal quote, reopen
 *  quote). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** A word that needs no quoting in a POSIX shell: no whitespace, quotes,
 *  `$`, backticks, globs, redirections, `;`, `&`, `|`, parentheses… — and
 *  no leading `=`, which zsh (the macOS default shell) expands as a command
 *  path lookup (`=ls` → `/bin/ls`, else "not found"). */
const SHELL_SAFE_WORD = /^[A-Za-z0-9_@%+:,./-][A-Za-z0-9_@%+=:,./-]*$/;

/** `value` as one shell word: bare when it is already safe (so an ordinary
 *  id prints as typed), single-quoted otherwise. */
export function shellWord(value: string): string {
  return SHELL_SAFE_WORD.test(value) ? value : shellQuote(value);
}

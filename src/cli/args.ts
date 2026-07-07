/**
 * Read the argument that follows a value-flag, rejecting a missing value or
 * another flag accidentally swallowed as the value (e.g. `--model --title X`
 * would otherwise set model to "--title"). Pass `allowDash` for flags whose
 * value may legitimately be "-" (read from stdin).
 *
 * Usage inside a parse loop: `const val = () => flagValue(args, ++i, a)`.
 */
export function flagValue(
  args: string[],
  i: number,
  flag: string,
  allowDash = false,
): string {
  const v = args[i];
  if (v === undefined || (v.startsWith("-") && !(allowDash && v === "-"))) {
    throw new Error(`'${flag}' needs a value`);
  }
  return v;
}

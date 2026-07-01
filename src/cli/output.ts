import pc from "picocolors";

/** TTY detection — when stdout is a pipe we suppress ANSI and animation. */
export const isTTY = Boolean(process.stdout.isTTY);

let plain = !isTTY;
export function setPlain(v: boolean): void {
  plain = v;
}

const wrap =
  (fn: (s: string) => string) =>
  (s: string): string =>
    plain ? s : fn(s);

/** Color helpers that no-op in --plain / non-TTY mode. */
export const c = {
  dim: wrap(pc.dim),
  bold: wrap(pc.bold),
  red: wrap(pc.red),
  green: wrap(pc.green),
  yellow: wrap(pc.yellow),
  cyan: wrap(pc.cyan),
  gray: wrap(pc.gray),
  magenta: wrap(pc.magenta),
  blue: wrap(pc.blue),
};

export function out(msg = ""): void {
  process.stdout.write(msg + "\n");
}

export function errln(msg = ""): void {
  process.stderr.write(msg + "\n");
}

export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

/** Render a simple aligned table. `rows` are pre-stringified cells. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(visibleLen(h), ...rows.map((r) => visibleLen(r[i] ?? ""))),
  );
  const fmt = (cells: string[]) =>
    cells
      .map((cell, i) => cell + " ".repeat(Math.max(0, widths[i]! - visibleLen(cell))))
      .join("  ")
      .trimEnd();
  const lines = [c.dim(fmt(headers)), ...rows.map(fmt)];
  return lines.join("\n");
}

// Length ignoring ANSI escape sequences, so colored cells still align.
function visibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, "").length;
}

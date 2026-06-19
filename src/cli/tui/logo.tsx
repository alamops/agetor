import { Box, Text } from "ink";

/**
 * "AGETOR" wordmarks for the dashboard's empty state. Two variants so the logo
 * adapts to the detail pane's width; `logoFor` picks the widest that fits.
 *
 * Both use only block / half-block glyphs (█ ▀ ▄) + space — all unambiguously
 * one cell — so they can't trip the wide-glyph wrapping that bit the task rows
 * (emoji-presentation chars measure 1 in Ink but render 2 in the terminal).
 */
export const LOGO_WIDE = [
  " █████  ██████ ███████ ████████  ██████  ██████",
  "██   ██ ██     ██         ██    ██    ██ ██   ██",
  "███████ ██  ██ █████      ██    ██    ██ ██████",
  "██   ██ ██   ██ ██        ██    ██    ██ ██   ██",
  "██   ██ ██████ ███████    ██     ██████  ██   ██",
];

export const LOGO_COMPACT = [
  "▄▀█ █▀▀ █▀▀ ▀█▀ █▀█ █▀█",
  "█▀█ █▄█ █▄▄  █  █▄█ █▀▄",
];

const widthOf = (lines: string[]) => Math.max(...lines.map((l) => l.length));
const WIDE_W = widthOf(LOGO_WIDE);
const COMPACT_W = widthOf(LOGO_COMPACT);

/** The widest logo variant that fits `maxWidth` columns, or null when even the
 *  compact one won't (the caller then shows plain text). */
export function logoFor(maxWidth: number): string[] | null {
  if (maxWidth >= WIDE_W) return LOGO_WIDE;
  if (maxWidth >= COMPACT_W) return LOGO_COMPACT;
  return null;
}

export function Logo({ maxWidth }: { maxWidth: number }) {
  const lines = logoFor(maxWidth);
  if (!lines) return null;
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} color="cyan">
          {line}
        </Text>
      ))}
    </Box>
  );
}

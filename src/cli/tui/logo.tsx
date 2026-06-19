import { Box, Text } from "ink";

/**
 * "AGETOR" wordmark for the dashboard's empty state. Full-block (█) + space
 * only — both unambiguously one cell — so it can't trip the wide-glyph
 * wrapping that bit the task rows (emoji-presentation chars measure 1 in
 * Ink but render 2 in the terminal). Shown only when the detail pane is at
 * least LOGO_WIDTH columns wide; narrower panes fall back to plain text.
 */
export const LOGO_LINES = [
  " █████   ██████ ███████ ███████  █████  ██████",
  "██   ██ ██      ██         ██    ██   ██ ██   ██",
  "███████ ██  ███ █████      ██    ██   ██ ██████",
  "██   ██ ██   ██ ██         ██    ██   ██ ██   ██",
  " █████   ██████ ███████    ██     █████  ██   ██",
];

export const LOGO_WIDTH = Math.max(...LOGO_LINES.map((l) => l.length));

export function Logo() {
  return (
    <Box flexDirection="column">
      {LOGO_LINES.map((line, i) => (
        <Text key={i} color="cyan">
          {line}
        </Text>
      ))}
    </Box>
  );
}

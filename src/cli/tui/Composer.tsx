import { useState } from "react";
import { Box, Text, useInput } from "ink";

/**
 * A minimal single-line text input, hand-rolled on `useInput` (no extra dep).
 * Stays mounted across sends so you can fire several messages in a row; clears
 * on submit, exits on Esc. Only active while `active` so it never competes with
 * the dashboard's nav keys.
 */
export function Composer({
  active,
  label,
  onSubmit,
  onCancel,
}: {
  active: boolean;
  label: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");

  useInput(
    (input, key) => {
      if (key.escape) {
        setText("");
        onCancel();
        return;
      }
      if (key.return) {
        const t = text.trim();
        if (t) {
          onSubmit(t);
          setText("");
        }
        return;
      }
      if (key.backspace || key.delete) {
        setText((s) => s.slice(0, -1));
        return;
      }
      // Append printable input only — skip control/meta chords (arrows, Ctrl-C).
      if (input && !key.ctrl && !key.meta) setText((s) => s + input);
    },
    { isActive: active },
  );

  return (
    <Box paddingX={1}>
      <Text color="cyan">{label} </Text>
      <Text>{text}</Text>
      <Text color="cyan">▏</Text>
    </Box>
  );
}

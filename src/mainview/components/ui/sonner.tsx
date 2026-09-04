import { Toaster as Sonner, type ToasterProps } from "sonner";
import { RUN_PANEL_DEFAULT_WIDTH } from "@/lib/panel-width";
import { useTheme } from "../theme-provider.tsx";

// Gap between the RunPanel's left edge and the toasts. When the panel is
// open, push toasts left of it so they don't sit on top of the panel header
// (where the X button lives) — sonner's hardcoded z-index of ~1e9 otherwise
// eats clicks meant for X. The panel is user-resizable, so the offset reads
// the `--run-panel-width` CSS variable RunPanel publishes on the document
// root (its single owner) rather than threading the width through App; the
// fallback only matters in the sliver before RunPanel's effect first runs.
const PANEL_OFFSET_RIGHT = `calc(var(--run-panel-width, ${RUN_PANEL_DEFAULT_WIDTH}px) + 16px)`;

interface Props extends ToasterProps {
  /** True while the right-side RunPanel is mounted. Shifts toasts left so
   *  they never overlap the panel's close button. */
  panelOpen?: boolean;
}

export function Toaster({ panelOpen = false, ...props }: Props) {
  const { resolved } = useTheme();
  return (
    <Sonner
      theme={resolved}
      position="top-right"
      // Clears the 40px header so toasts don't sit on top of the Settings
      // button (anchored top-right). Sonner's default offset is ~32px which
      // would overlap.
      offset={panelOpen ? { top: 56, right: PANEL_OFFSET_RIGHT } : 56}
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast: "group toast bg-card text-foreground border-border/60 shadow-2xl",
          description: "text-muted-foreground",
          actionButton: "bg-primary text-primary-foreground",
          cancelButton: "bg-muted text-muted-foreground",
        },
      }}
      {...props}
    />
  );
}

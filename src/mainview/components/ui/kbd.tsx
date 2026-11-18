import * as React from "react";
import { cn } from "@/lib/utils";

/** A keycap hint ("⌘↵"). Decorative: pair the control with `aria-keyshortcuts`
 *  and mark this `aria-hidden` so the control's accessible name stays clean. */
export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded border border-current/30 px-1 font-sans text-3xs font-medium leading-none opacity-80",
        className,
      )}
      {...props}
    />
  );
}

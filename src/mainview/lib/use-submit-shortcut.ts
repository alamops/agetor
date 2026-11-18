import { useEffect, type RefObject } from "react";
import { isMacPlatform } from "@/lib/platform";
import { isSubmitShortcut, shouldFireSubmit } from "@/lib/submit-shortcut";

/**
 * Cmd+Enter (Ctrl+Enter off macOS) runs a launch form. The listener sits on the
 * form's own root element (the New Task `<aside>`, a dialog's content root),
 * not on `document`, so it never fires for a key typed elsewhere on the page. It
 * stays inert when a descendant already consumed the key (an autocomplete picking
 * a suggestion), while a popover is open anywhere in the scope, and while Run is
 * disabled (`canRun`).
 */
export function useSubmitShortcut(
  scopeRef: RefObject<HTMLElement | null>,
  onRun: () => void,
  canRun: boolean,
): void {
  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope) return;
    const handler = (e: KeyboardEvent) => {
      if (!isSubmitShortcut(e, isMacPlatform())) return;
      const fire = shouldFireSubmit({
        defaultPrevented: e.defaultPrevented,
        scopeHasOpenPopover: scope.querySelector("[data-popover-open]") !== null,
        canRun,
      });
      if (!fire) return;
      e.preventDefault();
      onRun();
    };
    scope.addEventListener("keydown", handler);
    return () => scope.removeEventListener("keydown", handler);
  });
}

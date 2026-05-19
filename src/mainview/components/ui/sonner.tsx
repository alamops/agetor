import { Toaster as Sonner, type ToasterProps } from "sonner";

// Dark-only — agetor's index.html hardcodes `<html class="dark">`. If we ever
// add a light mode, swap this for `next-themes` and read the active theme.
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      position="top-right"
      // Clears the 40px header so toasts don't sit on top of the Settings
      // button (anchored top-right). Sonner's default offset is ~32px which
      // would overlap.
      offset={56}
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

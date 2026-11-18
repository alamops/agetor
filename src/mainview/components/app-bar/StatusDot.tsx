import { cn } from "@/lib/utils";

export type StatusDotTone = "danger" | "warning" | "success" | "muted" | "none";

// Literal classes (see BarMeter): `bg-${tone}-solid` would not survive the scan.
const DOT_CLASS: Record<StatusDotTone, string> = {
  danger: "bg-danger-solid",
  warning: "bg-warning-solid",
  success: "bg-success-solid",
  muted: "bg-muted-foreground/40",
  none: "bg-muted-foreground/30",
};

interface Props {
  tone: StatusDotTone;
  /** Spoken name of the state: the dot is never the only carrier of it. */
  label: string;
  className?: string;
  "data-testid"?: string;
}

/** One state dot: worst-state on the Harnesses button, per account in the panel. */
export function StatusDot({ tone, label, className, "data-testid": testId }: Props) {
  return (
    <span
      role="img"
      aria-label={label}
      data-testid={testId}
      data-tone={tone}
      className={cn("inline-block size-2 shrink-0 rounded-full", DOT_CLASS[tone], className)}
    />
  );
}

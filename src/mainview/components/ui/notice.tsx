import * as React from "react";
import { cn } from "@/lib/utils";

export type NoticeTone = "info" | "warning" | "danger" | "muted";

const TONE: Record<NoticeTone, string> = {
  info: "border-info/30 bg-info/10 text-foreground [&_[data-notice-icon]]:text-info",
  warning: "border-warning/40 bg-warning/10 text-foreground [&_[data-notice-icon]]:text-warning",
  danger: "border-danger/40 bg-danger/10 text-foreground [&_[data-notice-icon]]:text-danger",
  muted: "border-border bg-muted/40 text-muted-foreground [&_[data-notice-icon]]:text-muted-foreground",
};

export interface NoticeProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: NoticeTone;
  icon?: React.ReactNode;
  /** A trailing action (a ghost `size="sm"` button, a link). */
  action?: React.ReactNode;
}

/** An inline message block: context (info), caution (warning), failure
 *  (danger) or a read-only state (muted). Uses only semantic tokens, so both
 *  themes work. A `danger` notice announces itself (`role="alert"`). */
export function Notice({ tone = "info", icon, action, className, children, role, ...props }: NoticeProps) {
  return (
    <div
      role={role ?? (tone === "danger" ? "alert" : undefined)}
      data-tone={tone}
      className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-xs", TONE[tone], className)}
      {...props}
    >
      {icon && (
        <span data-notice-icon aria-hidden className="mt-0.5 shrink-0">
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

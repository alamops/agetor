import type { ReactNode } from "react";
import { History, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Harness, HarnessStack, HarnessStackKind } from "../../../shared/types.ts";

export const STACK_KIND_LABEL: Record<HarnessStackKind, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

interface Props {
  stack: HarnessStack;
  members: Harness[];
  deleting: boolean;
  onHistory: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (stack: HarnessStack) => void;
  /** Renders one member's full account row; the card only lays them out. */
  renderMember: (harness: Harness, index: number) => ReactNode;
}

/** One stack: label, kind, mirror mode and its actions, then its accounts in order. */
export function HarnessStackCard({ stack, members, deleting, onHistory, onEdit, onDelete, renderMember }: Props) {
  return (
    <li data-testid="harness-stack-row" className="space-y-2 rounded-md border border-border/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{stack.label}</p>
          <p className="text-xs text-muted-foreground">
            {STACK_KIND_LABEL[stack.kind]} · {stack.mirrorMode === "full" ? "Full mirror" : "Safe subset mirror"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onHistory(stack.id)}
            aria-label={`History of stack ${stack.label}`}
          >
            <History className="mr-1 size-3.5" /> History
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onEdit(stack.id)} aria-label={`Edit stack ${stack.label}`}>
            <Pencil className="mr-1 size-3.5" /> Edit
          </Button>
          <Button
            size="icon"
            variant="ghost"
            disabled={deleting}
            onClick={() => onDelete(stack)}
            aria-label={`Delete stack ${stack.label}`}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
      {stack.warnings.length > 0 && (
        <ul className="space-y-0.5 text-xs text-warning">
          {stack.warnings.map((w, i) => (
            <li key={`${w.code}:${w.harnessId ?? i}`}>{w.message}</li>
          ))}
        </ul>
      )}
      <ul className="space-y-1.5">
        {members.map((h, i) => (
          <li key={h.id}>{renderMember(h, i)}</li>
        ))}
      </ul>
      {members.length === 0 && <p className="text-xs text-muted-foreground">This stack has no accounts.</p>}
    </li>
  );
}

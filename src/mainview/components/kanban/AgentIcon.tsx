import { ClaudeCode, Codex, Kimi } from "@lobehub/icons";
import type { ComponentType } from "react";
import { cn } from "@/lib/utils";
import type { AgentKind } from "../../../shared/types.ts";

type IconProps = { size?: number | string; className?: string; "aria-hidden"?: boolean };

const ICONS: Record<AgentKind, ComponentType<IconProps>> = {
  "claude-code": ClaudeCode.Color,
  "codex": Codex.Color,
  "kimi": Kimi.Color,
};

/**
 * Renders the brand glyph for a CLI kind. Accepts any string so callers can
 * pass an unresolved harness id directly — anything other than the two
 * known kinds renders the claude-code glyph as a neutral default, which is
 * safer than throwing on an unknown alias mid-render.
 */
export function AgentIcon({ kind, className }: { kind: AgentKind | string; className?: string }) {
  const Icon = ICONS[kind as AgentKind] ?? ICONS["claude-code"];
  return <Icon size="1em" className={cn("size-3.5", className)} aria-hidden />;
}

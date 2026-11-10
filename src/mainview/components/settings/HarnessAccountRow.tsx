import { useEffect, useState } from "react";
import { BarChart3, RotateCcw, Terminal, Trash2 } from "lucide-react";
import { api, type AccountUsageDay, type HarnessesPayload } from "@/lib/api";
import { AgentIcon } from "@/components/kanban/AgentIcon";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { abbreviateHome, cn, formatTokens } from "@/lib/utils";
import { clampPercent, tierColorVar, warnTier } from "@/lib/usage";
import type { CooldownChip } from "@/lib/stack-editor";
import { quotaSummary } from "../../../shared/harness-stack.ts";
import type { AgentKind, Harness, HarnessQuota } from "../../../shared/types.ts";

/** Kinds still marked "experimental" in the UI — surfaced with the warning
 *  badge everywhere a harness/template kind is shown. Extend this list (not
 *  the individual call sites) as a kind graduates out of experimental. */
export function isExperimentalKind(kind: AgentKind): boolean {
  return kind === "codex" || kind === "cursor" || kind === "gemini" || kind === "antigravity" || kind === "fx" || kind === "opencode" || kind === "copilot";
}

type HarnessStatusRow = HarnessesPayload["statuses"][number];

// Literal class strings: Tailwind cannot see a `bg-${token}` built at runtime.
const FILL_CLASS: Record<"success" | "warning" | "danger", string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

/**
 * Compact 5-hour / weekly meter for one stack member, from the App-level
 * `usage` map (no fetch of its own). A snapshot older than 20 minutes reads
 * "stale" (the failover ignores it too); no snapshot reads "no quota data".
 */
export function StackQuotaMeter({ quota, now }: { quota: HarnessQuota | undefined; now: number }) {
  const summary = quotaSummary(quota, now);
  if (summary.status === "missing") {
    return (
      <span data-testid="harness-quota-meter" className="text-[11px] text-muted-foreground">
        no quota data
      </span>
    );
  }
  if (summary.status !== "ok" || summary.meters.length === 0) {
    return (
      <span
        data-testid="harness-quota-meter"
        className="text-[11px] text-muted-foreground"
        title={quota?.reason ?? undefined}
      >
        quota unavailable{summary.stale ? " · stale" : ""}
      </span>
    );
  }
  const label = summary.meters.map((m) => `${m.label} ${Math.round(clampPercent(m.usedPercent))}%`).join(", ");
  const ageMin = summary.ageMs === null ? null : Math.round(summary.ageMs / 60_000);
  return (
    <span
      data-testid="harness-quota-meter"
      role="img"
      aria-label={summary.stale ? `${label}, stale` : label}
      title={ageMin === null ? undefined : `Snapshot ${ageMin} min old`}
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-0.5", summary.stale && "opacity-60")}
    >
      {summary.meters.map((m) => {
        const pct = clampPercent(m.usedPercent);
        return (
          <span key={m.id} aria-hidden className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span>{m.label}</span>
            <span className="inline-block h-1.5 w-12 overflow-hidden rounded-full bg-muted">
              <span
                className={cn("block h-full rounded-full", FILL_CLASS[tierColorVar(warnTier(pct))])}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="font-mono">{Math.round(pct)}%</span>
          </span>
        );
      })}
      {summary.stale && <span aria-hidden className="text-[11px] text-muted-foreground">stale</span>}
    </span>
  );
}

export interface AccountRowProps {
  harness: Harness;
  status: HarnessStatusRow | undefined;
  homeDir: string;
  /** Position inside its stack, when stacked with 2+ members. */
  position: { text: string; index: number } | null;
  /** Show the quota meter (members of a stack only). */
  showQuota: boolean;
  quota: HarnessQuota | undefined;
  now: number;
  chips: CooldownChip[];
  pendingEnabled: boolean | undefined;
  pendingProfileMcp: boolean | undefined;
  onEdit: (h: Harness) => void;
  onDelete: (h: Harness) => void;
  onToggleEnabled: (h: Harness) => void;
  onOpenTerminal: (h: Harness) => void;
  onToggleProfileMcp: (h: Harness, next: boolean) => void;
  onClearCooldown: (h: Harness, model: string | null) => void;
  onRestore: (h: Harness) => void;
  /** True only when the account has mirror records to undo (its id is in the
   *  `/harnesses` payload's `mirrorRestorable`). */
  restorable: boolean;
}

/** One account row — the same in a stack card and under "Other accounts". */
export function AccountRow(props: AccountRowProps) {
  const {
    harness: h, status, homeDir, position, showQuota, quota, now, chips,
    pendingEnabled, pendingProfileMcp,
  } = props;
  // Which account's usage panel is expanded is row-local: the table fetches on
  // expand, and the scan behind it stats every transcript file.
  const [usageOpen, setUsageOpen] = useState(false);
  const available = status?.available ?? false;
  return (
    <div
      className={cn(
        "space-y-1.5 rounded-md border border-border/60 px-3 py-2",
        !h.enabled && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2">
        {position && (
          <span
            data-testid="harness-stack-position"
            className="w-14 shrink-0 text-[11px] font-medium text-info"
            title={position.index === 0 ? "Primary — mirrored onto every backup" : "Backup"}
          >
            {position.index === 0 ? "1 Primary" : `${position.index + 1} Backup`}
          </span>
        )}
        <AgentIcon kind={h.kind} className="size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{h.label}</span>
            {h.isBuiltin && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                built-in
              </span>
            )}
            {!h.enabled && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                disabled
              </span>
            )}
            {isExperimentalKind(h.kind) && (
              <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning">
                experimental
              </span>
            )}
            {status?.loggedIn === false && (
              <span
                className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning"
                title={status.authHelp ?? "Not logged in"}
              >
                not logged in
              </span>
            )}
            {position && (
              <span
                data-testid="harness-stack-chip"
                className="rounded border border-info/40 px-1.5 py-0.5 text-[10px] font-medium text-info"
                title="Harness account stack — fails over to the next account at its limit"
              >
                {position.text}
              </span>
            )}
            <span
              className={cn(
                "inline-block size-1.5 rounded-full",
                available ? "bg-success-solid" : "bg-danger-solid",
              )}
              title={status?.reason ?? status?.path ?? ""}
            />
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {h.id} · {h.kind}
            {h.home && <> · HOME={abbreviateHome(h.home, homeDir)}</>}
            {status?.version && <> · {status.version}</>}
          </div>
          {status?.loggedIn === false && status.authHelp && (
            <div className="truncate text-[11px] text-warning" title={status.authHelp}>
              {status.authHelp}
            </div>
          )}
          {/* Neutral, non-blocking lines (D-16): a missing login or
              an available upgrade never stops a run. */}
          {status?.notices?.map((notice) => (
            <div
              key={notice}
              data-testid="harness-status-notice"
              className="text-[11px] text-muted-foreground"
            >
              {notice}
            </div>
          ))}
        </div>
        <Switch
          checked={pendingEnabled ?? h.enabled}
          onCheckedChange={() => props.onToggleEnabled(h)}
          aria-label={h.enabled ? `Disable ${h.label}` : `Enable ${h.label}`}
        />
        {/* claude-code only: no other kind has a local usage source
            wired yet, and the route 400s for them. */}
        {h.kind === "claude-code" && (
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setUsageOpen((v) => !v)}
            aria-label={`${usageOpen ? "Hide" : "Show"} token usage for ${h.label}`}
            aria-expanded={usageOpen}
            title="Token usage — this account's local 30-day rollup"
          >
            <BarChart3 className="size-4" />
          </Button>
        )}
        {props.restorable && (
          <Button
            size="icon"
            variant="ghost"
            data-testid="harness-mirror-restore"
            onClick={() => props.onRestore(h)}
            aria-label={`Restore pre-stack config for ${h.label}`}
            title="Restore pre-stack config — put back what a stack mirror replaced"
          >
            <RotateCcw className="size-4" />
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          onClick={() => props.onOpenTerminal(h)}
          aria-label={`Open ${h.label} in Terminal`}
          title="Open in Terminal — load this harness's env to log in or inspect it"
        >
          <Terminal className="size-4" />
        </Button>
        {!h.isBuiltin && (
          <>
            <Button size="sm" variant="ghost" onClick={() => props.onEdit(h)} aria-label={`Edit ${h.label}`}>
              Edit
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => props.onDelete(h)}
              aria-label={`Delete ${h.label}`}
            >
              <Trash2 className="size-4" />
            </Button>
          </>
        )}
      </div>
      {showQuota && (
        <div className={cn(position && "pl-16")}>
          <StackQuotaMeter quota={quota} now={now} />
        </div>
      )}
      {chips.length > 0 && (
        <div className={cn("space-y-1", position && "pl-16")}>
          {chips.map((c) => (
            <div key={c.key} className="flex items-center gap-2">
              <span
                data-testid="harness-cooling-chip"
                role="note"
                aria-label={c.ariaLabel}
                title={c.message ?? undefined}
                className="shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning"
              >
                {c.text}
              </span>
              {/* Provider text: third-party data, rendered as plain text. */}
              {c.message && (
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={c.message}>
                  {c.message}
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                data-testid="harness-cooldown-clear"
                aria-label={`Clear cooldown on ${h.label}${c.model ? ` for ${c.model}` : ""}`}
                onClick={() => props.onClearCooldown(h, c.model)}
              >
                Clear
              </Button>
            </div>
          ))}
        </div>
      )}
      {h.kind === "fx" && (
        <div className="flex items-start gap-2 pl-6">
          <div className="min-w-0 flex-1">
            <div className="text-xs">Load profile MCP servers</div>
            <div className="text-[11px] text-muted-foreground">
              Loads the MCP servers from your own fx profile into each
              task's session (fx 0.0.13 or later).
            </div>
          </div>
          <Switch
            data-testid="harness-profile-mcp-toggle"
            checked={pendingProfileMcp ?? h.profileMcpServers !== false}
            onCheckedChange={(next) => props.onToggleProfileMcp(h, next)}
            aria-label={`Load profile MCP servers for ${h.label}`}
          />
        </div>
      )}
      {h.kind === "fx" && status?.fxProfilePermissionMode === "ask" && (
        <div
          data-testid="harness-fx-ask-hint"
          className="pl-6 text-[11px] text-muted-foreground"
        >
          fx's own profile starts in Ask mode. Agetor sets each task's
          mode itself; to change fx's default, run{" "}
          <code className="rounded bg-muted px-1">/permissions</code> inside fx.
        </div>
      )}
      {usageOpen && <AccountUsageTable harnessId={h.id} />}
    </div>
  );
}

/**
 * Per-day, per-model token rollup for one harness's account — fetched on
 * expand, not with the list, since the scan behind it stats every transcript
 * file. Numbers come from the account's local JSONL history, so they include
 * CLI sessions outside agetor (the budget shown is the account's).
 */
function AccountUsageTable({ harnessId }: { harnessId: string }) {
  const [days, setDays] = useState<AccountUsageDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDays(null);
    setError(null);
    api.getAccountUsage(harnessId)
      .then((p) => { if (!cancelled) setDays(p.days); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [harnessId]);

  if (error) {
    return <p className="px-1 text-[11px] text-danger">{error}</p>;
  }
  if (days === null) {
    return <p className="px-1 text-[11px] text-muted-foreground">Loading usage…</p>;
  }
  if (days.length === 0) {
    return (
      <p className="px-1 text-[11px] text-muted-foreground">
        No local usage history for this account (last 30 days).
      </p>
    );
  }
  return (
    <div className="max-h-48 overflow-auto rounded-md border border-border/40 bg-muted/20">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-muted/80 text-muted-foreground">
          <tr>
            <th className="px-2 py-1 text-left font-medium">Day</th>
            <th className="px-2 py-1 text-left font-medium">Model</th>
            <th className="px-2 py-1 text-right font-medium">In</th>
            <th className="px-2 py-1 text-right font-medium">Out</th>
            <th className="px-2 py-1 text-right font-medium">Cache w/r</th>
            <th className="px-2 py-1 text-right font-medium">Msgs</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={`${d.day}:${d.model}`} className="border-t border-border/30">
              <td className="px-2 py-1 font-mono">{d.day}</td>
              <td className="max-w-40 truncate px-2 py-1">{d.model}</td>
              <td className="px-2 py-1 text-right font-mono">{formatTokens(d.inputTokens)}</td>
              <td className="px-2 py-1 text-right font-mono">{formatTokens(d.outputTokens)}</td>
              <td className="px-2 py-1 text-right font-mono">
                {formatTokens(d.cacheWriteTokens)}/{formatTokens(d.cacheReadTokens)}
              </td>
              <td className="px-2 py-1 text-right font-mono">{d.messageCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

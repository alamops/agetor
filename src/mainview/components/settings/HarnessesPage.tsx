import { useEffect, useMemo, useState } from "react";
import { Layers, Plus } from "lucide-react";
import type { HarnessesPayload } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { stackPositionFor } from "@/lib/stack-badge";
import { cooldownChips, groupHarnesses } from "@/lib/stack-editor";
import { AccountRow } from "@/components/settings/HarnessAccountRow";
import { HarnessStackCard } from "@/components/settings/HarnessStackCard";
import type { Harness, HarnessQuota, HarnessStack } from "../../../shared/types.ts";

interface Props {
  payload: HarnessesPayload;
  statusByHarness: Map<string, HarnessesPayload["statuses"][number]>;
  homeDir: string;
  /** False while `dataDir` is still loading from `GET /defaults`. Adding a
   *  harness with an unresolved data dir would persist a broken HOME path
   *  (`/harnesses/claude-2` instead of `<dataDir>/harnesses/claude-2`). */
  canAdd: boolean;
  /** The App-level quota map (kept live by the `harness_usage` event). */
  usage: Record<string, HarnessQuota>;
  onAdd: () => void;
  onNewStack: () => void;
  onEditStack: (id: string) => void;
  onStackHistory: (id: string) => void;
  onDeleteStack: (stack: HarnessStack) => void;
  deletingStackId: string | null;
  onEdit: (h: Harness) => void;
  onDelete: (h: Harness) => void;
  onToggleEnabled: (h: Harness) => void;
  /** Open a new Terminal.app window with this harness's env loaded so the
   *  user can authenticate or inspect it (e.g. `claude /login`). */
  onOpenTerminal: (h: Harness) => void;
  /** Optimistic toggle state — keyed by harness id, value is what the user
   *  clicked toward. Missing keys mean "use the server's `h.enabled`". */
  pendingToggle: Record<string, boolean>;
  /** fx only: flip `profileMcpServers` (PATCH, optimistic). */
  onToggleProfileMcp: (h: Harness, next: boolean) => void;
  /** Optimistic `profileMcpServers` values, keyed by harness id. */
  pendingProfileMcp: Record<string, boolean>;
  onClearCooldown: (h: Harness, model: string | null) => void;
  onRestore: (h: Harness) => void;
}

/**
 * Settings → Harnesses: a toolbar, one card per stack (its accounts in
 * order), then the accounts that are in no stack. Every account row is the
 * same component in both places.
 */
export function HarnessesPage(props: Props) {
  const { payload, statusByHarness, usage } = props;
  const mirrorRestorable = useMemo(() => new Set(payload.mirrorRestorable ?? []), [payload.mirrorRestorable]);
  const stacks = payload.stacks ?? [];
  const limitStates = payload.limitStates ?? [];
  // Cooldown expiry and quota staleness are time-based; a slow tick keeps the
  // chips and the "stale" label honest without any new event stream.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const { stackGroups, others } = useMemo(
    () => groupHarnesses(payload.harnesses, stacks),
    [payload.harnesses, stacks],
  );

  const renderRow = (h: Harness, stacked: boolean) => {
    // `stackPositionFor` owns the "fewer than two members, no chip" rule.
    const at = stackPositionFor(stacks, h.id);
    return (
      <AccountRow
        key={h.id}
        harness={h}
        status={statusByHarness.get(h.id)}
        homeDir={props.homeDir}
        position={at ? { text: at.text, index: at.position - 1 } : null}
        showQuota={stacked && at !== null}
        quota={usage[h.id]}
        now={now}
        chips={cooldownChips(limitStates, h.id, now)}
        pendingEnabled={props.pendingToggle[h.id]}
        pendingProfileMcp={props.pendingProfileMcp[h.id]}
        onEdit={props.onEdit}
        onDelete={props.onDelete}
        onToggleEnabled={props.onToggleEnabled}
        onOpenTerminal={props.onOpenTerminal}
        onToggleProfileMcp={props.onToggleProfileMcp}
        onClearCooldown={props.onClearCooldown}
        onRestore={props.onRestore}
        restorable={mirrorRestorable.has(h.id)}
      />
    );
  };

  return (
    <div className="space-y-4 pt-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <label className="text-xs text-muted-foreground">Harnesses</label>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={props.onAdd}
            disabled={!props.canAdd}
            title={props.canAdd ? undefined : "Loading defaults…"}
          >
            <Plus className="mr-1 size-3.5" /> Add harness
          </Button>
          <Button variant="outline" size="sm" onClick={props.onNewStack}>
            <Layers className="mr-1 size-3.5" /> New stack
          </Button>
        </div>
      </div>

      <section className="space-y-2" data-testid="harness-stacks-section" aria-label="Account stacks">
        {stackGroups.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No stacks yet. Stack two or more accounts of the same harness: at its limit, a task continues on the
            next account with the same conversation, tools and settings. Stacks are machine-local.
          </p>
        ) : (
          <ul className="space-y-2">
            {stackGroups.map(({ stack, members }) => (
              <HarnessStackCard
                key={stack.id}
                stack={stack}
                members={members}
                deleting={props.deletingStackId === stack.id}
                onHistory={props.onStackHistory}
                onEdit={props.onEditStack}
                onDelete={props.onDeleteStack}
                renderMember={(h) => renderRow(h, true)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        {stackGroups.length > 0 && <p className="text-xs text-muted-foreground">Other accounts</p>}
        <div className="space-y-1.5">{others.map((h) => renderRow(h, false))}</div>
      </section>
    </div>
  );
}

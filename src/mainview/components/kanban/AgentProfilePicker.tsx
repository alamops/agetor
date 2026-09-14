import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IDENTIFIER_INPUT_PROPS } from "@/lib/identifier-input";
import { filterAgentProfiles } from "@/lib/agent-profiles";
import { cn } from "@/lib/utils";
import type { AgentProfile, Harness } from "../../../shared/types.ts";
import { AgentProfileCard } from "./AgentProfileCard";

interface AgentProfilePickerProps {
  /** Selected profile id, or `null` for "No agent — pick harness manually". */
  value: string | null;
  onChange: (id: string | null) => void;
  profiles: AgentProfile[];
  /** Live harness rows — resolves each profile's icon/label in the popover
   *  rows and the trigger's selected-chip display. */
  harnesses: Harness[];
  /** Renders a "Manage agents…" footer row that calls back instead of
   *  picking anything; omit to hide the footer entirely. */
  onManage?: () => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Controlled agent-profile picker: a trigger button (the selected profile's
 * chip, or the "No agent" placeholder) plus a searchable popover of every
 * profile. Picking one is the launch form's "one selection" — the caller is
 * expected to hide its manual harness/mode/model/effort block once `value`
 * is non-null (see plan D5). A profile can be cleared either from the
 * popover's "No agent" row or the trigger-adjacent `×` control.
 */
export function AgentProfilePicker({
  value,
  onChange,
  profiles,
  harnesses,
  onManage,
  disabled,
  className,
}: AgentProfilePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // 0 = the "No agent" row; 1..n = `filtered[i - 1]`.
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Consume Escape before an enclosing Dialog's own handler — see the
      // `data-popover-open` contract (CLAUDE.md UI conventions / arch item 11).
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const filtered = useMemo(() => filterAgentProfiles(profiles, query), [profiles, query]);
  const rowCount = filtered.length + 1;

  // Reset the highlight whenever the candidate rows change identity — see
  // the "reset active row on the rows ARRAY's identity" rule (CLAUDE.md
  // architecture item 12). `filtered` already changes identity on every
  // `query`/`profiles` change, so depending on it alone is sufficient.
  useEffect(() => {
    setActive(0);
  }, [filtered]);

  const selectedProfile = value ? (profiles.find((p) => p.id === value) ?? null) : null;

  const pick = (id: string | null) => {
    onChange(id);
    setOpen(false);
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % rowCount);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + rowCount) % rowCount);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active === 0) {
        pick(null);
      } else {
        const p = filtered[active - 1];
        if (p) pick(p.id);
      }
    }
  };

  return (
    <div ref={rootRef} data-testid="agent-profile-picker" className={cn("relative", className)}>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          data-testid="agent-profile-picker-trigger"
          onClick={() => setOpen((o) => !o)}
          className="h-auto min-h-9 w-full min-w-0 flex-1 justify-between px-3 py-1.5 text-left font-normal"
        >
          {selectedProfile ? (
            <AgentProfileCard
              profile={selectedProfile}
              harnesses={harnesses}
              variant="chip"
              className="min-w-0 border-0 bg-transparent px-0 py-0"
            />
          ) : value ? (
            <span className="flex min-w-0 items-center gap-1.5 text-warning">
              <Bot className="size-4 shrink-0" aria-hidden />
              <span className="truncate">Selected agent is no longer available</span>
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <Bot className="size-4 shrink-0" aria-hidden />
              <span className="truncate">No agent — pick harness manually</span>
            </span>
          )}
          <ChevronDown
            className={cn("size-4 shrink-0 opacity-60 transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </Button>
        {value && (
          <button
            type="button"
            data-testid="agent-profile-picker-clear"
            onClick={() => onChange(null)}
            disabled={disabled}
            title="Clear agent"
            className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent/40 hover:text-foreground disabled:opacity-50"
          >
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>

      {open && (
        <div
          data-popover-open=""
          data-testid="agent-profile-picker-popover"
          className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-border bg-card text-card-foreground shadow-xl"
        >
          <div className="border-b border-border/60 p-1.5">
            <Input
              ref={searchRef}
              {...IDENTIFIER_INPUT_PROPS}
              data-testid="agent-profile-picker-search"
              role="combobox"
              aria-expanded={open}
              aria-haspopup="listbox"
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-activedescendant={`${listboxId}-option-${active}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search agents…"
              className="h-7 border-0 px-0 shadow-none focus-visible:ring-0"
            />
          </div>
          <div id={listboxId} role="listbox" className="max-h-72 overflow-y-auto py-1">
            <button
              type="button"
              id={`${listboxId}-option-0`}
              role="option"
              aria-selected={active === 0}
              data-testid="agent-profile-picker-none"
              onMouseDown={(e) => {
                e.preventDefault();
                pick(null);
              }}
              onMouseEnter={() => setActive(0)}
              className={cn(
                "flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-sm text-muted-foreground",
                active === 0 ? "bg-accent text-accent-foreground" : "hover:bg-accent/40",
              )}
            >
              <Bot className="size-4 shrink-0" aria-hidden />
              No agent — pick harness manually
            </button>

            {profiles.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">No agents yet.</p>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">No matches.</p>
            ) : (
              filtered.map((p, i) => {
                const idx = i + 1;
                return (
                  <button
                    key={p.id}
                    id={`${listboxId}-option-${idx}`}
                    type="button"
                    role="option"
                    aria-selected={idx === active}
                    data-testid="agent-profile-picker-row"
                    data-profile-id={p.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(p.id);
                    }}
                    onMouseEnter={() => setActive(idx)}
                    className={cn(
                      "flex w-full items-start px-3 py-1.5 text-left",
                      idx === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/40",
                    )}
                  >
                    <AgentProfileCard profile={p} harnesses={harnesses} variant="row" className="min-w-0 flex-1" />
                  </button>
                );
              })
            )}
          </div>
          {onManage && (
            <div className="border-t border-border/60">
              <button
                type="button"
                data-testid="agent-profile-picker-manage"
                onClick={() => {
                  setOpen(false);
                  onManage();
                }}
                className="w-full px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground"
              >
                Manage agents…
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Workflow, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IDENTIFIER_INPUT_PROPS } from "@/lib/identifier-input";
import { cn } from "@/lib/utils";
import type { Pipeline } from "../../../shared/types.ts";

interface PipelinePickerProps {
  /** Selected pipeline id, or `null` for "No pipeline". */
  value: string | null;
  onChange: (id: string | null) => void;
  pipelines: Pipeline[];
  /** Renders a "Manage pipelines…" footer row; omit to hide it. */
  onManage?: () => void;
  disabled?: boolean;
  className?: string;
}

function filterPipelines(list: Pipeline[], query: string): Pipeline[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
}

/**
 * Controlled pipeline picker — a trigger button (the selected pipeline's
 * name, or the "No pipeline" placeholder) plus a searchable popover of
 * every pipeline, mirroring {@link AgentProfilePicker}'s structure/markers
 * (`data-popover-open`, Escape-closes, roving keyboard focus). Picking a
 * pipeline is `NewTaskForm`'s "one selection" replacement for the manual
 * agent picker (D1, `docs/plans/pipelines.md`).
 */
export function PipelinePicker({ value, onChange, pipelines, onManage, disabled, className }: PipelinePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // 0 = the "No pipeline" row; 1..n = `filtered[i - 1]`.
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

  const filtered = useMemo(() => filterPipelines(pipelines, query), [pipelines, query]);
  const rowCount = filtered.length + 1;

  useEffect(() => {
    setActive(0);
  }, [filtered]);

  const selectedPipeline = value ? (pipelines.find((p) => p.id === value) ?? null) : null;

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
    <div ref={rootRef} data-testid="pipeline-picker" className={cn("relative", className)}>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          data-testid="pipeline-picker-trigger"
          onClick={() => setOpen((o) => !o)}
          className="h-auto min-h-9 w-full min-w-0 flex-1 justify-between px-3 py-1.5 text-left font-normal"
        >
          {selectedPipeline ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <Workflow className="size-4 shrink-0 text-info" aria-hidden />
              <span className="truncate">{selectedPipeline.name}</span>
            </span>
          ) : value ? (
            <span className="flex min-w-0 items-center gap-1.5 text-warning">
              <Workflow className="size-4 shrink-0" aria-hidden />
              <span className="truncate">Selected pipeline is no longer available</span>
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <Workflow className="size-4 shrink-0" aria-hidden />
              <span className="truncate">No pipeline</span>
            </span>
          )}
          <ChevronDown className={cn("size-4 shrink-0 opacity-60 transition-transform", open && "rotate-180")} aria-hidden />
        </Button>
        {value && (
          <button
            type="button"
            data-testid="pipeline-picker-clear"
            onClick={() => onChange(null)}
            disabled={disabled}
            title="Clear pipeline"
            className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent/40 hover:text-foreground disabled:opacity-50"
          >
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>

      {open && (
        <div
          data-popover-open=""
          data-testid="pipeline-picker-popover"
          className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-border bg-card text-card-foreground shadow-xl"
        >
          <div className="border-b border-border/60 p-1.5">
            <Input
              ref={searchRef}
              {...IDENTIFIER_INPUT_PROPS}
              data-testid="pipeline-picker-search"
              role="combobox"
              aria-expanded={open}
              aria-haspopup="listbox"
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-activedescendant={`${listboxId}-option-${active}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search pipelines…"
              className="h-7 border-0 px-0 shadow-none focus-visible:ring-0"
            />
          </div>
          <div id={listboxId} role="listbox" className="max-h-72 overflow-y-auto py-1">
            <button
              type="button"
              id={`${listboxId}-option-0`}
              role="option"
              aria-selected={active === 0}
              data-testid="pipeline-picker-none"
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
              <Workflow className="size-4 shrink-0" aria-hidden />
              No pipeline
            </button>

            {pipelines.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">No pipelines yet.</p>
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
                    data-testid="pipeline-picker-row"
                    data-pipeline-id={p.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(p.id);
                    }}
                    onMouseEnter={() => setActive(idx)}
                    className={cn(
                      "flex w-full items-start gap-1.5 px-3 py-1.5 text-left",
                      idx === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/40",
                    )}
                  >
                    <Workflow className="mt-0.5 size-3.5 shrink-0 text-info" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{p.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {p.graph.steps.length} step{p.graph.steps.length === 1 ? "" : "s"}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
          {onManage && (
            <div className="border-t border-border/60">
              <button
                type="button"
                data-testid="pipeline-picker-manage"
                onClick={() => {
                  setOpen(false);
                  onManage();
                }}
                className="w-full px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground"
              >
                Manage pipelines…
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

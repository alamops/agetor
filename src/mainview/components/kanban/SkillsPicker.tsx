import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { api, type AvailableExtension } from "@/lib/api";
import { IDENTIFIER_INPUT_PROPS } from "@/lib/identifier-input";
import { cn } from "@/lib/utils";
import { AGENT_PROFILE_LIMITS, normalizeSkillName } from "../../../shared/agent-profile.ts";

// Per-harness-id suggestion cache, module-level so switching tabs or
// remounting the profile form doesn't re-walk the harness's skill/plugin
// dirs on every mount — same rationale as `useAgentProfiles`'s cache.
const suggestionCache = new Map<string, AvailableExtension[]>();
const suggestionInFlight = new Map<string, Promise<AvailableExtension[]>>();

async function fetchSkillSuggestions(harnessId: string): Promise<AvailableExtension[]> {
  const cached = suggestionCache.get(harnessId);
  if (cached) return cached;
  let inFlight = suggestionInFlight.get(harnessId);
  if (!inFlight) {
    inFlight = api
      .listAgentCapabilities({ agent: harnessId })
      .then(({ extensions }) => extensions.filter((e) => e.kind === "skill"))
      // A fetch failure just means no suggestions — free text still works.
      .catch(() => [] as AvailableExtension[]);
    suggestionInFlight.set(harnessId, inFlight);
  }
  const result = await inFlight;
  suggestionCache.set(harnessId, result);
  suggestionInFlight.delete(harnessId);
  return result;
}

interface SkillsPickerProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** Harness id to fetch skill suggestions for (no workdir — see
   *  `listAgentCapabilities`, plan D8). `null` disables the fetch entirely;
   *  free-text entry keeps working regardless. */
  harnessId: string | null;
  disabled?: boolean;
  className?: string;
}

/**
 * Chip input for an {@link AgentProfile}'s `skills` list: type-to-filter
 * suggestions sourced from the harness's user-level skills/plugins (no
 * workdir — profiles are workdir-agnostic), free text always accepted.
 * Enter / Tab / `,` commits the highlighted suggestion when the popover is
 * showing one, else the typed text (normalized, deduped, capped at
 * {@link AGENT_PROFILE_LIMITS.skills}).
 */
export function SkillsPicker({ value, onChange, harnessId, disabled, className }: SkillsPickerProps) {
  const [inputValue, setInputValue] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [suggestions, setSuggestions] = useState<AvailableExtension[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!harnessId) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    void fetchSkillSuggestions(harnessId).then((rows) => {
      if (!cancelled) setSuggestions(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [harnessId]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const valueSet = useMemo(() => new Set(value), [value]);
  const filtered = useMemo(() => {
    const q = inputValue.trim().toLowerCase();
    return suggestions
      .filter((s) => !valueSet.has(s.name))
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }, [suggestions, inputValue, valueSet]);

  useEffect(() => {
    setActive(0);
  }, [inputValue, filtered.length]);

  const atLimit = value.length >= AGENT_PROFILE_LIMITS.skills;

  const commit = (raw: string) => {
    const name = normalizeSkillName(raw);
    if (!name || atLimit) return;
    if (!valueSet.has(name)) onChange([...value, name]);
    setInputValue("");
    setOpen(false);
  };

  const removeChip = (skill: string) => onChange(value.filter((s) => s !== skill));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (atLimit) {
      if (e.key === "Backspace" && inputValue.length === 0 && value.length > 0) {
        e.preventDefault();
        onChange(value.slice(0, -1));
      }
      return;
    }
    if (e.key === "ArrowDown" && filtered.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % filtered.length);
      return;
    }
    if (e.key === "ArrowUp" && filtered.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (i - 1 + filtered.length) % filtered.length);
      return;
    }
    if (e.key === "Enter" || e.key === "Tab" || e.key === ",") {
      const suggestion = filtered[active];
      const raw = suggestion ? suggestion.name : inputValue;
      const name = normalizeSkillName(raw);
      if (!name) return; // Nothing to commit — let Tab/Enter behave normally.
      e.preventDefault();
      commit(raw);
      return;
    }
    if (e.key === "Backspace" && inputValue.length === 0 && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
      return;
    }
    if (e.key === "Escape" && open) {
      // Close the suggestion list only — never the enclosing dialog.
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} data-testid="skills-picker" className={cn("relative", className)}>
      <div
        className={cn(
          "flex flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1.5",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        {value.map((skill) => (
          <span
            key={skill}
            data-testid="skills-picker-chip"
            data-skill={skill}
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-card px-1.5 py-0.5 font-mono text-[11px]"
          >
            <span className="truncate">/{skill}</span>
            <button
              type="button"
              data-testid="skills-picker-remove"
              onClick={() => removeChip(skill)}
              disabled={disabled}
              title="Remove"
              className="-mr-0.5 ml-0.5 rounded-sm p-0.5 text-muted-foreground hover:bg-accent/40 hover:text-foreground disabled:opacity-50"
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          {...IDENTIFIER_INPUT_PROPS}
          data-testid="skills-picker-input"
          value={inputValue}
          disabled={disabled || atLimit}
          onChange={(e) => {
            setInputValue(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
            if (harnessId) void fetchSkillSuggestions(harnessId).then(setSuggestions);
          }}
          onKeyDown={onKeyDown}
          placeholder={atLimit ? "" : "Add a skill…"}
          className="min-w-[8ch] flex-1 border-0 bg-transparent p-0.5 text-xs outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
      </div>
      {atLimit && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Maximum {AGENT_PROFILE_LIMITS.skills} skills reached.
        </p>
      )}
      {open && !atLimit && filtered.length > 0 && (
        <div
          data-popover-open=""
          data-popover-keys="escape-only"
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-card text-card-foreground shadow-xl"
        >
          {filtered.map((s, i) => (
            <button
              key={s.name}
              type="button"
              role="option"
              aria-selected={i === active}
              data-testid="skills-picker-row"
              data-skill={s.name}
              onMouseDown={(e) => {
                e.preventDefault();
                commit(s.name);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-xs",
                i === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/40",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="font-mono">/{s.name}</span>
                {s.description && (
                  <span className="mt-0.5 block truncate text-muted-foreground">{s.description}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

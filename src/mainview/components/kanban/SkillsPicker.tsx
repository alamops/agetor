import { useEffect, useId, useMemo, useRef, useState } from "react";
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
      .then((result) => {
        // Cache only on success — a failed fetch is never cached (matches
        // the repo-wide rule), so the next mount/focus retries instead of
        // being stuck on an empty suggestion list forever.
        suggestionCache.set(harnessId, result);
        return result;
      })
      // A fetch failure just means no suggestions this time — free text
      // still works.
      .catch(() => [] as AvailableExtension[])
      .finally(() => {
        suggestionInFlight.delete(harnessId);
      });
    suggestionInFlight.set(harnessId, inFlight);
  }
  return inFlight;
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
  // -1 = no row highlighted — Tab/Enter then commits the typed text, never a
  // suggestion the user never navigated to. Set >=0 only via ArrowUp/Down or
  // a row's `onMouseEnter`.
  const [active, setActive] = useState(-1);
  const [suggestions, setSuggestions] = useState<AvailableExtension[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

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
    // Document-level Escape (like `AgentProfilePicker`) so the popover
    // closes before an enclosing Dialog's own Escape handler ever sees the
    // key — see the `data-popover-open` contract (CLAUDE.md UI conventions
    // / architecture item 11).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const valueSet = useMemo(() => new Set(value), [value]);
  const filtered = useMemo(() => {
    const q = inputValue.trim().toLowerCase();
    return suggestions
      .filter((s) => !valueSet.has(s.name))
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }, [suggestions, inputValue, valueSet]);

  // Reset the highlight whenever the candidate rows change identity (a new
  // typed query, a fresh suggestion fetch, …) — see the "reset active row on
  // the rows ARRAY's identity" rule (CLAUDE.md architecture item 12).
  useEffect(() => {
    setActive(-1);
  }, [filtered]);

  const atLimit = value.length >= AGENT_PROFILE_LIMITS.skills;

  const commit = (raw: string) => {
    const name = normalizeSkillName(raw);
    if (!name || atLimit) return;
    if (!valueSet.has(name)) onChange([...value, name]);
    setInputValue("");
    setOpen(false);
    setActive(-1);
  };

  const removeChip = (skill: string) => onChange(value.filter((s) => s !== skill));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && filtered.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (i < 0 ? 0 : (i + 1) % filtered.length));
      return;
    }
    if (e.key === "ArrowUp" && filtered.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (i <= 0 ? filtered.length - 1 : i - 1));
      return;
    }
    if (e.key === "Enter" || e.key === "Tab" || e.key === ",") {
      // Shift+Tab must never commit — it's a backward focus move, not a
      // commit gesture, regardless of what's typed or highlighted.
      if (e.key === "Tab" && e.shiftKey) return;
      // A suggestion is used only when the popover is open AND the user
      // actually navigated to a row (active >= 0) — never the first
      // suggestion by default, and never a stale row from a dismissed list.
      const suggestion = open && active >= 0 ? filtered[active] : undefined;
      const raw = suggestion ? suggestion.name : inputValue;
      const name = normalizeSkillName(raw);
      // Nothing to commit — don't preventDefault, so Tab/Shift+Tab still
      // moves focus natively and Enter/`,` are no-ops.
      if (!name) return;
      e.preventDefault();
      commit(raw);
      return;
    }
    if (e.key === "Backspace" && inputValue.length === 0 && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  };

  const onRootBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
  };

  const activeOptionId = open && active >= 0 && filtered[active] ? `${listboxId}-option-${active}` : undefined;

  return (
    <div ref={rootRef} data-testid="skills-picker" className={cn("relative", className)} onBlur={onRootBlur}>
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
          role="combobox"
          aria-expanded={open && !atLimit && filtered.length > 0}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-activedescendant={activeOptionId}
          value={inputValue}
          disabled={disabled}
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
          id={listboxId}
          data-popover-open=""
          data-popover-keys="escape-only"
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-card text-card-foreground shadow-xl"
        >
          {filtered.map((s, i) => (
            <button
              key={s.name}
              id={`${listboxId}-option-${i}`}
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

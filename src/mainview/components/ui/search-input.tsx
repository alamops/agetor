import * as React from "react";
import { Search, X } from "lucide-react";
import { IDENTIFIER_INPUT_PROPS } from "@/lib/identifier-input";
import { cn } from "@/lib/utils";

export interface SearchInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> {
  value: string;
  onValueChange: (next: string) => void;
  /** `data-testid` on the `<input>`; the clear button gets `<testId>-clear`. */
  testId?: string;
  /** Extra classes on the bordered wrapper. */
  wrapperClassName?: string;
}

/**
 * A search box: magnifier, text field and a clear (×) button that shows only
 * while there is text. Clearing empties the field and puts focus back in it,
 * so the full list is one click away.
 */
export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  ({ value, onValueChange, testId, wrapperClassName, className, "aria-label": ariaLabel, ...props }, ref) => {
    const innerRef = React.useRef<HTMLInputElement>(null);
    React.useImperativeHandle(ref, () => innerRef.current as HTMLInputElement);
    return (
      <div
        className={cn(
          "flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 focus-within:ring-1 focus-within:ring-ring",
          wrapperClassName,
        )}
      >
        <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <input
          ref={innerRef}
          type="text"
          data-testid={testId}
          {...IDENTIFIER_INPUT_PROPS}
          {...props}
          aria-label={ariaLabel}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          className={cn(
            "h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        />
        {value ? (
          <button
            type="button"
            data-testid={testId ? `${testId}-clear` : undefined}
            aria-label="Clear search"
            title="Clear search"
            onClick={() => {
              onValueChange("");
              innerRef.current?.focus();
            }}
            className="-mr-1.5 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
    );
  },
);
SearchInput.displayName = "SearchInput";

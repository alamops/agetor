import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Form-field primitives for the task-launch surfaces
 * (docs/architecture/task-launch-ui.md): a `Field` owns an id, a description id
 * and an error id; its `FieldLabel` points at the control through `htmlFor`,
 * and the control reads `useFieldControl()` to take the id and the
 * `aria-describedby` / `aria-invalid` wiring. Every control gets a real
 * `<label>` this way, so `getByLabel` and screen readers resolve it.
 */

interface FieldContextValue {
  id: string;
  descriptionId: string;
  errorId: string;
  invalid: boolean;
}

const FieldContext = React.createContext<FieldContextValue | null>(null);

export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Marks the control `aria-invalid` and points `aria-describedby` at the error. */
  invalid?: boolean;
  /** Use a caller-chosen control id instead of a generated one. */
  controlId?: string;
}

export function Field({ className, invalid = false, controlId, children, ...props }: FieldProps) {
  const generated = React.useId();
  const id = controlId ?? `field-${generated}`;
  const value = React.useMemo<FieldContextValue>(
    () => ({ id, descriptionId: `${id}-description`, errorId: `${id}-error`, invalid }),
    [id, invalid],
  );
  return (
    <FieldContext.Provider value={value}>
      <div className={cn("space-y-1.5", className)} {...props}>
        {children}
      </div>
    </FieldContext.Provider>
  );
}

/** What a control inside a `Field` spreads onto itself. */
export function useFieldControl(): {
  id: string | undefined;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
} {
  const ctx = React.useContext(FieldContext);
  if (!ctx) return { id: undefined, "aria-describedby": undefined, "aria-invalid": undefined };
  return {
    id: ctx.id,
    "aria-describedby": ctx.invalid ? `${ctx.descriptionId} ${ctx.errorId}` : ctx.descriptionId,
    "aria-invalid": ctx.invalid ? true : undefined,
  };
}

const LABEL_CLASS = "text-xs font-medium text-muted-foreground";

/** A standalone `<label>` (no `Field` needed). */
export const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => <label ref={ref} className={cn(LABEL_CLASS, className)} {...props} />,
);
Label.displayName = "Label";

/** The label of the enclosing `Field`: `htmlFor` is the field's control id. */
export const FieldLabel = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, htmlFor, ...props }, ref) => {
    const ctx = React.useContext(FieldContext);
    return <label ref={ref} htmlFor={htmlFor ?? ctx?.id} className={cn(LABEL_CLASS, className)} {...props} />;
  },
);
FieldLabel.displayName = "FieldLabel";

export function FieldDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  const ctx = React.useContext(FieldContext);
  return <p id={ctx?.descriptionId} className={cn("text-2xs text-muted-foreground", className)} {...props} />;
}

export function FieldError({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  const ctx = React.useContext(FieldContext);
  return <p id={ctx?.errorId} role="alert" className={cn("text-2xs text-danger", className)} {...props} />;
}

/** A labelled group of related controls (a radiogroup's wrapper, a set of toggles). */
export function FieldGroup({
  className,
  "aria-labelledby": labelledBy,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { "aria-labelledby"?: string }) {
  return <div role="group" aria-labelledby={labelledBy} className={cn("space-y-1.5", className)} {...props} />;
}

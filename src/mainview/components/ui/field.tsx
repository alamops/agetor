import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Form-field primitives for the task-launch surfaces
 * (docs/architecture/task-launch-ui.md): a `Field` owns a control id and a
 * description id. Its `FieldLabel` points at the control through `htmlFor`
 * (every control gets a real `<label>`, so `getByLabel` and screen readers
 * resolve it), and its `FieldDescription` carries `<controlId>-description`,
 * which the control names in its own `aria-describedby`. A caller that has no
 * generated id passes `controlId` and builds the same suffix.
 */

interface FieldContextValue {
  id: string;
  descriptionId: string;
}

const FieldContext = React.createContext<FieldContextValue | null>(null);

export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Use a caller-chosen control id instead of a generated one. */
  controlId?: string;
}

/** The id a `Field` with this control id gives its `FieldDescription`. */
export const fieldDescriptionId = (controlId: string): string => `${controlId}-description`;

export function Field({ className, controlId, children, ...props }: FieldProps) {
  const generated = React.useId();
  const id = controlId ?? `field-${generated}`;
  const value = React.useMemo<FieldContextValue>(() => ({ id, descriptionId: fieldDescriptionId(id) }), [id]);
  return (
    <FieldContext.Provider value={value}>
      <div className={cn("space-y-1.5", className)} {...props}>
        {children}
      </div>
    </FieldContext.Provider>
  );
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

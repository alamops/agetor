import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// `disabled` drops pointer events outright; an `aria-disabled` button keeps
// them (its own click guard and `cursor-not-allowed` need them), so each
// variant pins its hover background back to its resting one instead. (The
// accent text colour is left alone: it matches the foreground, and pinning
// it would fight a caller's own text colour.)
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90 aria-disabled:hover:bg-primary",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 aria-disabled:hover:bg-destructive",
        outline:
          "border border-input bg-background hover:bg-accent hover:text-accent-foreground aria-disabled:hover:bg-background",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-disabled:hover:bg-secondary",
        ghost: "hover:bg-accent hover:text-accent-foreground aria-disabled:hover:bg-transparent",
        link: "text-primary underline-offset-4 hover:underline aria-disabled:hover:no-underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = "Button";

export { buttonVariants };

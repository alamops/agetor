/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  // `src/shared/**/*.ts` is included so Tailwind's JIT picks up class-name
  // literals defined in shared metadata (e.g. TASK_TYPES' `iconClass` /
  // `borderClass`). Without it the JIT scan misses them and the colors
  // get purged from the bundle.
  content: [
    "./src/mainview/**/*.{html,js,ts,jsx,tsx}",
    "./src/shared/**/*.ts",
  ],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
        },
        danger: {
          DEFAULT: "hsl(var(--danger))",
          foreground: "hsl(var(--danger-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        geist: ['"Geist Variable"', "ui-sans-serif", "system-ui", "sans-serif"],
      },
      keyframes: {
        // Slower, calmer than tailwind's default `pulse` — used by TaskCard
        // to indicate "this card is waiting on you" without feeling anxious.
        // Pulses `filter: drop-shadow` rather than `box-shadow` so it stacks
        // cleanly on top of Tailwind's `ring-*` utilities (which themselves
        // compile to box-shadow and would otherwise be clobbered).
        "awaiting-pulse": {
          "0%, 100%": { filter: "drop-shadow(0 0 6px rgba(245, 158, 11, 0.55))" },
          "50%":      { filter: "drop-shadow(0 0 14px rgba(245, 158, 11, 0.85))" },
        },
      },
      animation: {
        "awaiting-pulse": "awaiting-pulse 2.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

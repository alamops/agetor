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
        merged: {
          DEFAULT: "hsl(var(--merged))",
          foreground: "hsl(var(--merged-foreground))",
        },
        spike: {
          DEFAULT: "hsl(var(--spike))",
          foreground: "hsl(var(--spike-foreground))",
        },
        "success-solid": "hsl(var(--success-solid))",
        "danger-solid": "hsl(var(--danger-solid))",
        "warning-solid": "hsl(var(--warning-solid))",
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
        // Slower, calmer than tailwind's default `pulse` — used by TaskCard's
        // awaiting-glow overlay to indicate "this card is waiting on you"
        // without feeling anxious. Animates OPACITY only (compositor-friendly:
        // no per-frame repaint) — the glow itself is a static box-shadow on a
        // dedicated overlay element (see TaskCard), which is also what keeps
        // it from clobbering Tailwind's `ring-*` box-shadow on the card.
        "awaiting-pulse": {
          "0%, 100%": { opacity: "0.45" },
          "50%":      { opacity: "1" },
        },
      },
      animation: {
        "awaiting-pulse": "awaiting-pulse 2.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

import type { Config } from "tailwindcss";

/**
 * HAYEK design direction: instrument panel / ledger / archive.
 * Dark, dense, monospace numerals, hairline borders. Two semantic accents:
 * `pass` (green) and `fail` (amber-red). No gradients.
 */
const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        panel: "hsl(var(--panel))",
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        pass: "hsl(var(--pass))",
        fail: "hsl(var(--fail))",
      },
      fontFamily: {
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      borderColor: {
        DEFAULT: "hsl(var(--border))",
      },
    },
  },
  plugins: [],
};

export default config;

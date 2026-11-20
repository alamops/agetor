// Async-correctness gate only: no recommended presets, three typed rules.
// A forgotten `await` on a Promise is silently truthy, which tsc cannot catch.
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/vendor/**",
      "**/build/**",
      "**/dist/**",
      "src/mainview/**",
    ],
  },
  {
    files: ["src/bun/**/*.ts", "src/cli/**/*.{ts,tsx}", "src/shared/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    // Some TUI files carry `eslint-disable react-hooks/exhaustive-deps`
    // comments; a no-op rule definition keeps them from being reported as
    // "definition not found" errors in this async-only gate.
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "react-hooks": { rules: { "exhaustive-deps": { meta: { schema: [] }, create: () => ({}) } } },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksConditionals: true, checksVoidReturn: false },
      ],
      "@typescript-eslint/await-thenable": "error",
    },
  },
];

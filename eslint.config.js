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
        {
          checksConditionals: true,
          // Catches forEach(async…), setTimeout(async…), .on(…, async…).
          // Other void-return sites (attributes, properties, returns,
          // variables) stay off: too noisy for the async-correctness gate.
          checksVoidReturn: { arguments: true, attributes: false, properties: false, returns: false, variables: false },
        },
      ],
      // Only object-ish values (Promises included) are flagged in templates.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true, allowNullish: true, allowAny: true, allowNever: true, allowRegExp: true },
      ],
      "@typescript-eslint/await-thenable": "error",
    },
  },
  {
    // bun:test types `expect(p).resolves.*` and `.rejects.*` matchers as
    // returning `void`, though at runtime they return a Promise. So in test files
    // `await expect(p).rejects.toThrow()` is a false `await-thenable` positive
    // (382 of them), and an un-awaited one is invisible to `no-floating-promises`
    // (a test that passes without ever checking the assertion). This block turns
    // the first rule off for tests and replaces the lost coverage with a syntax
    // rule that fails any `.resolves` / `.rejects` matcher used as a bare
    // statement, i.e. not awaited and not returned.
    files: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    rules: {
      "@typescript-eslint/await-thenable": "off",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ExpressionStatement > CallExpression[callee.object.property.name=/^(resolves|rejects)$/], " +
            "ExpressionStatement > CallExpression[callee.object.object.property.name=/^(resolves|rejects)$/]",
          message: "`expect(...).resolves/.rejects` returns a Promise: `await` it (or return it), or the assertion never runs.",
        },
      ],
    },
  },
];

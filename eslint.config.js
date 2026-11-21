// Async-correctness gate only: no recommended presets, three typed rules.
// A forgotten `await` on a Promise is silently truthy, which tsc cannot catch.
import tseslint from "typescript-eslint";

/** The Promise-returning matcher names bun:test types as `void`. */
const MATCHER_PROP = /^(resolves|rejects)$/;

function matcherName(member) {
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  if (member.computed && member.property.type === "Literal" && typeof member.property.value === "string") return member.property.value;
  return null;
}

/** Whether the value of `node` reaches an `await` or a `return`: directly, through
 *  a transparent wrapper (parentheses, `as`, `!`, `?:`, `&&`/`||`/`??`), as the
 *  concise body of an arrow, or as an element of an array handed to `Promise.all`
 *  and friends whose own value is consumed. */
function isConsumed(node) {
  const parent = node.parent;
  if (!parent) return false;
  switch (parent.type) {
    case "AwaitExpression":
    case "ReturnStatement":
      return true;
    case "ArrowFunctionExpression": {
      if (parent.body !== node) return false;
      // `xs.forEach((x) => expect(x).rejects…)` returns the Promise to forEach, which drops it.
      const call = parent.parent;
      const callee = call?.type === "CallExpression" ? call.callee : null;
      return !(callee?.type === "MemberExpression" && !callee.computed && callee.property.name === "forEach");
    }
    case "TSAsExpression":
    case "TSNonNullExpression":
    case "TSSatisfiesExpression":
    case "ChainExpression":
    case "ConditionalExpression":
    case "LogicalExpression":
      return parent.type === "ConditionalExpression" && parent.test === node ? false : isConsumed(parent);
    case "ArrayExpression": {
      const call = parent.parent;
      return call?.type === "CallExpression" && call.arguments.includes(parent)
        && call.callee.type === "MemberExpression"
        && call.callee.object.type === "Identifier" && call.callee.object.name === "Promise"
        && isConsumed(call);
    }
    default:
      return false;
  }
}

// A local rule: bun:test's `expect(p).resolves.x()` / `.rejects.x()` return a
// Promise at runtime but are typed `void`, so `no-floating-promises` cannot see
// a forgotten `await`, and a selector cannot say "not awaited". This rule flags
// every `.resolves` / `.rejects` (computed form included) whose whole matcher
// chain is not awaited or returned, whatever wraps it (`void`, `cond && …`, an
// assignment, a `forEach` callback body, a trailing `.catch(…)`).
const localPlugin = {
  rules: {
    "await-matcher": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          unawaited: "`expect(...).resolves/.rejects` returns a Promise: `await` it (or return it), or the assertion never runs.",
        },
      },
      create(context) {
        return {
          MemberExpression(node) {
            const name = matcherName(node);
            if (name === null || !MATCHER_PROP.test(name)) return;
            // Climb to the whole matcher chain: `.resolves.not.toBe(1)`, `.rejects.toThrow().catch(…)`.
            let top = node;
            for (;;) {
              const p = top.parent;
              if (p && ((p.type === "MemberExpression" && p.object === top) || (p.type === "CallExpression" && p.callee === top))) top = p;
              else break;
            }
            if (!isConsumed(top)) context.report({ node, messageId: "unawaited" });
          },
        };
      },
    },
  },
};

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
    // the first rule off for tests and replaces the lost coverage with a local
    // rule (`local/await-matcher`, above) that fails any `.resolves` / `.rejects`
    // matcher chain that is neither awaited nor returned, whatever wraps it
    // (bare, `void`, an assignment, `cond && …`, a `forEach` body, the computed
    // `["rejects"]` form). This block must stay AFTER the source block (flat config is
    // last-wins for `await-thenable`); lint-async-config.test.ts pins the order.
    files: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    plugins: { local: localPlugin },
    rules: {
      "@typescript-eslint/await-thenable": "off",
      "local/await-matcher": "error",
    },
  },
];

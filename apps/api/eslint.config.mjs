import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Flat config for the NestJS backend. Starts from the typescript-eslint
// "recommended" (syntactic) ruleset — catches real mistakes without needing
// full type information, so it stays fast. Type-aware rules (e.g.
// no-floating-promises) can be layered on later via recommendedTypeChecked.
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "**/*.js", "**/*.mjs"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // NestJS dependency injection uses empty constructors with `private`
      // parameter properties; these are idiomatic, not dead code.
      "no-empty-function": "off",
      "@typescript-eslint/no-empty-function": "off",
      // Best-effort cleanup (socket teardown, optimistic container removal)
      // deliberately swallows errors with `catch {}` — allow that, but still
      // flag genuinely-empty if/loop blocks.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // A few MCP tool builders capture `const self = this` to reference the
      // enclosing service from a returned descriptor object — intentional.
      "@typescript-eslint/no-this-alias": "off",
      // The backend logs through Pino; raw console is a smell. Boot-time
      // safety nets in main.ts opt out explicitly via eslint-disable.
      "no-console": "warn",
      // Allow intentionally-unused args/vars when prefixed with `_`.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Standalone CLI assertion scripts and the chat benchmark harness print to
    // the terminal by design — not part of the running server.
    files: ["**/*.check.ts", "src/chat/bench/**"],
    rules: { "no-console": "off" },
  },
);

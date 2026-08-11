import js from "@eslint/js";
import globals from "globals";

// llm-shims is a Node ESM project: the proxy (ollama-anthropic/proxy.mjs)
// runs under Node, and its tests (proxy.test.mjs) use node:test directly.
// Everything runs under Node, so one language-options block covers the tree.
export default [
  { ignores: ["node_modules/**", ".claude/**", ".worktrees/**"] },

  js.configs.recommended,

  // Project-wide rule tuning: keep the high-signal bug catchers as errors
  // (no-undef, no-redeclare, no-const-assign, no-dupe-keys, no-unreachable…
  // — these block the commit), demote stylistic noise to warnings so it
  // informs without halting work.
  {
    rules: {
      "no-unused-vars": ["warn", { caughtErrors: "none", argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
];

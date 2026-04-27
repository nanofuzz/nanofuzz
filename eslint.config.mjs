import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier/flat";

export default defineConfig(
  js.configs.recommended,
  tseslint.configs.recommended,
  globalIgnores(["**/*.js", "src/vscode/index.d.ts"]),
  {
    rules: {
      "prefer-rest-params": 0,
      "prefer-spread": 0,
      "@typescript-eslint/no-explicit-any": "warn",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-unused-expressions": "off",
      "@typescript-eslint/no-unused-expressions": "error",
      eqeqeq: 2,
      "no-fallthrough": 2,
      "no-template-curly-in-string": 2,
      "@typescript-eslint/prefer-ts-expect-error": 2,
      "@typescript-eslint/consistent-type-assertions": [
        1,
        { assertionStyle: "never" },
      ],
      // "eslint-comments/no-use": 2,
    },
  },
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
  },
  eslintConfigPrettier
);

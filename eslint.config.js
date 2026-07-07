import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/runs/**",
      "**/coverage/**",
      "**/*.tsbuildinfo",
      "packages/python-adapters/**/__pycache__/**"
    ]
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: {
        console: "readonly",
        module: "readonly",
        process: "readonly",
        URL: "readonly"
      }
    }
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      complexity: ["error", { max: 150 }],
      "max-lines": ["error", { max: 4000, skipBlankLines: true, skipComments: true }],
      "no-undef": "off",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["packages/*/dist/**", "../*/dist/**"],
              message: "Import source modules through package exports instead of dist outputs."
            }
          ]
        }
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }]
    }
  },
  {
    files: ["packages/core/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../../cli/**", "../../mcp-adapter/**", "../../ui/**", "../../python-adapters/**"],
              message: "Core must remain protocol-independent and cannot import adapter or UI packages."
            }
          ]
        }
      ]
    }
  },
  {
    files: ["packages/ui/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../../cli/**", "../../mcp-adapter/**", "../../python-adapters/**"],
              message: "UI may call Core APIs but must not import CLI, MCP adapter, or Python adapter internals."
            }
          ]
        }
      ]
    }
  },
  {
    files: ["packages/ui/src/**/*.{ts,tsx}", "packages/ui/tests/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-hooks/set-state-in-effect": "off",
      "react-refresh/only-export-components": "off"
    }
  }
);

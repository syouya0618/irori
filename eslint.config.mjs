import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // ローカル専用ディレクトリ。flutter/build/web/main.dart.js (数MBの生成JS) を
    // lint すると Node が heap OOM でクラッシュするため除外する (CI には存在しない)。
    "flutter/**",
    ".worktrees/**",
    ".codex-pet-runs/**",
  ]),
  {
    rules: {
      // process.env への非null断言 (!) を禁止。Vercel 環境変数のペースト時に
      // 末尾改行が混入すると auth が無音 fail するため、`?.trim() ?? ""` を強制する。
      // (learnings.md L71 / L204)
      "no-restricted-syntax": [
        "error",
        {
          selector:
            'TSNonNullExpression > MemberExpression[object.object.name="process"][object.property.name="env"]',
          message:
            'process.env への非null断言 (!) は禁止。末尾改行混入を防ぐため `?.trim() ?? ""` を使うこと。',
        },
      ],
    },
  },
  {
    // e2e/ は Playwright テストコード。fixture の第2引数 `use` を React の
    // `use` フックと誤検知する react-hooks/rules-of-hooks を無効化する。
    files: ["e2e/**/*.ts", "playwright.config.ts"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
]);

export default eslintConfig;

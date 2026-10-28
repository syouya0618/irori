/**
 * 版（build 識別子）の正本（2026-10-27 大型更新 E1）。
 *
 * - 端末が読んでおる build は、ビルド時に `next.config.ts` の `env.IRORI_BUILD_SHA` で埋め込む
 *   （`VERCEL_GIT_COMMIT_SHA` の先頭 7 桁。未設定・空・16 進でない値は `"dev"`）。`env` に書いた値は
 *   クライアントとサーバの両方の bundle へ**文字列として**置き換わる
 *   （node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/env.md）。
 *   置き換えは `process.env.IRORI_BUILD_SHA` という**字面**にだけ効くゆえ、分割代入や動的な鍵で読まぬ。
 * - 出すのは短い SHA だけ。branch 名（`VERCEL_GIT_COMMIT_REF`）・環境名・秘密の env は出さぬ。
 * - `"dev"` は「比べられぬ」を表す（ローカル・e2e の build）。dev 同士を「同じ版」と言わぬ。
 */

export const DEV_BUILD_ID = "dev"

const SHA_RE = /^[0-9a-f]{7,40}$/

/**
 * SHA の表記を短い build 識別子へ。`next.config.ts` の埋め込みと同じ規則
 * （`build-info.test.ts` が両者の一致を確かめる）。
 */
export function shortBuildId(sha: string | null | undefined): string {
  const text = typeof sha === "string" ? sha.trim().toLowerCase() : ""
  return SHA_RE.test(text) ? text.slice(0, 7) : DEV_BUILD_ID
}

/** この bundle が作られた時の build（端末が読んでおる版）。 */
export function clientBuildId(): string {
  return shortBuildId(process.env.IRORI_BUILD_SHA)
}

/** 比べられる識別子か（dev は比べぬ）。 */
export function isComparableBuildId(id: string | null | undefined): id is string {
  return typeof id === "string" && id !== DEV_BUILD_ID && /^[0-9a-f]{7}$/.test(id)
}

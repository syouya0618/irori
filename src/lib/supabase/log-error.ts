import type { PostgrestError } from "@supabase/supabase-js"

/**
 * Supabase の PostgrestError を構造化ログとして console.error に出力する。
 *
 * Supabase の error は実行時に class Error を継承しない plain object として
 * 振る舞うことがあり、`String(err)` では `[object Object]` になって真因が
 * 隠匿される。個別フィールド (message / code / details / hint) を明示的に
 * 読むことで確実にログへ残す。
 *
 * `context` は呼び出し側の追加情報 (userId など)。error の 4 フィールドより
 * 先に spread しており、context が同名キーで error 情報を上書きすることは
 * できない (error 情報が常に保たれる)。
 */
export function logSupabaseError(
  scope: string,
  summary: string,
  error: PostgrestError,
  context?: Record<string, unknown>,
): void {
  console.error(`[${scope}] ${summary}`, {
    ...context,
    message: error.message,
    code: error.code,
    details: error.details,
    hint: error.hint,
  })
}

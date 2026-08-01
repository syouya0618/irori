import type { AuthError, PostgrestError } from "@supabase/supabase-js"

/**
 * Supabase の PostgrestError を構造化ログとして console.error に出力する。
 *
 * Supabase の error は実行時に class Error を継承しない plain object として
 * 振る舞うことがあり、`String(err)` では `[object Object]` になって真因が
 * 隠匿される。個別フィールド (message / code / details / hint) を明示的に
 * 読むことで確実にログへ残す。
 *
 * `context` は呼び出し側の追加情報 (userId など)。error の各フィールドより
 * 先に spread しており、context が同名キーで error 情報を上書きすることは
 * できない (error 情報が常に保たれる)。
 *
 * `AuthError` も受ける (getClaims / getUser 由来)。PostgrestError と違い
 * details / hint を持たず status を持つため、両者の和集合を undefined 許容で読む。
 */
export function logSupabaseError(
  scope: string,
  summary: string,
  error: PostgrestError | AuthError,
  context?: Record<string, unknown>,
): void {
  const asRecord = error as Partial<PostgrestError> & Partial<AuthError>
  console.error(`[${scope}] ${summary}`, {
    ...context,
    message: error.message,
    code: asRecord.code,
    details: asRecord.details,
    hint: asRecord.hint,
    status: asRecord.status,
  })
}

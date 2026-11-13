/**
 * ごはんの Server Action（食材・設定・除外・好み）が共有する、入力の形の検査と失敗の分類。
 *
 * 境界指令を持たない中立モジュール（`"use server"` のファイルは関数しか export できないので、
 * 型・定数・純関数はここへ置く）。食材辞書・レシピのカタログを import しない
 * （Client Component から値 import しても画面の bundle を重くしない）。
 *
 * ## 規則
 * - 要求は**余分な項目を持たない**こと。`householdId` や `profileId` を紛れ込ませた要求は、
 *   無視ではなく拒否する（世帯と本人は Server Action が `getAuthContext()` から、DB が
 *   `auth.uid()` から決める）。
 * - ここで見るのは形と範囲だけ。「今日より後か」のように時刻に依る検証と、カタログに在る ID かの
 *   検証は Server Action が行う（端末の控えから復元した要求を、日付が変わっただけで読めない
 *   扱いにしないため）。
 * - 文字列の上限・ID の形は DB（`supabase/migrations/20261111100003_dinner_tables.sql`）の
 *   検証と同じにする。DB が最終の門で、ここは「届く前に分かる拒否」を利用者の言葉で返すための写し。
 */

import { failureOfRpcError, unknownResult, type ChoreSaveFailure } from "@/lib/domain/rpc-outcome"

export const MEAL_INVALID_MESSAGE = "入力内容を確認してください。"
export const MEAL_SAVE_FAILED_MESSAGE = "保存できませんでした。通信状況を確認して、もう一度お試しください。"
export const MEAL_FORBIDDEN_MESSAGE = "この操作を行えません。再読み込みして、内容と権限を確認してください。"
export const MEAL_ID_CONFLICT_MESSAGE =
  "同じ操作が別の内容で記録済みでした。上書きはしていません。画面の内容を確認してください。"
/** 例外（通信断・中断）で、保存されたかどうかを確かめられなかったとき。 */
export const MEAL_RESULT_UNKNOWN_MESSAGE =
  "保存できたかを確認できませんでした。通信状況を確認して、同じ操作で確認し直してください。"

/** DB の `dinner_j_uuid` と同じ形（小文字の 16 進）。行 ID・世帯の人や子の ID に使う。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isMealUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value)
}

/** カタログ ID（食材・レシピ・アレルゲン・タグ）の形。DB の CHECK と同じ。 */
const CATALOG_ID_RE = /^[a-z0-9_-]{1,64}$/

export function isCatalogIdText(value: unknown): value is string {
  return typeof value === "string" && CATALOG_ID_RE.test(value)
}

/**
 * 表示用の短い 1 行の文字列か（DB の `dinner_label` と同じ規則）。
 * 前後の空白を除いた長さが 1〜max 文字で、制御文字を含まない。
 */
export function isMealLabel(value: unknown, max: number): value is string {
  if (typeof value !== "string") return false
  const trimmed = value.trim()
  if (trimmed.length === 0 || [...trimmed].length > max) return false
  for (const char of trimmed) {
    const code = char.codePointAt(0) ?? 0
    if ((code >= 0x01 && code <= 0x1f) || code === 0x7f) return false
  }
  return true
}

/** 余分な項目を持たないか（必須の項目が在るかは、項目ごとの検査が見る）。 */
export function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

export function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
}

type DbError = { code?: string | null; message?: string | null }

/**
 * ごはんの RPC の失敗を、利用者向けの文と分類へ写す（DB の生のエラーは返さない。呼び出し側が
 * ログへ出す）。
 *
 * - 23505 … 同じ ID に別の内容が既に在る。同じ内容を送り直しても成立しない（conflict）
 * - 42501 … 権限が無い・世帯の外の人や子・ほかの家族の個人設定（rejected）
 * - 22023 / 23514 … 入力が DB の検証に合わない（rejected）
 * - code を持たない失敗（fetch の失敗・timeout）… 書かれたかもしれない（unknown）
 */
export function mealFailureOf(error: DbError, messages: { forbidden?: string } = {}): ChoreSaveFailure {
  const code = error.code ?? ""
  if (code === "23505") return { error: MEAL_ID_CONFLICT_MESSAGE, failure: "conflict" }
  if (code === "42501") return failureOfRpcError(error, messages.forbidden ?? MEAL_FORBIDDEN_MESSAGE)
  if (code === "22023" || code === "23514") return failureOfRpcError(error, MEAL_INVALID_MESSAGE)
  return failureOfRpcError(error, MEAL_SAVE_FAILED_MESSAGE)
}

/**
 * RPC の呼び出しと戻り値の読み取りを包み、例外を「結果不明」として返す。
 *
 * 例外（fetch の reject・中断）は、要求が届かなかったのか、保存の後で応答だけが失われたのかを
 * 区別できない。拒否（rejected）と言い換えると、端末の控えが捨てられて二重登録の道が開く。
 * 入力の検証は `run` の外で済ませること（検証の拒否を結果不明にしない）。
 */
export async function settleMealAction<S>(
  action: string,
  userId: string,
  run: () => Promise<S | ChoreSaveFailure>,
): Promise<S | ChoreSaveFailure> {
  try {
    return await run()
  } catch (err) {
    // 家庭の入力を載せない（操作名と例外の種類だけ）
    console.error("[meals] action threw", {
      action,
      userId,
      message: err instanceof Error ? err.message : String(err),
    })
    return unknownResult(MEAL_RESULT_UNKNOWN_MESSAGE)
  }
}

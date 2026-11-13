/**
 * 家事機能（ごみ・掃除・ごはん）の保存 RPC の戻り値と、Server Action が画面へ返す結果の共通形。
 *
 * 境界指令を持たぬ中立モジュール（`"use server"` のファイルは関数しか export できぬゆえ、型と
 * 純関数はここへ置く）。保存契約は第 2 世代: RPC が 1 トランザクションで
 * `{ status: "saved" | "replayed" | "conflict", <entityKey>: 行 }` を返す。
 *
 * - `saved` … 今回の要求で書いた
 * - `replayed` … 同じ内容が既に保存済みだった（応答を失った自分の再送。二重にならぬ）
 * - `conflict` … 別の端末が先に更新しており、**上書きしておらぬ**。最新の行を返す
 *
 * Action は戻り値の形を必ず検査する。形が合わねば「保存できたか分からぬ」（`unknown`）として
 * 返し、成功とも失敗とも断定せぬ。
 */
import { isRecord } from "@/lib/domain/child-sharing"
import { failureKindOfDbError, type CreateFailureKind } from "@/lib/domain/save-attempt"

export const RPC_STATUSES = ["saved", "replayed", "conflict"] as const
export type RpcStatus = (typeof RPC_STATUSES)[number]

export function isRpcStatus(value: unknown): value is RpcStatus {
  return typeof value === "string" && (RPC_STATUSES as readonly string[]).includes(value)
}

/** RPC の戻り値から status だけを読む（行を返さぬ RPC 用）。形が合わねば null。 */
export function parseRpcStatus(data: unknown): RpcStatus | null {
  return isRecord(data) && isRpcStatus(data.status) ? data.status : null
}

/**
 * RPC の戻り値 jsonb を `{ status, entity }` へ読む。`entityKey` は RPC が行を載せるキー
 * （例: `"routine"`）。status が既知の 3 値でない・行が object でないなら null
 * （null は「拒否」ではなく「結果不明」として扱うこと — 行は書かれておるかもしれぬ）。
 *
 * 行の中身（列）の検査は呼び出し側の責務じゃ。ここは外枠だけを見る。
 */
export function parseRpcOutcome(
  data: unknown,
  entityKey: string,
): { status: RpcStatus; entity: Record<string, unknown> } | null {
  if (!isRecord(data) || !isRpcStatus(data.status)) return null
  // 継承プロパティ（"constructor" 等）を行と取り違えぬよう、自前のキーだけを見る
  if (!Object.prototype.hasOwnProperty.call(data, entityKey)) return null
  const entity = data[entityKey]
  return isRecord(entity) ? { status: data.status, entity } : null
}

/** 保存 Action の成功応答。`conflict` も応答としては成功（上書きはしておらぬ。読み直させる）。 */
export interface ChoreSaveSuccess {
  status: RpcStatus
}

/**
 * 保存 Action の失敗応答。
 * - `rejected` … 行は書かれておらぬと断定できる（検証・認証・DB の制約違反）
 * - `unknown` … 書かれたかもしれぬ（通信断・タイムアウト・戻り値の形が不正）
 * - `conflict` … 同じ id に別の内容が既に在る等、同じ内容を送り直しても成立せぬ
 */
export interface ChoreSaveFailure {
  error: string
  failure: CreateFailureKind
}

export type ChoreSaveResult<S extends ChoreSaveSuccess = ChoreSaveSuccess> = S | ChoreSaveFailure

/** 入力の検証・認証で、DB へ届く前に拒否した時の応答。 */
export function rejectedResult(error: string): ChoreSaveFailure {
  return { error, failure: "rejected" }
}

/**
 * Supabase / PostgREST のエラーを失敗応答へ分類する（`failureKindOfDbError` を再利用）。
 * SQLSTATE を持つ失敗は rejected、code を持たぬ失敗（fetch 失敗・timeout）は unknown。
 * `message` は利用者向けの日本語（DB の生エラーは返さず、呼び出し側でログへ出す）。
 */
export function failureOfRpcError(error: { code?: string | null }, message: string): ChoreSaveFailure {
  return { error: message, failure: failureKindOfDbError(error) }
}

/** RPC は成功を返したが戻り値の形を読めなかった時の応答（保存されておるかもしれぬ）。 */
export const RPC_UNREADABLE_RESULT_MESSAGE = "保存結果を確認できませんでした。同じ操作で確認し直してください。"

export function unknownResult(error: string = RPC_UNREADABLE_RESULT_MESSAGE): ChoreSaveFailure {
  return { error, failure: "unknown" }
}

/** Action の応答（Server からの値ゆえ形を信用せぬ）が成功応答か。 */
export function isChoreSaveSuccess(value: unknown): value is ChoreSaveSuccess {
  return isRecord(value) && isRpcStatus(value.status) && value.error === undefined
}

/** Action の応答が、分類つきの失敗応答か。分類を持たぬ・未知の分類は false（= 結果不明として扱う）。 */
export function isChoreSaveFailure(value: unknown): value is ChoreSaveFailure {
  return (
    isRecord(value) &&
    typeof value.error === "string" &&
    (value.failure === "rejected" || value.failure === "unknown" || value.failure === "conflict")
  )
}

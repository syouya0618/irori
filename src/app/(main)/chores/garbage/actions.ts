"use server"

import { revalidatePath } from "next/cache"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { isGarbageRequest, type GarbageRequest } from "@/lib/domain/garbage"
import type { Database } from "@/lib/types/database"
import {
  failureOfRpcError,
  parseRpcStatus,
  rejectedResult,
  unknownResult,
  type ChoreSaveResult,
} from "@/lib/domain/rpc-outcome"

/**
 * ごみの分類（予定の用途）を読む画面を無効化する。分類は予定の一覧（カレンダー・育児ホームの
 * 「今日・明日の予定」）にも合成して出すゆえ、4 面とも対象じゃ。
 */
function revalidateGarbageConsumers() {
  revalidatePath("/calendar")
  revalidatePath("/baby")
  revalidatePath("/chores/garbage")
  revalidatePath("/chores")
}

/** RPC の拒否（SQLSTATE）を利用者向けの文へ。DB の生の文言は返さぬ（ログへ出す）。 */
function rejectionMessage(error: { code?: string | null; message?: string | null }): string {
  const code = error.code ?? ""
  const message = error.message ?? ""
  if (code === "42501") {
    return "この予定は分類できません。予定が削除されたか、操作する権限がありません。"
  }
  if (code === "22023") {
    if (message.includes("medical")) return "健診・予防接種の予定は、ごみの日にできません。"
    if (message.includes("not part of a series")) {
      return "この予定は繰り返しではないため、「シリーズ全体」は選べません。"
    }
    return "入力内容を確認してください。"
  }
  return "保存できませんでした。もう一度お試しください。"
}

/**
 * `save_event_purpose` の引数を組む。`p_seen_*` は画面が見ておった分類の行の版
 * （`event_purposes.updated_at` の表記のまま。行なしは null）。
 */
function saveArgs(
  input: Extract<GarbageRequest, { op: "save" }>,
): Database["public"]["Functions"]["save_event_purpose"]["Args"] {
  return {
    p_event_id: input.eventId,
    p_scope: input.scope,
    p_action: input.action,
    p_garbage_kind: input.garbageKind,
    p_reminder: input.reminder,
    p_seen_series: input.seen.series,
    p_seen_event: input.seen.event,
  }
}

/**
 * ごみの分類の保存（分類・変更・この回だけ通常へ戻す・解除）と、予定が見つからぬ分類の手動整理。
 *
 * - 世帯は**受け取らぬ**。RPC が `auth.uid()` から導く（クライアントの household_id を信用せぬ）。
 *   予定の鍵（event_uid / シリーズの鍵）も受け取らず、行 id からサーバが引く
 * - 入力は `isGarbageRequest`（画面・端末の控えと同じ門）で検証する。余分な項目を持つ値は拒む
 * - 戻り値は家事機能の共通形（`ChoreSaveResult`）。結果を読めぬ時・通信の失敗は `unknown`
 *   （保存されたかもしれぬ。画面は同じ内容で確かめ直させる）
 * - 同じ内容の送り直しは RPC が `replayed` を返す（「その鍵の用途をこの値にする」という
 *   状態の設定ゆえ、何度送っても 1 行のまま・通知設定も 1 件のまま）
 * - **画面が見ておった版（`seen`）をそのまま RPC へ渡す**。今の版と違い、かつ適用すると何かが
 *   変わる時は RPC が `conflict` を返し、何も書かぬ（古い画面・古い控えの「同じ操作で確認」が、
 *   家族の新しい分類と通知を黙って消さぬ）。版の照合は RPC がロックの中で行う — ここで読んでから
 *   比べると、読みと書きの間に別の保存が挟まる
 */
export async function submitGarbageRequest(input: unknown): Promise<ChoreSaveResult> {
  const auth = await getAuthContext()
  if (auth.error !== null) return rejectedResult(auth.error)
  if (!isGarbageRequest(input)) return rejectedResult("入力内容を確認してください。")
  const { supabase, householdId } = auth.context

  try {
    const { data, error } =
      input.op === "save"
        ? await supabase.rpc("save_event_purpose", saveArgs(input))
        : await supabase.rpc("delete_orphan_event_purpose", { p_id: input.purposeId })

    if (error) {
      logSupabaseError("garbage", `${input.op} failed`, error, { householdId, op: input.op })
      return failureOfRpcError(error, rejectionMessage(error))
    }
    const status = parseRpcStatus(data)
    if (status === null) {
      console.error("[garbage] RPC の戻り値を読めぬ", { householdId, op: input.op })
      return unknownResult()
    }
    // conflict（何も書いておらぬ）でも、画面が最新を読み直せるよう無効化する
    revalidateGarbageConsumers()
    return { status }
  } catch (err) {
    // 要求が届いたかどうかを区別できぬ（保存の後で応答だけが失われたかもしれぬ）
    console.error("[garbage] RPC が throw", {
      householdId,
      op: input.op,
      message: err instanceof Error ? err.message : String(err),
    })
    return unknownResult()
  }
}

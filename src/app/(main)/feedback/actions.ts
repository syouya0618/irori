"use server"

import { revalidatePath } from "next/cache"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseErrorRedacted } from "@/lib/supabase/log-error"
import { isClientId } from "@/lib/utils/client-id"
import {
  FEEDBACK_BODY_MAX,
  FEEDBACK_DB_ERROR,
  FEEDBACK_TITLE_MAX,
  checkFeedbackText,
  feedbackTextErrorMessage,
  normalizeFeedbackText,
  type SubmitFeedbackResult,
} from "@/lib/domain/feedback"

const SUBMIT_FAILED = "送信できませんでした。電波の良い場所でもう一度お試しください"

/**
 * 要望を送る（利用者）。
 *
 * ## 書込は RPC だけ（service role は使わぬ）
 * `submit_feedback` は SECURITY DEFINER で、承認・世帯・入力の形・冪等・上限を DB 側で
 * 確かめ、運用者への知らせも**同じトランザクション**で積む。ここで先に同じ検査をするのは
 * 文言を欄ごとに返すため（DB は本文を含まぬ 22023 しか返さぬ）。
 *
 * ## 二重送信と通信断
 * `requestId` は画面が「送る意図ごとに 1 回だけ」作る UUID じゃ。応答だけが失われて再送されても
 * 同じ鍵なら DB が同じ 1 行を返す（`duplicate`）。鍵の使い回しで内容が違えば `conflict`
 * （直した文面を黙って捨てぬ）。
 *
 * ⚠️ ログに題・本文を出さぬ。CHECK 違反の details は行の中身を運ぶゆえ、redacted 版で残す。
 */
export async function submitFeedback(input: {
  requestId: unknown
  title: unknown
  body: unknown
}): Promise<SubmitFeedbackResult> {
  if (!isClientId(input.requestId)) {
    return { status: "error", error: "送信の準備に失敗しました。画面を開き直してください" }
  }
  if (typeof input.title !== "string" || typeof input.body !== "string") {
    return { status: "error", error: "入力内容を確認してください" }
  }

  const title = normalizeFeedbackText(input.title)
  const body = normalizeFeedbackText(input.body)
  const titleError = checkFeedbackText(title, {
    max: FEEDBACK_TITLE_MAX,
    multiline: false,
    required: true,
  })
  if (titleError) {
    return {
      status: "error",
      field: "title",
      error: feedbackTextErrorMessage(titleError, { label: "要望", max: FEEDBACK_TITLE_MAX }),
    }
  }
  const bodyError = checkFeedbackText(body, {
    max: FEEDBACK_BODY_MAX,
    multiline: true,
    required: false,
  })
  if (bodyError) {
    return {
      status: "error",
      field: "body",
      error: feedbackTextErrorMessage(bodyError, { label: "詳しい内容", max: FEEDBACK_BODY_MAX }),
    }
  }

  const auth = await getAuthContext()
  if (auth.error !== null) return { status: "error", error: auth.error }
  const { supabase, userId } = auth.context

  const { data, error } = await supabase.rpc("submit_feedback", {
    p_client_request_id: input.requestId,
    p_title: title,
    p_body: body,
  })

  if (error) {
    logSupabaseErrorRedacted("feedback", "submit_feedback failed", error, {
      userId,
      requestId: input.requestId,
    })
    if (error.code === FEEDBACK_DB_ERROR.requestConflict) {
      // 応答を失った初回の送信は DB に在る。画面がそこへ辿れるよう id を引く
      // （RLS が自分の行だけを見せる。引けなくても conflict は返す）。
      const { data: prior, error: priorError } = await supabase
        .from("feedback_items")
        .select("id")
        .eq("submitter_id", userId)
        .eq("client_request_id", input.requestId)
        .maybeSingle()
      if (priorError) {
        logSupabaseErrorRedacted("feedback", "prior feedback lookup failed", priorError, {
          userId,
          requestId: input.requestId,
        })
      }
      // 応答を失った初回の送信で効かなかった revalidate をここで効かせる（一覧に前の送信を出す）。
      revalidatePath("/feedback", "layout")
      return { status: "conflict", feedbackId: prior?.id ?? null }
    }
    if (error.code === FEEDBACK_DB_ERROR.rateLimited) {
      return {
        status: "error",
        error: "短い間に多くの要望が送られました。明日もう一度お試しください",
      }
    }
    if (error.code === FEEDBACK_DB_ERROR.forbidden) {
      return { status: "error", error: "要望を送る権限がありません" }
    }
    if (error.code === FEEDBACK_DB_ERROR.unauthenticated) {
      return { status: "error", error: "ログインし直してからお試しください" }
    }
    if (error.code === FEEDBACK_DB_ERROR.invalid) {
      return { status: "error", error: "入力内容を確認してください" }
    }
    return { status: "error", error: SUBMIT_FAILED }
  }

  // RETURNS TABLE は配列で返る。0 行を「成功」と偽らぬ。
  const row = Array.isArray(data) ? data[0] : undefined
  if (!row || typeof row.feedback_id !== "string") {
    console.error("[feedback] submit_feedback が行を返さなかった", { userId })
    return { status: "error", error: SUBMIT_FAILED }
  }

  revalidatePath("/feedback", "layout")
  return { status: row.created ? "created" : "duplicate", feedbackId: row.feedback_id }
}

/**
 * 開いた要望を既読にする（投稿者・運用者）。画面のマウント後に呼ぶ —— Server Component の
 * 描画中に書くと、先読みや再描画で「見ておらぬのに既読」になりうる。
 *
 * 失敗しても画面は止めぬ（既読は知らせの補助）。ただし握り潰さずログに残す。
 */
export async function markFeedbackSeen(feedbackId: unknown): Promise<{ ok: boolean }> {
  if (!isClientId(feedbackId)) return { ok: false }

  const auth = await getAuthContext()
  if (auth.error !== null) return { ok: false }
  const { supabase, userId } = auth.context

  const { error } = await supabase.rpc("mark_feedback_seen", { p_feedback_id: feedbackId })
  if (error) {
    logSupabaseErrorRedacted("feedback", "mark_feedback_seen failed", error, {
      userId,
      feedbackId,
    })
    return { ok: false }
  }
  // 一覧の「更新あり」と設定画面の件数は Client Cache（staleTimes.dynamic = 10 秒）に
  // 古いまま残りうる。既読を書いたら捨てさせる（戻った一覧に消したはずの印を出さぬ）。
  revalidatePath("/feedback", "layout")
  revalidatePath("/settings")
  return { ok: true }
}

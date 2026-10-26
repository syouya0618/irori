"use server"

import { revalidatePath } from "next/cache"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseErrorRedacted } from "@/lib/supabase/log-error"
import { isClientId } from "@/lib/utils/client-id"
import {
  COMMIT_SHA_RE,
  FEEDBACK_COMMENT_MAX,
  FEEDBACK_DB_ERROR,
  FEEDBACK_MERGE_REF_MAX,
  FEEDBACK_RELEASE_NOTE_MAX,
  checkFeedbackText,
  feedbackTextErrorMessage,
  isOperatorSettableStatus,
  normalizeCommitSha,
  normalizeFeedbackText,
  observedDeployFromEnv,
  type OperatorFeedbackResult,
} from "@/lib/domain/feedback"
import type { PostgrestError } from "@supabase/supabase-js"

const SAVE_FAILED = "保存できませんでした。電波の良い場所でもう一度お試しください"

/**
 * 運用者の操作（受信箱）。
 *
 * ## 権限の門は DB じゃ
 * 運用者かどうかは `operator_update_feedback` / `operator_release_feedback` が
 * `is_app_operator()` で確かめ、違えば 42501 で拒む（世帯 owner であることは根拠にならぬ）。
 * ここで先に問い合わせぬのは往復を増やさぬためで、緩めておるのではない。Server Action は
 * 画面を通らず直接 POST で叩けるゆえ、門を画面やここに置いても意味は無い。
 *
 * ## service role は使わぬ
 * 書込は認証済みクライアントの RPC だけ。投稿者への知らせも RPC が同じトランザクションで積み、
 * 送るのは cron（/api/cron/notify）じゃ。
 */

function optionalText(
  raw: unknown,
  field: { label: string; max: number; multiline: boolean },
): { value: string | null } | { error: string } {
  if (raw === undefined || raw === null) return { value: null }
  if (typeof raw !== "string") return { error: "入力内容を確認してください" }
  const value = normalizeFeedbackText(raw)
  const error = checkFeedbackText(value, {
    max: field.max,
    multiline: field.multiline,
    required: false,
  })
  if (error) return { error: feedbackTextErrorMessage(error, field) }
  return { value: value === "" ? null : value }
}

function mapOperatorError(
  error: PostgrestError,
  context: Record<string, unknown>,
  summary: string,
): OperatorFeedbackResult {
  logSupabaseErrorRedacted("feedback-inbox", summary, error, context)
  // IRF03 = 開いた後に誰かが更新した / IRF01 = 同じ鍵で別の内容が既に記録されておる
  // （通信断の後に書き直した操作）。どちらも「読み直してから操作し直す」が正しい対処ゆえ同じに写す。
  if (
    error.code === FEEDBACK_DB_ERROR.versionConflict ||
    error.code === FEEDBACK_DB_ERROR.requestConflict
  ) {
    return { status: "conflict" }
  }
  if (error.code === FEEDBACK_DB_ERROR.forbidden) {
    return { status: "error", error: "運用者の権限がありません" }
  }
  if (error.code === FEEDBACK_DB_ERROR.notFound) {
    return { status: "error", error: "要望が見つかりませんでした" }
  }
  if (error.code === FEEDBACK_DB_ERROR.invalid) {
    return { status: "error", error: "入力内容を確認してください" }
  }
  return { status: "error", error: SAVE_FAILED }
}

function readVersionRow(data: unknown): { version: number; created: boolean } | null {
  const row = Array.isArray(data) ? data[0] : undefined
  if (!row || typeof row.version !== "number" || typeof row.created !== "boolean") return null
  return { version: row.version, created: row.created }
}

/**
 * 状態の変更・返信（released 以外）。`status` が null なら返信だけ。
 *
 * - 見送りと、反映済みからの差し戻しには理由（返信）が要る（DB も拒む）
 * - `mergeRef` は「取り込み済み」の記録で、**本番反映ではない**（対応中の時だけ）
 */
export async function updateFeedbackStatus(input: {
  feedbackId: unknown
  requestId: unknown
  expectedVersion: unknown
  status: unknown
  comment: unknown
  mergeRef: unknown
}): Promise<OperatorFeedbackResult> {
  if (!isClientId(input.feedbackId) || !isClientId(input.requestId)) {
    return { status: "error", error: "画面を開き直してからお試しください" }
  }
  if (!Number.isInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) {
    return { status: "error", error: "画面を開き直してからお試しください" }
  }
  // null = 返信だけ。それ以外は通常の変更で選べる状態に限る。
  const status = input.status
  if (status !== null && !isOperatorSettableStatus(status)) {
    // released はここでは立てぬ（証拠を伴う確定フォームへ）。未知の値もここで拒む。
    return { status: "error", error: "選べない状態です" }
  }
  const comment = optionalText(input.comment, {
    label: "返信",
    max: FEEDBACK_COMMENT_MAX,
    multiline: true,
  })
  if ("error" in comment) return { status: "error", error: comment.error }
  const mergeRef = optionalText(input.mergeRef, {
    label: "取り込み済みの変更",
    max: FEEDBACK_MERGE_REF_MAX,
    multiline: false,
  })
  if ("error" in mergeRef) return { status: "error", error: mergeRef.error }

  if (status === null && comment.value === null && mergeRef.value === null) {
    return { status: "error", error: "返信を入力するか、状態を選んでください" }
  }
  if (status === "declined" && comment.value === null) {
    return { status: "error", error: "見送りの理由を返信に書いてください" }
  }

  const auth = await getAuthContext()
  if (auth.error !== null) return { status: "error", error: auth.error }
  const { supabase, userId } = auth.context

  const { data, error } = await supabase.rpc("operator_update_feedback", {
    p_feedback_id: input.feedbackId,
    p_client_request_id: input.requestId,
    p_expected_version: input.expectedVersion as number,
    p_status: status,
    p_comment: comment.value,
    p_merge_ref: mergeRef.value,
  })
  if (error) {
    return mapOperatorError(
      error,
      { userId, feedbackId: input.feedbackId },
      "operator_update_feedback failed",
    )
  }
  const row = readVersionRow(data)
  if (!row) {
    console.error("[feedback-inbox] operator_update_feedback が行を返さなかった", {
      userId,
      feedbackId: input.feedbackId,
    })
    return { status: "error", error: SAVE_FAILED }
  }

  revalidatePath("/feedback", "layout")
  return { status: "ok", version: row.version, duplicate: !row.created }
}

/**
 * 「本番で反映を確かめた」の確定。
 *
 * ⚠️ `productionVerified` は運用者の**明示の宣言**（画面のチェックボックス）じゃ。true 以外は
 * 拒む。PR のマージ・プレビューでの確認では立てぬ —— 未確認の段階で投稿者に
 * 「反映されました」と見せることになる。
 *
 * `observed_deploy` はこのサーバが自分で観測したデプロイ（`VERCEL_ENV:VERCEL_GIT_COMMIT_SHA`）。
 * 運用者の申告（commitSha）とは別の観測として記録する。取れねば null（ローカル・e2e）。
 */
export async function releaseFeedback(input: {
  feedbackId: unknown
  requestId: unknown
  expectedVersion: unknown
  commitSha: unknown
  releaseNote: unknown
  productionVerified: unknown
  comment: unknown
}): Promise<OperatorFeedbackResult> {
  if (!isClientId(input.feedbackId) || !isClientId(input.requestId)) {
    return { status: "error", error: "画面を開き直してからお試しください" }
  }
  if (!Number.isInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) {
    return { status: "error", error: "画面を開き直してからお試しください" }
  }
  if (input.productionVerified !== true) {
    return {
      status: "error",
      error: "本番環境で反映を確かめたことにチェックを入れてください",
    }
  }
  if (typeof input.commitSha !== "string") {
    return { status: "error", error: "確かめたコミットの SHA を入力してください" }
  }
  const commitSha = normalizeCommitSha(input.commitSha)
  if (!COMMIT_SHA_RE.test(commitSha)) {
    return {
      status: "error",
      error: "コミットの SHA は 7〜40 桁の英数字（0-9, a-f）で入力してください",
    }
  }
  const releaseNote = optionalText(input.releaseNote, {
    label: "リリース情報",
    max: FEEDBACK_RELEASE_NOTE_MAX,
    multiline: false,
  })
  if ("error" in releaseNote) return { status: "error", error: releaseNote.error }
  const comment = optionalText(input.comment, {
    label: "返信",
    max: FEEDBACK_COMMENT_MAX,
    multiline: true,
  })
  if ("error" in comment) return { status: "error", error: comment.error }

  const auth = await getAuthContext()
  if (auth.error !== null) return { status: "error", error: auth.error }
  const { supabase, userId } = auth.context

  const { data, error } = await supabase.rpc("operator_release_feedback", {
    p_feedback_id: input.feedbackId,
    p_client_request_id: input.requestId,
    p_expected_version: input.expectedVersion as number,
    p_commit_sha: commitSha,
    p_release_note: releaseNote.value,
    p_observed_deploy: observedDeployFromEnv(process.env),
    p_production_verified: true,
    p_comment: comment.value,
  })
  if (error) {
    return mapOperatorError(
      error,
      { userId, feedbackId: input.feedbackId },
      "operator_release_feedback failed",
    )
  }
  const row = readVersionRow(data)
  if (!row) {
    console.error("[feedback-inbox] operator_release_feedback が行を返さなかった", {
      userId,
      feedbackId: input.feedbackId,
    })
    return { status: "error", error: SAVE_FAILED }
  }

  revalidatePath("/feedback", "layout")
  return { status: "ok", version: row.version, duplicate: !row.created }
}

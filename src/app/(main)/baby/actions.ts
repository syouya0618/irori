"use server"

import { revalidatePath } from "next/cache"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import {
  deriveDurationMinFromSec,
  FEEDING_DURATION_SEC_MIN,
  FEEDING_DURATION_SEC_MAX,
} from "@/lib/domain/feeding"
import {
  validateLogTime,
  validateSleepOrder,
} from "@/lib/domain/baby-log-time"
import { todayJstString } from "@/lib/utils/date-jst"
import type { FeedingType, DiaperType } from "@/lib/types/database"

const MAX_MEMO_LENGTH = 1000

function validateMemoLength(memo?: string | null): string | null {
  if (memo && memo.length > MAX_MEMO_LENGTH) {
    return `メモは${MAX_MEMO_LENGTH}文字以内で入力してください`
  }
  return null
}

// 記録時刻（loggedAt）を伴う作成系 Action 共通の検証。
// 未指定（従来どおり DB の now() 既定）は素通し、指定時のみ未来/不正 ISO を拒否する。
function validateCreateLoggedAt(loggedAt?: string | null): string | null {
  if (loggedAt === undefined || loggedAt === null) return null
  return validateLogTime(loggedAt)
}

interface RecordFeedingInput {
  feedingType: FeedingType
  amountMl?: number | null
  /**
   * 授乳時間（秒精度）。duration_min は round(sec/60) でサーバ側導出し併記する
   * （両列を1経路で書き drift を防ぐ）。母乳/ミルク等の時間なし記録では省略する。
   */
  durationSec?: number | null
  /** 記録時刻（ISO 8601）。未指定時は DB の now() 既定に依存する。 */
  loggedAt?: string
  memo?: string
}

interface RecordDiaperInput {
  diaperType: DiaperType
  /** 記録時刻（ISO 8601）。未指定時は DB の now() 既定に依存する。 */
  loggedAt?: string
  memo?: string
}

interface RecordTemperatureInput {
  temperature: number
  /** 記録時刻（ISO 8601）。未指定時は DB の now() 既定に依存する。 */
  loggedAt?: string
  memo?: string
}

interface RecordGrowthInput {
  weightG?: number | null
  heightCm?: number | null
  /** 記録時刻（ISO 8601）。未指定時は DB の now() 既定に依存する。 */
  loggedAt?: string
  memo?: string
}

interface RecordMemoInput {
  memo: string
  /** 記録時刻（ISO 8601）。未指定時は DB の now() 既定に依存する。 */
  loggedAt?: string
}

export async function recordFeeding(input: RecordFeedingInput) {
  const memoError = validateMemoLength(input.memo)
  if (memoError) return { error: memoError, id: null }
  const timeError = validateCreateLoggedAt(input.loggedAt)
  if (timeError) return { error: timeError, id: null }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error, id: null }
  const { supabase, userId, householdId } = result.context

  const durationSec = input.durationSec ?? null
  const { data, error } = await supabase
    .from("baby_logs")
    .insert({
      household_id: householdId,
      log_type: "feeding",
      logged_by: userId,
      feeding_type: input.feedingType,
      amount_ml: input.amountMl ?? null,
      // 秒を source of truth に、分は後方互換のため round で併記（1経路で両列を書く）
      duration_sec: durationSec,
      duration_min: deriveDurationMinFromSec(durationSec),
      // 未指定時は logged_at を送らず DB の now() 既定に委ねる（従来挙動）
      ...(input.loggedAt != null && { logged_at: input.loggedAt }),
      memo: input.memo || null,
    })
    .select("id")
    .single()

  if (error) {
    logSupabaseError("baby", "授乳の記録に失敗", error, { userId, householdId })
    return { error: "授乳の記録に失敗しました。", id: null }
  }
  if (!data) {
    console.error("[baby] 授乳の記録: 行が返らず", { userId, householdId })
    return { error: "授乳の記録に失敗しました。", id: null }
  }

  revalidatePath("/baby")
  return { error: null, id: data.id }
}

export async function recordDiaper(input: RecordDiaperInput) {
  const memoError = validateMemoLength(input.memo)
  if (memoError) return { error: memoError, id: null }
  const timeError = validateCreateLoggedAt(input.loggedAt)
  if (timeError) return { error: timeError, id: null }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error, id: null }
  const { supabase, userId, householdId } = result.context

  const { data, error } = await supabase
    .from("baby_logs")
    .insert({
      household_id: householdId,
      log_type: "diaper",
      logged_by: userId,
      diaper_type: input.diaperType,
      ...(input.loggedAt != null && { logged_at: input.loggedAt }),
      memo: input.memo || null,
    })
    .select("id")
    .single()

  if (error) {
    logSupabaseError("baby", "おむつの記録に失敗", error, { userId, householdId })
    return { error: "おむつの記録に失敗しました。", id: null }
  }
  if (!data) {
    console.error("[baby] おむつの記録: 行が返らず", { userId, householdId })
    return { error: "おむつの記録に失敗しました。", id: null }
  }

  revalidatePath("/baby")
  return { error: null, id: data.id }
}

export async function startSleep(loggedAt?: string) {
  const timeError = validateCreateLoggedAt(loggedAt)
  if (timeError) return { error: timeError, id: null }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error, id: null }
  const { supabase, userId, householdId } = result.context

  // B-03: 楽観 append 用に作成した睡眠ログの id を返す（.select("id").single()）。
  // 既存の 23505（既に睡眠中）分岐は不変 — insert 競合時は error に 23505 が入る。
  const { data, error } = await supabase
    .from("baby_logs")
    .insert({
      household_id: householdId,
      log_type: "sleep",
      logged_by: userId,
      ...(loggedAt != null && { logged_at: loggedAt }),
    })
    .select("id")
    .single()

  if (error) {
    // 23505 は「既に睡眠中」= UNIQUE 制約による正常系ゆえログ対象外。
    if (error.code === "23505") {
      return { error: "既に睡眠中のセッションがあります。", id: null }
    }
    logSupabaseError("baby", "睡眠の開始に失敗", error, { userId, householdId })
    return { error: "睡眠の記録に失敗しました。", id: null }
  }
  if (!data) {
    console.error("[baby] 睡眠の開始: 行が返らず", { userId, householdId })
    return { error: "睡眠の記録に失敗しました。", id: null }
  }

  revalidatePath("/baby")
  return { error: null, id: data.id }
}

export async function endSleep(logId: string) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  const { data, error } = await supabase
    .from("baby_logs")
    .update({ ended_at: new Date().toISOString() })
    .eq("id", logId)
    .eq("household_id", householdId)
    .is("ended_at", null)
    .select("id")
    .single()

  // PGRST116 は .single() の「該当行なし」= アクティブな睡眠が無い正常系ゆえ
  // ログ対象外。それ以外の error は真の失敗として構造化ログに残す。
  if (error) {
    if (error.code !== "PGRST116") {
      logSupabaseError("baby", "睡眠の終了に失敗", error, { logId, householdId })
    }
    return { error: "アクティブな睡眠セッションが見つかりません。" }
  }
  if (!data) {
    return { error: "アクティブな睡眠セッションが見つかりません。" }
  }

  revalidatePath("/baby")
  return { error: null }
}

export async function recordTemperature(input: RecordTemperatureInput) {
  const memoError = validateMemoLength(input.memo)
  if (memoError) return { error: memoError, id: null }
  const timeError = validateCreateLoggedAt(input.loggedAt)
  if (timeError) return { error: timeError, id: null }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error, id: null }
  const { supabase, userId, householdId } = result.context

  // B-03: 楽観 append 用に作成ログの id を返す。
  const { data, error } = await supabase
    .from("baby_logs")
    .insert({
      household_id: householdId,
      log_type: "temperature",
      logged_by: userId,
      temperature: input.temperature,
      ...(input.loggedAt != null && { logged_at: input.loggedAt }),
      memo: input.memo || null,
    })
    .select("id")
    .single()

  if (error) {
    logSupabaseError("baby", "体温の記録に失敗", error, { userId, householdId })
    return { error: "体温の記録に失敗しました。", id: null }
  }
  if (!data) {
    console.error("[baby] 体温の記録: 行が返らず", { userId, householdId })
    return { error: "体温の記録に失敗しました。", id: null }
  }

  revalidatePath("/baby")
  return { error: null, id: data.id }
}

export async function recordGrowth(input: RecordGrowthInput) {
  const memoError = validateMemoLength(input.memo)
  if (memoError) return { error: memoError, id: null }
  const timeError = validateCreateLoggedAt(input.loggedAt)
  if (timeError) return { error: timeError, id: null }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error, id: null }
  const { supabase, userId, householdId } = result.context

  // B-03: 楽観 append 用に作成ログの id を返す。
  const { data, error } = await supabase
    .from("baby_logs")
    .insert({
      household_id: householdId,
      log_type: "growth",
      logged_by: userId,
      weight_g: input.weightG ?? null,
      height_cm: input.heightCm ?? null,
      ...(input.loggedAt != null && { logged_at: input.loggedAt }),
      memo: input.memo || null,
    })
    .select("id")
    .single()

  if (error) {
    logSupabaseError("baby", "成長記録に失敗", error, { userId, householdId })
    return { error: "成長記録に失敗しました。", id: null }
  }
  if (!data) {
    console.error("[baby] 成長記録: 行が返らず", { userId, householdId })
    return { error: "成長記録に失敗しました。", id: null }
  }

  revalidatePath("/baby")
  return { error: null, id: data.id }
}

export async function recordMemo(input: RecordMemoInput) {
  if (!input.memo) return { error: "メモを入力してください", id: null }
  const memoError = validateMemoLength(input.memo)
  if (memoError) return { error: memoError, id: null }
  const timeError = validateCreateLoggedAt(input.loggedAt)
  if (timeError) return { error: timeError, id: null }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error, id: null }
  const { supabase, userId, householdId } = result.context

  // B-03: 楽観 append 用に作成ログの id を返す。
  const { data, error } = await supabase
    .from("baby_logs")
    .insert({
      household_id: householdId,
      log_type: "memo",
      logged_by: userId,
      ...(input.loggedAt != null && { logged_at: input.loggedAt }),
      memo: input.memo,
    })
    .select("id")
    .single()

  if (error) {
    logSupabaseError("baby", "メモの記録に失敗", error, { userId, householdId })
    return { error: "メモの記録に失敗しました。", id: null }
  }
  if (!data) {
    console.error("[baby] メモの記録: 行が返らず", { userId, householdId })
    return { error: "メモの記録に失敗しました。", id: null }
  }

  revalidatePath("/baby")
  return { error: null, id: data.id }
}

export async function updateLog(
  logId: string,
  updates: {
    loggedAt?: string
    feedingType?: FeedingType
    amountMl?: number | null
    /**
     * 授乳時間（秒精度）。duration_min は record 系と同じく round(sec/60) で
     * サーバ側導出し両列を1経路で書く（旧 durationMin 単独更新は sec との
     * drift を生むため廃止）。null は「時間なしの授乳」= 両列 null。
     */
    durationSec?: number | null
    diaperType?: DiaperType
    endedAt?: string | null
    temperature?: number | null
    weightG?: number | null
    heightCm?: number | null
    memo?: string | null
  },
) {
  const memoError = validateMemoLength(updates.memo)
  if (memoError) return { error: memoError }

  // 授乳時間の範囲検証（DB CHECK chk_duration_sec と同じ 1..10800 秒 + 整数のみ）。
  // null は「時間なしへ戻す」で妥当。クライアント parse（parseFeedingDurationInput）
  // との二重防御としてサーバでも弾く。
  if (updates.durationSec !== undefined && updates.durationSec !== null) {
    const sec = updates.durationSec
    if (
      !Number.isInteger(sec) ||
      sec < FEEDING_DURATION_SEC_MIN ||
      sec > FEEDING_DURATION_SEC_MAX
    ) {
      return { error: "授乳時間は1秒〜180分の範囲で指定してください" }
    }
  }

  // 未来時刻の拒否（+5 分の時計ずれ許容）。auth 前に純関数で弾く（memoError と同順）。
  // クライアント検証と同一の validateLogTime を共有し判定を一致させる。
  if (updates.loggedAt !== undefined) {
    const timeError = validateLogTime(updates.loggedAt)
    if (timeError) return { error: timeError }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  // sleep ログの logged_at ≤ ended_at 整合をサーバで担保する。クライアント送信値ではなく
  // 実 DB の ended_at と突き合わせる（sleepOverlapMinutesForDate が負 overlap で壊れるのを防ぐ）。
  // loggedAt を変更する時のみ既存行の log_type / ended_at を取得して検証する。
  if (updates.loggedAt !== undefined) {
    const { data: existing, error: fetchError } = await supabase
      .from("baby_logs")
      .select("log_type, ended_at")
      .eq("id", logId)
      .eq("household_id", householdId)
      .maybeSingle()
    if (fetchError) {
      logSupabaseError("baby", "ログ更新前の取得に失敗", fetchError, {
        logId,
        householdId,
      })
      return { error: "ログの更新に失敗しました。" }
    }
    if (!existing) {
      return { error: "ログの更新に失敗しました。" }
    }
    if (existing.log_type === "sleep") {
      // endedAt も同時変更されるなら新値、そうでなければ既存値と突き合わせる。
      const effectiveEndedAt =
        updates.endedAt !== undefined ? updates.endedAt : existing.ended_at
      const orderError = validateSleepOrder(updates.loggedAt, effectiveEndedAt)
      if (orderError) return { error: orderError }
    }
  }

  // .update() は 0 行更新でも error: null を返す（別世帯・不在 id なら 0 行マッチ）。
  // .select("id").single() で更新行を要求し、0 行を「成功」と偽らないようにする。
  const { data, error } = await supabase
    .from("baby_logs")
    .update({
      ...(updates.loggedAt !== undefined && { logged_at: updates.loggedAt }),
      ...(updates.feedingType !== undefined && {
        feeding_type: updates.feedingType,
      }),
      ...(updates.amountMl !== undefined && { amount_ml: updates.amountMl }),
      ...(updates.durationSec !== undefined && {
        duration_sec: updates.durationSec,
        duration_min: deriveDurationMinFromSec(updates.durationSec),
      }),
      ...(updates.diaperType !== undefined && {
        diaper_type: updates.diaperType,
      }),
      ...(updates.endedAt !== undefined && { ended_at: updates.endedAt }),
      ...(updates.temperature !== undefined && {
        temperature: updates.temperature,
      }),
      ...(updates.weightG !== undefined && { weight_g: updates.weightG }),
      ...(updates.heightCm !== undefined && { height_cm: updates.heightCm }),
      ...(updates.memo !== undefined && { memo: updates.memo }),
    })
    .eq("id", logId)
    .eq("household_id", householdId)
    .select("id")
    .single()

  // PGRST116 は「該当行なし」= 対象ログが存在しない/別世帯という正常な失敗ゆえ
  // ログ対象外。それ以外の error は真の失敗として構造化ログに残す。
  if (error) {
    if (error.code !== "PGRST116") {
      logSupabaseError("baby", "ログの更新に失敗", error, { logId, householdId })
    }
    return { error: "ログの更新に失敗しました。" }
  }
  if (!data) {
    return { error: "ログの更新に失敗しました。" }
  }

  revalidatePath("/baby")
  return { error: null }
}

export async function deleteLog(logId: string) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  // .delete() は 0 行削除でも error: null を返す（別世帯・不在 id なら 0 行マッチ）。
  // .select("id") で削除行を要求し、0 行を「成功」と偽らないようにする。
  const { data, error } = await supabase
    .from("baby_logs")
    .delete()
    .eq("id", logId)
    .eq("household_id", householdId)
    .select("id")

  if (error) {
    logSupabaseError("baby", "ログの削除に失敗", error, { logId, householdId })
    return { error: "ログの削除に失敗しました。" }
  }
  if (!data || data.length === 0) {
    return { error: "既に削除されています。" }
  }

  revalidatePath("/baby")
  return { error: null }
}

// ---------------------------------------------------------------------------
// 育児日記（baby_diaries: 1世帯・1日1本のテキスト。ぴよログ流）
// ---------------------------------------------------------------------------

const MAX_DIARY_LENGTH = 5000
const DIARY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * その日の育児日記を保存する（1日1本、upsert 1経路）。
 * - content の trim 後が空なら「その日の日記を消す」= 行 DELETE（冪等: 行が無くても成功）。
 * - 日付キー（diary_date）ゆえ過去日の日記も作成・編集できる（ぴよログ準拠）。
 *   未来日は拒否（date nav は未来へ進めない前提の二重防御）。
 */
export async function upsertBabyDiary(diaryDate: string, content: string) {
  if (!DIARY_DATE_RE.test(diaryDate)) {
    return { error: "日付の形式が不正です", diary: null }
  }
  // YYYY-MM-DD は辞書順 = 暦順
  if (diaryDate > todayJstString()) {
    return { error: "未来の日記は書けません", diary: null }
  }
  const trimmed = content.trim()
  if (trimmed.length > MAX_DIARY_LENGTH) {
    return {
      error: `日記は${MAX_DIARY_LENGTH}文字以内で入力してください`,
      diary: null,
    }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error, diary: null }
  const { supabase, userId, householdId } = result.context

  if (trimmed === "") {
    // 空保存 = その日の日記を削除（DB CHECK も空行を禁じており、空行は残さない）。
    const { error } = await supabase
      .from("baby_diaries")
      .delete()
      .eq("household_id", householdId)
      .eq("diary_date", diaryDate)

    if (error) {
      logSupabaseError("baby", "diary delete failed", error, {
        householdId,
        diaryDate,
      })
      return { error: "日記の削除に失敗しました。もう一度お試しください。", diary: null }
    }
    revalidatePath("/baby")
    return { error: null, diary: null }
  }

  const { data, error } = await supabase
    .from("baby_diaries")
    .upsert(
      {
        household_id: householdId,
        diary_date: diaryDate,
        content: trimmed,
        updated_by: userId,
      },
      { onConflict: "household_id,diary_date" },
    )
    .select("id, diary_date, content, updated_at")
    .single()

  if (error) {
    logSupabaseError("baby", "diary upsert failed", error, {
      householdId,
      diaryDate,
    })
    return { error: "日記の保存に失敗しました。もう一度お試しください。", diary: null }
  }
  if (!data) {
    return { error: "日記の保存に失敗しました。もう一度お試しください。", diary: null }
  }

  revalidatePath("/baby")
  return { error: null, diary: data }
}

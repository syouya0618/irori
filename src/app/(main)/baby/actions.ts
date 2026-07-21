"use server"

import { revalidatePath } from "next/cache"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { deriveDurationMinFromSec } from "@/lib/domain/feeding"
import type { FeedingType, DiaperType } from "@/lib/types/database"

const MAX_MEMO_LENGTH = 1000

function validateMemoLength(memo?: string | null): string | null {
  if (memo && memo.length > MAX_MEMO_LENGTH) {
    return `メモは${MAX_MEMO_LENGTH}文字以内で入力してください`
  }
  return null
}

interface RecordFeedingInput {
  feedingType: FeedingType
  amountMl?: number | null
  /**
   * 授乳時間（秒精度）。duration_min は round(sec/60) でサーバ側導出し併記する
   * （両列を1経路で書き drift を防ぐ）。母乳/ミルク等の時間なし記録では省略する。
   */
  durationSec?: number | null
  memo?: string
}

interface RecordDiaperInput {
  diaperType: DiaperType
  memo?: string
}

interface RecordTemperatureInput {
  temperature: number
  memo?: string
}

interface RecordGrowthInput {
  weightG?: number | null
  heightCm?: number | null
  memo?: string
}

interface RecordMemoInput {
  memo: string
}

export async function recordFeeding(input: RecordFeedingInput) {
  const memoError = validateMemoLength(input.memo)
  if (memoError) return { error: memoError, id: null }

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

export async function startSleep() {
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
    durationMin?: number | null
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

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

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
      ...(updates.durationMin !== undefined && {
        duration_min: updates.durationMin,
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

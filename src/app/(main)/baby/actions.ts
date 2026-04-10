"use server"

import { revalidatePath } from "next/cache"
import { getAuthContext } from "@/lib/supabase/auth-context"
import type { FeedingType, DiaperType } from "@/lib/types/database"

interface RecordFeedingInput {
  feedingType: FeedingType
  amountMl?: number | null
  memo?: string
}

interface RecordDiaperInput {
  diaperType: DiaperType
  memo?: string
}

export async function recordFeeding(input: RecordFeedingInput) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId, householdId } = result.context

  const { error } = await supabase.from("baby_logs").insert({
    household_id: householdId,
    log_type: "feeding",
    logged_by: userId,
    feeding_type: input.feedingType,
    amount_ml: input.amountMl ?? null,
    memo: input.memo || null,
  })

  if (error) return { error: "授乳の記録に失敗しました。" }

  revalidatePath("/baby")
  return { error: null }
}

export async function recordDiaper(input: RecordDiaperInput) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId, householdId } = result.context

  const { error } = await supabase.from("baby_logs").insert({
    household_id: householdId,
    log_type: "diaper",
    logged_by: userId,
    diaper_type: input.diaperType,
    memo: input.memo || null,
  })

  if (error) return { error: "おむつの記録に失敗しました。" }

  revalidatePath("/baby")
  return { error: null }
}

export async function startSleep() {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId, householdId } = result.context

  const { error } = await supabase.from("baby_logs").insert({
    household_id: householdId,
    log_type: "sleep",
    logged_by: userId,
  })

  if (error) {
    if (error.code === "23505") {
      return { error: "既に睡眠中のセッションがあります。" }
    }
    return { error: "睡眠の記録に失敗しました。" }
  }

  revalidatePath("/baby")
  return { error: null }
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

  if (error || !data) {
    return { error: "アクティブな睡眠セッションが見つかりません。" }
  }

  revalidatePath("/baby")
  return { error: null }
}

export async function updateLog(
  logId: string,
  updates: {
    loggedAt?: string
    feedingType?: FeedingType
    amountMl?: number | null
    diaperType?: DiaperType
    endedAt?: string | null
    memo?: string | null
  },
) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  const { error } = await supabase
    .from("baby_logs")
    .update({
      ...(updates.loggedAt !== undefined && { logged_at: updates.loggedAt }),
      ...(updates.feedingType !== undefined && {
        feeding_type: updates.feedingType,
      }),
      ...(updates.amountMl !== undefined && { amount_ml: updates.amountMl }),
      ...(updates.diaperType !== undefined && {
        diaper_type: updates.diaperType,
      }),
      ...(updates.endedAt !== undefined && { ended_at: updates.endedAt }),
      ...(updates.memo !== undefined && { memo: updates.memo }),
    })
    .eq("id", logId)
    .eq("household_id", householdId)

  if (error) return { error: "ログの更新に失敗しました。" }

  revalidatePath("/baby")
  return { error: null }
}

export async function deleteLog(logId: string) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  const { error } = await supabase
    .from("baby_logs")
    .delete()
    .eq("id", logId)
    .eq("household_id", householdId)

  if (error) return { error: "ログの削除に失敗しました。" }

  revalidatePath("/baby")
  return { error: null }
}

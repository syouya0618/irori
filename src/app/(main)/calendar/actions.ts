"use server"

import { revalidatePath } from "next/cache"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { validateCalendarEventInput } from "@/lib/domain/calendar-validation"

export interface CalendarEventActionInput {
  title: string
  memo?: string | null
  isAllDay: boolean
  startDate: string // YYYY-MM-DD (JST)
  endDate: string // YYYY-MM-DD (JST, inclusive)
  startAt?: string | null // ISO(timed のみ)
  endAt?: string | null
}

export async function createCalendarEvent(input: CalendarEventActionInput) {
  const v = validateCalendarEventInput(input)
  if (v.error !== null) return { error: v.error }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId, householdId } = result.context

  const { data, error } = await supabase
    .from("calendar_events")
    .insert({
      household_id: householdId,
      title: v.value.title,
      memo: v.value.memo,
      is_all_day: v.value.isAllDay,
      start_date: v.value.startDate,
      end_date: v.value.endDate,
      start_at: v.value.startAt,
      end_at: v.value.endAt,
      source: "native",
      created_by: userId,
    })
    .select("id")
    .single()

  // error と「行なし」を分離: logSupabaseError は非 null の PostgrestError を要求
  // するため error! を渡さない。
  if (error) {
    logSupabaseError("calendar", "create failed", error, { userId, householdId })
    return { error: "予定の作成に失敗しました。もう一度お試しください。" }
  }
  if (!data) {
    console.error("[calendar] create returned no row", { userId, householdId })
    return { error: "予定の作成に失敗しました。もう一度お試しください。" }
  }

  revalidatePath("/calendar")
  return { error: null, eventId: data.id }
}

export async function updateCalendarEvent(
  input: CalendarEventActionInput & { id: string },
) {
  const v = validateCalendarEventInput(input)
  if (v.error !== null) return { error: v.error }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  // .update は 0 行でも error:null のため .select で行数を検証し silent fail を防ぐ。
  // source='native' 絞りで同期(google)行の改変も弾く(RLS でも弾かれるが二重防御)。
  const { data, error } = await supabase
    .from("calendar_events")
    .update({
      title: v.value.title,
      memo: v.value.memo,
      is_all_day: v.value.isAllDay,
      start_date: v.value.startDate,
      end_date: v.value.endDate,
      start_at: v.value.startAt,
      end_at: v.value.endAt,
    })
    .eq("id", input.id)
    .eq("household_id", householdId)
    .eq("source", "native")
    .select("id")

  if (error) {
    logSupabaseError("calendar", "update failed", error, { id: input.id, householdId })
    return { error: "予定の更新に失敗しました。もう一度お試しください。" }
  }
  if (!data || data.length === 0) {
    return { error: "この予定は編集できません（同期予定か、権限がありません）。" }
  }

  revalidatePath("/calendar")
  return { error: null }
}

export async function deleteCalendarEvent(id: string) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  const { data, error } = await supabase
    .from("calendar_events")
    .delete()
    .eq("id", id)
    .eq("household_id", householdId)
    .eq("source", "native")
    .select("id")

  if (error) {
    logSupabaseError("calendar", "delete failed", error, { id, householdId })
    return { error: "予定の削除に失敗しました。もう一度お試しください。" }
  }
  if (!data || data.length === 0) {
    return { error: "この予定は削除できません（同期予定か、権限がありません）。" }
  }

  revalidatePath("/calendar")
  return { error: null }
}

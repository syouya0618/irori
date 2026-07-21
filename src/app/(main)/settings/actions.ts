"use server"

import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { getAppOrigin } from "@/lib/utils/app-origin"
import { isFutureJstDate } from "@/lib/utils/date-jst"
import { logSupabaseError } from "@/lib/supabase/log-error"
import {
  PUMPING_INTERVAL_DEFAULT,
  normalizePumpingInterval,
} from "@/lib/domain/baby-pumping"

export async function updateProfile(formData: FormData) {
  const displayName = formData.get("display_name")

  if (typeof displayName !== "string" || displayName.trim().length === 0) {
    return { error: "表示名を入力してください" }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId } = result.context

  const { error } = await supabase
    .from("profiles")
    .update({ display_name: displayName.trim() })
    .eq("id", userId)

  if (error) {
    return { error: "プロフィールの更新に失敗しました" }
  }

  return { success: true }
}

export async function generateInvite() {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId, householdId } = result.context

  const { data: invitation, error } = await supabase
    .from("invitations")
    .insert({
      household_id: householdId,
      invited_by: userId,
      role: "member",
    })
    .select("token")
    .single()

  if (error || !invitation) {
    return { error: "招待リンクの生成に失敗しました" }
  }

  const baseUrl = getAppOrigin()
  const inviteUrl = `${baseUrl}/invite/${invitation.token}`

  return { success: true, url: inviteUrl }
}

export async function approveUser(targetUserId: string) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase } = result.context

  const { error } = await supabase.rpc("approve_user", {
    target_user_id: targetUserId,
  })

  if (error) {
    if (error.message.includes("Only owners")) {
      return { error: "承認権限がありません" }
    }
    return { error: "承認に失敗しました" }
  }

  return { success: true }
}

import { VALID_PAGES, type ValidPage } from "@/lib/constants/pages"
import type { ItemCategory } from "@/lib/types/database"

const VALID_STOCK_CATEGORIES: ItemCategory[] = [
  "baby", "cleaning", "hygiene", "other_daily",
]

export async function updateDefaultPage(page: string) {
  if (!VALID_PAGES.includes(page as ValidPage)) {
    return { error: "無効なページ指定です" }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId } = result.context

  const { error } = await supabase
    .from("profiles")
    .update({ default_page: page })
    .eq("id", userId)

  if (error) {
    return { error: "設定の更新に失敗しました" }
  }

  return { success: true }
}

export async function updateAutoStockCategories(categories: ItemCategory[]) {
  // バリデーション: 全てが有効なカテゴリであること
  const valid = categories.every((c) => VALID_STOCK_CATEGORIES.includes(c))
  if (!valid) {
    return { error: "無効なカテゴリが含まれています" }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  const { error } = await supabase
    .from("households")
    .update({ auto_stock_categories: categories })
    .eq("id", householdId)

  if (error) {
    return { error: "設定の更新に失敗しました" }
  }

  return { success: true }
}

export async function updateBabyProfile(formData: FormData) {
  const babyName = formData.get("baby_name")
  const babyBirthDate = formData.get("baby_birth_date")
  const pumpingIntervalRaw = formData.get("pumping_interval_min")

  if (typeof babyName !== "string") {
    return { error: "名前を入力してください" }
  }

  // 搾乳間隔（分）。未送信時は既定を維持。範囲外・不正値は明確に弾く。
  let pumpingIntervalValue = PUMPING_INTERVAL_DEFAULT
  if (typeof pumpingIntervalRaw === "string" && pumpingIntervalRaw.trim() !== "") {
    const normalized = normalizePumpingInterval(Number(pumpingIntervalRaw))
    if (normalized === null) {
      return { error: "搾乳間隔の値が不正です" }
    }
    pumpingIntervalValue = normalized
  }

  let birthDateValue: string | null = null
  if (typeof babyBirthDate === "string" && babyBirthDate.trim() !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(babyBirthDate)) {
      return { error: "生年月日の形式が不正です" }
    }
    // JST 基準で未来日を拒否する。DB 側 CHECK（chk_baby_birth_date）は
    // CURRENT_DATE（UTC）基準のため単独では JST 当日を弾く窓があるが、
    // その是正（CHECK の JST 化）は I-09a の migration 管轄。本 PR は
    // アプリ層で JST 未来日を先に弾き、明確な文言を返す。
    if (isFutureJstDate(babyBirthDate)) {
      return { error: "誕生日には今日以前の日付を指定してください" }
    }
    birthDateValue = babyBirthDate
  }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  const { error } = await supabase
    .from("households")
    .update({
      baby_name: babyName.trim() || null,
      baby_birth_date: birthDateValue,
      pumping_interval_min: pumpingIntervalValue,
    })
    .eq("id", householdId)

  if (error) {
    logSupabaseError("settings", "baby profile update failed", error, {
      householdId,
    })
    // 23514 = CHECK 制約違反（chk_baby_birth_date）。DB の CURRENT_DATE は
    // UTC 基準のため、JST 00:00〜08:59 に当日を登録すると UTC ではまだ前日で
    // baby_birth_date <= CURRENT_DATE を満たさず弾かれる。汎用文言に化けさせず
    // 誕生日起因と分かる文言を返す（DB 側 CHECK の JST 化は I-09a 管轄）。
    if (error.code === "23514") {
      return { error: "誕生日には今日以前の日付を指定してください" }
    }
    return { error: "赤ちゃん情報の更新に失敗しました" }
  }

  return { success: true }
}

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect("/login")
}

"use server"

import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getAuthContext } from "@/lib/supabase/auth-context"

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

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
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

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect("/login")
}

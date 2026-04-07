"use server"

import { createClient } from "@/lib/supabase/server"

export async function createHousehold(name: string) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { error: "認証されていません。ログインしてください。" }
  }

  // Create household
  const { data: household, error: householdError } = await supabase
    .from("households")
    .insert({ name })
    .select("id")
    .single()

  if (householdError || !household) {
    return { error: "世帯の作成に失敗しました。もう一度お試しください。" }
  }

  // Update profile with household_id and role
  const { error: profileError } = await supabase
    .from("profiles")
    .update({
      household_id: household.id,
      role: "owner" as const,
    })
    .eq("id", user.id)

  if (profileError) {
    return { error: "プロフィールの更新に失敗しました。もう一度お試しください。" }
  }

  return { error: null }
}

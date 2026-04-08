"use server"

import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"

export async function createHousehold(name: string) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { error: "認証されていません。ログインしてください。" }
  }

  const householdId = crypto.randomUUID()

  const { error: householdError } = await supabase
    .from("households")
    .insert({ id: householdId, name })

  if (householdError) {
    return { error: "世帯の作成に失敗しました。もう一度お試しください。" }
  }

  // .select("id").single() で更新が実際に1行影響したことを検証。
  // 0行影響（プロフィール未存在等）の場合 PGRST116 エラーで検知する。
  const { error: profileError } = await supabase
    .from("profiles")
    .update({
      household_id: householdId,
      role: "owner" as const,
    })
    .eq("id", user.id)
    .select("id")
    .single()

  if (profileError) {
    return { error: "プロフィールの更新に失敗しました。もう一度お試しください。" }
  }

  revalidatePath("/meals")
  redirect("/meals")
}

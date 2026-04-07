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

  // UUID をサーバー側で生成し、INSERT 後の SELECT を回避
  // （INSERT は RLS 許可だが、SELECT は household_id 一致が必要で、
  //  この時点では profile.household_id が NULL のため SELECT が失敗する）
  const householdId = crypto.randomUUID()

  const { error: householdError } = await supabase
    .from("households")
    .insert({ id: householdId, name })

  if (householdError) {
    return { error: "世帯の作成に失敗しました。もう一度お試しください。" }
  }

  // Update profile with household_id and role
  const { error: profileError } = await supabase
    .from("profiles")
    .update({
      household_id: householdId,
      role: "owner" as const,
    })
    .eq("id", user.id)

  if (profileError) {
    return { error: "プロフィールの更新に失敗しました。もう一度お試しください。" }
  }

  return { error: null }
}

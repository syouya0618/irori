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

  // 世帯作成は SECURITY DEFINER 関数 create_household 経由で行う。
  // profiles の household_id / role / is_approved はユーザーが直接書込不可
  // （列権限で制限）であり、世帯の作成・owner 付与・自動承認をこの関数が
  // アトミックに実施する。
  const { error } = await supabase.rpc("create_household", { p_name: name })

  if (error) {
    console.error("createHousehold failed", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    })
    return { error: "世帯の作成に失敗しました。もう一度お試しください。" }
  }

  revalidatePath("/meals")
  redirect("/meals")
}

"use server"

import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"

export async function acceptInvitation(invitationId: string) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { error: "認証されていません。ログインしてください。" }
  }

  // SECURITY DEFINER 関数でアトミックに招待を承認
  // バリデーション（期限切れ・重複参加・ステータス）は全てDB関数内で実行
  const { error } = await supabase.rpc("accept_invitation", {
    invitation_uuid: invitationId,
  })

  if (error) {
    const message = error.message
    if (message.includes("already belongs")) {
      return { error: "すでに世帯に参加しています。" }
    }
    if (message.includes("not pending")) {
      return { error: "この招待は無効です。" }
    }
    if (message.includes("expired")) {
      return { error: "招待の有効期限が切れています。" }
    }
    if (message.includes("not found")) {
      return { error: "この招待は無効です。" }
    }
    return { error: "世帯への参加に失敗しました。もう一度お試しください。" }
  }

  revalidatePath("/meals")
  redirect("/meals")
}

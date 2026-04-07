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

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect("/login")
}

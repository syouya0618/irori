"use server"

import { createClient } from "@/lib/supabase/server"

export async function acceptInvitation(invitationId: string) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { error: "認証されていません。ログインしてください。" }
  }

  // Double-check user doesn't already belong to a household
  const { data: profile } = await supabase
    .from("profiles")
    .select("household_id")
    .eq("id", user.id)
    .single()

  if (profile?.household_id) {
    return { error: "すでに世帯に参加しています。" }
  }

  // Verify invitation is still valid — use DB values for role and household_id
  const { data: invitation } = await supabase
    .from("invitations")
    .select("id, status, expires_at, role, household_id")
    .eq("id", invitationId)
    .single()

  if (!invitation || invitation.status !== "pending") {
    return { error: "この招待は無効です。" }
  }

  if (new Date(invitation.expires_at) < new Date()) {
    return { error: "招待の有効期限が切れています。" }
  }

  // Update profile with household_id and role from the DB invitation
  const { error: profileError } = await supabase
    .from("profiles")
    .update({
      household_id: invitation.household_id,
      role: invitation.role,
    })
    .eq("id", user.id)

  if (profileError) {
    return { error: "世帯への参加に失敗しました。もう一度お試しください。" }
  }

  // Mark invitation as accepted
  const { error: invitationError } = await supabase
    .from("invitations")
    .update({
      status: "accepted" as const,
      accepted_by: user.id,
    })
    .eq("id", invitationId)

  if (invitationError) {
    return { error: "招待の更新に失敗しました。" }
  }

  return { error: null }
}

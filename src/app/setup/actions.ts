"use server"

import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { extractInviteToken } from "@/lib/utils/invite-token"

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

/**
 * 招待リンク/コードを貼り付けて既存世帯に参加する（/setup の逸路）。
 *
 * 招待受諾が完了せず「承認済み・世帯なし」で /setup に落ちたユーザーを救う。
 * `accept_invitation` は profile が household_id IS NULL であれば通り
 * （is_approved の値は前提にせず true を冪等セット）、/setup は household_id IS
 * NULL の時のみ表示されるため、/setup に来た全ユーザーで機能する。
 * バリデーション（期限切れ・重複参加・ステータス）は DB 関数内でアトミック。
 */
export async function joinByInviteToken(rawInput: string) {
  const token = extractInviteToken(rawInput)
  if (!token) {
    return { error: "招待リンクまたはコードが正しくありません。" }
  }

  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { error: "認証されていません。ログインしてください。" }
  }

  // token から招待を引く（get_invitation_by_token は SECURITY DEFINER）。
  // token は secret ゆえ構造化ログには含めない（userId のみ）。
  const { data: invitations, error: lookupError } = await supabase.rpc(
    "get_invitation_by_token",
    { invite_token: token }
  )

  if (lookupError) {
    console.error("joinByInviteToken lookup failed", {
      message: lookupError.message,
      code: lookupError.code,
      details: lookupError.details,
      hint: lookupError.hint,
      userId: user.id,
    })
    return { error: "招待の確認に失敗しました。もう一度お試しください。" }
  }

  const invitation = invitations?.[0]
  if (!invitation) {
    return { error: "この招待リンクは無効です。正しいリンクを確認してください。" }
  }

  const { error: acceptError } = await supabase.rpc("accept_invitation", {
    invitation_uuid: invitation.id,
  })

  if (acceptError) {
    const message = acceptError.message
    if (message.includes("already belongs")) {
      return { error: "すでに世帯に参加しています。" }
    }
    if (message.includes("not pending")) {
      return { error: "この招待は使用済みです。" }
    }
    if (message.includes("expired")) {
      return { error: "招待の有効期限が切れています。" }
    }
    if (message.includes("not found")) {
      return { error: "この招待は無効です。" }
    }
    console.error("joinByInviteToken accept failed", {
      message: acceptError.message,
      code: acceptError.code,
      details: acceptError.details,
      hint: acceptError.hint,
      userId: user.id,
    })
    return { error: "世帯への参加に失敗しました。もう一度お試しください。" }
  }

  revalidatePath("/meals")
  redirect("/meals")
}

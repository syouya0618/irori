"use server"

import { getAuthContext } from "@/lib/supabase/auth-context"
import { isClientId } from "@/lib/utils/client-id"

export async function createChildShare(form: FormData) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const child = String(form.get("child_id") ?? "")
  const until = String(form.get("until") ?? "")
  if (!isClientId(child) || (until && !Number.isFinite(Date.parse(until)))) return { error: "子どもと期限を確認してください" }
  const { data, error } = await result.context.supabase.rpc("create_child_share", {
    p_child_id: child, p_daily: form.get("daily") === "on", p_diary: form.get("diary") === "on",
    p_health: form.get("health") === "on", p_custom: form.get("custom") === "on",
    p_until: until ? new Date(until).toISOString() : null,
  })
  if (error || !data || typeof data !== "object" || Array.isArray(data) || typeof data.token !== "string" || !/^[a-f0-9]{64}$/.test(data.token)) return { error: "招待を作成できませんでした。世帯オーナーの権限と期限を確認してください" }
  return { path: `/invite/${data.token}/shared` }
}
export async function revokeChildShare(id: string) {
  if (!isClientId(id)) return { error: "共有の指定が不正です" }
  const auth = await getAuthContext()
  if (auth.error !== null) return { error: auth.error }
  const { data, error } = await auth.context.supabase.rpc("revoke_child_share", { p_share_id: id })
  return error || data !== true ? { error: "共有の取消を確認できませんでした" } : { success: true }
}

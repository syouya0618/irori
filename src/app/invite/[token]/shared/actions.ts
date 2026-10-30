"use server"

import { createClient } from "@/lib/supabase/server"
import { getVerifiedUserId } from "@/lib/supabase/verified-user"

export async function acceptChildShare(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return { error: "無効な招待です" }
  const client = await createClient()
  if (!await getVerifiedUserId(client, "shared-invite")) return { error: "ログインしてください" }
  const { data, error } = await client.rpc("accept_child_share", { p_token: token })
  return error || !data ? { error: "この招待は利用できません。期限・取消・利用済みの状態を招待者へ確認してください" } : { id: data }
}

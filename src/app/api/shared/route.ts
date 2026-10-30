import { createClient } from "@/lib/supabase/server"
import { getVerifiedUserId } from "@/lib/supabase/verified-user"
export const dynamic = "force-dynamic"
const headers = { "Cache-Control": "private, no-store, max-age=0", "Vary": "Cookie", "Pragma": "no-cache" }
export async function GET() {
  const client = await createClient()
  if (!await getVerifiedUserId(client,"shared-list")) return Response.json({ error: "ログインしてください" },{ status: 401, headers })
  const { data, error } = await client.rpc("list_child_shares", { p_owned: false })
  return error ? Response.json({ error: "共有を取得できませんでした" },{ status: 503, headers }) : Response.json(data, { headers })
}

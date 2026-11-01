import { createClient } from "@/lib/supabase/server"
import { getVerifiedUserId } from "@/lib/supabase/verified-user"
import { isClientId } from "@/lib/utils/client-id"
export const dynamic = "force-dynamic"
const headers = { "Cache-Control": "private, no-store, max-age=0", "Vary": "Cookie", "Pragma": "no-cache" }
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isClientId(id)) return Response.json({ error: "共有は利用できません" },{ status: 403, headers })
  const client = await createClient()
  if (!await getVerifiedUserId(client,"shared-api")) return Response.json({ error: "ログインしてください" },{ status: 401, headers })
  const { data, error } = await client.rpc("shared_child_snapshot", { p_share_id: id })
  return error || !data ? Response.json({ error: "共有は失効したか、確認できませんでした" },{ status: 403, headers }) : Response.json(data, { headers })
}

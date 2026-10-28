import { getAuthContext } from "@/lib/supabase/auth-context"
// 拒否理由 → HTTP status は書き出し・PDF と同じ 1 表（401 はログインし直せば直る時だけ）
import { AUTH_DENIAL_HTTP_STATUS } from "@/lib/auth/auth-denial-status"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { parseLookupIds, selectBabyLogsByIds } from "@/lib/domain/baby-log-lookup"

/**
 * 応答不明の保存の照合（読みだけ）。`GET /api/baby-logs/lookup?id=<uuid>&id=<uuid>`。
 *
 * Server Action の直列送信の列に並ばぬ照合経路じゃ（`@/lib/domain/baby-log-lookup` の注記）。
 * 書き込みも送り直しもせぬ — 見つかった行（自世帯の確定値）を返すだけ。見つからぬことは
 * 「保存されなかった」の断定ではない（応答を失った要求がまだ処理中でありうる）。
 *
 * 認可は書き出しと同じ getAuthContext（未認証 401 / 未承認・世帯なし 403 / 取得失敗 503）と RLS。
 * 応答は no-store（個人データ。SW も /api/ を素通しする）。
 */
export async function GET(request: Request) {
  const ids = parseLookupIds(new URL(request.url).searchParams.getAll("id"))
  if (!ids) return new Response("Invalid id", { status: 400 })

  const result = await getAuthContext()
  if (result.error !== null) {
    return new Response(result.error, { status: AUTH_DENIAL_HTTP_STATUS[result.reason] })
  }
  const { supabase, householdId } = result.context

  const { logs, error } = await selectBabyLogsByIds(supabase, householdId, ids)
  if (error) {
    logSupabaseError("baby", "保存の照合（GET）に失敗", error, { householdId, count: ids.length })
    return new Response("Lookup failed", { status: 500 })
  }
  return Response.json(
    { logs },
    { headers: { "Cache-Control": "no-store" } },
  )
}

import type { AuthContext } from "@/lib/supabase/auth-context"
import { BABY_LOG_COLUMNS } from "@/lib/domain/baby-log-columns"
import { isClientId } from "@/lib/utils/client-id"
import type { BabyLogData } from "@/lib/types/baby"

/**
 * 応答不明の保存（`@/lib/domain/save-attempt` の unknown）の照合に使う、id 指定の**読み**。
 * Server Action（findBabyLogsByIds）と Route Handler（GET /api/baby-logs/lookup）が共有する。
 *
 * 照合を Route Handler でも引ける理由: Next.js は Server Action をクライアントごとに一つずつ
 * 直列に送る（同梱 docs `02-guides/server-actions.md`「Sequential dispatch on the client」）。
 * 応答の返らぬ記録の Action の後ろに照合の Action を並べると、照合も同じだけ待たされ、利用者は
 * 「記録中」のまま固まる。GET は Action の列に並ばず、期限と取消しを持てる。
 *
 * 世帯は呼び出し側が getAuthContext から渡す（引数の世帯を信じぬ）。RLS と household_id の
 * 明示フィルタの二重。別世帯の id は「見つからぬ」と同じ応答になる（存在を漏らさぬ）。
 */
export const LOOKUP_MAX_IDS = 20

export function parseLookupIds(ids: unknown): string[] | null {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > LOOKUP_MAX_IDS) return null
  if (!ids.every((id) => typeof id === "string" && isClientId(id))) return null
  return [...new Set(ids as string[])]
}

export async function selectBabyLogsByIds(
  supabase: AuthContext["supabase"],
  householdId: string,
  ids: string[],
) {
  const { data, error } = await supabase
    .from("baby_logs")
    .select(BABY_LOG_COLUMNS)
    .eq("household_id", householdId)
    .in("id", ids)
  return { logs: (data ?? []) as BabyLogData[], error }
}

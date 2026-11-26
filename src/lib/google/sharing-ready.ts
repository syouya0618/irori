import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"

/** Fail closed until BOTH sharing migrations have been applied. */
export const GOOGLE_SHARING_NOT_READY = "Google カレンダーの共有設定を確認できません。少し時間をおいて再試行してください。"

export async function googleSharingReady(supabase: SupabaseClient<Database>): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("google_sharing_schema_ready", {})
    if (error) {
      console.warn("[google-sharing] schema readiness check failed", { code: error.code })
      return false
    }
    return data === true
  } catch {
    return false
  }
}

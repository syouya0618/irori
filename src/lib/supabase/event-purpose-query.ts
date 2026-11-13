import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"
import {
  EVENT_PURPOSE_COLUMNS,
  eventPurposeLoadOf,
  type EventPurposeLoad,
} from "@/lib/domain/garbage"
import { logSupabaseError } from "@/lib/supabase/log-error"

/**
 * 世帯の予定の用途（ごみの日）を一括で読む。予定を一覧で描く 4 箇所（カレンダーの SSR / client
 * refetch、育児ホームの SSR / client refetch）とごみの画面が、同じ列・同じ条件で読むための
 * 唯一の組み立て場所じゃ。
 *
 * **決して throw せぬ・予定の表示を倒さぬ**: 失敗（表が未適用の環境・通信断・中断）は
 * `{ status: "failed" }` として返す。呼び出し側はそれを「未分類」と描かず「不明」として扱う。
 * 行数は「分類したシリーズ数 + 例外の数」で小さい（月の窓で絞らぬ = 鍵で結ぶため絞れぬ）。
 *
 * 境界指令を持たぬ中立モジュール（Server Component と Client Component の両方から値 import する）。
 *
 * @param signal client の取り直し用（次の取り直し・unmount で古い要求を捨てる）。サーバでは渡さぬ
 */
export async function fetchEventPurposeLoad(
  supabase: SupabaseClient<Database>,
  householdId: string,
  signal?: AbortSignal,
): Promise<EventPurposeLoad> {
  try {
    const { data, error } = await (signal
      ? supabase
          .from("event_purposes")
          .select(EVENT_PURPOSE_COLUMNS)
          .eq("household_id", householdId)
          .abortSignal(signal)
      : supabase
          .from("event_purposes")
          .select(EVENT_PURPOSE_COLUMNS)
          .eq("household_id", householdId))
    if (error) {
      // 中断（次の取り直し・離脱）は失敗として記録せぬ
      if (!signal?.aborted) {
        logSupabaseError("garbage", "event purposes lookup failed", error, { householdId })
      }
      return { status: "failed" }
    }
    return eventPurposeLoadOf(data, false)
  } catch (err) {
    if (!signal?.aborted) {
      console.error("[garbage] event purposes lookup threw", {
        householdId,
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return { status: "failed" }
  }
}

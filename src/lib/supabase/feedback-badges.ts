import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"
import { logSupabaseError } from "@/lib/supabase/log-error"

type Client = SupabaseClient<Database>

/**
 * 設定画面・一覧の「件数の目印」。**読めなかった時は null**（「0 件」と偽らぬ）。
 *
 * どちらも認証済みクライアントで数える。行の可視範囲は RLS（投稿者本人 or 運用者）が
 * 決めるゆえ、ここで service role を使ってはならぬ。
 */

/** 自分の要望のうち、運用者の更新を**まだ見ておらぬ**件数。 */
export async function countMyUnseenFeedback(
  supabase: Client,
  userId: string,
): Promise<number | null> {
  const { count, error } = await supabase
    .from("feedback_items")
    .select("id", { count: "exact", head: true })
    .eq("submitter_id", userId)
    .eq("submitter_has_unseen", true)
  if (error) {
    logSupabaseError("feedback", "unseen feedback count failed", error, { userId })
    return null
  }
  return typeof count === "number" ? count : null
}

/**
 * 受信箱の未読（どの運用者もまだ開いておらぬ）件数。**運用者だと分かった時だけ**呼ぶこと
 * —— 運用者でなければ RLS が自分の行だけを見せ、件数の意味が変わる。
 */
export async function countUnreadInbox(supabase: Client): Promise<number | null> {
  const { count, error } = await supabase
    .from("feedback_items")
    .select("id", { count: "exact", head: true })
    .is("operator_seen_at", null)
  if (error) {
    logSupabaseError("feedback", "unread inbox count failed", error)
    return null
  }
  return typeof count === "number" ? count : null
}

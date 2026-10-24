import { createClient } from "@/lib/supabase/server"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { getVerifiedUserId } from "@/lib/supabase/verified-user"
import { PendingContent } from "./pending-content"

/**
 * 承認待ち画面。承認状態は**ここで読み直す**（F1 / F3 / REG-05）。
 *
 * proxy は profiles の取得が一過性に失敗した時も `profile?.is_approved ?? false` で
 * 承認済みの世帯員をここへ 307 する。ゆえに「ここに居る = 承認待ち」とは限らぬ。
 * PendingContent の世帯キャッシュ破棄は、読めて・`is_approved === false`・世帯なし
 * の時だけ許す。読めぬ時は「承認待ち」と断定せず確認を促す（画面は使えるまま）。
 *
 * getAuthContext を使わぬのは、not-approved を household_id より先に返すため、
 * 破棄の判定に要る「世帯の有無」が見えぬからじゃ。
 *
 * ⚠️ 読めぬ時・承認済みの時に `/` 等へ redirect してはならぬ。proxy の取得が失敗し
 * 続けておれば proxy → ここ → `/` → proxy … と跳ね合う。回復は「承認状態を確認」
 * （router.refresh で proxy を通し直す）に任せる。
 */
export default async function PendingApprovalPage() {
  const supabase = await createClient()
  // proxy と同じ判定源を使う（別方式にすると食い違いで無限リダイレクトになる）
  const userId = await getVerifiedUserId(supabase, "pending-approval")

  if (!userId) {
    return <PendingContent approvalStatus="unconfirmed" allowCachePurge={false} />
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("is_approved, household_id")
    .eq("id", userId)
    .single()

  if (profileError) {
    logSupabaseError("pending-approval", "profile lookup failed", profileError, {
      userId,
    })
  }

  // 「明示的に false と読めた時だけ」承認待ちと断定する（auth-context と同じ流儀）
  const confirmedPending = !profileError && profile?.is_approved === false

  return (
    <PendingContent
      approvalStatus={confirmedPending ? "pending" : "unconfirmed"}
      // 世帯を持つ未承認者（承認の取り消し等）のキャッシュは本人の世帯のものかもしれぬ
      allowCachePurge={confirmedPending && profile.household_id === null}
    />
  )
}

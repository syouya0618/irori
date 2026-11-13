import { ShoppingView } from "@/components/chores/meals/shopping/shopping-view"
import { KeepLastGood } from "@/components/chores/shared/keep-last-good"
import { MealContextError } from "@/lib/meals/server/context"
import { loadShoppingView } from "@/lib/meals/server/plan-views"
import { getAuthContext } from "@/lib/supabase/auth-context"

/**
 * 買い物（/chores/meals/shopping）。売場ごとの「まだ買うもの」、購入済み、献立から不要になった項目。
 *
 * - 必要量・残り・「リストが古いか」はサーバーで計算する（食材辞書・レシピのカタログを画面の
 *   bundle へ載せない）。残り = 必要量 −（購入量 − 在庫へ足した量）。
 * - 読めなかったときは `KeepLastGood` へ理由を渡す（「買うものなし」と偽らない）。初回の表示なら
 *   error boundary、表示済みの画面の取り直し（定期・復帰時）なら直前のリストを保って
 *   「更新できませんでした」を出す。**ここから throw しないこと** — 店内の不安定な回線で
 *   取り直しが 1 度失敗しただけで、見ていたリストと開いたシートの入力が消える。
 * - 見出し（h1）と外枠の余白は layout が持つ。
 *
 * 認証・承認・世帯は (main)/layout が遷移で受ける。
 */
export default async function MealShoppingPage() {
  const { context } = await getAuthContext()
  if (!context) return null
  const { supabase, userId, householdId } = context

  const loaded = await loadShoppingView(supabase, householdId)
  const scope = `shopping:${userId}:${householdId}`
  if (!loaded.ok) return <KeepLastGood scope={scope} failure={new MealContextError(loaded.failures).message} />

  return (
    <KeepLastGood scope={scope}>
      <ShoppingView
        // 持ち主（利用者・世帯）が替われば、画面の状態と保存の手順ごと作り直す
        key={`${userId}:${householdId}`}
        owner={{ userId, householdId }}
        view={loaded.view}
      />
    </KeepLastGood>
  )
}

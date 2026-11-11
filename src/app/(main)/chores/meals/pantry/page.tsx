import { genericInfoFrom, toPantryItemViews } from "@/components/chores/meals/pantry/pantry-item-view"
import { PantryView } from "@/components/chores/meals/pantry/pantry-view"
import { KeepLastGood } from "@/components/chores/shared/keep-last-good"
import { MealContextError, loadMealContext } from "@/lib/meals/server/context"
import { getAuthContext } from "@/lib/supabase/auth-context"

/**
 * 食材（/chores/meals/pantry）。世帯の在庫を読み、期限・確認の古さ・食材の一覧との結び付きを
 * サーバーで判定して画面へ渡す（「今日」は JST。端末の時計に依らない）。
 *
 * - 読めなければ `KeepLastGood` へ理由を渡す（「食材なし」と言い換えない）。初回の表示なら
 *   ごはんの error boundary、表示済みの画面の取り直し（定期・復帰時）なら直前の内容を保って
 *   「更新できませんでした」を出す。**ここから throw しないこと** — 取り直しの失敗で error boundary
 *   が画面を置き換え、書きかけのまとめ入力と確認中の下書きが消える。
 * - 行は届いたが解釈できない食材は、件数を画面に出す（消えたと見せない）。
 * - 見出し（h1）と外枠の余白は `meals/layout.tsx` が持つ。ここは区画（h2 から）だけを返す。
 *
 * 認証・承認・世帯は (main)/layout が遷移で受ける。子ども閲覧招待（viewer）は layout が
 * /shared へ送り、RLS も SELECT を返さない。
 */
export default async function PantryPage() {
  const { context } = await getAuthContext()
  if (!context) return null
  const { supabase, userId, householdId } = context

  const scope = `pantry:${userId}:${householdId}`
  const loaded = await loadMealContext(supabase, householdId, { include: ["pantry"] })
  if (!loaded.ok) return <KeepLastGood scope={scope} failure={new MealContextError(loaded.failures).message} />
  const ctx = loaded.context
  const items = toPantryItemViews(
    ctx.pantry,
    ctx.today,
    (id) => ctx.lookup.index.byId.get(id)?.name,
    // 総称（「豚肉」「きのこ」）で登録した食材は、材料に数えていないことと直し方を行に出す
    genericInfoFrom(ctx.lookup.index.byId),
  )

  return (
    <KeepLastGood scope={scope}>
      <PantryView
        // 持ち主（利用者・世帯）が替われば、画面の状態と保存の手順ごと作り直す
        key={`${userId}:${householdId}`}
        owner={{ userId, householdId }}
        today={ctx.today}
        items={items}
        unreadable={ctx.unreadable.pantry ?? 0}
      />
    </KeepLastGood>
  )
}

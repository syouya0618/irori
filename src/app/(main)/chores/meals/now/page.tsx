import { NowView } from "@/components/chores/meals/now/now-view"
import { AddToPlanProvider } from "@/components/chores/meals/shared/add-to-plan"
import { loadAddToPlanSlots } from "@/components/chores/meals/shared/add-to-plan-load"
import { RefreshOnVisible } from "@/components/chores/shared/refresh-on-visible"
import { loadMealContext, requireMealContext } from "@/lib/meals/server/context"
import { mealToday } from "@/lib/meals/server/today"
import { NOW_VIEW_PARTS, buildNowView } from "@/lib/meals/server/views"
import { getAuthContext } from "@/lib/supabase/auth-context"

/**
 * 今あるもので（/chores/meals/now）。在庫・常備品・使わない食材・好み・食後評価から、
 * 揃う候補（基本 3 案）・分量を確認・買い足せば作れる、を別の枠で出す。
 *
 * - 計算はサーバーで行う（食材辞書とレシピを画面の bundle に載せない）。生成 AI は使わない。
 * - 読めなければ throw（ごはんの error boundary が受ける）。読めていない在庫・除外を「無い」として
 *   提案しない（使わない食材を 1 件でも読めなければ、提案そのものを出さない）。
 *   **他の画面のように `KeepLastGood` で直前の内容を保たぬ**（R34）: この画面には失う入力が無く、
 *   取り直しに失敗した時に古い提案を残すと、その間に家族が足したアレルギーの除外が効いておらぬ
 *   料理を出し続けうる。安全の側（提案を出さぬ）を採る。
 * - 候補を献立へ入れる操作（R48）のために、今日からの献立の空きを別に読む。**読めなくても提案は出す**
 *   （その場合は「献立に入れる」の釦を出さないだけ。献立を読めないことで提案を倒さない）。
 * - 見出し（h1）と外枠の余白は `meals/layout.tsx` が持つ。
 */
export default async function MealsNowPage() {
  const { context } = await getAuthContext()
  if (!context) return null
  const { supabase, userId, householdId } = context

  const today = mealToday()
  const [loaded, slots] = await Promise.all([
    loadMealContext(supabase, householdId, { include: NOW_VIEW_PARTS, today }),
    loadAddToPlanSlots(supabase, householdId, today),
  ])
  const view = buildNowView(requireMealContext(loaded))

  return (
    <>
      {slots === null ? (
        <NowView view={view} />
      ) : (
        <AddToPlanProvider
          // 持ち主（利用者・世帯）が替われば、保存の手順ごと作り直す
          key={`${userId}:${householdId}`}
          owner={{ userId, householdId }}
          slots={slots}
        >
          <NowView view={view} />
        </AddToPlanProvider>
      )}
      <RefreshOnVisible />
    </>
  )
}

import { PlanView } from "@/components/chores/meals/plan/plan-view"
import { PLAN_START_PARAM, resolvePlanStart } from "@/components/chores/meals/plan/plan-query"
import { KeepLastGood } from "@/components/chores/shared/keep-last-good"
import { MealContextError } from "@/lib/meals/server/context"
import { loadMealAiStatus } from "@/lib/meals/server/plan-views"
import { mealToday } from "@/lib/meals/server/today"
import { getAuthContext } from "@/lib/supabase/auth-context"

import { loadPlanPageData } from "./plan-page-data"

/**
 * AI 補助（希望の文の読み取り）は最悪 8 秒 × 2 回 + 待ち時間かかる。Server Action の timeout は
 * page の値で決まる（`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
 * 02-route-segment-config/maxDuration.md`）。
 */
export const maxDuration = 30

/**
 * 献立（/chores/meals/plan）。開始日から 7 日ぶんの献立を表示し、1〜7 日分を作る。
 *
 * - 献立・在庫・使わない食材の設定はサーバーで読み、在庫の引当と除外の判定もサーバーで行う
 *   （食材辞書・レシピのカタログを画面の bundle へ載せない）。
 * - 読めなかったときは `KeepLastGood` へ理由を渡す（「献立なし」と偽らない）。初回の表示なら
 *   error boundary、表示済みの画面の取り直し（定期・復帰時）なら直前の内容を保って
 *   「更新できませんでした」を出す。**ここから throw しないこと** — 取り直しの失敗で error boundary
 *   が画面を置き換え、入力中の希望の文・開いたシートが消える。
 * - AI 補助の状態は、読めなくても画面を倒さない（`loadMealAiStatus` は throw しない。
 *   AI が未設定・停止中でも、同じ画面が自動献立で動く）。
 * - 見出し（h1）と外枠の余白は layout が持つ。
 *
 * 認証・承認・世帯は (main)/layout が遷移で受ける。
 */
export default async function MealPlanPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const { context } = await getAuthContext()
  if (!context) return null
  const { supabase, userId, householdId } = context
  const today = mealToday()
  const startDate = resolvePlanStart((await searchParams)[PLAN_START_PARAM], today)

  const [data, ai] = await Promise.all([
    loadPlanPageData(supabase, householdId, userId, { startDate, today }),
    loadMealAiStatus(supabase),
  ])
  // 表示する週が替われば、前の週の内容を「直前に読めた内容」として出さぬ
  const scope = `plan:${userId}:${householdId}:${startDate}`
  if (!data.ok) return <KeepLastGood scope={scope} failure={new MealContextError(data.failures).message} />

  return (
    <KeepLastGood scope={scope}>
      <PlanView
        // 持ち主（利用者・世帯）が替われば、画面の状態と保存の手順ごと作り直す
        key={`${userId}:${householdId}`}
        owner={{ userId, householdId }}
        view={data.view}
        extras={data.extras}
        ai={ai}
      />
    </KeepLastGood>
  )
}

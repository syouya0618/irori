"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { createClient } from "@/lib/supabase/client"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { addDays, formatDateKey } from "@/lib/utils/date"
import { todayJstString, weekStartMonday } from "@/lib/utils/date-jst"
import type { MealType, MealReaction } from "@/lib/types/database"

/**
 * 作成の楽観行に使うローカル擬似 id の prefix。
 * meal-week-view.tsx の temp id 生成と、fetchMeals 失敗時の temp 行
 * クリーンアップが同じ判定を共有するため、ここで一元定義する。
 */
export const OPTIMISTIC_MEAL_ID_PREFIX = "optimistic-"

export interface MealWithDetails {
  id: string
  date: string
  meal_type: MealType
  title: string
  is_eating_out: boolean
  template_id: string | null
  meal_reactions: {
    user_id: string
    reaction: MealReaction
  }[]
  meal_ingredients: {
    name: string
    quantity: string | null
    category: string
  }[]
}

interface UseWeekMealsArgs {
  initialMeals: MealWithDetails[]
  householdId: string
  initialWeekStart: string // YYYY-MM-DD (Monday)
}

export function useWeekMeals({
  initialMeals,
  householdId,
  initialWeekStart,
}: UseWeekMealsArgs) {
  const [weekStart, setWeekStart] = useState<Date>(
    () => new Date(initialWeekStart + "T00:00:00")
  )
  const [meals, setMeals] = useState<MealWithDetails[]>(initialMeals)
  const [isLoading, setIsLoading] = useState(false)

  // Realtime subscription が weekStart 変更のたびに再購読しないよう ref で保持する。
  const weekStartRef = useRef(weekStart)
  useEffect(() => { weekStartRef.current = weekStart }, [weekStart])

  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  }, [weekStart])

  const mealMap = useMemo(() => {
    const map = new Map<string, MealWithDetails>()
    for (const meal of meals) {
      map.set(`${meal.date}:${meal.meal_type}`, meal)
    }
    return map
  }, [meals])

  const isCurrentWeek = useMemo(() => {
    // JST 固定: サーバー SSR (UTC) と端末 TZ のどちらでも同じ判定になる
    const currentMonday = weekStartMonday(todayJstString())
    return formatDateKey(weekStart) === currentMonday
  }, [weekStart])

  const fetchMeals = useCallback(
    async (start: Date) => {
      setIsLoading(true)
      const supabase = createClient()
      const startStr = formatDateKey(start)
      const endStr = formatDateKey(addDays(start, 6))

      const { data, error: mealsError } = await supabase
        .from("meals")
        .select(
          `
          id, date, meal_type, title, is_eating_out, template_id,
          meal_reactions ( user_id, reaction ),
          meal_ingredients ( name, quantity, category )
        `
        )
        .eq("household_id", householdId)
        .gte("date", startStr)
        .lte("date", endStr)
        .order("date")

      if (mealsError) {
        logSupabaseError("meal-week-view", "meals lookup failed", mealsError, {
          householdId,
        })
      }

      if (data) {
        setMeals(data as unknown as MealWithDetails[])
      } else {
        // 真値が取れなかった場合は temp 楽観行のみ除去する。
        // 残すと「作成が確定したか分からない行」が編集可能なまま残留し、
        // temp id (optimistic-*) のまま updateMeal が飛んで権限エラーになる。
        // 確定 id 行は消さない (真値が取れない時に既存表示を壊さない)。
        setMeals((prev) =>
          prev.filter((m) => !m.id.startsWith(OPTIMISTIC_MEAL_ID_PREFIX))
        )
      }
      setIsLoading(false)
    },
    [householdId]
  )

  function goToPreviousWeek() {
    const newStart = addDays(weekStart, -7)
    setWeekStart(newStart)
    fetchMeals(newStart)
  }

  function goToNextWeek() {
    const newStart = addDays(weekStart, 7)
    setWeekStart(newStart)
    fetchMeals(newStart)
  }

  function goToCurrentWeek() {
    const mondayYmd = weekStartMonday(todayJstString())
    // todayJstString は常に YYYY-MM-DD を返すため null は到達不能
    // （weekStartMonday の型を絞るための防御。表示専用パスゆえ現状維持で安全）
    if (mondayYmd === null) return
    // 時刻付き文字列はローカル解釈される（state 初期化と同形の UTC 罠回避）
    const monday = new Date(mondayYmd + "T00:00:00")
    setWeekStart(monday)
    fetchMeals(monday)
  }

  // ── 楽観更新ミューテータ ──────────────────────────────
  // いずれも Realtime refetch (fetchMeals) が配列を丸ごと真値で置換するため、
  // 楽観行はサーバー確定値で自然収束する (shopping-list.tsx と同じ手動 state 方式)。

  /**
   * 楽観 upsert: 同 id の行があれば置換、なければ末尾に追加する。
   * 作成 (temp id 行の挿入)・更新 (該当行の置換)・ロールバック (snapshot 復元) を兼ねる。
   */
  function upsertMealOptimistic(meal: MealWithDetails) {
    setMeals((prev) =>
      prev.some((m) => m.id === meal.id)
        ? prev.map((m) => (m.id === meal.id ? meal : m))
        : [...prev, meal]
    )
  }

  /** 楽観 remove: 削除の即時反映、および作成失敗時の temp 行ロールバックに使う。 */
  function removeMealOptimistic(mealId: string) {
    setMeals((prev) => prev.filter((m) => m.id !== mealId))
  }

  /**
   * createMeal 成功時に temp id をサーバー発行 id へ差し替える。
   * temp id のまま残すと、refetch 到着前にカードを編集/リアクションした際に
   * 存在しない id で action が飛んでしまう。refetch が先に走って temp 行が
   * 既に正規行へ置換されている場合は no-op。
   */
  function replaceMealIdOptimistic(tempId: string, realId: string) {
    setMeals((prev) =>
      prev.map((m) => (m.id === tempId ? { ...m, id: realId } : m))
    )
  }

  /**
   * 自分のリアクションを楽観反映する (reaction === null は解除)。
   * meal_reactions は Realtime 購読に乗っていない (channel は meals テーブルのみ)
   * ため、この反映が次の meals refetch まで最終状態になる。
   * 失敗時は呼び出し側が直前値で再度呼んでロールバックする。
   */
  function applyReactionOptimistic(
    mealId: string,
    targetUserId: string,
    reaction: MealReaction | null
  ) {
    setMeals((prev) =>
      prev.map((meal) => {
        if (meal.id !== mealId) return meal
        const others = meal.meal_reactions.filter(
          (r) => r.user_id !== targetUserId
        )
        return {
          ...meal,
          meal_reactions:
            reaction === null
              ? others
              : [...others, { user_id: targetUserId, reaction }],
        }
      })
    )
  }

  useEffect(() => {
    const supabase = createClient()

    const channel = supabase
      .channel(`meals-${householdId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "meals",
          filter: `household_id=eq.${householdId}`,
        },
        () => {
          fetchMeals(weekStartRef.current)
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [householdId, fetchMeals])

  return {
    weekStart,
    meals,
    isLoading,
    weekDays,
    mealMap,
    isCurrentWeek,
    goToPreviousWeek,
    goToNextWeek,
    goToCurrentWeek,
    upsertMealOptimistic,
    removeMealOptimistic,
    replaceMealIdOptimistic,
    applyReactionOptimistic,
  }
}

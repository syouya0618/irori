"use client"

import { useState, useEffect, useRef, startTransition } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { MealDayRow } from "@/components/meals/meal-day-row"
import { MealFormSheet } from "@/components/meals/meal-form-sheet"
import {
  useWeekMeals,
  OPTIMISTIC_MEAL_ID_PREFIX,
} from "@/components/meals/use-week-meals"
import { formatWeekRange } from "@/components/meals/week-date-utils"
import {
  loadTemplate,
  createMeal,
  updateMeal,
  deleteMeal,
} from "@/app/(main)/meals/actions"
import { formatDateKey } from "@/lib/utils/date"
import { todayJstString } from "@/lib/utils/date-jst"
import type { MealFormSubmitData } from "@/components/meals/meal-form-sheet"
import type { MealWithDetails } from "@/components/meals/use-week-meals"
import type { MealType, ItemCategory, MealReaction } from "@/lib/types/database"

interface MealWeekViewProps {
  initialMeals: MealWithDetails[]
  householdId: string
  userId: string
  initialWeekStart: string // YYYY-MM-DD (Monday)
}

// 作成の楽観行に使うローカル擬似 id の連番。createMeal が確定 id を返すか
// Realtime refetch が来るまでの間だけ存在する (同一セッション内の一意性で十分)。
// prefix は use-week-meals.ts の OPTIMISTIC_MEAL_ID_PREFIX と共有し、
// refetch 失敗時の temp 行クリーンアップが同じ判定で行えるようにする
let tempIdSeq = 0

/** フォーム入力 (IngredientInput) を SELECT 結果と同じ行 shape へ変換する */
function toOptimisticIngredients(
  ingredients: MealFormSubmitData["ingredients"]
): MealWithDetails["meal_ingredients"] {
  return ingredients.map((ing) => ({
    name: ing.name,
    quantity: ing.quantity || null,
    category: ing.category,
  }))
}

export function MealWeekView({
  initialMeals,
  householdId,
  userId,
  initialWeekStart,
}: MealWeekViewProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const {
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
  } = useWeekMeals({ initialMeals, householdId, initialWeekStart })

  // Sheet state
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editingMeal, setEditingMeal] = useState<MealWithDetails | null>(null)
  const [selectedDate, setSelectedDate] = useState("")
  const [selectedMealType, setSelectedMealType] = useState<MealType>("dinner")
  // open のたびに formKey を進めて MealFormSheet を remount し、useState 初期値を
  // 最新 props から評価させる (baby-dashboard.tsx と同パターン)。
  // 注意: open 中に formKey が変わると入力途中の内容が消えるため、
  // setFormKey は open する直前 (closed 状態) でのみ呼ぶこと。
  const [formKey, setFormKey] = useState(0)
  const [prefilledFromTemplate, setPrefilledFromTemplate] = useState<{
    title: string
    ingredients: Array<{
      name: string
      quantity: string
      category: ItemCategory
    }>
  } | null>(null)

  const templateIdFromUrl = searchParams.get("template")
  const hasProcessedUrlTemplate = useRef(false)

  useEffect(() => {
    if (!templateIdFromUrl || hasProcessedUrlTemplate.current) return
    hasProcessedUrlTemplate.current = true

    let cancelled = false
    loadTemplate(templateIdFromUrl).then((result) => {
      if (cancelled) return

      if (result.error) {
        toast.error(result.error)
      } else if (result.data) {
        const today = todayJstString()
        setPrefilledFromTemplate(result.data)
        setEditingMeal(null)
        setSelectedDate(today)
        setSelectedMealType("dinner")
        setFormKey((k) => k + 1)
        setSheetOpen(true)
      } else {
        // data も error もない想定外ケース
        toast.error("テンプレートが見つかりません")
      }

      // 成功・失敗に関わらず URL params は一度だけクリアする
      // （リロード時に再処理されないように）
      router.replace("/meals")
    })

    return () => {
      cancelled = true
    }
  }, [templateIdFromUrl, router])

  function openNewMeal(date: string, mealType: MealType) {
    setEditingMeal(null)
    setSelectedDate(date)
    setSelectedMealType(mealType)
    setFormKey((k) => k + 1)
    setSheetOpen(true)
  }

  function openEditMeal(meal: MealWithDetails) {
    setEditingMeal(meal)
    setSelectedDate(meal.date)
    setSelectedMealType(meal.meal_type)
    setFormKey((k) => k + 1)
    setSheetOpen(true)
  }

  function handleSheetClose(open: boolean) {
    setSheetOpen(open)
    if (!open) {
      setEditingMeal(null)
      setPrefilledFromTemplate(null)
    }
  }

  // ── 楽観更新オーケストレーション ─────────────────────────
  // 方針: UI へ即時反映してシートを閉じ、server action は裏で走らせる。
  // 失敗時のみロールバック + toast (シートは閉じたまま)。成功時は
  // meals テーブルの Realtime refetch が配列を丸ごと真値で置換して収束する。

  function handleSubmitMeal(data: MealFormSubmitData) {
    if (data.id) {
      // ── 更新: 該当 meal を楽観置換 (reactions / template_id は既存値を維持)
      const mealId = data.id
      const previous = meals.find((m) => m.id === mealId)
      const rollback = () => {
        // snapshot があれば復元。refetch 等で既に消えていた場合は楽観行ごと除去
        if (previous) upsertMealOptimistic(previous)
        else removeMealOptimistic(mealId)
      }
      upsertMealOptimistic({
        id: mealId,
        date: data.date,
        meal_type: data.mealType,
        title: data.title,
        is_eating_out: data.isEatingOut,
        template_id: previous?.template_id ?? null,
        meal_reactions: previous?.meal_reactions ?? [],
        meal_ingredients: toOptimisticIngredients(data.ingredients),
      })
      handleSheetClose(false)

      startTransition(async () => {
        try {
          const result = await updateMeal({
            id: mealId,
            date: data.date,
            mealType: data.mealType,
            title: data.title,
            isEatingOut: data.isEatingOut,
            ingredients: data.ingredients,
          })
          if (result.error) {
            rollback()
            toast.error(result.error)
          }
        } catch (err) {
          console.error("[meals] updateMeal failed", { mealId, err })
          rollback()
          toast.error("献立の更新に失敗しました。通信環境をご確認ください。")
        }
      })
    } else {
      // ── 作成: temp id で楽観挿入 → 成功時に確定 id へ差し替え
      const tempId = `${OPTIMISTIC_MEAL_ID_PREFIX}${++tempIdSeq}`
      upsertMealOptimistic({
        id: tempId,
        date: data.date,
        meal_type: data.mealType,
        title: data.title,
        is_eating_out: data.isEatingOut,
        template_id: null,
        meal_reactions: [],
        meal_ingredients: toOptimisticIngredients(data.ingredients),
      })
      handleSheetClose(false)

      startTransition(async () => {
        try {
          const result = await createMeal({
            date: data.date,
            mealType: data.mealType,
            title: data.title,
            isEatingOut: data.isEatingOut,
            ingredients: data.ingredients,
          })
          if (result.error !== null) {
            removeMealOptimistic(tempId)
            toast.error(result.error)
            return
          }
          // refetch 到着前にカードを編集/リアクションしても正しい id で
          // action が飛ぶよう確定 id へ差し替える (refetch 先行時は no-op)
          replaceMealIdOptimistic(tempId, result.mealId)
        } catch (err) {
          console.error("[meals] createMeal failed", { err })
          removeMealOptimistic(tempId)
          toast.error("献立の追加に失敗しました。通信環境をご確認ください。")
        }
      })
    }
  }

  function handleDeleteMeal(mealId: string) {
    const previous = meals.find((m) => m.id === mealId)
    removeMealOptimistic(mealId)
    handleSheetClose(false)

    startTransition(async () => {
      try {
        const result = await deleteMeal(mealId)
        if (result.error) {
          if (previous) upsertMealOptimistic(previous)
          toast.error(result.error)
        }
      } catch (err) {
        console.error("[meals] deleteMeal failed", { mealId, err })
        if (previous) upsertMealOptimistic(previous)
        toast.error("献立の削除に失敗しました。通信環境をご確認ください。")
      }
    })
  }

  function handleOptimisticReaction(
    mealId: string,
    reaction: MealReaction | null
  ) {
    applyReactionOptimistic(mealId, userId, reaction)
  }

  const formInitialData = editingMeal
    ? {
        id: editingMeal.id,
        title: editingMeal.title,
        mealType: editingMeal.meal_type,
        date: editingMeal.date,
        isEatingOut: editingMeal.is_eating_out,
        ingredients: editingMeal.meal_ingredients.map((ing) => ({
          name: ing.name,
          quantity: ing.quantity ?? "",
          category: ing.category as ItemCategory,
        })),
      }
    : prefilledFromTemplate
      ? {
          // id なし = 新規作成扱い
          title: prefilledFromTemplate.title,
          mealType: selectedMealType,
          date: selectedDate,
          isEatingOut: false,
          ingredients: prefilledFromTemplate.ingredients,
        }
      : undefined

  const hasAnyMeals = meals.length > 0

  return (
    <div className="flex flex-col gap-3 px-4 pt-4">
      {/* Week navigation header */}
      <div className="glass flex flex-col items-center gap-2 rounded-2xl px-4 py-3 shadow-lg shadow-black/[0.04]">
        <div className="flex w-full items-center justify-between">
          <Button
            variant="ghost"
            size="icon"
            onClick={goToPreviousWeek}
            aria-label="前の週"
            className="min-h-11 min-w-11"
          >
            <ChevronLeft className="size-5" />
          </Button>
          <span className="text-sm font-semibold text-foreground">
            {formatWeekRange(weekStart)}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={goToNextWeek}
            aria-label="次の週"
            className="min-h-11 min-w-11"
          >
            <ChevronRight className="size-5" />
          </Button>
        </div>
        {!isCurrentWeek && (
          <Button
            variant="secondary"
            size="sm"
            onClick={goToCurrentWeek}
            className="text-xs"
          >
            今週
          </Button>
        )}
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex justify-center py-2">
          <div className="h-0.5 w-16 animate-pulse rounded-full bg-primary/30" />
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !hasAnyMeals && isCurrentWeek && (
        <div className="glass flex flex-col items-center gap-2 rounded-2xl p-6 text-center shadow-lg shadow-black/[0.04]">
          <p className="text-sm text-muted-foreground">
            今週の献立はまだありません。タップして追加しましょう！
          </p>
        </div>
      )}

      {/* Day rows */}
      <div className="flex flex-col gap-2 pb-4">
        {weekDays.map((day) => {
          const dateKey = formatDateKey(day)

          return (
            <MealDayRow
              key={dateKey}
              day={day}
              dateKey={dateKey}
              mealMap={mealMap}
              userId={userId}
              openEditMeal={openEditMeal}
              openNewMeal={openNewMeal}
              onOptimisticReaction={handleOptimisticReaction}
            />
          )
        })}
      </div>

      {/* Meal form sheet: key={formKey} で open ごとに remount してプリフィルを保証 */}
      <MealFormSheet
        key={formKey}
        open={sheetOpen}
        onOpenChange={handleSheetClose}
        initialData={formInitialData}
        defaultDate={selectedDate}
        defaultMealType={selectedMealType}
        onSubmitMeal={handleSubmitMeal}
        onDeleteMeal={handleDeleteMeal}
      />
    </div>
  )
}

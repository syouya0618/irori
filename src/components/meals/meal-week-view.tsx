"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { MealDayRow } from "@/components/meals/meal-day-row"
import { MealFormSheet } from "@/components/meals/meal-form-sheet"
import { useWeekMeals } from "@/components/meals/use-week-meals"
import { formatWeekRange } from "@/components/meals/week-date-utils"
import { loadTemplate } from "@/app/(main)/meals/actions"
import { formatDateKey } from "@/lib/utils/date"
import type { MealWithDetails } from "@/components/meals/use-week-meals"
import type { MealType, ItemCategory } from "@/lib/types/database"

interface MealWeekViewProps {
  initialMeals: MealWithDetails[]
  householdId: string
  userId: string
  initialWeekStart: string // YYYY-MM-DD (Monday)
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
  } = useWeekMeals({ initialMeals, householdId, initialWeekStart })

  // Sheet state
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editingMeal, setEditingMeal] = useState<MealWithDetails | null>(null)
  const [selectedDate, setSelectedDate] = useState("")
  const [selectedMealType, setSelectedMealType] = useState<MealType>("dinner")
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
        const today = formatDateKey(new Date())
        setPrefilledFromTemplate(result.data)
        setEditingMeal(null)
        setSelectedDate(today)
        setSelectedMealType("dinner")
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
    setSheetOpen(true)
  }

  function openEditMeal(meal: MealWithDetails) {
    setEditingMeal(meal)
    setSelectedDate(meal.date)
    setSelectedMealType(meal.meal_type)
    setSheetOpen(true)
  }

  function handleSheetClose(open: boolean) {
    setSheetOpen(open)
    if (!open) {
      setEditingMeal(null)
      setPrefilledFromTemplate(null)
    }
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
            />
          )
        })}
      </div>

      {/* Meal form sheet */}
      <MealFormSheet
        open={sheetOpen}
        onOpenChange={handleSheetClose}
        initialData={formInitialData}
        defaultDate={selectedDate}
        defaultMealType={selectedMealType}
      />
    </div>
  )
}

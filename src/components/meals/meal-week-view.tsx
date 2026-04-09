"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { MealCard, EmptyMealSlot } from "@/components/meals/meal-card"
import { MealFormSheet } from "@/components/meals/meal-form-sheet"
import { createClient } from "@/lib/supabase/client"
import { loadTemplate } from "@/app/(main)/meals/actions"
import { getMonday, addDays, formatDateKey } from "@/lib/utils/date"
import { MEAL_TYPE_SHORT_LABELS } from "@/lib/utils/meal-types"
import type {
  MealType,
  MealReaction,
  ItemCategory,
} from "@/lib/types/database"

// ── Helpers ──

const DAY_NAMES = ["月", "火", "水", "木", "金", "土", "日"]

// Week view only shows breakfast/lunch/dinner (not snack)
const WEEK_VIEW_MEAL_TYPES: MealType[] = ["breakfast", "lunch", "dinner"]

function formatDayHeader(d: Date): string {
  const formatter = new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
  })
  const dayOfWeek = DAY_NAMES[(d.getDay() + 6) % 7]
  return `${formatter.format(d)}（${dayOfWeek}）`
}

function formatWeekRange(monday: Date): string {
  const sunday = addDays(monday, 6)
  const f = new Intl.DateTimeFormat("ja-JP", {
    month: "long",
    day: "numeric",
  })
  return `${f.format(monday)}\u301C${f.format(sunday)}`
}

function isToday(d: Date): boolean {
  const today = new Date()
  return (
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  )
}

// ── Types ──

interface MealWithDetails {
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

  const [weekStart, setWeekStart] = useState<Date>(
    () => new Date(initialWeekStart + "T00:00:00")
  )
  const [meals, setMeals] = useState<MealWithDetails[]>(initialMeals)
  const [isLoading, setIsLoading] = useState(false)

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

  // URL params から template ID を読み取り、自動でシートを開く
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

  // Ref to avoid re-subscribing on every week change
  const weekStartRef = useRef(weekStart)
  useEffect(() => { weekStartRef.current = weekStart }, [weekStart])

  // Computed week days
  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  }, [weekStart])

  // Meals indexed by date+mealType
  const mealMap = useMemo(() => {
    const map = new Map<string, MealWithDetails>()
    for (const meal of meals) {
      map.set(`${meal.date}:${meal.meal_type}`, meal)
    }
    return map
  }, [meals])

  // Check if current week is this week
  const isCurrentWeek = useMemo(() => {
    const currentMonday = getMonday(new Date())
    return formatDateKey(weekStart) === formatDateKey(currentMonday)
  }, [weekStart])

  // ── Fetch meals for the current week ──

  const fetchMeals = useCallback(
    async (start: Date) => {
      setIsLoading(true)
      const supabase = createClient()
      const startStr = formatDateKey(start)
      const endStr = formatDateKey(addDays(start, 6))

      const { data } = await supabase
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

      if (data) {
        setMeals(data as unknown as MealWithDetails[])
      }
      setIsLoading(false)
    },
    [householdId]
  )

  // ── Week navigation ──

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
    const monday = getMonday(new Date())
    setWeekStart(monday)
    fetchMeals(monday)
  }

  // ── Realtime subscription ──

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

  // ── Sheet handlers ──

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

  // ── Build form data ──

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

  // ── Check if all days are empty (empty state) ──
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
          const todayFlag = isToday(day)

          return (
            <div
              key={dateKey}
              className={`rounded-2xl p-3 ${
                todayFlag
                  ? "glass shadow-lg shadow-black/[0.04] ring-1 ring-primary/20"
                  : "bg-muted/30"
              }`}
            >
              {/* Day header */}
              <div className="mb-2 flex items-center gap-2">
                <span
                  className={`text-sm font-semibold ${
                    todayFlag ? "text-primary" : "text-foreground"
                  }`}
                >
                  {formatDayHeader(day)}
                </span>
                {todayFlag && (
                  <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                    今日
                  </span>
                )}
              </div>

              {/* Meal type headers + slots */}
              <div className="flex gap-2">
                {WEEK_VIEW_MEAL_TYPES.map((type) => {
                  const meal = mealMap.get(`${dateKey}:${type}`)

                  return (
                    <div key={type} className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="text-center text-[10px] font-medium text-muted-foreground">
                        {MEAL_TYPE_SHORT_LABELS[type]}
                      </span>
                      {meal ? (
                        <MealCard
                          meal={{
                            id: meal.id,
                            title: meal.title,
                            mealType: meal.meal_type,
                            isEatingOut: meal.is_eating_out,
                            reactions: meal.meal_reactions.map((r) => ({
                              userId: r.user_id,
                              reaction: r.reaction,
                            })),
                          }}
                          currentUserId={userId}
                          onTap={() => openEditMeal(meal)}
                        />
                      ) : (
                        <EmptyMealSlot
                          mealType={type}
                          onTap={() => openNewMeal(dateKey, type)}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
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

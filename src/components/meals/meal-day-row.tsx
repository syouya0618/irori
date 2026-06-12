"use client"

import { MealCard, EmptyMealSlot } from "@/components/meals/meal-card"
import { formatDayHeader, isToday } from "@/components/meals/week-date-utils"
import { MEAL_TYPE_SHORT_LABELS } from "@/lib/utils/meal-types"
import type { MealWithDetails } from "@/components/meals/use-week-meals"
import type { MealType, MealReaction } from "@/lib/types/database"

// 週ビューは snack を除く3食のみ表示する
const WEEK_VIEW_MEAL_TYPES: MealType[] = ["breakfast", "lunch", "dinner"]

interface MealDayRowProps {
  day: Date
  dateKey: string
  mealMap: Map<string, MealWithDetails>
  userId: string
  openEditMeal: (meal: MealWithDetails) => void
  openNewMeal: (date: string, mealType: MealType) => void
  onOptimisticReaction: (mealId: string, reaction: MealReaction | null) => void
}

export function MealDayRow({
  day,
  dateKey,
  mealMap,
  userId,
  openEditMeal,
  openNewMeal,
  onOptimisticReaction,
}: MealDayRowProps) {
  const todayFlag = isToday(day)

  return (
    <div
      data-testid={`meal-day-${dateKey}`}
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
                  onOptimisticReaction={onOptimisticReaction}
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
}

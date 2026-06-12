"use client"

import { cn } from "@/lib/utils"
import { UtensilsCrossed } from "lucide-react"
import { MealReactions } from "@/components/meals/meal-reactions"
import { MEAL_TYPE_LABELS } from "@/lib/utils/meal-types"
import type { MealType, MealReaction } from "@/lib/types/database"

interface MealReactionData {
  userId: string
  reaction: MealReaction
}

export interface MealCardData {
  id: string
  title: string
  mealType: MealType
  isEatingOut: boolean
  reactions: MealReactionData[]
}

interface MealCardProps {
  meal: MealCardData
  currentUserId: string
  onTap: () => void
  /** 自分のリアクションの楽観反映 (null は解除)。MealReactions へ中継する */
  onOptimisticReaction: (mealId: string, reaction: MealReaction | null) => void
}

export function MealCard({
  meal,
  currentUserId,
  onTap,
  onOptimisticReaction,
}: MealCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onTap}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onTap() }}
      className={cn(
        "glass flex w-full cursor-pointer flex-col gap-1.5 rounded-2xl p-3 text-left shadow-lg shadow-black/[0.04]",
        "min-h-11 transition-colors duration-200 hover:bg-white/70 active:bg-white/80"
      )}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {meal.title}
          </p>
        </div>
        {meal.isEatingOut && (
          <span
            className="flex-shrink-0 text-sm"
            aria-label="外食"
            title="外食"
          >
            <UtensilsCrossed className="size-3.5 text-primary" />
          </span>
        )}
      </div>

      <div
        className="flex items-center justify-between"
        onClick={(e) => e.stopPropagation()}
      >
        <MealReactions
          mealId={meal.id}
          currentUserId={currentUserId}
          reactions={meal.reactions}
          onOptimisticReaction={onOptimisticReaction}
        />
      </div>
    </div>
  )
}

interface EmptyMealSlotProps {
  mealType: MealType
  onTap: () => void
}

export function EmptyMealSlot({ mealType, onTap }: EmptyMealSlotProps) {
  return (
    <button
      type="button"
      onClick={onTap}
      data-testid={`empty-meal-slot-${mealType}`}
      className={cn(
        "flex w-full flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-border/60 p-3",
        "min-h-11 transition-colors duration-200 hover:border-primary/40 hover:bg-primary/5"
      )}
    >
      <span className="text-lg leading-none text-muted-foreground/60">+</span>
      <span className="text-[10px] text-muted-foreground/60">
        {MEAL_TYPE_LABELS[mealType]}
      </span>
    </button>
  )
}

"use client"

import { useOptimistic, useTransition } from "react"
import { cn } from "@/lib/utils"
import { upsertReaction } from "@/app/(main)/meals/actions"
import { toast } from "sonner"
import type { MealReaction } from "@/lib/types/database"

interface ReactionData {
  userId: string
  reaction: MealReaction
}

interface MealReactionsProps {
  mealId: string
  currentUserId: string
  reactions: ReactionData[]
}

const REACTION_CONFIG: {
  value: MealReaction
  emoji: string
  label: string
}[] = [
  { value: "good", emoji: "\uD83D\uDE0B", label: "おいしい" },
  { value: "ok", emoji: "\uD83D\uDE10", label: "ふつう" },
  { value: "bad", emoji: "\uD83D\uDE45", label: "いまいち" },
]

export function MealReactions({
  mealId,
  currentUserId,
  reactions,
}: MealReactionsProps) {
  const [isPending, startTransition] = useTransition()
  const [optimisticReactions, setOptimisticReactions] = useOptimistic(
    reactions,
    (
      current: ReactionData[],
      action: { reaction: MealReaction; remove: boolean }
    ) => {
      if (action.remove) {
        return current.filter((r) => r.userId !== currentUserId)
      }
      const existing = current.find((r) => r.userId === currentUserId)
      if (existing) {
        return current.map((r) =>
          r.userId === currentUserId
            ? { ...r, reaction: action.reaction }
            : r
        )
      }
      return [
        ...current,
        { userId: currentUserId, reaction: action.reaction },
      ]
    }
  )

  const currentUserReaction = optimisticReactions.find(
    (r) => r.userId === currentUserId
  )
  const partnerReaction = optimisticReactions.find(
    (r) => r.userId !== currentUserId
  )

  function handleReaction(reaction: MealReaction) {
    const isRemoving = currentUserReaction?.reaction === reaction

    startTransition(async () => {
      setOptimisticReactions({ reaction, remove: isRemoving })

      const result = await upsertReaction(mealId, reaction)
      if (result.error) {
        toast.error(result.error)
      }
    })
  }

  return (
    <div className="flex items-center gap-1">
      {REACTION_CONFIG.map(({ value, emoji, label }) => {
        const isActive = currentUserReaction?.reaction === value
        const isPartnerReaction = partnerReaction?.reaction === value

        return (
          <button
            key={value}
            type="button"
            onClick={() => handleReaction(value)}
            disabled={isPending}
            aria-label={label}
            aria-pressed={isActive}
            className={cn(
              "relative flex min-h-8 min-w-8 items-center justify-center rounded-full text-base transition-colors duration-200",
              isActive
                ? "bg-primary/10 ring-2 ring-primary/30"
                : "hover:bg-muted"
            )}
          >
            <span className={cn(
              "transition-colors duration-200",
              isActive ? "grayscale-0" : "grayscale-[0.3]"
            )}>
              {emoji}
            </span>
            {isPartnerReaction && (
              <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary/60" />
            )}
          </button>
        )
      })}
    </div>
  )
}

"use client"

import { useRef, useTransition } from "react"
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
  /**
   * 自分のリアクションの楽観反映 (reaction === null は解除)。
   * 親 (useWeekMeals の meals state) が反映先を持つ手動 state 方式
   * (shopping-item.tsx と同パターン)。useOptimistic だと transition 完了時に
   * base へ revert するが、meal_reactions は Realtime 購読に乗っておらず
   * base が更新されないため、成功した自分の操作が見かけ上消えてしまう。
   */
  onOptimisticReaction: (mealId: string, reaction: MealReaction | null) => void
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
  onOptimisticReaction,
}: MealReactionsProps) {
  const [isPending, startTransition] = useTransition()
  // isPending の render 反映は 1 frame 遅れるため、同一 tick 内の連打は
  // ref で同期ガードする (二重 action は server の toggle 仕様と相互作用して
  // 「付けたつもりが消える」状態崩れを起こす)
  const inFlightRef = useRef(false)

  const currentUserReaction = reactions.find(
    (r) => r.userId === currentUserId
  )
  const partnerReaction = reactions.find((r) => r.userId !== currentUserId)

  function handleReaction(reaction: MealReaction) {
    if (inFlightRef.current) return
    inFlightRef.current = true

    // ロールバック用に直前値を snapshot
    const previous = currentUserReaction?.reaction ?? null
    // 同じ絵文字の再タップ = 解除 (server 側 upsertReaction の toggle 仕様と一致)
    const next = previous === reaction ? null : reaction
    onOptimisticReaction(mealId, next)

    startTransition(async () => {
      try {
        const result = await upsertReaction(mealId, reaction)
        if (result.error) {
          // ロールバック
          onOptimisticReaction(mealId, previous)
          toast.error(result.error)
        }
      } catch (err) {
        console.error("[meals] upsertReaction failed", { mealId, reaction, err })
        onOptimisticReaction(mealId, previous)
        toast.error("リアクションの保存に失敗しました。通信環境をご確認ください。")
      } finally {
        inFlightRef.current = false
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

"use client"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Plus } from "lucide-react"
import type { RecipeSuggestion } from "@/lib/domain"

/**
 * マッチ率(0〜100)に応じたBadge色クラスを返す。
 * 80%以上: 緑、50%以上: 琥珀、それ以外: グレー。
 */
export function matchRateBadgeClass(matchPercent: number): string {
  if (matchPercent >= 80) return "bg-emerald-100 text-emerald-700"
  if (matchPercent >= 50) return "bg-amber-100 text-amber-700"
  return "bg-gray-100 text-gray-600"
}

interface SuggestionCardProps {
  suggestion: RecipeSuggestion
  onAddToMeal: (suggestion: RecipeSuggestion) => void
}

export function SuggestionCard({
  suggestion,
  onAddToMeal,
}: SuggestionCardProps) {
  const matchPercent = Math.round(suggestion.scoreBreakdown.matchRate * 100)

  return (
    <div className="glass rounded-2xl p-3 shadow-lg shadow-black/[0.04]">
      {/* ヘッダー: タイトル + マッチ率 */}
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{suggestion.title}</p>
          <div className="mt-1 flex items-center gap-1.5">
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                matchRateBadgeClass(matchPercent),
              )}
            >
              {matchPercent}%マッチ
            </span>
            {suggestion.hasExpiringStock && (
              <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                期限間近
              </span>
            )}
          </div>
        </div>
      </div>

      {/* マッチ食材 */}
      {suggestion.matchedIngredients.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {suggestion.matchedIngredients.map((ing) => (
            <span
              key={`match-${ing.name}`}
              className={cn(
                "rounded-full px-2 py-0.5 text-xs",
                ing.isExpiring
                  ? "bg-red-50 text-red-700"
                  : "bg-emerald-50 text-emerald-700",
              )}
            >
              {ing.name}
            </span>
          ))}
        </div>
      )}

      {/* 不足食材 */}
      {suggestion.missingIngredients.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1">
          <span className="text-xs text-muted-foreground">不足:</span>
          {suggestion.missingIngredients.map((ing) => (
            <span
              key={`missing-${ing.name}`}
              className="rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground"
            >
              {ing.name}
            </span>
          ))}
        </div>
      )}

      {/* アクション */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onAddToMeal(suggestion)}
        className="min-h-11 w-full cursor-pointer gap-1.5"
        aria-label={`${suggestion.title}を献立に追加`}
      >
        <Plus size={14} />
        献立に追加
      </Button>
    </div>
  )
}

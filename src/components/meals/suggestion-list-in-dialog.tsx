"use client"

import { useEffect, useState, useTransition } from "react"
import { Loader2, Lightbulb } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { getRecipeSuggestions } from "@/app/(main)/stock/actions"
import { loadTemplate } from "@/app/(main)/meals/actions"
import type { RecipeSuggestion, TemplateIngredient } from "@/lib/domain"
import { matchRateBadgeClass } from "@/components/stock/suggestion-card"

interface SuggestionListInDialogProps {
  isActive: boolean
  onSelect: (data: {
    title: string
    ingredients: TemplateIngredient[]
  }) => void
}

export function SuggestionListInDialog({
  isActive,
  onSelect,
}: SuggestionListInDialogProps) {
  const [suggestions, setSuggestions] = useState<RecipeSuggestion[]>([])
  const [hasLoaded, setHasLoaded] = useState(false)
  const [isPending, startTransition] = useTransition()

  // isLoading は derived state として扱う（useEffect 内での setState を避ける）
  const isLoading = isActive && !hasLoaded

  // タブがアクティブになった時に1回だけフェッチ
  useEffect(() => {
    if (!isActive || hasLoaded) return

    let cancelled = false
    getRecipeSuggestions().then((result) => {
      if (cancelled) return
      if (result.error) {
        toast.error(result.error)
      } else {
        setSuggestions(result.data)
      }
      setHasLoaded(true)
    })

    return () => {
      cancelled = true
    }
  }, [isActive, hasLoaded])

  function handleSelect(templateId: string) {
    startTransition(async () => {
      const result = await loadTemplate(templateId)
      if (result.error) {
        toast.error(result.error)
        return
      }
      if (result.data) {
        onSelect(result.data)
      }
    })
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (suggestions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <Lightbulb className="size-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">
          おすすめ献立がありません
        </p>
        <p className="text-xs text-muted-foreground/70">
          在庫に合うテンプレートが見つかりませんでした
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {suggestions.map((suggestion) => {
        const matchPercent = Math.round(
          suggestion.scoreBreakdown.matchRate * 100,
        )

        return (
          <div
            key={suggestion.templateId}
            role="button"
            tabIndex={0}
            onClick={() => !isPending && handleSelect(suggestion.templateId)}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && !isPending) {
                e.preventDefault()
                handleSelect(suggestion.templateId)
              }
            }}
            className="flex w-full flex-col gap-2 rounded-xl p-3 text-left transition-colors duration-200 hover:bg-muted active:bg-muted/80 cursor-pointer"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {suggestion.title}
                </p>
              </div>
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                  matchRateBadgeClass(matchPercent),
                )}
              >
                {matchPercent}%
              </span>
              {suggestion.hasExpiringStock && (
                <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                  期限間近
                </span>
              )}
            </div>
            {suggestion.matchedIngredients.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {suggestion.matchedIngredients.map((ing) => (
                  <span
                    key={ing.name}
                    className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700"
                  >
                    {ing.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

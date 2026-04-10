"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  ChevronDown,
  ChevronRight,
  Lightbulb,
  Loader2,
  Sparkles,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { getRecipeSuggestions } from "@/app/(main)/stock/actions"
import type { StockItemData } from "./stock-item"
import type { RecipeSuggestion } from "@/lib/domain"
import { SuggestionCard } from "./suggestion-card"

interface StockSuggestionsProps {
  /** 初期提案データ（SSRで取得） */
  initialSuggestions: RecipeSuggestion[]
  /** 現在の在庫リスト（Realtime更新される） */
  items: StockItemData[]
}

const INITIAL_VISIBLE = 5

export function StockSuggestions({
  initialSuggestions,
  items,
}: StockSuggestionsProps) {
  const router = useRouter()
  const [suggestions, setSuggestions] =
    useState<RecipeSuggestion[]>(initialSuggestions)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isExpanded, setIsExpanded] = useState(true)
  const [showAll, setShowAll] = useState(false)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isFirstRender = useRef(true)

  // 在庫変更を1000msデバウンスして再計算
  // キャンセルフラグで race condition（タブ切替え中の古い結果上書き）を防ぐ
  useEffect(() => {
    // 初回マウント時は初期データを使うのでスキップ
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }

    let cancelled = false

    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    debounceRef.current = setTimeout(async () => {
      if (cancelled) return
      setIsRefreshing(true)
      const result = await getRecipeSuggestions()
      if (cancelled) return
      if (result.error) {
        toast.error(result.error)
      } else {
        setSuggestions(result.data)
      }
      setIsRefreshing(false)
    }, 1000)

    return () => {
      cancelled = true
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [items])

  const handleAddToMeal = (suggestion: RecipeSuggestion) => {
    // URL paramsでtemplateIdを渡し、/mealsへ遷移
    router.push(`/meals?template=${encodeURIComponent(suggestion.templateId)}`)
  }

  const visibleSuggestions = showAll
    ? suggestions
    : suggestions.slice(0, INITIAL_VISIBLE)

  return (
    <div className="flex flex-col gap-2">
      {/* セクションヘッダー */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex min-h-11 items-center gap-2 rounded-xl px-1 py-2 text-left transition-colors duration-200 hover:bg-accent/30"
      >
        {isExpanded ? (
          <ChevronDown size={16} className="text-muted-foreground" />
        ) : (
          <ChevronRight size={16} className="text-muted-foreground" />
        )}
        <Sparkles size={16} className="text-primary" />
        <span className="text-sm font-semibold">おすすめ献立</span>
        {suggestions.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {suggestions.length}件
          </span>
        )}
        {isRefreshing && (
          <Loader2
            size={14}
            className="ml-auto animate-spin text-muted-foreground"
          />
        )}
      </button>

      {/* リストコンテンツ */}
      {isExpanded && (
        <>
          {suggestions.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl bg-muted/30 p-6 text-center">
              <Lightbulb size={32} className="text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">
                おすすめ献立がまだありません
              </p>
              <p className="text-xs text-muted-foreground/70">
                献立を作成してテンプレート保存すると、在庫に合った提案が表示されます
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                {visibleSuggestions.map((suggestion) => (
                  <SuggestionCard
                    key={suggestion.templateId}
                    suggestion={suggestion}
                    onAddToMeal={handleAddToMeal}
                  />
                ))}
              </div>
              {suggestions.length > INITIAL_VISIBLE && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowAll(!showAll)}
                  className="min-h-11 w-full cursor-pointer"
                >
                  {showAll
                    ? "閉じる"
                    : `もっと見る（残り${suggestions.length - INITIAL_VISIBLE}件）`}
                </Button>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { Package } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { updateAutoStockCategories } from "@/app/(main)/settings/actions"
import { getCategoryLabel } from "@/lib/utils/categories"
import type { ItemCategory } from "@/lib/types/database"

const AUTO_STOCK_OPTIONS: { value: ItemCategory; label: string }[] = [
  { value: "baby", label: getCategoryLabel("baby") },
  { value: "cleaning", label: getCategoryLabel("cleaning") },
  { value: "hygiene", label: getCategoryLabel("hygiene") },
  { value: "other_daily", label: getCategoryLabel("other_daily") },
]

export function AutoStockCategoriesCard({
  initialCategories,
}: {
  initialCategories: string[]
}) {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(initialCategories),
  )
  const [isPending, startTransition] = useTransition()

  function handleToggle(category: ItemCategory) {
    const next = new Set(selected)
    if (next.has(category)) {
      next.delete(category)
    } else {
      next.add(category)
    }
    setSelected(next)

    startTransition(async () => {
      const result = await updateAutoStockCategories(
        [...next] as ItemCategory[],
      )
      if (result.error) {
        toast.error(result.error)
        setSelected(new Set(initialCategories))
      }
    })
  }

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Package size={18} />
          在庫自動追加
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          買い物リストでチェックした時に、以下のカテゴリは在庫に自動追加されます。
          残日数の自動計算は育児ログ連動のベビー用品のみ対応しています。
        </p>
        <div className="grid grid-cols-2 gap-2">
          {AUTO_STOCK_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => handleToggle(opt.value)}
              disabled={isPending}
              className={cn(
                "flex min-h-11 items-center justify-center rounded-xl px-3 py-2 text-sm font-medium transition-colors duration-200",
                selected.has(opt.value)
                  ? "bg-primary/10 text-primary ring-1 ring-primary/20"
                  : "bg-muted/50 text-muted-foreground",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

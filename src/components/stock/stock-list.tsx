"use client"

import { useState, useEffect, useMemo, useCallback } from "react"
import {
  Plus,
  Carrot,
  Apple,
  Beef,
  Fish,
  Milk,
  Egg,
  Wheat,
  Flame,
  Snowflake,
  Cookie,
  UtensilsCrossed,
  Baby,
  SprayCan,
  Heart,
  Package,
  AlertTriangle,
} from "lucide-react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { checkAndAutoAddLowStock } from "@/app/(main)/stock/actions"
import { StockItem, type StockItemData } from "./stock-item"
import { StockFormSheet } from "./stock-form-sheet"
import { StockSuggestions } from "./stock-suggestions"
import { getCategoryLabel, categoryDisplayOrder } from "@/lib/utils/categories"
import { daysFromTodayJst } from "@/lib/utils/date-jst"
import type { ItemCategory } from "@/lib/types/database"
import type { RecipeSuggestion } from "@/lib/domain"

const categoryIcons: Record<ItemCategory, React.ComponentType<{ size?: number; className?: string }>> = {
  vegetable: Carrot,
  fruit: Apple,
  meat: Beef,
  fish: Fish,
  dairy: Milk,
  egg: Egg,
  grain: Wheat,
  seasoning: Flame,
  frozen: Snowflake,
  snack_food: Cookie,
  other_food: UtensilsCrossed,
  baby: Baby,
  cleaning: SprayCan,
  hygiene: Heart,
  other_daily: Package,
}

interface StockListProps {
  initialItems: StockItemData[]
  initialSuggestions: RecipeSuggestion[]
  consumptionRates: Record<string, number | null>
  householdId: string
}

function countExpiringItems(items: StockItemData[]): number {
  return items.filter((item) => {
    if (!item.expires_at) return false
    const diffDays = daysFromTodayJst(item.expires_at)
    return diffDays !== null && diffDays <= 3
  }).length
}

export function StockList({
  initialItems,
  initialSuggestions,
  consumptionRates,
  householdId,
}: StockListProps) {
  const [items, setItems] = useState<StockItemData[]>(initialItems)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<StockItemData | null>(null)

  useEffect(() => {
    const supabase = createClient()

    const channel = supabase
      .channel("stock")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "stock_items",
          filter: `household_id=eq.${householdId}`,
        },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const newItem = payload.new as StockItemData
            setItems((prev) => {
              if (prev.some((i) => i.id === newItem.id)) return prev
              return [...prev, newItem]
            })
          } else if (payload.eventType === "UPDATE") {
            const updated = payload.new as StockItemData
            setItems((prev) =>
              prev.map((i) => (i.id === updated.id ? updated : i))
            )
          } else if (payload.eventType === "DELETE") {
            const deleted = payload.old as { id: string }
            setItems((prev) => prev.filter((i) => i.id !== deleted.id))
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [householdId])

  // 在庫低下チェック（30分間隔で自動実行）
  useEffect(() => {
    const key = "stock_low_checked_at"
    const THIRTY_MIN = 30 * 60 * 1000
    const last = sessionStorage.getItem(key)

    if (last && Date.now() - Number(last) < THIRTY_MIN) return

    checkAndAutoAddLowStock().then((result) => {
      if (result.error) return
      sessionStorage.setItem(key, String(Date.now()))
      if (result.addedItems.length > 0) {
        toast.success(
          `在庫が少ない${result.addedItems.length}件を買い物リストに追加しました`,
          { description: result.addedItems.join("、") },
        )
      }
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleOptimisticDelete = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const handleEdit = useCallback((item: StockItemData) => {
    setEditingItem(item)
    setSheetOpen(true)
  }, [])

  const handleAdd = () => {
    setEditingItem(null)
    setSheetOpen(true)
  }

  const grouped = useMemo(() => {
    const groups = new Map<ItemCategory, StockItemData[]>()
    for (const item of items) {
      const list = groups.get(item.category) ?? []
      list.push(item)
      groups.set(item.category, list)
    }
    const ordered: [ItemCategory, StockItemData[]][] = []
    for (const cat of categoryDisplayOrder) {
      const list = groups.get(cat)
      if (list && list.length > 0) {
        list.sort((a, b) => a.name.localeCompare(b.name, "ja"))
        ordered.push([cat, list])
      }
    }
    return ordered
  }, [items])

  const expiringCount = useMemo(() => countExpiringItems(items), [items])

  return (
    <div className="flex flex-col gap-4 px-4 pt-12 pb-8">
      {/* ヘッダー */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold">在庫</h1>
          <span className="text-sm text-muted-foreground">
            {items.length}件
          </span>
        </div>

        <Button
          onClick={handleAdd}
          size="sm"
          className="cursor-pointer"
        >
          <Plus size={16} />
          追加
        </Button>
      </div>

      {/* 期限切れアラート */}
      {expiringCount > 0 && (
        <div className="flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-700">
          <AlertTriangle size={16} className="shrink-0" />
          <span>
            {expiringCount}件のアイテムが期限切れ間近です
          </span>
        </div>
      )}

      {/* おすすめ献立セクション */}
      <StockSuggestions
        initialSuggestions={initialSuggestions}
        items={items}
      />

      {/* アイテム一覧 */}
      {grouped.length === 0 ? (
        <div className="flex min-h-[40dvh] flex-col items-center justify-center gap-3">
          <Package size={48} className="text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">
            在庫が登録されていません
          </p>
          <Button
            onClick={handleAdd}
            variant="outline"
            className="cursor-pointer"
          >
            <Plus size={16} />
            最初のアイテムを追加
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {grouped.map(([category, categoryItems]) => {
            const Icon = categoryIcons[category]
            return (
              <div key={category}>
                {/* カテゴリーヘッダー */}
                <div className="flex items-center gap-2 px-1 pt-3 pb-1">
                  <Icon size={14} className="text-muted-foreground" />
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    {getCategoryLabel(category)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {categoryItems.length}
                  </span>
                </div>

                {/* アイテム一覧 */}
                <div className="glass rounded-2xl shadow-lg shadow-black/[0.04] divide-y divide-border/30">
                  {categoryItems.map((item) => (
                    <StockItem
                      key={item.id}
                      item={item}
                      dailyRate={consumptionRates[item.category] ?? null}
                      onEdit={handleEdit}
                      onOptimisticDelete={handleOptimisticDelete}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 追加・編集シート */}
      <StockFormSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        editingItem={editingItem}
      />
    </div>
  )
}

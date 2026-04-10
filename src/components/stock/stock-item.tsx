"use client"

import { useState, useTransition, useRef, useEffect } from "react"
import { Trash2, ShoppingCart } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { getCategoryLabel, getCategoryColor } from "@/lib/utils/categories"
import { daysFromTodayJst } from "@/lib/utils/date-jst"
import { Button } from "@/components/ui/button"
import { deleteStockItem, addToShoppingList } from "@/app/(main)/stock/actions"
import type { ItemCategory } from "@/lib/types/database"

export interface StockItemData {
  id: string
  name: string
  category: ItemCategory
  quantity: number
  unit: string | null
  expires_at: string | null
  created_by: string
  created_at: string
  updated_at: string
}

interface StockItemProps {
  item: StockItemData
  onEdit: (item: StockItemData) => void
  onOptimisticDelete: (id: string) => void
}

function getExpiryStatus(expiresAt: string | null): {
  label: string
  className: string
} | null {
  if (!expiresAt) return null

  const diffDays = daysFromTodayJst(expiresAt)
  if (diffDays === null) return null

  // expiresAt は "YYYY-MM-DD" 形式。月日はタイムゾーン非依存で文字列から抽出。
  const parts = expiresAt.split("-")
  const month = Number(parts[1])
  const day = Number(parts[2])
  const monthDayLabel = `${month}/${day}`

  if (diffDays < 0) {
    return { label: "期限切れ", className: "bg-red-100 text-red-700" }
  }
  if (diffDays === 0) {
    return { label: "今日まで", className: "bg-red-100 text-red-700" }
  }
  if (diffDays <= 3) {
    return {
      label: `あと${diffDays}日`,
      className: "bg-amber-100 text-amber-700",
    }
  }
  if (diffDays <= 7) {
    return { label: monthDayLabel, className: "bg-yellow-50 text-yellow-700" }
  }
  return { label: monthDayLabel, className: "text-muted-foreground" }
}

export function StockItem({
  item,
  onEdit,
  onOptimisticDelete,
}: StockItemProps) {
  const [isPending, startTransition] = useTransition()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    }
  }, [])

  const expiryStatus = getExpiryStatus(item.expires_at)

  const handleDelete = () => {
    if (!confirmDelete) {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      setConfirmDelete(true)
      confirmTimerRef.current = setTimeout(() => setConfirmDelete(false), 3000)
      return
    }

    onOptimisticDelete(item.id)

    startTransition(async () => {
      const result = await deleteStockItem(item.id)
      if (result.error) {
        toast.error(result.error)
      }
    })
  }

  const handleAddToShopping = () => {
    startTransition(async () => {
      const result = await addToShoppingList(item.id)
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success(`${item.name}を買い物リストに追加しました`)
      }
    })
  }

  return (
    <div className="group flex min-h-11 items-center gap-2 px-3 py-2">
      {/* メイン: タップで編集 */}
      <button
        type="button"
        onClick={() => onEdit(item)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{item.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {item.quantity}{item.unit ? ` ${item.unit}` : ""}
            </span>
          </div>
        </div>

        {/* カテゴリバッジ */}
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
            getCategoryColor(item.category)
          )}
        >
          {getCategoryLabel(item.category)}
        </span>

        {/* 賞味期限バッジ */}
        {expiryStatus && (
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
              expiryStatus.className
            )}
          >
            {expiryStatus.label}
          </span>
        )}
      </button>

      {/* 買い物リストに追加 */}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={handleAddToShopping}
        disabled={isPending}
        className={cn(
          "shrink-0 cursor-pointer opacity-0 group-hover:opacity-100 transition-colors duration-200",
          "max-sm:opacity-100"
        )}
        aria-label={`${item.name}を買い物リストに追加`}
      >
        <ShoppingCart size={14} />
      </Button>

      {/* 削除 */}
      <Button
        type="button"
        variant={confirmDelete ? "destructive" : "ghost"}
        size="icon-sm"
        onClick={handleDelete}
        disabled={isPending}
        className={cn(
          "shrink-0 cursor-pointer opacity-0 group-hover:opacity-100 transition-colors duration-200",
          "max-sm:opacity-100"
        )}
        aria-label={confirmDelete ? `${item.name}を削除（確認）` : `${item.name}を削除`}
      >
        <Trash2 size={14} />
      </Button>
    </div>
  )
}

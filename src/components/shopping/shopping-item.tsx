"use client"

import { useState, useTransition, useRef, useEffect } from "react"
import { Trash2 } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { getCategoryLabel, getCategoryColor } from "@/lib/utils/categories"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { toggleItem, deleteItem } from "@/app/(main)/shopping/actions"
import type { ItemCategory, StoreType } from "@/lib/types/database"

export interface ShoppingItemData {
  id: string
  name: string
  quantity: string | null
  category: ItemCategory
  store_type: StoreType
  is_checked: boolean
  checked_by: string | null
  checked_at: string | null
  sort_order: number
}

interface ShoppingItemProps {
  item: ShoppingItemData
  checkedByName?: string | null
  onOptimisticToggle: (id: string, isChecked: boolean) => void
  onOptimisticDelete: (id: string) => void
}

export function ShoppingItem({
  item,
  checkedByName,
  onOptimisticToggle,
  onOptimisticDelete,
}: ShoppingItemProps) {
  const [isPending, startTransition] = useTransition()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout>>(null)

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    }
  }, [])

  const handleToggle = () => {
    const newChecked = !item.is_checked
    onOptimisticToggle(item.id, newChecked)

    startTransition(async () => {
      const result = await toggleItem(item.id, newChecked)
      if (result.error) {
        // ロールバック
        onOptimisticToggle(item.id, !newChecked)
        toast.error(result.error)
      }
    })
  }

  const handleDelete = () => {
    if (!confirmDelete) {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      setConfirmDelete(true)
      confirmTimerRef.current = setTimeout(() => setConfirmDelete(false), 3000)
      return
    }

    onOptimisticDelete(item.id)

    startTransition(async () => {
      const result = await deleteItem(item.id)
      if (result.error) {
        toast.error(result.error)
      }
    })
  }

  return (
    <div
      className={cn(
        "group flex min-h-11 items-center gap-3 rounded-xl px-3 py-2 transition-colors duration-200",
        item.is_checked
          ? "opacity-50"
          : "active:bg-accent/50"
      )}
    >
      {/* チェックボックス - 大きなタッチターゲット */}
      <button
        type="button"
        onClick={handleToggle}
        disabled={isPending}
        className="flex size-11 shrink-0 items-center justify-center -ml-2"
        aria-label={item.is_checked ? `${item.name}のチェックを外す` : `${item.name}をチェック`}
      >
        <Checkbox
          checked={item.is_checked}
          onCheckedChange={() => {}}
          className={cn(
            "size-5 rounded-md transition-colors duration-200 pointer-events-none",
            item.is_checked && "data-checked:bg-primary/60"
          )}
          tabIndex={-1}
        />
      </button>

      {/* アイテム情報 */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-sm font-medium truncate transition-colors duration-200",
              item.is_checked && "line-through text-muted-foreground"
            )}
          >
            {item.name}
          </span>
          {item.quantity && (
            <span
              className={cn(
                "shrink-0 text-xs text-muted-foreground",
                item.is_checked && "line-through"
              )}
            >
              {item.quantity}
            </span>
          )}
        </div>
        {item.is_checked && checkedByName && (
          <span className="text-[10px] text-muted-foreground">
            {checkedByName}
          </span>
        )}
      </div>

      {/* カテゴリーバッジ */}
      <span
        className={cn(
          "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
          getCategoryColor(item.category)
        )}
      >
        {getCategoryLabel(item.category)}
      </span>

      {/* 削除ボタン */}
      <Button
        type="button"
        variant={confirmDelete ? "destructive" : "ghost"}
        size="icon-sm"
        onClick={handleDelete}
        disabled={isPending}
        className={cn(
          "shrink-0 cursor-pointer opacity-0 group-hover:opacity-100 transition-colors duration-200",
          "touch-action-manipulation [touch-action:manipulation]",
          // モバイルでは常に表示
          "max-sm:opacity-100"
        )}
        aria-label={confirmDelete ? `${item.name}を削除（確認）` : `${item.name}を削除`}
      >
        <Trash2 size={14} />
      </Button>
    </div>
  )
}

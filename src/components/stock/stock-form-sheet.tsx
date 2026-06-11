"use client"

import { useState, useTransition } from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { addStockItem, updateStockItem } from "@/app/(main)/stock/actions"
import { allCategories } from "@/lib/utils/categories"
import type { StockItemData } from "./stock-item"
import type { ItemCategory } from "@/lib/types/database"

const STOCK_UNITS = [
  { value: "個", label: "個" },
  { value: "パック", label: "パック" },
  { value: "本", label: "本" },
  { value: "袋", label: "袋" },
  { value: "缶", label: "缶" },
  { value: "箱", label: "箱" },
  { value: "枚", label: "枚" },
  { value: "切", label: "切れ" },
  { value: "g", label: "g" },
  { value: "kg", label: "kg" },
  { value: "ml", label: "ml" },
  { value: "L", label: "L" },
]

interface StockFormSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingItem: StockItemData | null
}

export function StockFormSheet({
  open,
  onOpenChange,
  editingItem,
}: StockFormSheetProps) {
  const isEditing = !!editingItem
  const [isPending, startTransition] = useTransition()

  const [name, setName] = useState("")
  const [category, setCategory] = useState<ItemCategory>("other_food")
  const [quantity, setQuantity] = useState("1")
  const [unit, setUnit] = useState("")
  const [expiresAt, setExpiresAt] = useState("")

  // open/editingItem が変化した時にフォームを初期化する。
  // useEffect ではなく render-time conditional setState パターンを使い、
  // setState-in-effect 警告を回避する（React公式推奨）。
  // See: https://react.dev/learn/you-might-not-need-an-effect#resetting-all-state-when-a-prop-changes
  const [prevKey, setPrevKey] = useState<string | null>(null)
  const currentKey = open ? (editingItem?.id ?? "__new__") : null

  if (currentKey !== prevKey) {
    setPrevKey(currentKey)
    if (open) {
      setName(editingItem?.name ?? "")
      setCategory(editingItem?.category ?? "other_food")
      setQuantity(editingItem ? String(editingItem.quantity) : "1")
      setUnit(editingItem?.unit ?? "")
      setExpiresAt(editingItem?.expires_at?.split("T")[0] ?? "")
    }
  }

  const handleSubmit = () => {
    if (!name.trim()) {
      toast.error("アイテム名を入力してください")
      return
    }

    const formData = new FormData()
    formData.set("name", name.trim())
    formData.set("category", category)
    formData.set("quantity", quantity || "1")
    formData.set("unit", unit)
    formData.set("expires_at", expiresAt)

    startTransition(async () => {
      const result = isEditing
        ? await updateStockItem(editingItem.id, formData)
        : await addStockItem(formData)

      if ("error" in result) {
        toast.error(result.error)
      } else {
        toast.success(isEditing ? "在庫を更新しました" : "在庫を追加しました")
        onOpenChange(false)
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-2xl">
        <SheetHeader>
          <SheetTitle>
            {isEditing ? "在庫を編集" : "在庫を追加"}
          </SheetTitle>
          <SheetDescription>
            {isEditing
              ? "在庫情報を更新します"
              : "冷蔵庫・冷凍庫・パントリーの在庫を記録します"}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 py-4">
          {/* アイテム名 */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="stock-name">アイテム名</Label>
            <Input
              id="stock-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: 牛乳、豚バラ肉"
              className="h-11"
              autoFocus
            />
          </div>

          {/* カテゴリ */}
          <div className="flex flex-col gap-2">
            <Label>カテゴリ</Label>
            <Select
              items={allCategories}
              value={category}
              onValueChange={(v) => setCategory(v as ItemCategory)}
            >
              <SelectTrigger className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {allCategories.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 数量 + 単位 */}
          <div className="flex gap-3">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="stock-quantity">数量</Label>
              <Input
                id="stock-quantity"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="h-11"
              />
            </div>
            <div className="flex flex-1 flex-col gap-2">
              <Label>単位</Label>
              <Select items={STOCK_UNITS} value={unit} onValueChange={(v) => setUnit(v ?? "")}>
                <SelectTrigger className="h-11">
                  <SelectValue placeholder="選択" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">なし</SelectItem>
                  {STOCK_UNITS.map((u) => (
                    <SelectItem key={u.value} value={u.value}>
                      {u.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* 賞味期限 */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="stock-expires">賞味期限</Label>
            <Input
              id="stock-expires"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="h-11"
            />
          </div>
        </div>

        <SheetFooter className="flex-row gap-3">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="flex-1 cursor-pointer"
            disabled={isPending}
          >
            キャンセル
          </Button>
          <Button
            onClick={handleSubmit}
            className="flex-1 cursor-pointer"
            disabled={isPending}
          >
            {isPending ? (
              <Loader2 size={16} className="animate-spin" />
            ) : null}
            {isEditing ? "更新" : "追加"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

"use client"

import { useRef, useState, useTransition } from "react"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2, Plus, Trash2, ReceiptText, Camera } from "lucide-react"
import { toast } from "sonner"
import { addReceiptItemsToStock } from "@/app/(main)/stock/actions"
import { allCategories } from "@/lib/utils/categories"
import { guessItemCategory } from "@/lib/domain/item-category-guess"
import { scannedItemsToDrafts, type ReceiptDraftItem } from "@/lib/domain/receipt"
import { scanReceiptWithTesseract } from "@/lib/ocr/scan-receipt"
import type { ItemCategory } from "@/lib/types/database"

interface DraftRow {
  id: number
  name: string
  category: ItemCategory
  quantity: string
  /** ユーザーが手動でカテゴリを変えたら自動推測を止める */
  categoryTouched: boolean
}

interface ReceiptEntrySheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function blankRow(id: number): DraftRow {
  return { id, name: "", category: "other_food", quantity: "1", categoryTouched: false }
}

/** 既存行の最大 id + 1（ref を使わず render 安全に一意 id を採る） */
function nextRowId(rows: DraftRow[]): number {
  return rows.reduce((max, r) => Math.max(max, r.id), 0) + 1
}

export function ReceiptEntrySheet({ open, onOpenChange }: ReceiptEntrySheetProps) {
  const [rows, setRows] = useState<DraftRow[]>(() => [blankRow(0)])
  const [isPending, startTransition] = useTransition()
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // open が閉→開に変わったら入力をリセット
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setRows([blankRow(0)])
      setScanning(false)
      setScanProgress(0)
    }
  }

  const handleScanFile = (file: File) => {
    setScanning(true)
    setScanProgress(0)
    scanReceiptWithTesseract(file, (p) => {
      if (p.status === "recognizing text") {
        setScanProgress(Math.round(p.progress * 100))
      }
    })
      .then((scanned) => {
        const drafts = scannedItemsToDrafts(scanned)
        if (drafts.length === 0) {
          toast.error("レシートから商品を読み取れませんでした。手入力してください")
          return
        }
        setRows((prev) => {
          const filled = prev.filter((r) => r.name.trim() !== "")
          let id = filled.reduce((max, r) => Math.max(max, r.id), 0) + 1
          const scannedRows: DraftRow[] = drafts.map((d) => ({
            id: id++,
            name: d.name,
            category: d.category,
            quantity: String(d.quantity),
            categoryTouched: false,
          }))
          return filled.length > 0 ? [...filled, ...scannedRows] : scannedRows
        })
        toast.success(`${drafts.length}件を読み取りました。確認して追加してください`)
      })
      .catch(() => {
        toast.error("読み取りに失敗しました")
      })
      .finally(() => setScanning(false))
  }

  const filledCount = rows.filter((r) => r.name.trim() !== "").length

  const addRow = () => {
    setRows((prev) => [...prev, blankRow(nextRowId(prev))])
  }

  const removeRow = (id: number) => {
    setRows((prev) => {
      const next = prev.filter((r) => r.id !== id)
      return next.length > 0 ? next : [blankRow(0)]
    })
  }

  const updateName = (id: number, name: string) => {
    setRows((prev) =>
      prev.map((r) =>
        r.id === id
          ? {
              ...r,
              name,
              // 未タッチのカテゴリは名前から自動推測
              category: r.categoryTouched ? r.category : guessItemCategory(name),
            }
          : r,
      ),
    )
  }

  const updateCategory = (id: number, category: ItemCategory) => {
    setRows((prev) =>
      prev.map((r) =>
        r.id === id ? { ...r, category, categoryTouched: true } : r,
      ),
    )
  }

  const updateQuantity = (id: number, quantity: string) => {
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, quantity } : r)),
    )
  }

  const handleSubmit = () => {
    const drafts: ReceiptDraftItem[] = rows
      .filter((r) => r.name.trim() !== "")
      .map((r) => ({
        name: r.name,
        category: r.category,
        quantity: Number(r.quantity),
      }))

    if (drafts.length === 0) {
      toast.error("商品名を入力してください")
      return
    }

    startTransition(async () => {
      const result = await addReceiptItemsToStock(drafts)
      if ("error" in result) {
        toast.error(result.error)
        return
      }
      toast.success(`${result.count}件を在庫に追加しました`)
      onOpenChange(false)
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto rounded-t-2xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <ReceiptText size={18} className="text-primary" />
            レシートから追加
          </SheetTitle>
          <SheetDescription>
            買ったものを続けて入力できます。カテゴリは名前から自動で推測します（変更可）。
          </SheetDescription>
        </SheetHeader>

        {/* 端末内 OCR で写真から読み取る（外部送信なし） */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleScanFile(file)
            e.target.value = "" // 同じ写真を再選択できるようクリア
          }}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={scanning || isPending}
          className="mt-3 w-full cursor-pointer"
        >
          {scanning ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              読み取り中… {scanProgress > 0 ? `${scanProgress}%` : ""}
            </>
          ) : (
            <>
              <Camera size={16} />
              レシートを撮影して読み取る（端末内・送信なし）
            </>
          )}
        </Button>

        <div className="flex flex-col gap-2 py-4">
          {rows.map((row, index) => (
            <div key={row.id} className="flex items-center gap-2">
              <Input
                value={row.name}
                onChange={(e) => updateName(row.id, e.target.value)}
                placeholder="商品名"
                aria-label={`商品名 ${index + 1}`}
                className="h-11 flex-1"
                autoFocus={index === 0}
              />
              <Select
                items={allCategories}
                value={row.category}
                onValueChange={(v) => updateCategory(row.id, v as ItemCategory)}
              >
                <SelectTrigger className="h-11 w-24 shrink-0" aria-label={`カテゴリ ${index + 1}`}>
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
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step="1"
                value={row.quantity}
                onChange={(e) => updateQuantity(row.id, e.target.value)}
                aria-label={`数量 ${index + 1}`}
                className="h-11 w-14 shrink-0 px-2 text-center"
              />
              <button
                type="button"
                onClick={() => removeRow(row.id)}
                aria-label={`${index + 1}行目を削除`}
                className="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors duration-200 hover:bg-muted hover:text-foreground"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            onClick={addRow}
            className="mt-1 cursor-pointer self-start"
          >
            <Plus size={16} />
            行を追加
          </Button>
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
            {isPending ? <Loader2 size={16} className="animate-spin" /> : null}
            まとめて追加{filledCount > 0 ? `（${filledCount}件）` : ""}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

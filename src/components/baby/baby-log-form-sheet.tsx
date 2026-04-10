"use client"

import { useState, useEffect, useTransition } from "react"
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
import { Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { updateLog, deleteLog } from "@/app/(main)/baby/actions"
import {
  getLogTypeLabel,
  getFeedingTypeLabel,
  getDiaperTypeLabel,
} from "@/lib/utils/baby-log-labels"
import { formatTimeJst } from "@/lib/utils/date-jst"
import type { FeedingType, DiaperType } from "@/lib/types/database"
import type { BabyLogData } from "@/lib/types/baby"

const FEEDING_TYPES: FeedingType[] = [
  "breast_left",
  "breast_right",
  "bottle",
  "solid",
]
const DIAPER_TYPES: DiaperType[] = ["pee", "poop", "both"]

function segmentCn(active: boolean): string {
  return `flex-1 rounded-lg px-2 py-2 text-sm font-medium transition-colors duration-200 ${
    active
      ? "bg-primary text-primary-foreground"
      : "bg-muted text-muted-foreground hover:text-foreground"
  }`
}

interface BabyLogFormSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  log: BabyLogData | null
}

export function BabyLogFormSheet({
  open,
  onOpenChange,
  log,
}: BabyLogFormSheetProps) {
  const [isPending, startTransition] = useTransition()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const [feedingType, setFeedingType] = useState<FeedingType>("bottle")
  const [amountMl, setAmountMl] = useState("")
  const [diaperType, setDiaperType] = useState<DiaperType>("pee")
  const [memo, setMemo] = useState("")

  // Sync form state when sheet opens with a log
  useEffect(() => {
    if (open && log) {
      setFeedingType(log.feeding_type ?? "bottle")
      setAmountMl(log.amount_ml?.toString() ?? "")
      setDiaperType(log.diaper_type ?? "pee")
      setMemo(log.memo ?? "")
      setShowDeleteConfirm(false)
    }
  }, [open, log])

  function handleSave() {
    if (!log) return

    startTransition(async () => {
      const updates: Parameters<typeof updateLog>[1] = { memo: memo || null }

      if (log.log_type === "feeding") {
        updates.feedingType = feedingType
        updates.amountMl =
          feedingType === "bottle" || feedingType === "solid"
            ? parseInt(amountMl) || null
            : null
      }
      if (log.log_type === "diaper") {
        updates.diaperType = diaperType
      }

      const result = await updateLog(log.id, updates)
      if (result.error) {
        toast.error(result.error)
        return
      }
      toast.success("ログを更新しました")
      onOpenChange(false)
    })
  }

  function handleDelete() {
    if (!log) return

    startTransition(async () => {
      const result = await deleteLog(log.id)
      if (result.error) {
        toast.error(result.error)
        return
      }
      toast.success("ログを削除しました")
      onOpenChange(false)
    })
  }

  if (!log) return null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[85dvh] overflow-hidden rounded-t-2xl safe-bottom"
      >
        <SheetHeader className="pb-2">
          <SheetTitle>{getLogTypeLabel(log.log_type)}を編集</SheetTitle>
          <SheetDescription>
            {formatTimeJst(log.logged_at)} の記録を変更できます
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-2">
          {/* Feeding-specific fields */}
          {log.log_type === "feeding" && (
            <>
              <div className="space-y-1.5">
                <Label>種類</Label>
                <div className="flex gap-1.5">
                  {FEEDING_TYPES.map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setFeedingType(type)}
                      className={segmentCn(feedingType === type)}
                    >
                      {getFeedingTypeLabel(type)}
                    </button>
                  ))}
                </div>
              </div>

              {(feedingType === "bottle" || feedingType === "solid") && (
                <div className="space-y-1.5">
                  <Label htmlFor="amount-ml">量 (ml)</Label>
                  <Input
                    id="amount-ml"
                    type="number"
                    inputMode="numeric"
                    placeholder="例: 80"
                    value={amountMl}
                    onChange={(e) => setAmountMl(e.target.value)}
                    disabled={isPending}
                    className="min-h-11 rounded-lg"
                    min={0}
                    max={999}
                  />
                </div>
              )}
            </>
          )}

          {/* Diaper-specific fields */}
          {log.log_type === "diaper" && (
            <div className="space-y-1.5">
              <Label>種類</Label>
              <div className="flex gap-1.5">
                {DIAPER_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setDiaperType(type)}
                    className={segmentCn(diaperType === type)}
                  >
                    {getDiaperTypeLabel(type)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Memo (all types) */}
          <div className="space-y-1.5">
            <Label htmlFor="memo">メモ</Label>
            <Input
              id="memo"
              type="text"
              placeholder="任意のメモ"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              disabled={isPending}
              autoComplete="off"
              className="min-h-11 rounded-lg"
            />
          </div>

          {/* Delete */}
          <div className="border-t pt-3">
            {showDeleteConfirm ? (
              <div className="flex items-center gap-2">
                <p className="flex-1 text-sm text-destructive">
                  本当に削除しますか？
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowDeleteConfirm(false)}
                  disabled={isPending}
                >
                  キャンセル
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={handleDelete}
                  disabled={isPending}
                >
                  {isPending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    "削除する"
                  )}
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowDeleteConfirm(true)}
                className="w-full text-destructive hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
                この記録を削除
              </Button>
            )}
          </div>
        </div>

        <SheetFooter>
          <Button
            onClick={handleSave}
            disabled={isPending}
            className="min-h-11 w-full rounded-lg text-base font-semibold"
          >
            {isPending ? (
              <>
                <Loader2 className="animate-spin" />
                更新中...
              </>
            ) : (
              "更新する"
            )}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

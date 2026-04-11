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
import { Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"
import {
  updateLog,
  deleteLog,
  recordTemperature,
  recordGrowth,
  recordMemo as recordMemoAction,
} from "@/app/(main)/baby/actions"
import {
  getLogTypeLabel,
  getFeedingTypeLabel,
  getDiaperTypeLabel,
} from "@/lib/utils/baby-log-labels"
import { formatTimeJst } from "@/lib/utils/date-jst"
import { segmentCn } from "@/lib/utils/segment-cn"
import type { BabyLogType, FeedingType, DiaperType } from "@/lib/types/database"
import type { BabyLogData } from "@/lib/types/baby"

const FEEDING_TYPES: FeedingType[] = [
  "breast_left",
  "breast_right",
  "bottle",
  "solid",
]
const DIAPER_TYPES: DiaperType[] = ["pee", "poop", "both"]

interface BabyLogFormSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** edit mode: 既存ログの編集 */
  log: BabyLogData | null
  /** create mode: 新規ログのタイプ（log が null 時に使用） */
  createLogType?: BabyLogType | null
}

export function BabyLogFormSheet({
  open,
  onOpenChange,
  log,
  createLogType,
}: BabyLogFormSheetProps) {
  const [isPending, startTransition] = useTransition()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // 親がkey={formKey}で毎回remountするため、propsから直接初期化
  const [feedingType, setFeedingType] = useState<FeedingType>(log?.feeding_type ?? "bottle")
  const [amountMl, setAmountMl] = useState(log?.amount_ml?.toString() ?? "")
  const [diaperType, setDiaperType] = useState<DiaperType>(log?.diaper_type ?? "pee")
  const [temperature, setTemperature] = useState(log?.temperature?.toString() ?? "")
  const [weightG, setWeightG] = useState(log?.weight_g?.toString() ?? "")
  const [heightCm, setHeightCm] = useState(log?.height_cm?.toString() ?? "")
  const [memo, setMemo] = useState(log?.memo ?? "")

  const isCreateMode = !log && !!createLogType
  const logType = log?.log_type ?? createLogType

  function handleSave() {
    if (isCreateMode) {
      handleCreate()
    } else if (log) {
      handleUpdate()
    }
  }

  function handleCreate() {
    startTransition(async () => {
      let result: { error: string | null }

      switch (createLogType) {
        case "temperature": {
          const temp = parseFloat(temperature)
          if (isNaN(temp) || temp < 34 || temp > 42) {
            toast.error("体温は34.0〜42.0の範囲で入力してください")
            return
          }
          result = await recordTemperature({
            temperature: temp,
            memo: memo || undefined,
          })
          break
        }
        case "growth": {
          const w = weightG ? parseInt(weightG) : null
          const h = heightCm ? parseFloat(heightCm) : null
          if (!w && !h) {
            toast.error("体重または身長を入力してください")
            return
          }
          result = await recordGrowth({
            weightG: w,
            heightCm: h,
            memo: memo || undefined,
          })
          break
        }
        case "memo": {
          if (!memo.trim()) {
            toast.error("メモを入力してください")
            return
          }
          result = await recordMemoAction({ memo: memo.trim() })
          break
        }
        default:
          return
      }

      if (result.error) {
        toast.error(result.error)
        return
      }
      toast.success("記録しました")
      onOpenChange(false)
    })
  }

  function handleUpdate() {
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
      if (log.log_type === "temperature") {
        const temp = parseFloat(temperature)
        if (isNaN(temp) || temp < 34 || temp > 42) {
          toast.error("体温は34.0〜42.0の範囲で入力してください")
          return
        }
        updates.temperature = temp
      }
      if (log.log_type === "growth") {
        const w = weightG ? parseInt(weightG) : null
        const h = heightCm ? parseFloat(heightCm) : null
        if (!w && !h) {
          toast.error("体重または身長を入力してください")
          return
        }
        updates.weightG = w
        updates.heightCm = h
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

  if (!logType) return null

  const title = isCreateMode
    ? `${getLogTypeLabel(logType)}を記録`
    : `${getLogTypeLabel(logType)}を編集`
  const description = isCreateMode
    ? undefined
    : log
      ? `${formatTimeJst(log.logged_at)} の記録を変更できます`
      : undefined

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[85dvh] overflow-hidden rounded-t-2xl safe-bottom"
      >
        <SheetHeader className="pb-2">
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>

        <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-2">
          {/* Feeding fields */}
          {logType === "feeding" && (
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

          {/* Diaper fields */}
          {logType === "diaper" && (
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

          {/* Temperature field */}
          {logType === "temperature" && (
            <div className="space-y-1.5">
              <Label htmlFor="temperature">体温 (℃)</Label>
              <Input
                id="temperature"
                type="number"
                inputMode="decimal"
                placeholder="例: 36.5"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                disabled={isPending}
                className="min-h-11 rounded-lg"
                min={34}
                max={42}
                step={0.1}
              />
            </div>
          )}

          {/* Growth fields */}
          {logType === "growth" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="weight-g">体重 (g)</Label>
                <Input
                  id="weight-g"
                  type="number"
                  inputMode="numeric"
                  placeholder="例: 4500"
                  value={weightG}
                  onChange={(e) => setWeightG(e.target.value)}
                  disabled={isPending}
                  className="min-h-11 rounded-lg"
                  min={0}
                  max={30000}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="height-cm">身長 (cm)</Label>
                <Input
                  id="height-cm"
                  type="number"
                  inputMode="decimal"
                  placeholder="例: 55.0"
                  value={heightCm}
                  onChange={(e) => setHeightCm(e.target.value)}
                  disabled={isPending}
                  className="min-h-11 rounded-lg"
                  min={0}
                  max={150}
                  step={0.1}
                />
              </div>
            </>
          )}

          {/* Memo (all types) */}
          <div className="space-y-1.5">
            <Label htmlFor="memo">メモ</Label>
            <Input
              id="memo"
              type="text"
              placeholder={logType === "memo" ? "メモを入力" : "任意のメモ"}
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              disabled={isPending}
              autoComplete="off"
              className="min-h-11 rounded-lg"
            />
          </div>

          {/* Delete (edit mode only) */}
          {!isCreateMode && log && (
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
          )}
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
                {isCreateMode ? "記録中..." : "更新中..."}
              </>
            ) : isCreateMode ? (
              "記録する"
            ) : (
              "更新する"
            )}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

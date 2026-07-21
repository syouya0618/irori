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
  recordFeeding,
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
import { buildOptimisticLog } from "@/lib/domain/baby-optimistic-log"
import type { BabyLogType, FeedingType, DiaperType } from "@/lib/types/database"
import type { BabyLogData } from "@/lib/types/baby"

const FEEDING_TYPES: FeedingType[] = [
  "breast_left",
  "breast_right",
  "bottle",
  "solid",
  "pumped",
]
const DIAPER_TYPES: DiaperType[] = ["pee", "poop", "both"]

// 量（ml）を伴う授乳タイプ。母乳（左/右）は量を測らないため除外する。
const AMOUNT_FEEDING_TYPES: FeedingType[] = ["bottle", "solid", "pumped"]

function allowsAmount(type: FeedingType): boolean {
  return AMOUNT_FEEDING_TYPES.includes(type)
}

// 搾乳・ミルク等の量をワンタップで入れるプリセット（10mL刻み・10〜100mL）。
// これらは近道であって上限ではない。100mL を超える量は下の自由入力で記録できる。
const AMOUNT_PRESETS_ML = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]

// 「量 (ml)」入力を DB CHECK（0〜999）と整合する number|null へ正規化する。
// falsy 衝突（0ml を null 扱いしない）を避けるため Number.isFinite で判定する。
function parseAmountMl(raw: string): number | null {
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// 通信断で Server Action が reject すると、startTransition 内の unhandled reject が
// 最寄りの error boundary へ bubble し全画面エラー化 + 入力/記録が無言で失われる
// (node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md:375)。
// 圏外操作でその袋小路に落ちないよう、各ハンドラの reject を握ってトーストへ倒す。
const OFFLINE_ERROR_MESSAGE =
  "通信できませんでした。電波の良い場所でもう一度お試しください"

function toastOfflineError(context: string, err: unknown) {
  // 握り潰さずエラー詳細を構造化ログに残す（CLAUDE.md: catch 内でログ必須）。
  console.error(`[baby-log-form-sheet] ${context} が例外を投げました`, {
    message: err instanceof Error ? err.message : String(err),
  })
  toast.error(OFFLINE_ERROR_MESSAGE)
}

interface BabyLogFormSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** edit mode: 既存ログの編集 */
  log: BabyLogData | null
  /** create mode: 新規ログのタイプ（log が null 時に使用） */
  createLogType?: BabyLogType | null
  /**
   * create mode で log_type='feeding' の時の初期授乳タイプ（搾乳の記録導線用）。
   * 未指定時は "bottle" にフォールバックする。
   */
  createFeedingType?: FeedingType | null
  /** 記録者（logged_by）。楽観 append 行の作成に使う（B-03） */
  userId: string
  /**
   * 作成成功時に楽観 append する行を親へ渡す（B-03）。作成導線は quick actions
   * （isToday ゲート下）からのみ開くため、logged_at（client now）は選択日と一致する。
   * 編集（update）は既存行の書き換えで append 対象外 — 反映は従来どおり Realtime 経路。
   */
  onLogRecorded?: (log: BabyLogData) => void
  /** 削除成功時にローカル state から除去する行の id を親へ渡す（B-03） */
  onLogRemoved?: (id: string) => void
}

export function BabyLogFormSheet({
  open,
  onOpenChange,
  log,
  createLogType,
  createFeedingType,
  userId,
  onLogRecorded,
  onLogRemoved,
}: BabyLogFormSheetProps) {
  const [isPending, startTransition] = useTransition()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // 親がkey={formKey}で毎回remountするため、propsから直接初期化
  const [feedingType, setFeedingType] = useState<FeedingType>(
    log?.feeding_type ?? createFeedingType ?? "bottle",
  )
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
      try {
        let result: { error: string | null; id: string | null }
        // B-03: 成功時に返却 id で楽観 append する行を組む builder（値が in-scope な
        // 各 case 内で確定させる）。null のままなら append しない。
        let buildLog: ((id: string) => BabyLogData) | null = null

        switch (createLogType) {
          case "feeding": {
            const amt = allowsAmount(feedingType)
              ? parseAmountMl(amountMl)
              : null
            result = await recordFeeding({
              feedingType,
              amountMl: amt,
              memo: memo || undefined,
            })
            buildLog = (id) =>
              buildOptimisticLog({
                id,
                logType: "feeding",
                loggedBy: userId,
                feedingType,
                amountMl: amt,
                memo: memo || null,
              })
            break
          }
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
            buildLog = (id) =>
              buildOptimisticLog({
                id,
                logType: "temperature",
                loggedBy: userId,
                temperature: temp,
                memo: memo || null,
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
            buildLog = (id) =>
              buildOptimisticLog({
                id,
                logType: "growth",
                loggedBy: userId,
                weightG: w,
                heightCm: h,
                memo: memo || null,
              })
            break
          }
          case "memo": {
            if (!memo.trim()) {
              toast.error("メモを入力してください")
              return
            }
            result = await recordMemoAction({ memo: memo.trim() })
            buildLog = (id) =>
              buildOptimisticLog({
                id,
                logType: "memo",
                loggedBy: userId,
                memo: memo.trim(),
              })
            break
          }
          default:
            return
        }

        if (result.error) {
          toast.error(result.error)
          return
        }
        // B-03: Realtime を待たず timeline へ楽観 append
        if (buildLog && result.id) {
          onLogRecorded?.(buildLog(result.id))
        }
        toast.success("記録しました")
        onOpenChange(false)
      } catch (err) {
        toastOfflineError("recordCreate", err)
      }
    })
  }

  function handleUpdate() {
    if (!log) return

    startTransition(async () => {
      try {
        const updates: Parameters<typeof updateLog>[1] = { memo: memo || null }

        if (log.log_type === "feeding") {
          updates.feedingType = feedingType
          updates.amountMl = allowsAmount(feedingType)
            ? parseAmountMl(amountMl)
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
      } catch (err) {
        toastOfflineError("updateLog", err)
      }
    })
  }

  function handleDelete() {
    if (!log) return

    startTransition(async () => {
      try {
        const result = await deleteLog(log.id)
        if (result.error) {
          toast.error(result.error)
          return
        }
        // B-03: Realtime DELETE echo を待たずローカル state からも除去
        onLogRemoved?.(log.id)
        toast.success("ログを削除しました")
        onOpenChange(false)
      } catch (err) {
        toastOfflineError("deleteLog", err)
      }
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

              {allowsAmount(feedingType) && (
                <div className="space-y-1.5">
                  <Label htmlFor="amount-ml">量 (ml)</Label>
                  {/* ワンタップ用プリセット（10〜100mL）。押すと下の入力欄に反映され、
                      100mL 超は入力欄で直接指定できる。 */}
                  <div className="grid grid-cols-5 gap-1.5">
                    {AMOUNT_PRESETS_ML.map((ml) => {
                      const active = amountMl === String(ml)
                      return (
                        <button
                          key={ml}
                          type="button"
                          onClick={() => setAmountMl(String(ml))}
                          disabled={isPending}
                          className={`min-h-11 rounded-lg text-sm font-medium transition-colors duration-200 disabled:opacity-50 ${
                            active
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {ml}
                        </button>
                      )
                    })}
                  </div>
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

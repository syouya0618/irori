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
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Loader2, Trash2, Minus, Plus } from "lucide-react"
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
import {
  formatTimeJst,
  formatJstTimeInput,
  toJstDateString,
  todayJstString,
} from "@/lib/utils/date-jst"
import {
  jstDateTimeToIso,
  validateLogTime,
} from "@/lib/domain/baby-log-time"
import { segmentCn } from "@/lib/utils/segment-cn"
import {
  allowsDuration,
  parseFeedingDurationInput,
} from "@/lib/domain/feeding"
import { buildOptimisticLog } from "@/lib/domain/baby-optimistic-log"
import type { BabyLogType, FeedingType, DiaperType } from "@/lib/types/database"
import type { BabyLogData } from "@/lib/types/baby"

// 新規記録で選べる授乳タイプ。母乳は 'breast'（左右の吸わせ回数を持つサイクル 1 行）へ
// 統一し、移行前の片側行 breast_left / breast_right は過去データ専用ゆえ並べない
// （6 択にすると 1 行の flex に収まらず「離乳食」が潰れて 44px タッチも崩れる）。
const FEEDING_TYPES: FeedingType[] = ["breast", "bottle", "solid", "pumped"]

/**
 * 種類ボタンに並べる授乳タイプ。移行前の片側行（breast_left / breast_right）を
 * 編集する時だけ、その行の種別を先頭に足す — さもなくば「どれも選択されていない」
 * 編集画面になり、種別を触っていないのに保存で別種別へ化けたように見える。
 *
 * 判定は**不変の prop**（log?.feeding_type ?? createFeedingType）から導くこと。
 * feedingType state から導くと母乳を選んだ瞬間に「左」ボタンが消えて列が横に跳ねる。
 * create 側も見るのは、呼び出し側が createFeedingType に片側行を渡した時に
 * 「選択中の種別に対応するボタンが無い（どれも highlight されない）」状態を作らないため。
 */
function feedingTypeOptions(
  logFeedingType: FeedingType | null | undefined,
): FeedingType[] {
  if (logFeedingType === "breast_left" || logFeedingType === "breast_right") {
    return [logFeedingType, ...FEEDING_TYPES]
  }
  return FEEDING_TYPES
}

const DIAPER_TYPES: DiaperType[] = ["pee", "poop", "both"]

// 量（ml）を伴う授乳タイプ。母乳（サイクル/片側とも）は量を測らないため除外する。
const AMOUNT_FEEDING_TYPES: FeedingType[] = ["bottle", "solid", "pumped"]

function allowsAmount(type: FeedingType): boolean {
  return AMOUNT_FEEDING_TYPES.includes(type)
}

// 母乳サイクルの左右回数の上限（DB CHECK chk_breast_counts_required の 0..20 と対）。
const BREAST_COUNT_MAX = 20
// 合計 0 の拒否文言。サーバ（actions.ts の BREAST_COUNTS_ERROR）と同じ規約だが、
// "use server" ファイルは関数以外を export できない（Turbopack がビルドで落ちる。
// しかも tsc では検出できない）ため定数は共有せず、ここに置く。
const BREAST_COUNTS_ERROR = "左右の回数は合計1回以上で指定してください"

// 回数を DB CHECK と同じ 0..20 の整数へ丸める。NaN は「最保守値 = 0」へ倒す
// （Math.min/max は NaN を素通しし、そのまま送ると DB CHECK 違反で保存が落ちる）。
function clampBreastCount(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(BREAST_COUNT_MAX, Math.max(0, Math.round(n)))
}

/**
 * 保存に使う左右回数を確定する。'breast' 以外は null（counts を持てない
 * = DB CHECK chk_breast_counts_only_breast のミラー）。
 */
function resolveBreastCounts(
  type: FeedingType,
  left: number,
  right: number,
): { left: number; right: number } | null {
  if (type !== "breast") return null
  return { left: clampBreastCount(left), right: clampBreastCount(right) }
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
  // 母乳サイクルの左右の吸わせ回数。既存行からは `??` で seed する — 0 は falsy だが
  // 有効値（片側だけ吸わせた回）ゆえ `||` で既定 1 に化けさせると DB と乖離する。
  // 他種別からの切替・新規記録は「左1・右0」を既定にする（片側から始める最頻ケース）。
  const [breastLeftCount, setBreastLeftCount] = useState(
    log?.breast_left_count ?? 1,
  )
  const [breastRightCount, setBreastRightCount] = useState(
    log?.breast_right_count ?? 0,
  )
  // 授乳時間の編集入力（分・秒）。seed は duration_sec を優先し、#140 以前の旧行
  // （duration_min のみ・sec null）は min*60 で補完する — さもなくば旧行の編集保存で
  // 時間が silent に消える。dirty 判定（seed と同値なら durationSec を送らない）は
  // 時刻編集（seedTimeHm）と同じ規約。
  const seededDurationSec =
    log?.duration_sec ??
    (log?.duration_min != null ? log.duration_min * 60 : null)
  const [durMinInput, setDurMinInput] = useState(() =>
    seededDurationSec != null ? String(Math.floor(seededDurationSec / 60)) : "",
  )
  const [durSecInput, setDurSecInput] = useState(() =>
    seededDurationSec != null ? String(seededDurationSec % 60) : "",
  )
  // 左右別授乳時間（sides）を持つ行か。**不変の prop から導く**（state から導くと
  // 種別切替で入力欄が消えて跳ねる — feedingTypeOptions と同じ理由）。sides を持つ行は
  // 左右それぞれで時間を編集し、合計はサーバ導出（合計だけの編集は updateLog が
  // fail-loud で拒否する契約ゆえ、合計欄そのものを出さない）。
  const hasSides = log?.breast_left_sec != null
  const [sideLeftMin, setSideLeftMin] = useState(() =>
    hasSides ? String(Math.floor((log!.breast_left_sec as number) / 60)) : "",
  )
  const [sideLeftSec, setSideLeftSec] = useState(() =>
    hasSides ? String((log!.breast_left_sec as number) % 60) : "",
  )
  const [sideRightMin, setSideRightMin] = useState(() =>
    hasSides ? String(Math.floor((log!.breast_right_sec as number) / 60)) : "",
  )
  const [sideRightSec, setSideRightSec] = useState(() =>
    hasSides ? String((log!.breast_right_sec as number) % 60) : "",
  )
  const [diaperType, setDiaperType] = useState<DiaperType>(log?.diaper_type ?? "pee")
  const [temperature, setTemperature] = useState(log?.temperature?.toString() ?? "")
  const [weightG, setWeightG] = useState(log?.weight_g?.toString() ?? "")
  const [heightCm, setHeightCm] = useState(log?.height_cm?.toString() ?? "")
  const [memo, setMemo] = useState(log?.memo ?? "")
  // 記録時刻（JST の "HH:mm"）。編集時は既存 logged_at、新規時は現在時刻を既定に。
  // remount ごとに初期化式が再評価されるため resetForm 不要（全 state が prop から再構築される）。
  const [timeHm, setTimeHm] = useState(() =>
    formatJstTimeInput(log ? log.logged_at : new Date().toISOString()),
  )
  // 編集モードの時刻 seed（初期 HH:mm）。ユーザーが時刻を触ったかの dirty 判定に使う。
  // remount ごとに初期化されるため、その編集セッションの起点値を保持する（新規は空）。
  const [seedTimeHm] = useState(() =>
    log ? formatJstTimeInput(log.logged_at) : "",
  )
  // 日付はそのログの JST 日付を維持（日付跨ぎ編集はスコープ外）。新規は当日（作成導線は
  // isToday ゲート下ゆえ today = 選択日）。時刻のみ編集可能で date 部は不可視に固定する。
  const logDate = log ? toJstDateString(log.logged_at) : todayJstString()

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
        // 選択した時刻（JST の logDate + timeHm）を ISO へ。未来/不正はここで弾く。
        // record アクションと楽観 append で同じ loggedAt を使い、DB と即時表示を一致させる。
        const loggedAt = jstDateTimeToIso(logDate, timeHm)
        if (!loggedAt) {
          toast.error("時刻を入力してください")
          return
        }
        const timeError = validateLogTime(loggedAt)
        if (timeError) {
          toast.error(timeError)
          return
        }

        let result: { error: string | null; id: string | null }
        // B-03: 成功時に返却 id で楽観 append する行を組む builder（値が in-scope な
        // 各 case 内で確定させる）。null のままなら append しない。
        let buildLog: ((id: string) => BabyLogData) | null = null

        switch (createLogType) {
          case "feeding": {
            const amt = allowsAmount(feedingType)
              ? parseAmountMl(amountMl)
              : null
            // 母乳サイクルは左右回数が必須（DB CHECK chk_breast_counts_required）。
            // counts なし・合計 0 で送るとサーバが 100% 弾くため、往復前に潰す。
            const counts = resolveBreastCounts(
              feedingType,
              breastLeftCount,
              breastRightCount,
            )
            if (counts && counts.left + counts.right < 1) {
              toast.error(BREAST_COUNTS_ERROR)
              return
            }
            result = await recordFeeding({
              feedingType,
              amountMl: amt,
              breastLeftCount: counts?.left ?? null,
              breastRightCount: counts?.right ?? null,
              loggedAt,
              memo: memo || undefined,
            })
            buildLog = (id) =>
              buildOptimisticLog({
                id,
                logType: "feeding",
                loggedBy: userId,
                loggedAt,
                feedingType,
                amountMl: amt,
                // 楽観行にも counts を乗せる。落とすと Realtime が上書きするまで
                // タイムラインが「母乳」だけ（内訳なし）で表示されてしまう。
                breastLeftCount: counts?.left ?? null,
                breastRightCount: counts?.right ?? null,
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
              loggedAt,
              memo: memo || undefined,
            })
            buildLog = (id) =>
              buildOptimisticLog({
                id,
                logType: "temperature",
                loggedBy: userId,
                loggedAt,
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
              loggedAt,
              memo: memo || undefined,
            })
            buildLog = (id) =>
              buildOptimisticLog({
                id,
                logType: "growth",
                loggedBy: userId,
                loggedAt,
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
            result = await recordMemoAction({ memo: memo.trim(), loggedAt })
            buildLog = (id) =>
              buildOptimisticLog({
                id,
                logType: "memo",
                loggedBy: userId,
                loggedAt,
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
        const updates: Parameters<typeof updateLog>[1] = {
          memo: memo || null,
        }

        // 時刻を触った時のみ loggedAt を送る。量やメモだけの編集で既存 logged_at の秒が
        // HH:mm 丸めで無言に失われるのを防ぐ（updateLog は未指定なら logged_at を変更しない）。
        // seed と同値（変更→元に戻した場合含む）なら送らず、時刻検証もスキップしてよい
        // — 既存記録の時刻はそのまま妥当。
        if (timeHm !== seedTimeHm) {
          const loggedAt = jstDateTimeToIso(logDate, timeHm)
          if (!loggedAt) {
            toast.error("時刻を入力してください")
            return
          }
          const timeError = validateLogTime(loggedAt)
          if (timeError) {
            toast.error(timeError)
            return
          }
          updates.loggedAt = loggedAt
        }

        if (log.log_type === "feeding") {
          updates.feedingType = feedingType
          updates.amountMl = allowsAmount(feedingType)
            ? parseAmountMl(amountMl)
            : null
          // 母乳サイクルの左右回数。'breast' 以外へ切替えた時は**送らない** —
          // updateLog が feedingType の変更に連動して必ず null 化するため
          // （chk_breast_counts_only_breast のミラー。amount の null 化と同じ規約）。
          const counts = resolveBreastCounts(
            feedingType,
            breastLeftCount,
            breastRightCount,
          )
          if (counts) {
            if (counts.left + counts.right < 1) {
              toast.error(BREAST_COUNTS_ERROR)
              return
            }
            updates.breastLeftCount = counts.left
            updates.breastRightCount = counts.right
          }
          if (hasSides && feedingType === "breast") {
            // sides を持つ行は左右それぞれを送り、合計はサーバが導出する
            // （durationSec は送らない — 同時指定はサーバが拒否する契約）。
            const left = parseBreastSideDuration(sideLeftMin, sideLeftSec)
            const right = parseBreastSideDuration(sideRightMin, sideRightSec)
            const sideError = left.error ?? right.error
            if (sideError) {
              toast.error(sideError)
              return
            }
            if (left.value + right.value < 1) {
              toast.error("授乳時間を選んでください")
              return
            }
            updates.breastLeftSec = left.value
            updates.breastRightSec = right.value
          } else if (allowsDuration(feedingType)) {
            // dirty 時のみ送る（未変更の保存で旧行の時間を無言に書き換えない）。
            const seedMin =
              seededDurationSec != null
                ? String(Math.floor(seededDurationSec / 60))
                : ""
            const seedSec =
              seededDurationSec != null ? String(seededDurationSec % 60) : ""
            if (durMinInput !== seedMin || durSecInput !== seedSec) {
              const parsed = parseFeedingDurationInput(durMinInput, durSecInput)
              if (parsed.error) {
                toast.error(parsed.error)
                return
              }
              updates.durationSec = parsed.value
            }
          } else if (seededDurationSec != null) {
            // 母乳以外へ種類変更: 時間の意味が無くなるため明示クリア
            // （amount の null 化と同じ規約。duration_min も action 側で連動 null）。
            updates.durationSec = null
          }
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
          {/* 記録時刻（全タイプ共通・HH:mm/JST）。日付はそのログの日付を維持する。
              授乳のみ「開始時刻」と明示する: 授乳行の logged_at は開始時刻セマンティクス
              （backfill 20260726100003 で統一）ゆえ、無表示だと終了時刻を入れる人が現れ、
              「移行後に生まれた終了セマンティクス行」は backfill でも検知できない */}
          <div className="space-y-1.5">
            <Label htmlFor="log-time">
              {logType === "feeding" ? "開始時刻" : "時刻"}
            </Label>
            <Input
              id="log-time"
              type="time"
              value={timeHm}
              onChange={(e) => setTimeHm(e.target.value)}
              disabled={isPending}
              className="min-h-11 rounded-lg"
            />
          </div>

          {/* Feeding fields */}
          {logType === "feeding" && (
            <>
              <div className="space-y-1.5">
                <Label>種類</Label>
                <div className="flex gap-1.5">
                  {feedingTypeOptions(
                    log?.feeding_type ?? createFeedingType,
                  ).map((type) => (
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

              {/* 母乳サイクルの左右の吸わせ回数（'breast' のみ）。1 サイクルを 1 行で
                  記録するため「左に何回・右に何回吸わせたか」をここで数える。 */}
              {feedingType === "breast" && (
                <div className="space-y-1.5">
                  <Label>左右の回数</Label>
                  <div className="flex w-full gap-3">
                    <BreastCountStepper
                      label="左"
                      value={breastLeftCount}
                      onChange={setBreastLeftCount}
                      disabled={isPending}
                    />
                    <BreastCountStepper
                      label="右"
                      value={breastRightCount}
                      onChange={setBreastRightCount}
                      disabled={isPending}
                    />
                  </div>
                </div>
              )}

              {/* 左右別授乳時間の編集（sides を持つサイクル行のみ）。合計欄は出さない
                  — 合計だけの編集は updateLog が fail-loud で拒否する契約。 */}
              {log && hasSides && feedingType === "breast" && (
                <div className="space-y-1.5">
                  <Label>時間（左右それぞれ）</Label>
                  <BreastSideDurationInput
                    label="左"
                    idPrefix="side-left"
                    min={sideLeftMin}
                    sec={sideLeftSec}
                    onMinChange={setSideLeftMin}
                    onSecChange={setSideLeftSec}
                    disabled={isPending}
                  />
                  <BreastSideDurationInput
                    label="右"
                    idPrefix="side-right"
                    min={sideRightMin}
                    sec={sideRightSec}
                    onMinChange={setSideRightMin}
                    onSecChange={setSideRightSec}
                    disabled={isPending}
                  />
                </div>
              )}

              {/* 授乳時間の編集（母乳のみ・編集モードのみ）。タイマー記録の
                  「何分間行ったか」をあとから直せるようにする。 */}
              {log && !(hasSides && feedingType === "breast") && allowsDuration(feedingType) && (
                <div className="space-y-1.5">
                  <Label htmlFor="duration-min">時間（分・秒）</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="duration-min"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={180}
                      aria-label="時間（分）"
                      value={durMinInput}
                      onChange={(e) => setDurMinInput(e.target.value)}
                      disabled={isPending}
                      className="min-h-11 rounded-lg"
                    />
                    <span className="shrink-0 text-sm text-muted-foreground">
                      分
                    </span>
                    <Input
                      id="duration-sec"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={59}
                      aria-label="時間（秒）"
                      value={durSecInput}
                      onChange={(e) => setDurSecInput(e.target.value)}
                      disabled={isPending}
                      className="min-h-11 rounded-lg"
                    />
                    <span className="shrink-0 text-sm text-muted-foreground">
                      秒
                    </span>
                  </div>
                </div>
              )}

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
            {/* 複数行対応: 改行を含む日記メモを保存できるよう textarea を使う。
                日記ビューは whitespace-pre-wrap で改行を反映する。 */}
            <Textarea
              id="memo"
              placeholder={logType === "memo" ? "メモを入力" : "任意のメモ"}
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              disabled={isPending}
              autoComplete="off"
              rows={logType === "memo" ? 4 : 2}
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

/**
 * 母乳サイクルの片側（左 or 右）の回数ステッパー。
 *
 * 授乳中の片手操作を前提に、自由入力ではなく ±ボタン（44px）で数える。値は
 * clampBreastCount で 0..20 に丸めたうえ、境界ではボタン自体も disabled にする
 * （表示と送信値が食い違わないようにする二重化）。
 *
 * 見た目と aria 名は `feeding-timer.tsx` の `CountStepper`（タイマー保存時の同機能）に
 * 揃えてある。同じ「左右の回数」を数える操作が記録直後と編集で別物に見えないように
 * するため — 触る時は両方を揃えて直すこと（共通化は timer 側の担当と重なるため保留）。
 */
function BreastCountStepper({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string
  value: number
  onChange: (next: number) => void
  disabled: boolean
}) {
  const buttonCn =
    "flex min-h-11 min-w-11 items-center justify-center rounded-xl border bg-background transition-colors duration-200 hover:bg-muted active:bg-muted disabled:opacity-50"
  return (
    <div className="flex flex-1 flex-col items-center gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`${label}の回数を1減らす`}
          onClick={() => onChange(clampBreastCount(value - 1))}
          disabled={disabled || value <= 0}
          className={buttonCn}
        >
          <Minus size={18} />
        </button>
        {/* output は暗黙で role="status" ゆえ、増減が支援技術へも読み上げられる */}
        <output
          aria-label={`${label}の回数`}
          className="w-8 text-center text-2xl font-bold tabular-nums"
        >
          {value}
        </output>
        <button
          type="button"
          aria-label={`${label}の回数を1増やす`}
          onClick={() => onChange(clampBreastCount(value + 1))}
          disabled={disabled || value >= BREAST_COUNT_MAX}
          className={buttonCn}
        >
          <Plus size={18} />
        </button>
      </div>
    </div>
  )
}

/**
 * 左右別授乳時間の片側入力を秒へ変換する。空欄は 0（片側だけ授乳した行を表せる）。
 * 範囲は DB CHECK chk_breast_side_sec_total の 0..10800 のミラー（分 0..180・秒 0..59）。
 */
function parseBreastSideDuration(
  minStr: string,
  secStr: string,
): { value: number; error: string | null } {
  const min = minStr.trim() === "" ? 0 : Number(minStr)
  const sec = secStr.trim() === "" ? 0 : Number(secStr)
  if (
    !Number.isInteger(min) ||
    !Number.isInteger(sec) ||
    min < 0 ||
    min > 180 ||
    sec < 0 ||
    sec > 59
  ) {
    return { value: 0, error: "授乳時間は0〜180分・0〜59秒で入力してください" }
  }
  const total = min * 60 + sec
  if (total > 10800) {
    return { value: 0, error: "授乳時間は片側180分以内で入力してください" }
  }
  return { value: total, error: null }
}

/** 左右別授乳時間の片側（分・秒）入力。aria 名は「左の分」等で一意に引ける。 */
function BreastSideDurationInput({
  label,
  idPrefix,
  min,
  sec,
  onMinChange,
  onSecChange,
  disabled,
}: {
  label: string
  idPrefix: string
  min: string
  sec: string
  onMinChange: (v: string) => void
  onSecChange: (v: string) => void
  disabled: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-6 shrink-0 text-sm font-medium text-muted-foreground">
        {label}
      </span>
      <Input
        id={`${idPrefix}-min`}
        type="number"
        inputMode="numeric"
        min={0}
        max={180}
        aria-label={`${label}の分`}
        value={min}
        onChange={(e) => onMinChange(e.target.value)}
        disabled={disabled}
        className="min-h-11 rounded-lg"
      />
      <span className="shrink-0 text-sm text-muted-foreground">分</span>
      <Input
        id={`${idPrefix}-sec`}
        type="number"
        inputMode="numeric"
        min={0}
        max={59}
        aria-label={`${label}の秒`}
        value={sec}
        onChange={(e) => onSecChange(e.target.value)}
        disabled={disabled}
        className="min-h-11 rounded-lg"
      />
      <span className="shrink-0 text-sm text-muted-foreground">秒</span>
    </div>
  )
}

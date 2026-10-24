"use client"

import { useEffect, useRef, useState, useTransition } from "react"
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
import { AlertCircle, Loader2, RefreshCw, Trash2 } from "lucide-react"
import { toast } from "sonner"
import {
  updateLog,
  deleteLog,
  recordFeeding,
  recordDiaper,
  recordTemperature,
  recordGrowth,
  recordMemo as recordMemoAction,
} from "@/app/(main)/baby/actions"
import { formatDiaryDateHeadingFromYmd } from "@/lib/domain/baby-diary"
import {
  getLogTypeLabel,
  getFeedingTypeLabel,
  getDiaperTypeLabel,
} from "@/lib/utils/baby-log-labels"
import {
  formatTimeJst,
  formatJstTimeInput,
  isValidYmd,
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
  clampBreastCount,
  FEEDING_DURATION_SEC_MAX,
  parseFeedingDurationInput,
} from "@/lib/domain/feeding"
import { BreastCountStepper } from "@/components/baby/breast-count-stepper"
import { buildOptimisticLog } from "@/lib/domain/baby-optimistic-log"
import { getLogSummary } from "@/lib/domain/baby-log-summary"
import { STALE_SCREEN_SAVE_ERROR } from "@/lib/domain/timestamptz-text"
import { newClientId } from "@/lib/utils/client-id"
// startTransition 内の未処理 reject は error boundary へ bubble し、入力/記録が
// 無言で失われる。握ってトーストへ倒す（機序の詳細は offline-error.ts）。
import { toastOfflineError } from "@/lib/utils/offline-error"
import type {
  BabyLogType,
  FeedingType,
  DiaperType,
  PoopAmount,
  BreastStartSide,
} from "@/lib/types/database"
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

// うんちの量（poop_amount）。「指定なし」= null は量を記録しない（旧行と同じ形）。
// 量を持てるのはうんちを含む種別だけ（DB CHECK chk_poop_amount_only_poop のミラー —
// サーバは pee への種別変更で量を強制 null 化するが、画面でも欄ごと消して迷わせない）。
const POOP_AMOUNT_OPTIONS: { value: PoopAmount | null; label: string }[] = [
  { value: "small", label: "少量" },
  { value: "large", label: "大量" },
  { value: null, label: "指定なし" },
]

function allowsPoopAmount(type: DiaperType): boolean {
  return type === "poop" || type === "both"
}

/** DB 由来の値を型へ絞る（TEXT + CHECK ゆえ未知値は null = 指定なしへ退化） */
function seedPoopAmount(value: string | null | undefined): PoopAmount | null {
  return value === "small" || value === "large" ? value : null
}

// 母乳サイクルの開始側（breast_start_side）。「不明」= null は旧行の既定形で、
// 編集で分からぬ時に無理に左右を選ばせない。
const START_SIDE_OPTIONS: { value: BreastStartSide | null; label: string }[] = [
  { value: "left", label: "左から" },
  { value: "right", label: "右から" },
  { value: null, label: "不明" },
]

function seedStartSide(value: string | null | undefined): BreastStartSide | null {
  return value === "left" || value === "right" ? value : null
}

// 量（ml）を伴う授乳タイプ。母乳（サイクル/片側とも）は量を測らないため除外する。
const AMOUNT_FEEDING_TYPES: FeedingType[] = ["bottle", "solid", "pumped"]

function allowsAmount(type: FeedingType): boolean {
  return AMOUNT_FEEDING_TYPES.includes(type)
}

// 合計 0 の拒否文言。サーバ（actions.ts の BREAST_COUNTS_ERROR）と同じ規約だが、
// "use server" ファイルは関数以外を export できない（Turbopack がビルドで落ちる。
// しかも tsc では検出できない）ため定数は共有せず、ここに置く。
// 上限（BREAST_COUNT_MAX）と丸め（clampBreastCount）は @/lib/domain/feeding が正本。
const BREAST_COUNTS_ERROR = "左右の回数は合計1回以上で指定してください"

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
  /**
   * create mode の記録日（YYYY-MM-DD, JST）。省略時は開いた日（今日）。過去日の追記
   * （機能 C）では親が選択日を渡し、画面は日付を見える形で示す。**マウント時の値だけを
   * 使う**（親は開くたびに key で作り直す。開いた後の選択日の変化は無視する）。
   */
  createDate?: string
  /** 記録者（logged_by）。楽観 append 行の作成に使う（B-03） */
  userId: string
  /**
   * 編集中の行の記録者の表示名（機能 A）。二人以上の世帯でだけ親が渡し、説明文に添える。
   */
  recorderLabel?: string | null
  /**
   * 作成成功時に楽観 append する行を親へ渡す（B-03）。作成導線は quick actions
   * （isToday ゲート下）からのみ開くため、logged_at（client now）は選択日と一致する。
   * 編集（update）は既存行の書き換えで append 対象外 — 反映は下の onLogUpdated が担う。
   */
  onLogRecorded?: (log: BabyLogData) => void
  /**
   * 編集（update）成功時に、サーバが返した更新後の行を親へ渡す。親はこれで画面を
   * 即時に書き換える — Realtime UPDATE の到達だけに頼ると、不達の間は「更新しました」
   * と出るのに時刻等が旧値のまま残り、開き直しても旧値で seed される。Realtime の
   * echo も同じ反映関数（BabyDashboard の applyUpdatedLog）を通り、同じ版なら冪等、
   * 古い版（updated_at が古い）は捨てられる。
   */
  onLogUpdated?: (log: BabyLogData) => void
  /** 削除成功時にローカル state から除去する行の id を親へ渡す（B-03） */
  onLogRemoved?: (id: string) => void
  /**
   * 保存が衝突した後（P2-07）、家族が先に保存した最新の行で編集し直す。親はこの行で
   * シートを開き直す（key で作り直し、最新の行と版から seed する）。入力中の内容は
   * 利用者がこの導線を選んだ時にだけ捨てる。
   */
  onReloadLog?: (log: BabyLogData) => void
}

export function BabyLogFormSheet({
  open,
  onOpenChange,
  log,
  createLogType,
  createFeedingType,
  createDate,
  userId,
  recorderLabel = null,
  onLogRecorded,
  onLogUpdated,
  onLogRemoved,
  onReloadLog,
}: BabyLogFormSheetProps) {
  const [isPending, startTransition] = useTransition()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  // 編集を始めた時点の行の版（P2-07）。保存はこの版でしか書けぬ — 開いている間に家族が
  // 先に保存しておれば、サーバは 0 行を衝突として返す。開いた時点で固定する（親は開く
  // たびに key で作り直すゆえ、次に開けば最新の行の版から始まる）。
  const [expectedUpdatedAt] = useState(() => log?.updated_at ?? null)
  // 保存・削除の衝突（P2-07）。current は先に保存されていた最新の行（他端末で削除済みなら
  // null。削除の衝突は行が在る時だけゆえ常に行を持つ）。
  // 衝突の後は入力を残したまま保存を止め、最新の内容で編集し直す導線だけを出す — この
  // シートは全項目を開いた時点の値から送るゆえ、そのまま上書きすると家族が直した項目まで
  // 無言で巻き戻る。
  const [conflict, setConflict] = useState<{ current: BabyLogData | null } | null>(
    null,
  )
  // 新規記録の冪等 id（P2-08）。シートを開いた 1 回の入力 = 1 つの意図ゆえ、通信断の
  // 後に同じシートから「記録する」を押し直しても同じ id が届き、二重記録にならぬ。
  // 親は開くたびに key で作り直すため、次の記録は新しい id になる。
  // 通信断の**後に入力を直した**なら、それは別の意図ゆえ id を作り直す（前回の保存が
  // 成立していた場合、同じ id で違う内容を送るとサーバが fail-loud に拒む）。
  const [clientId, setClientId] = useState(() => newClientId())
  const sendFailedRef = useRef(false)

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
  // うんちの量。既存行から seed（旧行・未指定は null = 指定なし）。
  const [poopAmount, setPoopAmount] = useState<PoopAmount | null>(
    seedPoopAmount(log?.poop_amount),
  )
  // 母乳サイクルの開始側。既存行から seed（旧行は null = 不明）。新規記録も null 既定
  // — 分からぬものを「左」と決め打ちで捏造しない（タイマー経路はタップした側を確実に送る）。
  const [breastStartSide, setBreastStartSide] = useState<BreastStartSide | null>(
    seedStartSide(log?.breast_start_side),
  )
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
  // 「今日」は開いた時点で固定する。描画中に todayJstString() を読むと、Compiler 有りでは
  // マウント時に凍結、無しでは日跨ぎで翌日へずれ、開いた時刻（23:55 等）が「未来の時刻」で
  // 弾かれる — 振る舞いを Compiler 任せにせず、開いた時点の値を明示して持つ。
  const [todayYmd] = useState(() => todayJstString())
  // 記録日（YYYY-MM-DD, JST）。編集はそのログの日付、新規は親が渡した日（過去日の追記）
  // か開いた日。日付と時刻は両方とも画面に見える形で持ち、保存時に ISO へ組む（機能 C:
  // 深夜を跨いだ授乳の開始時刻は「前日の 23:50」のように日付ごと直せる）。
  const [dateYmd, setDateYmd] = useState(() =>
    log ? toJstDateString(log.logged_at) : (createDate ?? todayYmd),
  )
  // 編集モードの日付 seed。時刻の seed と同じく dirty 判定に使う（新規は空）
  const [seedDateYmd] = useState(() => (log ? toJstDateString(log.logged_at) : ""))
  const logDate = dateYmd

  const isCreateMode = !log && !!createLogType
  const logType = log?.log_type ?? createLogType

  // 通信断の後に入力のどれかが変わったら冪等 id を作り直す（上の注記）。入力の state を
  // まとめて依存にし、失敗フラグが立っている時だけ動く。
  useEffect(() => {
    if (!sendFailedRef.current) return
    sendFailedRef.current = false
    setClientId(newClientId())
  }, [
    feedingType,
    amountMl,
    breastLeftCount,
    breastRightCount,
    breastStartSide,
    diaperType,
    poopAmount,
    temperature,
    weightG,
    heightCm,
    memo,
    timeHm,
    dateYmd,
  ])

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
        // 選択した日付・時刻（JST の logDate + timeHm）を ISO へ。未来/不正はここで弾く。
        // record アクションと楽観 append で同じ loggedAt を使い、DB と即時表示を一致させる。
        if (!isValidYmd(logDate)) {
          toast.error("日付を入力してください")
          return
        }
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

        let result: {
          error: string | null
          id: string | null
          updatedAt?: string
          replayed?: true
        }
        // B-03: 成功時に返却 id（と行の版）で楽観 append する行を組む builder（値が
        // in-scope な各 case 内で確定させる）。null のままなら append しない。
        let buildLog:
          | ((id: string, updatedAt: string | null) => BabyLogData)
          | null = null

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
            // 開始側は母乳サイクルのみ（それ以外はサーバが拒否する契約ゆえ null）
            const startSide = feedingType === "breast" ? breastStartSide : null
            result = await recordFeeding({
              feedingType,
              amountMl: amt,
              breastLeftCount: counts?.left ?? null,
              breastRightCount: counts?.right ?? null,
              breastStartSide: startSide,
              loggedAt,
              memo: memo || undefined,
              clientId,
            })
            buildLog = (id, updatedAt) =>
              buildOptimisticLog({
                id,
                updatedAt,
                logType: "feeding",
                loggedBy: userId,
                loggedAt,
                feedingType,
                amountMl: amt,
                // 楽観行にも counts を乗せる。落とすと Realtime が上書きするまで
                // タイムラインが「母乳」だけ（内訳なし）で表示されてしまう。
                breastLeftCount: counts?.left ?? null,
                breastRightCount: counts?.right ?? null,
                breastStartSide: startSide,
                memo: memo || null,
              })
            break
          }
          case "diaper": {
            // 過去日の追記（機能 C）。クイック記録（1 タップ・今）とは別経路で、日付と
            // 時刻を見える形で持つ。量は poop / both の時だけ（CHECK のミラー）
            const amount = allowsPoopAmount(diaperType) ? poopAmount : null
            result = await recordDiaper({
              diaperType,
              poopAmount: amount,
              loggedAt,
              memo: memo || undefined,
              clientId,
            })
            buildLog = (id, updatedAt) =>
              buildOptimisticLog({
                id,
                updatedAt,
                logType: "diaper",
                loggedBy: userId,
                loggedAt,
                diaperType,
                poopAmount: amount,
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
              clientId,
            })
            buildLog = (id, updatedAt) =>
              buildOptimisticLog({
                id,
                updatedAt,
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
              clientId,
            })
            buildLog = (id, updatedAt) =>
              buildOptimisticLog({
                id,
                updatedAt,
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
            result = await recordMemoAction({ memo: memo.trim(), loggedAt, clientId })
            buildLog = (id, updatedAt) =>
              buildOptimisticLog({
                id,
                updatedAt,
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
        if (result.replayed) {
          // 応答を失った前回の保存が受理されていた。行は resync / Realtime で揃う
          toast.success("既に記録されています（二重には記録していません）")
          onOpenChange(false)
          return
        }
        // B-03: Realtime を待たず timeline へ楽観 append。行の版も乗せる（作成直後に
        // 開いた編集が、その版で保存できるように。P2-07）
        if (buildLog && result.id) {
          onLogRecorded?.(buildLog(result.id, result.updatedAt ?? null))
        }
        toast.success("記録しました")
        onOpenChange(false)
      } catch (err) {
        sendFailedRef.current = true
        toastOfflineError("[baby-log-form-sheet] recordCreate", err)
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

        // 日付か時刻を触った時のみ loggedAt を送る。量やメモだけの編集で既存 logged_at の
        // 秒が HH:mm 丸めで無言に失われるのを防ぐ（updateLog は未指定なら logged_at を
        // 変更しない）。seed と同値（変更→元に戻した場合含む）なら送らず、時刻検証も
        // スキップしてよい — 既存記録の時刻はそのまま妥当。
        if (timeHm !== seedTimeHm || logDate !== seedDateYmd) {
          if (!isValidYmd(logDate)) {
            toast.error("日付を入力してください")
            return
          }
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
            // 開始側は母乳サイクルの時だけ送る（null = 不明へ戻す）。'breast' 以外へ
            // 切替えた時は送らない — updateLog が種別変更に連動して null 化する契約。
            updates.breastStartSide = breastStartSide
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
          // 量は種類と対で送る（updateLog の契約）。pee は量を持てないため null。
          updates.poopAmount = allowsPoopAmount(diaperType) ? poopAmount : null
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

        // 版を持たぬ行（作成の応答に版が無かった楽観行）は、無条件の上書きにせず止める
        if (!expectedUpdatedAt) {
          toast.error(STALE_SCREEN_SAVE_ERROR)
          return
        }
        const result = await updateLog(log.id, updates, expectedUpdatedAt)
        if (result.conflict) {
          // 入力（各 state）には触れぬ。背後の画面を最新へ揃え、シートで衝突を見せる。
          setConflict(result.conflict)
          // 通知の枠はスクロール領域の先頭にある。下の欄まで送ってから押した時に
          // 「押しても何も起きぬ」に見えぬよう、理由をトーストでも示す
          toast.error(result.error)
          // 開いておった削除の確認も閉じる（開いた時点の版はもう古く、押しても同じ衝突になる）
          setShowDeleteConfirm(false)
          if (result.conflict.current) {
            onLogUpdated?.(result.conflict.current)
          } else {
            // 他端末で削除済み（DELETE は Realtime で届かぬゆえ、画面の幽霊行を外す）
            onLogRemoved?.(log.id)
          }
          return
        }
        if (result.error) {
          toast.error(result.error)
          return
        }
        // Realtime を待たず画面へ反映する（echo が後追いで来ても同じ行の置換ゆえ冪等）
        if (result.log) {
          onLogUpdated?.(result.log)
        }
        toast.success("ログを更新しました")
        onOpenChange(false)
      } catch (err) {
        toastOfflineError("[baby-log-form-sheet] updateLog", err)
      }
    })
  }

  function handleDelete() {
    if (!log) return

    startTransition(async () => {
      try {
        // 削除も開いた時点の版でしか消せぬ（家族が先に直した記録を、古い画面から編集ごと
        // 消させぬ）。版を持たぬ行は保存と同じく、無条件の削除にせず止める
        if (!expectedUpdatedAt) {
          toast.error(STALE_SCREEN_SAVE_ERROR)
          return
        }
        const result = await deleteLog(log.id, expectedUpdatedAt)
        if (result.conflict) {
          // 保存の衝突と同じ見せ方: 入力には触れず、確認を閉じ、背後の画面を最新へ揃え、
          // 最新の内容で編集し直す導線（onReloadLog）を出す。行は画面から外さぬ（消えておらぬ）
          setConflict(result.conflict)
          toast.error(result.error)
          setShowDeleteConfirm(false)
          onLogUpdated?.(result.conflict.current)
          return
        }
        if (result.error) {
          toast.error(result.error)
          // 他端末で既に削除済み: 行はもう無いゆえ画面からも外して閉じる
          // （DELETE は Realtime で届かぬため、残すと幽霊行になる。P1-04）
          if (result.alreadyDeleted) {
            onLogRemoved?.(log.id)
            onOpenChange(false)
          }
          return
        }
        // B-03: Realtime DELETE echo を待たずローカル state からも除去
        onLogRemoved?.(log.id)
        toast.success("ログを削除しました")
        onOpenChange(false)
      } catch (err) {
        toastOfflineError("[baby-log-form-sheet] deleteLog", err)
      }
    })
  }

  if (!logType) return null

  const title = isCreateMode
    ? `${getLogTypeLabel(logType)}を記録`
    : `${getLogTypeLabel(logType)}を編集`
  // 過去日の追記は「今の記録」ではないことを見出し直下で示す（誤保存の防止。機能 C）
  const isPastDateCreate = isCreateMode && isValidYmd(logDate) && logDate < todayYmd
  const description = isCreateMode
    ? isPastDateCreate
      ? `${formatDiaryDateHeadingFromYmd(logDate)} の記録として保存します。日付と時刻を確かめてください`
      : undefined
    : log
      ? recorderLabel
        ? `${formatTimeJst(log.logged_at)} の記録（${recorderLabel}）を変更できます`
        : `${formatTimeJst(log.logged_at)} の記録を変更できます`
      : undefined
  // 衝突時に見せる「先に保存された内容」の 1 行目（日付・時刻・要約）。メモの記録は要約が
  // 本文の先頭 20 字ゆえ種別名に代え、本文は 2 行目に全文で出す（二重に見せぬ）。
  const conflictCurrent = conflict?.current ?? null
  const conflictSummary = conflictCurrent
    ? `${formatDiaryDateHeadingFromYmd(toJstDateString(conflictCurrent.logged_at))} ${formatTimeJst(conflictCurrent.logged_at)}　${
        conflictCurrent.log_type === "memo"
          ? getLogTypeLabel("memo")
          : getLogSummary(conflictCurrent)
      }`
    : ""

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
          {/* 保存の衝突（P2-07）。枠は日記の編集シートの衝突と同じ部品・配色で組む。
              書いた人は断定しない（応答が失われた自分の保存・同じ利用者の別端末も同じ形で
              衝突する）。入力は残し、利用者が選んだ時だけ最新の内容で編集し直す。 */}
          {conflict && (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm"
            >
              <p className="flex items-start gap-2 font-medium text-destructive">
                <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                {conflict.current
                  ? "この記録は別の端末で先に更新されていました（家族またはご自身）"
                  : "この記録は他の端末で削除されていました"}
              </p>
              <p className="text-xs text-muted-foreground">
                {conflict.current
                  ? "あなたの入力はそのまま残しています。先に保存された内容を確かめ、「最新の内容で編集し直す」を押してから、直すか削除するかを選び直してください（入力は最新の内容に置き換わります）。"
                  : "保存先の記録がないため、この入力は保存できません。必要なら内容を控えてから閉じてください。"}
              </p>
              {conflict.current && (
                <>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground">
                      先に保存された内容
                    </span>
                    <p className="rounded-lg bg-background/60 p-3 text-sm leading-relaxed break-words whitespace-pre-wrap">
                      {conflictSummary}
                      {conflict.current.memo ? `\n${conflict.current.memo}` : ""}
                    </p>
                  </div>
                  {onReloadLog && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        if (conflict.current) onReloadLog(conflict.current)
                      }}
                      disabled={isPending}
                      className="min-h-11 w-full rounded-lg"
                    >
                      <RefreshCw aria-hidden="true" />
                      最新の内容で編集し直す
                    </Button>
                  )}
                </>
              )}
            </div>
          )}

          {/* 記録日と記録時刻（全タイプ共通・JST）。日付は未来を選べぬ（max）。深夜を跨いだ
              授乳は「前日の 23:50」のように日付ごと直せる（機能 C）。
              授乳のみ「開始時刻」と明示する: 授乳行の logged_at は開始時刻セマンティクス
              （backfill 20260726100003 で統一）ゆえ、無表示だと終了時刻を入れる人が現れ、
              「移行後に生まれた終了セマンティクス行」は backfill でも検知できない */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="log-date">日付</Label>
              <Input
                id="log-date"
                type="date"
                value={dateYmd}
                max={todayYmd}
                onChange={(e) => setDateYmd(e.target.value)}
                disabled={isPending}
                className="min-h-11 rounded-lg"
              />
            </div>
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
                      onStep={(d) => setBreastLeftCount((v) => clampBreastCount(v + d))}
                      disabled={isPending}
                    />
                    <BreastCountStepper
                      label="右"
                      value={breastRightCount}
                      onStep={(d) => setBreastRightCount((v) => clampBreastCount(v + d))}
                      disabled={isPending}
                    />
                  </div>
                </div>
              )}

              {/* 母乳サイクルの開始側（'breast' のみ）。回数・時間は順序を持たぬため
                  「どちらから始めたか」はここでしか直せない。不明のままでも保存できる。 */}
              {feedingType === "breast" && (
                <div className="space-y-1.5">
                  <Label>開始側</Label>
                  <div className="flex gap-1.5">
                    {START_SIDE_OPTIONS.map((opt) => (
                      <button
                        key={opt.label}
                        type="button"
                        onClick={() => setBreastStartSide(opt.value)}
                        disabled={isPending}
                        className={segmentCn(breastStartSide === opt.value)}
                      >
                        {opt.label}
                      </button>
                    ))}
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
            <>
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

              {/* うんちの量（うんちを含む種別のみ）。量なしの旧行は「指定なし」で開く。 */}
              {allowsPoopAmount(diaperType) && (
                <div className="space-y-1.5">
                  <Label>うんちの量</Label>
                  <div className="flex gap-1.5">
                    {POOP_AMOUNT_OPTIONS.map((opt) => (
                      <button
                        key={opt.label}
                        type="button"
                        onClick={() => setPoopAmount(opt.value)}
                        disabled={isPending}
                        className={segmentCn(poopAmount === opt.value)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
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
                    disabled={isPending || conflict !== null}
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
                  // 衝突の後は開いた時点の版が古く、削除しても同じ衝突になる。最新の内容で
                  // 編集し直して（新しい版で開き直して）から選ばせる
                  disabled={conflict !== null}
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
            // 衝突の後は開いた時点の版のままゆえ、押しても同じ衝突になる（上書きの導線は
            // 置かぬ — 全項目を古い値から送るため、家族が直した項目まで巻き戻る）
            disabled={isPending || conflict !== null}
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
  if (total > FEEDING_DURATION_SEC_MAX) {
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

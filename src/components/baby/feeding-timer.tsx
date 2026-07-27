"use client"

import { useState, useEffect, useRef } from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Loader2, Square, Check, Minus, Plus } from "lucide-react"
import { toast } from "sonner"
import { recordFeeding } from "@/app/(main)/baby/actions"
import { clampFeedingDurationSec } from "@/lib/domain"
import { buildOptimisticLog } from "@/lib/domain/baby-optimistic-log"
import { useWakeLock } from "@/lib/hooks/use-wake-lock"
import { useNow } from "@/lib/hooks/use-now"
import { segmentCn } from "@/lib/utils/segment-cn"
import {
  formatDurationSec,
  formatBreastCounts,
} from "@/lib/utils/baby-log-labels"
import { toJstDateString, todayJstString } from "@/lib/utils/date-jst"
import type { FeedingType } from "@/lib/types/database"
import type { BabyLogData } from "@/lib/types/baby"

const STORAGE_KEY = "irori:feeding-timer"
const MAX_TIMER_AGE_MS = 2 * 60 * 60 * 1000 // 2時間で stale 扱い

// 片側の吸わせ回数の上限。DB CHECK chk_breast_counts_required
// （supabase/migrations/20260726100002_baby_breast_counts.sql の 0..20）の
// クライアント側ミラー。
//
// **これは検証ではなく救済である**（削るな）: 21 回目のタップで素通しにすると
// サーバの validateBreastCounts が記録を拒否し、走行中のタイマーが「停止しても
// 記録できない」恒久スタックに落ちる。clampFeedingDurationSec が 181 分以上を
// 180 分で記録するのと同じ方針で、上限に張り付かせて記録は必ず通す。
const MAX_BREAST_COUNT = 20

// 手動入力の上限。母乳サイクルは左右を何度も往復するため、合計時間は片側だけの
// 15 分（サイクル化前の上限）を普通に超える。60 分まで選べるようにする
// （duration_sec の DB 上限 180 分の内側ゆえ clampFeedingDurationSec と衝突しない）。
// 秒精度（duration_sec）で保存する（duration_min は round で併記される）。
const MANUAL_MAX_MINUTES = 60
const MANUAL_MINUTE_OPTIONS = Array.from(
  { length: MANUAL_MAX_MINUTES + 1 },
  (_, i) => i,
) // 0..60
const MANUAL_SECOND_OPTIONS = Array.from({ length: 60 }, (_, i) => i) // 0..59
const DEFAULT_MANUAL_MINUTES = 5

type TimerMode = "timer" | "manual"

/** 母乳サイクル中に「今どちら側を吸わせているか」。記録は常に 'breast' 1 行。 */
type BreastSide = "breast_left" | "breast_right"

/**
 * 進行中の母乳サイクルの状態。左右それぞれ何回吸わせたか（stint）と現在側を持つ。
 * 1 回の授乳＝1 行（feeding_type='breast'）に breast_left_count /
 * breast_right_count として保存する。
 */
interface CycleState {
  side: BreastSide
  leftCount: number
  rightCount: number
}

interface TimerState {
  startedAt: string // ISO string
  /**
   * 現在吸わせている側。旧形式（counts を持たない TimerState）から復元できるよう
   * キー名は据え置く。
   */
  feedingType: BreastSide
  /** counts を持たない旧形式が localStorage に残っているため optional。 */
  leftCount?: number
  rightCount?: number
}

function formatTimer(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

/**
 * 親から渡る initialFeedingType を「開始側」へ正規化する。
 *
 * baby-dashboard の timerFeedingType は `FeedingType` 型ゆえ、型の上では
 * 'breast'（サイクル行）や将来増える ENUM 値も渡りうる。その場合は左開始として
 * 退化させる（#159 の「未知値→null 退化」と同じ流儀で throw させない）。
 * 実際の開始側が右だった場合でも、ユーザーの最初のタップで右へ切り替わり
 * 「左1・右1」になるだけで、記録失敗もクラッシュもしない — 許容できる劣化であって
 * 無音のバグではない。
 */
function normalizeSide(type: FeedingType): BreastSide {
  return type === "breast_right" ? "breast_right" : "breast_left"
}

/** 開始側を 1 回で seed した初期サイクル（左開始なら 左1・右0）。 */
function seedCycle(side: BreastSide): CycleState {
  return {
    side,
    leftCount: side === "breast_left" ? 1 : 0,
    rightCount: side === "breast_right" ? 1 : 0,
  }
}

function clampCount(value: number): number {
  return Math.min(Math.max(value, 0), MAX_BREAST_COUNT)
}

/** localStorage 由来の回数を整数・0..20 へ正規化する。整数でなければ null。 */
function normalizeStoredCount(value: unknown): number | null {
  return Number.isInteger(value) ? clampCount(value as number) : null
}

/**
 * localStorage の TimerState からサイクル状態を復元する。
 *
 * - 旧形式（counts なし）・整数でない壊れた値は「現在側=1・反対側=0」で seed する
 *   （throw させない。復元に失敗して記録が消えるより退化させる方が実害が小さい）
 * - 合計 0 も現在側 1 へ救済する: timer モードには回数を直す UI が無く、0+0 のままだと
 *   停止＝記録がサーバ検証 / DB CHECK chk_breast_counts_required に必ず弾かれ、
 *   タイマーが恒久スタックする（MAX_TIMER_AGE_MS の stale 破棄と同じ救済方針）
 */
function restoreCycle(state: TimerState): CycleState {
  const side = normalizeSide(state.feedingType)
  const left = normalizeStoredCount(state.leftCount)
  const right = normalizeStoredCount(state.rightCount)
  if (left === null || right === null || left + right < 1) return seedCycle(side)
  return { side, leftCount: left, rightCount: right }
}

function persistTimerState(startedAt: Date, cycle: CycleState) {
  const state: TimerState = {
    startedAt: startedAt.toISOString(),
    feedingType: cycle.side,
    leftCount: cycle.leftCount,
    rightCount: cycle.rightCount,
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

/**
 * 手動入力の分・秒を保存用の秒数へ変換する。
 * 60 分（3600 秒）を上限にクランプする（秒精度をそのまま保持）。
 */
function manualDurationSec(minutes: number, seconds: number): number {
  const totalSeconds = Math.min(
    minutes * 60 + seconds,
    MANUAL_MAX_MINUTES * 60,
  )
  return clampFeedingDurationSec(totalSeconds)
}

interface FeedingTimerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialFeedingType: FeedingType
  /** 記録者（logged_by）。楽観 append 行の作成に使う（B-03） */
  userId: string
  /**
   * 記録成功時に楽観 append する行を親へ渡す（B-03）。深夜跨ぎ（サイクル開始が
   * JST で前日）の行は呼ばない — 詳細は saveFeeding のコメント。
   */
  onLogRecorded?: (log: BabyLogData) => void
  /**
   * 深夜跨ぎで onLogRecorded を見送った行を親へ渡す（批判レビュー P3）。
   * timeline（当日窓の logs）には入れられないが、「最終授乳」の fallback を
   * この行で即時更新しないと、記録直後にチップが「---」へ落ちる。
   */
  onPrevDayLogRecorded?: (log: BabyLogData) => void
}

export function FeedingTimer({
  open,
  onOpenChange,
  initialFeedingType,
  userId,
  onLogRecorded,
  onPrevDayLogRecorded,
}: FeedingTimerProps) {
  const [cycle, setCycle] = useState<CycleState>(() =>
    seedCycle(normalizeSide(initialFeedingType)),
  )
  const [startedAt, setStartedAt] = useState<Date | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const isSavingRef = useRef(false)
  // 授乳時間の入力方式。タイマー（既定）と手動入力（分・秒）を切り替える。
  const [mode, setMode] = useState<TimerMode>("timer")
  const [manualMin, setManualMin] = useState(DEFAULT_MANUAL_MINUTES)
  const [manualSec, setManualSec] = useState(0)
  // タイマーが実際に走るのは timer モードの時だけ（手動入力中は tick / wake lock 不要）
  const timerRunning = open && mode === "timer" && !!startedAt
  const now = useNow(1000, timerRunning)
  const initializedRef = useRef(false)

  useWakeLock(timerRunning)

  // Restore or initialize timer on open
  useEffect(() => {
    if (!open) {
      initializedRef.current = false
      return
    }
    if (initializedRef.current) return
    initializedRef.current = true

    // 開くたびにタイマー方式・手動入力の既定へ戻す（前回 manual のまま開かない）
    setMode("timer")
    setManualMin(DEFAULT_MANUAL_MINUTES)
    setManualSec(0)

    // Try to restore from localStorage (stale タイマーは破棄)
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const state: TimerState = JSON.parse(saved)
        const savedTime = new Date(state.startedAt)
        if (Date.now() - savedTime.getTime() < MAX_TIMER_AGE_MS) {
          /* eslint-disable react-hooks/set-state-in-effect -- localStorageからのタイマー復元 */
          setStartedAt(savedTime)
          setCycle(restoreCycle(state))
          /* eslint-enable react-hooks/set-state-in-effect */
          return
        }
        localStorage.removeItem(STORAGE_KEY)
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY)
    }

    // Start new timer（開始側を 1 回で seed する）
    const start = new Date()
    const seeded = seedCycle(normalizeSide(initialFeedingType))
    setStartedAt(start)
    setCycle(seeded)
    persistTimerState(start, seeded)
  }, [open, initialFeedingType])

  /**
   * 吸わせる側を切り替える（タイマー中の stint カウント）。
   * 反対側のタップで「その側を吸わせ始めた」= 回数 +1。同じ側の再タップは連続
   * stint にならないため no-op（押し間違い / 連打で回数が水増しされるのを防ぐ）。
   */
  function handleSideTap(next: BreastSide) {
    if (cycle.side === next) return
    const bumped: CycleState = {
      side: next,
      leftCount:
        next === "breast_left"
          ? clampCount(cycle.leftCount + 1)
          : cycle.leftCount,
      rightCount:
        next === "breast_right"
          ? clampCount(cycle.rightCount + 1)
          : cycle.rightCount,
    }
    setCycle(bumped)
    // アプリを閉じても回数が消えないよう、切替ごとに保存する
    if (startedAt) persistTimerState(startedAt, bumped)
  }

  /** 手動入力のステッパー（左右の回数を直接増減する）。 */
  function handleCountChange(side: BreastSide, delta: number) {
    const next: CycleState =
      side === "breast_left"
        ? { ...cycle, leftCount: clampCount(cycle.leftCount + delta) }
        : { ...cycle, rightCount: clampCount(cycle.rightCount + delta) }
    setCycle(next)
    if (startedAt) persistTimerState(startedAt, next)
  }

  const elapsedSeconds = startedAt
    ? Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000))
    : 0

  // タイマー停止・手動記録の共通保存経路。母乳は「1 回の授乳 = 1 行」の母乳サイクル
  // （feeding_type='breast'）として左右の回数つきで記録し、durationSec（秒精度）で
  // 保存する（duration_min はサーバ側で round 併記）。通信断 reject を握って永久
  // disabled を防ぐ（recordFeeding は redirect しないため finally で isSaving を戻せる）。
  //
  // loggedAt はサイクルの**開始時刻**（終了時刻ではない）。タイマーは開始時刻、
  // 手動入力は「記録時刻 − 授乳時間」を渡す。過去行も backfill migration
  // （20260726100003_baby_feeding_backfill_start_time）で開始基準へ揃えてある。
  async function saveFeeding(durationSec: number, loggedAt: string) {
    if (isSavingRef.current) return

    const { leftCount, rightCount } = cycle
    // 合計 0 のサイクル行は「授乳していない行」ゆえサーバ検証と DB CHECK
    // chk_breast_counts_required に弾かれる。往復ぶんの通信を待たせず手前で止める
    // （手動入力のステッパーを両方 0 にできるのが唯一の入口。サーバ側と二重防御）。
    if (leftCount + rightCount < 1) {
      toast.error("左右の回数は合計1回以上にしてください")
      return
    }

    isSavingRef.current = true
    setIsSaving(true)

    let result: Awaited<ReturnType<typeof recordFeeding>>
    try {
      result = await recordFeeding({
        feedingType: "breast",
        breastLeftCount: leftCount,
        breastRightCount: rightCount,
        durationSec,
        loggedAt,
      })
    } catch (err) {
      // recordFeeding は通信断で reject しうる。握り潰さず記録し、再試行を促す。
      console.error("[feeding-timer] recordFeeding が例外を投げました", {
        message: err instanceof Error ? err.message : String(err),
        breastLeftCount: leftCount,
        breastRightCount: rightCount,
        durationSec,
        loggedAt,
      })
      toast.error("授乳の記録に失敗しました。通信状況を確認してもう一度お試しください。")
      return
    } finally {
      // throw / 正常のいずれの経路でも必ず解除する（永久 disabled の防止）。
      // recordFeeding は redirect しないため finally で戻して問題ない。
      isSavingRef.current = false
      setIsSaving(false)
    }

    if (result.error) {
      toast.error(result.error)
      return
    }

    // 深夜跨ぎ: logged_at が開始時刻になったため、日付が変わってから停止すると
    // 前日の行が生まれる。baby-dashboard の Realtime admission guard
    // （baby-dashboard.tsx: `toJstDateString(newLog.logged_at) !== selectedDateRef.current`）
    // と同じ「logged_at の JST 日付一致」で入場を判定するが、比較相手は selectedDate
    // ではなく **今日（JST）** にしてある。<FeedingTimer> は isToday ゲートの外に
    // 描画されるため、シートを開いたまま日付が変わると today だけが翌日へ進み
    // selectedDate は前日に留まる。その窓では本ガードは dashboard より**厳しく**、
    // まだ表示中の前日 timeline なら受け入れられた行の append も見送る（保守側へ倒す）。
    // 一致しない行を append すると、翌日のタイムラインに前日の記録が現れ、リロードで
    // 消える不整合になる。ゆえに「選択日=今日だから等価」ではなく、意図して
    // 厳しくしている分岐である（等価だと読んで消すな）。
    const isSameJstDay = toJstDateString(loggedAt) === todayJstString()

    // B-03: 返却 id で楽観 append（Realtime を待たず timeline/回数を即時更新）
    if (result.id) {
      const optimisticLog = buildOptimisticLog({
        id: result.id,
        logType: "feeding",
        loggedBy: userId,
        feedingType: "breast",
        breastLeftCount: leftCount,
        breastRightCount: rightCount,
        durationSec,
        loggedAt,
      })
      if (isSameJstDay) {
        onLogRecorded?.(optimisticLog)
      } else {
        // 前日行は timeline へ入れられない（入場条件違反）が、「最終授乳」の
        // fallback は更新する — さもなくば記録直後にチップが「---」へ落ち、
        // 前日保存トーストと合わせても「消えた」印象を残す（P3）。
        onPrevDayLogRecorded?.(optimisticLog)
      }
    }

    localStorage.removeItem(STORAGE_KEY)
    setStartedAt(null)
    // 内訳（左2・右1）と時間を添えて「何が記録されたか」を確認できるようにする。
    // 日跨ぎで append を見送った時は必ず前日保存を明示する — 無言でスキップすると
    // 「記録されていない」と誤解して再タップし、二重記録になる。
    const detail = [
      formatBreastCounts(leftCount, rightCount),
      formatDurationSec(durationSec),
    ]
      .filter(Boolean)
      .join("・")
    toast.success(
      isSameJstDay
        ? `授乳を記録しました（${detail}）`
        : `授乳を記録しました（${detail}／前日の記録として保存）`,
    )
    onOpenChange(false)
  }

  function handleStop() {
    // startedAt が無いのは「記録成功 → 親が閉じるまで」の一瞬だけ。開始時刻が
    // 無いまま now を代用すると logged_at の意味（開始時刻）が壊れるため記録しない。
    if (!startedAt) return
    void saveFeeding(
      clampFeedingDurationSec(elapsedSeconds),
      startedAt.toISOString(),
    )
  }

  function handleManualRecord() {
    const totalSeconds = manualMin * 60 + manualSec
    // clamp 前の生値で 0 を弾く（clampFeedingDurationSec は 0 を 1 秒へ持ち上げるため、
    // clamp 後に判定すると「時間未選択」を無音で 1 秒として記録してしまう）
    if (totalSeconds <= 0) {
      toast.error("授乳時間を選んでください")
      return
    }
    const durationSec = manualDurationSec(manualMin, manualSec)
    // 手動入力の logged_at はサイクル開始時刻 = 記録時刻 − 授乳時間
    void saveFeeding(
      durationSec,
      new Date(Date.now() - durationSec * 1000).toISOString(),
    )
  }

  function handleCancel() {
    localStorage.removeItem(STORAGE_KEY)
    setStartedAt(null)
    onOpenChange(false)
  }

  function handleOpenChange(isOpen: boolean) {
    if (!isOpen && startedAt && !isSavingRef.current) {
      // Sheet dismissed by swipe — treat as cancel
      localStorage.removeItem(STORAGE_KEY)
      setStartedAt(null)
    }
    onOpenChange(isOpen)
  }

  const countsLabel = formatBreastCounts(cycle.leftCount, cycle.rightCount)

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[85dvh] overflow-hidden rounded-t-2xl safe-bottom"
      >
        <SheetHeader className="pb-2">
          <SheetTitle>授乳を記録</SheetTitle>
          <SheetDescription>
            {mode === "timer"
              ? "吸わせる側を替えるたびに左右のボタンを押してください。停止すると1回の授乳として記録されます"
              : "授乳にかかった時間と左右の回数を選んで記録します"}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col items-center gap-6 px-4 py-6">
          {/* 入力方式の切替（タイマー / 手動） */}
          <div className="flex w-full gap-1.5">
            <button
              type="button"
              onClick={() => setMode("timer")}
              className={segmentCn(mode === "timer")}
            >
              タイマー
            </button>
            <button
              type="button"
              onClick={() => setMode("manual")}
              className={segmentCn(mode === "manual")}
            >
              手動入力
            </button>
          </div>

          {mode === "timer" ? (
            <>
              {/* 現在吸わせている側。反対側をタップすると stint が +1 される */}
              <div className="flex w-full gap-1.5">
                <button
                  type="button"
                  onClick={() => handleSideTap("breast_left")}
                  className={segmentCn(cycle.side === "breast_left")}
                >
                  左
                </button>
                <button
                  type="button"
                  onClick={() => handleSideTap("breast_right")}
                  className={segmentCn(cycle.side === "breast_right")}
                >
                  右
                </button>
              </div>

              {/* 経過時間 */}
              <div className="font-mono text-5xl font-bold tabular-nums tracking-tight">
                {formatTimer(elapsedSeconds)}
              </div>

              {/* 吸わせた回数（左右の内訳） */}
              <div className="flex flex-col items-center gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  吸わせた回数
                </span>
                {/* 手動入力で両側 0 にしてから timer へ戻ると空になるため 0回 と出す
                    （反対側をタップすればその側が 1 になり復帰できる） */}
                <span className="text-lg font-semibold tabular-nums">
                  {countsLabel || "0回"}
                </span>
              </div>

              {/* 停止ボタン */}
              <Button
                onClick={handleStop}
                disabled={isSaving}
                size="lg"
                className="min-h-14 w-full rounded-2xl text-lg font-semibold"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="animate-spin" />
                    記録中...
                  </>
                ) : (
                  <>
                    <Square size={20} className="fill-current" />
                    停止して記録
                  </>
                )}
              </Button>
            </>
          ) : (
            <>
              {/* 左右の回数（ステッパー） */}
              <div className="flex w-full gap-3">
                <CountStepper
                  label="左"
                  value={cycle.leftCount}
                  disabled={isSaving}
                  onChange={(delta) => handleCountChange("breast_left", delta)}
                />
                <CountStepper
                  label="右"
                  value={cycle.rightCount}
                  disabled={isSaving}
                  onChange={(delta) => handleCountChange("breast_right", delta)}
                />
              </div>

              {/* 分・秒ピッカー（60分まで） */}
              <div className="flex items-end justify-center gap-3">
                <div className="flex flex-col items-center gap-1">
                  <label
                    htmlFor="manual-min"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    分
                  </label>
                  <select
                    id="manual-min"
                    value={manualMin}
                    onChange={(e) => setManualMin(Number(e.target.value))}
                    disabled={isSaving}
                    className="min-h-11 rounded-lg border bg-background px-4 text-2xl font-bold tabular-nums transition-colors duration-200 disabled:opacity-50"
                  >
                    {MANUAL_MINUTE_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
                <span className="pb-2 text-2xl font-bold text-muted-foreground">
                  :
                </span>
                <div className="flex flex-col items-center gap-1">
                  <label
                    htmlFor="manual-sec"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    秒
                  </label>
                  <select
                    id="manual-sec"
                    value={manualSec}
                    onChange={(e) => setManualSec(Number(e.target.value))}
                    disabled={isSaving}
                    className="min-h-11 rounded-lg border bg-background px-4 text-2xl font-bold tabular-nums transition-colors duration-200 disabled:opacity-50"
                  >
                    {MANUAL_SECOND_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {String(s).padStart(2, "0")}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* 記録ボタン */}
              <Button
                onClick={handleManualRecord}
                disabled={isSaving}
                size="lg"
                className="min-h-14 w-full rounded-2xl text-lg font-semibold"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="animate-spin" />
                    記録中...
                  </>
                ) : (
                  <>
                    <Check size={20} />
                    記録する
                  </>
                )}
              </Button>
            </>
          )}

          <button
            type="button"
            onClick={handleCancel}
            className="text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground"
          >
            キャンセル（記録しない）
          </button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

/**
 * 左右それぞれの吸わせ回数を直接増減するステッパー（手動入力モード専用）。
 * タッチターゲットは 44px 以上（min-h-11 / min-w-11）。
 */
function CountStepper({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string
  value: number
  disabled: boolean
  onChange: (delta: number) => void
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
          onClick={() => onChange(-1)}
          disabled={disabled || value <= 0}
          className={buttonCn}
        >
          <Minus size={18} />
        </button>
        {/* output は暗黙で role="status" ゆえ、増減が支援技術へも読み上げられる
            （編集シートの BreastCountStepper と要素種別まで揃える） */}
        <output
          aria-label={`${label}の回数`}
          className="w-8 text-center text-2xl font-bold tabular-nums"
        >
          {value}
        </output>
        <button
          type="button"
          aria-label={`${label}の回数を1増やす`}
          onClick={() => onChange(1)}
          disabled={disabled || value >= MAX_BREAST_COUNT}
          className={buttonCn}
        >
          <Plus size={18} />
        </button>
      </div>
    </div>
  )
}

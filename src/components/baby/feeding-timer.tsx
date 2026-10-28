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
import { Loader2, Square, Check, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { recordFeeding } from "@/app/(main)/baby/actions"
import { lookupBabyLogs } from "@/lib/domain/baby-log-lookup-client"
import { noteServerActionFailure, STALE_CLIENT_ACTION_MESSAGE } from "@/lib/pwa/app-version"
import {
  phaseAfterFailure,
  SAVE_CONFLICT_MESSAGE,
  SAVE_RESEND_LABEL,
  SAVE_UNKNOWN_MESSAGE,
} from "@/lib/domain/save-attempt"
import {
  clampBreastCount,
  clampFeedingDurationSec,
  resolveBreastSideSeconds,
} from "@/lib/domain/feeding"
import { BreastCountStepper } from "@/components/baby/breast-count-stepper"
import {
  belongsToOwner,
  clearPersistedTimer,
  isTimerStale,
  readPersistedTimer,
  writePersistedTimer,
  type PersistedBreastSide,
  type PersistedFeedingPayload,
  type PersistedFeedingSubmission,
  type PersistedTimerState,
} from "@/lib/domain/feeding-timer-storage"
import { newClientId } from "@/lib/utils/client-id"
import { useWakeLock } from "@/lib/hooks/use-wake-lock"
import { useNow } from "@/lib/hooks/use-now"
import { useServerClock } from "@/lib/hooks/use-server-clock"
import { segmentCn } from "@/lib/utils/segment-cn"
import {
  formatDurationSec,
  formatBreastCounts,
  formatBreastSideBreakdown,
  formatElapsedMinutes,
} from "@/lib/utils/baby-log-labels"
import {
  formatTimeJst,
  shiftYmd,
  toJstDateString,
  todayJstString,
} from "@/lib/utils/date-jst"
import type { FeedingType, BreastStartSide } from "@/lib/types/database"
import type { BabyLogData } from "@/lib/types/baby"
import { buildOptimisticLog } from "@/lib/domain/baby-optimistic-log"

// 開いてからこの時間未満のタイマーは「誤って開いた」とみなし、通常の閉じ方（暗幕・×・
// Esc・Android の戻る）で計測を取り消して閉じる。タイマーはシートを開いた瞬間に始まる
// ため、誤タップや手動入力のつもりで開いた 0 秒の計測が端末に残ってチップに居座らぬよう
// にする。失うのは 1 分未満の計測だけで、手動入力で記録し直せる。
const ACCIDENTAL_OPEN_GRACE_MS = 60_000

// 記録の送信がこの時間を越えても返らぬ時は「応答を待っています」と出し、照合を先に使わせる
// （Server Action は直列に送られるため、送り直しは同じ列で待たされる）
const SEND_SLOW_NOTICE_MS = 15_000

/**
 * 誤って開いた直後とみなせるか。**fail-closed** に判じる — 迷えば「計測中」とし、
 * 閉じる操作では捨てぬ。
 *
 * - 経過が負（端末の時計が戻って開始時刻が未来になった）なら猶予外。表示は 00:00 に
 *   丸めるが、左右の回数・秒数を積んだ長い計測でありうる（ここで捨てれば P1-05 の
 *   「閉じる 1 回で計測が消える」が戻る）
 * - 開いた時の seed から一度でも触った（左右の切替・回数の増減・積算）計測は、1 分
 *   未満でも確認を経ずには捨てぬ
 */
function isAccidentalOpen(
  startedAt: Date,
  nowMs: number,
  cycle: CycleState,
): boolean {
  const elapsed = nowMs - startedAt.getTime()
  if (elapsed < 0 || elapsed >= ACCIDENTAL_OPEN_GRACE_MS) return false
  return isUntouchedSeed(cycle)
}

/** seedCycle が作ったままで、利用者が何も操作していないサイクルか。 */
function isUntouchedSeed(cycle: CycleState): boolean {
  if (cycle.sidesUnknown || cycle.startSide === null) return false
  if (cycle.side !== cycle.startSide) return false
  if (cycle.leftSec !== 0 || cycle.rightSec !== 0) return false
  const seeded = seedCycle(cycle.startSide, cycle.sideSince)
  return (
    cycle.leftCount === seeded.leftCount && cycle.rightCount === seeded.rightCount
  )
}

// 片側の吸わせ回数は clampBreastCount（@/lib/domain/feeding。上限 BREAST_COUNT_MAX は
// DB CHECK chk_breast_counts_required の 0..20 のミラー）で丸める。
//
// **これは検証ではなく救済である**（削るな）: 21 回目のタップで素通しにすると
// サーバの validateBreastCounts が記録を拒否し、走行中のタイマーが「停止しても
// 記録できない」恒久スタックに落ちる。clampFeedingDurationSec が 181 分以上を
// 180 分で記録するのと同じ方針で、上限に張り付かせて記録は必ず通す。

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
type BreastSide = PersistedBreastSide

/**
 * 進行中の母乳サイクルの状態。左右それぞれ何回吸わせたか（stint）と現在側を持つ。
 * 1 回の授乳＝1 行（feeding_type='breast'）に breast_left_count /
 * breast_right_count として保存する。
 */
interface CycleState {
  side: BreastSide
  /**
   * サイクルを始めた側（DB の breast_start_side）。counts / sides は順序を持たぬため
   * ここで別に覚える。旧形式 localStorage から復元して片側からしか吸わせていない
   * （反対側 0 回）なら推定できるが、両側とも 1 回以上なら復元不能 = null（不明）。
   */
  startSide: BreastSide | null
  leftCount: number
  rightCount: number
  /** 側ごとの確定済み積算秒（現在側の走行分は含まない）。sidesUnknown 時は常に 0。 */
  leftSec: number
  rightSec: number
  /** 現在側を吸わせ始めた時刻(ISO)。live 表示と banking の基点。 */
  sideSince: string
  /**
   * 旧形式 localStorage（切替時刻なし）から復元したサイクル。過去の左右配分は
   * 原理的に復元できないため、このサイクルは sides を記録せず合計のみで保存する
   * （途中から banking を始めると未帰属分が抜けた嘘の配分になる）。保存も旧形式の
   * まま行い、開き直しても sidesUnknown が維持される（粘着）。
   */
  sidesUnknown: boolean
}

/**
 * 親（ダッシュボード）へ知らせる「計測中」の要約。シートを閉じても計測は端末に残る
 * （UX-04a）ゆえ、親はこれでチップを出して戻る導線を作る。null は計測なし。
 */
export interface RunningTimer {
  startedAt: string
  side: BreastSide
  /** 開始から MAX_TIMER_AGE_MS を超えた停め忘れ。開けば記録か破棄を選ぶ */
  stale: boolean
  /**
   * 記録を押した後、保存できたか確かめられておらぬ（送信中・応答不明・内容の衝突）。
   * 親のチップは「計測中」ではなく「保存を確認中」と出す（計測は止まっておる）。
   */
  pendingSave: boolean
}

/** localStorage / DB 用に CycleState の側を DB 値（left / right）へ写す。 */
function toDbStartSide(side: BreastSide | null): BreastStartSide | null {
  if (side === "breast_left") return "left"
  if (side === "breast_right") return "right"
  return null
}

/**
 * 旧形式（startSide を持たぬ TimerState）の復元時に開始側を推定する。
 * 片側しか吸わせていなければその側で確定、両側とも吸わせていれば順序は復元不能。
 */
function inferStartSide(leftCount: number, rightCount: number): BreastSide | null {
  if (leftCount > 0 && rightCount === 0) return "breast_left"
  if (rightCount > 0 && leftCount === 0) return "breast_right"
  return null
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
function seedCycle(side: BreastSide, sideSinceIso: string): CycleState {
  return {
    side,
    startSide: side,
    leftCount: side === "breast_left" ? 1 : 0,
    rightCount: side === "breast_right" ? 1 : 0,
    leftSec: 0,
    rightSec: 0,
    sideSince: sideSinceIso,
    sidesUnknown: false,
  }
}

/** sideSince から現在までの経過秒（banking の量）。不正な ISO は 0 として扱う。 */
function elapsedSinceSideStart(sideSinceIso: string): number {
  const since = new Date(sideSinceIso).getTime()
  if (Number.isNaN(since)) return 0
  return Math.max(0, Math.round((Date.now() - since) / 1000))
}

/** localStorage 由来の回数を整数・0..20 へ正規化する。整数でなければ null。 */
function normalizeStoredCount(value: unknown): number | null {
  return Number.isInteger(value) ? clampBreastCount(value as number) : null
}

/**
 * localStorage の TimerState からサイクル状態を復元する。
 *
 * - 旧形式（counts なし）・整数でない壊れた値は「現在側=1・反対側=0」で seed する
 *   （throw させない。復元に失敗して記録が消えるより退化させる方が実害が小さい）
 * - 合計 0 も現在側 1 へ救済する: timer モードには回数を直す UI が無く、0+0 のままだと
 *   停止＝記録がサーバ検証 / DB CHECK chk_breast_counts_required に必ず弾かれ、
 *   タイマーが恒久スタックする（stale の扱いと同じ救済方針）
 */
function restoreCycle(state: PersistedTimerState): CycleState {
  const side = normalizeSide(state.feedingType)
  const nowIso = new Date().toISOString()
  const left = normalizeStoredCount(state.leftCount)
  const right = normalizeStoredCount(state.rightCount)
  const counts =
    left === null || right === null || left + right < 1
      ? seedCycle(side, nowIso)
      : { leftCount: left, rightCount: right }

  // 開始側: 保存値があればそれ、無ければ counts から推定（推定不能なら null = 不明）。
  // counts を seed し直した（壊れていた）場合は現在側から始めたものとして扱う。
  const storedStart =
    state.startSide === "breast_left" || state.startSide === "breast_right"
      ? state.startSide
      : null
  const startSide =
    storedStart ??
    ("startSide" in counts
      ? counts.startSide
      : inferStartSide(counts.leftCount, counts.rightCount))

  // 左右別秒の復元。leftSec/rightSec が非負整数・sideSince が妥当な ISO の
  // 3点セットが揃わなければ sidesUnknown（粘着 — CycleState の docstring 参照）。
  const leftSec =
    Number.isInteger(state.leftSec) && (state.leftSec as number) >= 0
      ? (state.leftSec as number)
      : null
  const rightSec =
    Number.isInteger(state.rightSec) && (state.rightSec as number) >= 0
      ? (state.rightSec as number)
      : null
  const sideSinceValid =
    typeof state.sideSince === "string" &&
    !Number.isNaN(new Date(state.sideSince).getTime())
  if (leftSec === null || rightSec === null || !sideSinceValid) {
    return {
      side,
      startSide,
      leftCount: counts.leftCount,
      rightCount: counts.rightCount,
      leftSec: 0,
      rightSec: 0,
      sideSince: nowIso,
      sidesUnknown: true,
    }
  }
  // sideSince は保存値を引き継ぐ: 閉じていた区間も現在側の授乳が続いていたと
  // みなして banking する（切替はタップでしか起きないため正しい帰属）。
  return {
    side,
    startSide,
    leftCount: counts.leftCount,
    rightCount: counts.rightCount,
    leftSec,
    rightSec,
    sideSince: state.sideSince as string,
    sidesUnknown: false,
  }
}

function toPersistedState(
  startedAt: Date,
  cycle: CycleState,
  meta: {
    userId: string
    householdId: string
    clientId: string
    submission: PersistedFeedingSubmission | null
  },
): PersistedTimerState {
  return {
    startedAt: startedAt.toISOString(),
    feedingType: cycle.side,
    leftCount: cycle.leftCount,
    rightCount: cycle.rightCount,
    // 不明（null）は書かない（復元時に counts から推定し直す余地を残す）
    ...(cycle.startSide ? { startSide: cycle.startSide } : {}),
    // sidesUnknown のサイクルは秒情報を保存しない（旧形式のまま）= 開き直しても
    // sidesUnknown が復元される粘着性の実装。書けば「途中からの配分」が本物に見えてしまう
    ...(cycle.sidesUnknown
      ? {}
      : {
          leftSec: cycle.leftSec,
          rightSec: cycle.rightSec,
          sideSince: cycle.sideSince,
        }),
    // 持ち主と冪等 id（P3-08 / P2-08）
    userId: meta.userId,
    householdId: meta.householdId,
    clientId: meta.clientId,
    // 記録を押した後の固定した送信内容（応答不明でも再読込で同じ内容を照合できる）
    ...(meta.submission ? { submission: meta.submission } : {}),
  }
}

/** 固定した送信内容の要約（応答不明の間に「何を送ったか」を見せる）。 */
function describeSubmission(payload: PersistedFeedingPayload): string {
  // 時刻を持たぬ送信内容は、サーバが受け取った時刻で記録される（押した時刻を推定できなかった。N3）
  const start =
    payload.loggedAt !== undefined
      ? `${formatTimeJst(payload.loggedAt)} 開始`
      : "開始はサーバが受け取った時刻"
  const startLabel =
    payload.breastStartSide === "left"
      ? "左から"
      : payload.breastStartSide === "right"
        ? "右から"
        : ""
  const breakdown =
    payload.breastLeftSec !== undefined && payload.breastRightSec !== undefined
      ? formatBreastSideBreakdown(
          payload.breastLeftCount,
          payload.breastRightCount,
          payload.breastLeftSec,
          payload.breastRightSec,
        )
      : [
          formatBreastCounts(payload.breastLeftCount, payload.breastRightCount),
          formatDurationSec(payload.durationSec ?? 0),
        ]
          .filter(Boolean)
          .join("・")
  return [start, startLabel, breakdown].filter(Boolean).join("・")
}

interface FeedingTimerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialFeedingType: FeedingType
  /** 記録者（logged_by）。楽観 append 行と端末保存の持ち主に使う（B-03 / P3-08） */
  userId: string
  /** 今の世帯。端末保存の持ち主に使う（別世帯の計測・送信内容を復元も送信もせぬ） */
  householdId: string
  /**
   * 記録成功時に楽観 append する行を親へ渡す（B-03）。深夜跨ぎ（サイクル開始が
   * JST で前日）の行も渡す — どの配列（選択日の logs・週窓・最終授乳の fallback）へ
   * 入れるかは親の appendLog が行の日付で決める（レビュー P3-8）。
   */
  onLogRecorded?: (log: BabyLogData) => void
  /**
   * 計測の有無が変わるたびに親へ知らせる（開始・復元・側の切替・記録・破棄）。
   * 親はこれでダッシュボードに「授乳を計測中」のチップを出し、閉じたシートへ戻る
   * 導線を作る（UX-04a: 閉じても計測は端末に残り、破棄は明示の操作だけ）。
   */
  onRunningChange?: (running: RunningTimer | null) => void
}

/** 利用者・世帯が替わった時は、計測・固定した送信内容を新しい名義へ持ち越さぬ。 */
export function FeedingTimer(props: FeedingTimerProps) {
  return <OwnedFeedingTimer key={`${props.userId}:${props.householdId}`} {...props} />
}

function OwnedFeedingTimer({
  open,
  onOpenChange,
  initialFeedingType,
  userId,
  householdId,
  onLogRecorded,
  onRunningChange,
}: FeedingTimerProps) {
  const [cycle, setCycle] = useState<CycleState>(() =>
    seedCycle(normalizeSide(initialFeedingType), new Date().toISOString()),
  )
  const [startedAt, setStartedAt] = useState<Date | null>(null)
  // 停め忘れ（開始から MAX_TIMER_AGE_MS 超）を復元した状態。走らせ直さず、開始時刻を
  // 保ったまま授乳時間を手で入れて記録するか、破棄するかを利用者が選ぶ（P3-08）。
  const [stale, setStale] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const isSavingRef = useRef(false)
  // この計測の冪等 id（P2-08）。開始時に 1 回だけ作り、停止の再試行で同じ値を送る。
  const clientIdRef = useRef<string | null>(null)
  // 記録を押した時に固定した送信内容（A2）。null は「まだ押していない / 直してよい」。
  // 応答不明の間は入力を出さず、再送はこれをそのまま送る（時刻・秒数を作り直さぬ）。
  const [submission, setSubmissionState] = useState<PersistedFeedingSubmission | null>(null)
  const submissionRef = useRef<PersistedFeedingSubmission | null>(null)
  function setSubmission(next: PersistedFeedingSubmission | null) {
    submissionRef.current = next
    setSubmissionState(next)
  }
  // 照合で見つからず内容を直す時に持ち越す、最初の押下の開始時刻（無い = 受信時刻で記録する送信）。
  // 同じ id の間だけ使い、記録の確定・破棄・保存前の拒否で捨てる（N3-02）
  const keptOriginRef = useRef<{ clientId: string; loggedAt: string | undefined } | null>(null)
  // 「記録されたか確かめる」の状態。notFound は「まだ見つからぬ」— 保存されなんだ断定ではない
  const [lookup, setLookup] = useState<"idle" | "checking" | "notFound" | "error">("idle")
  // 同じ id で別の内容が記録済みだった時のサーバの確定行（端末には残さぬ。再読込後は照合で読み直す）
  const [conflictLog, setConflictLog] = useState<BabyLogData | null>(null)
  // 照合の取得（GET）の取消し口。閉じた後・次の照合の前に止める
  const lookupAbortRef = useRef<AbortController | null>(null)
  const activeRef = useRef(true)
  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
      lookupAbortRef.current?.abort()
    }
  }, [])
  // 送信が SEND_SLOW_NOTICE_MS を越えても返らぬ。送り直しは直列の列で待たされるゆえ出さず、
  // 照合（GET）だけを先に使えるようにする
  const [slowSend, setSlowSend] = useState(false)
  useEffect(() => {
    if (!isSaving) {
      setSlowSend(false) // eslint-disable-line react-hooks/set-state-in-effect -- 送信の終わりで案内を畳む
      return
    }
    const id = setTimeout(() => setSlowSend(true), SEND_SLOW_NOTICE_MS)
    return () => clearTimeout(id)
  }, [isSaving])
  // 端末保存に失敗した時の通知は 1 回だけ（切替ごとに鳴らさぬ）
  const persistWarnedRef = useRef(false)
  // 手元の計測（state）の鏡。開く effect は deps を絞っておるため、ref で最新を読む
  // （端末保存が効かぬ環境で、閉じて開き直した時に手元の計測を上書きせぬ。P3-7）
  const startedAtRef = useRef<Date | null>(null)
  const cycleRef = useRef<CycleState | null>(null)
  useEffect(() => {
    startedAtRef.current = startedAt
    cycleRef.current = cycle
  }, [startedAt, cycle])
  // 「キャンセル（記録しない）」の確認段（P1-05: 破棄は確認を経た明示操作だけ）。
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  // 授乳時間の入力方式。タイマー（既定）と手動入力（分・秒）を切り替える。
  const [mode, setMode] = useState<TimerMode>("timer")
  const [manualLeftMin, setManualLeftMin] = useState(DEFAULT_MANUAL_MINUTES)
  const [manualLeftSec, setManualLeftSec] = useState(0)
  const [manualRightMin, setManualRightMin] = useState(0)
  const [manualRightSec, setManualRightSec] = useState(0)
  // タイマーが実際に走るのは timer モードの時だけ（手動入力中は wake lock 不要）
  const timerRunning = open && mode === "timer" && !!startedAt
  // 時計は計測中ならモードを問わず進める: 手動入力中も「誤って開いた直後か」の判定が
  // 1 分で切り替わる必要があるため。
  const now = useNow(1000, open && !!startedAt)
  const initializedRef = useRef(false)
  // 一度でも開いた後だけ親へ報告する（開く前の null で、親が端末保存から拾った
  // 「計測中」を上書きせぬ）。
  const everOpenedRef = useRef(false)

  useWakeLock(timerRunning)
  // 手動記録の「押した時刻」をサーバの時計で推定し、タイマーの停止では端末の時計の開始時刻を
  // サーバの時計へ写す（開いておる間、開いた時・画面復帰・10 分ごとに取り直す。N3 / v8 N3-01）
  const { serverNowIso, toServerIso, deviceSkewMs } = useServerClock(open)

  // 計測の有無・側・停め忘れを親へ知らせる（UX-04a のチップ）。最新の callback を ref で読む。
  const onRunningChangeRef = useRef(onRunningChange)
  useEffect(() => {
    onRunningChangeRef.current = onRunningChange
  })
  useEffect(() => {
    if (!everOpenedRef.current) return
    onRunningChangeRef.current?.(
      startedAt
        ? {
            startedAt: startedAt.toISOString(),
            side: cycle.side,
            stale,
            pendingSave: submission !== null,
          }
        : null,
    )
  }, [startedAt, cycle.side, stale, submission])

  /** 端末保存へ書く。失敗（容量不足・プライベートモード）は 1 回だけ利用者へ知らせる。 */
  function persist(at: Date, next: CycleState) {
    if (!activeRef.current) return
    const clientId = clientIdRef.current ?? newClientId()
    clientIdRef.current = clientId
    const ok = writePersistedTimer(
      toPersistedState(at, next, {
        userId,
        householdId,
        clientId,
        submission: submissionRef.current,
      }),
    )
    if (!ok && !persistWarnedRef.current) {
      persistWarnedRef.current = true
      toast.error(
        "この端末に計測を保存できませんでした。画面を閉じたり再読み込みすると計測が消えます",
      )
    }
  }

  // Restore or initialize timer on open
  useEffect(() => {
    if (!open) {
      initializedRef.current = false
      return
    }
    if (initializedRef.current) return
    initializedRef.current = true
    everOpenedRef.current = true

    /* eslint-disable react-hooks/set-state-in-effect -- 開いた時点の端末保存からタイマーを復元する */
    // 開くたびにタイマー方式・手動入力の既定へ戻す（前回 manual のまま開かない）。
    // 手動入力の既定は開始側 5:00・反対側 0:00。破棄の確認段も畳んで開く。
    setMode("timer")
    setConfirmingDiscard(false)
    setStale(false)
    setLookup("idle")
    const startSide = normalizeSide(initialFeedingType)
    setManualLeftMin(startSide === "breast_left" ? DEFAULT_MANUAL_MINUTES : 0)
    setManualLeftSec(0)
    setManualRightMin(startSide === "breast_right" ? DEFAULT_MANUAL_MINUTES : 0)
    setManualRightSec(0)

    const saved = readPersistedTimer()
    if (!saved && persistWarnedRef.current && startedAtRef.current && cycleRef.current) {
      // 端末保存が効かぬ環境（容量不足・プライベートモード）で閉じて開き直した。
      // 手元の計測がそのまま真値ゆえ、新しいタイマーで上書きせぬ（「閉じても計測は
      // 続きます」の文言どおり。P3-7）。停め忘れの判定だけは開くたびに行う
      const kept = startedAtRef.current
      if (isTimerStale(kept.toISOString(), Date.now())) {
        setStale(true)
        setMode("manual")
        setManualLeftMin(0)
        setManualRightMin(0)
      }
      persist(kept, cycleRef.current)
      return
    }
    if (saved) {
      if (!belongsToOwner(saved, { userId, householdId })) {
        // 別の利用者・世帯の計測（P3-08）。名義を変えて記録せぬよう捨てて始め直す。
        // 本文は見せぬ（他人の記録）。ログには事実だけ残す
        console.warn("[feeding-timer] 別の利用者・世帯の計測が端末に残っていたため破棄した")
        clearPersistedTimer()
      } else {
        const savedTime = new Date(saved.startedAt)
        const restored = restoreCycle(saved)
        // 送信内容の id は計測の id と同じでなければならぬ（食い違えば送信内容は信用せぬ）
        const savedSubmission =
          saved.submission && saved.submission.payload.clientId === saved.clientId
            ? saved.submission
            : null
        const clientId = saved.clientId ?? newClientId()
        clientIdRef.current = clientId
        setStartedAt(savedTime)
        setCycle(restored)
        if (savedSubmission) {
          // 記録を押した後に閉じた・再読込した。送信中のまま残ったものは結果不明として扱い、
          // 走らせ直さず固定した内容で照合する（停め忘れの判定もせぬ — 送った内容は確定済み）
          const pending: PersistedFeedingSubmission = {
            ...savedSubmission,
            phase: savedSubmission.phase === "sending" ? "unknown" : savedSubmission.phase,
          }
          setSubmission(pending)
          persist(savedTime, restored)
          if (pending.phase === "unknown") void checkSubmission(pending, { auto: true })
          return
        }
        if (isTimerStale(saved.startedAt, Date.now())) {
          // 停め忘れ: 黙って捨てず、開始時刻を保ったまま手動入力で記録するか破棄するかを
          // 選ばせる。走らせ直すと「3 時間の授乳」を上限で丸めて記録する嘘になる
          setStale(true)
          setMode("manual")
          setManualLeftMin(0)
          setManualRightMin(0)
        }
        // 持ち主と冪等 id を書き足す（旧形式の移行・再試行での id 固定）
        persist(savedTime, restored)
        return
      }
    }

    // Start new timer（開始側を 1 回で seed し、banking の基点も開始時刻に置く）
    const start = new Date()
    const seeded = seedCycle(normalizeSide(initialFeedingType), start.toISOString())
    clientIdRef.current = newClientId()
    setSubmission(null)
    setStartedAt(start)
    setCycle(seeded)
    persist(start, seeded)
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- persist / checkSubmission は持ち主 / ref だけを読む
  }, [open, initialFeedingType, userId, householdId])

  /**
   * 吸わせる側を切り替える（タイマー中の stint カウント）。
   * 反対側のタップで「その側を吸わせ始めた」= 回数 +1。同じ側の再タップは連続
   * stint にならないため no-op（押し間違い / 連打で回数が水増しされるのを防ぐ）。
   */
  function handleSideTap(next: BreastSide) {
    if (cycle.side === next) return
    // 離れる側へ経過を banking する（sidesUnknown のサイクルは配分を持たないため加算しない）
    const banked = cycle.sidesUnknown ? 0 : elapsedSinceSideStart(cycle.sideSince)
    const bumped: CycleState = {
      ...cycle,
      side: next,
      leftCount:
        next === "breast_left"
          ? clampBreastCount(cycle.leftCount + 1)
          : cycle.leftCount,
      rightCount:
        next === "breast_right"
          ? clampBreastCount(cycle.rightCount + 1)
          : cycle.rightCount,
      leftSec:
        cycle.side === "breast_left" ? cycle.leftSec + banked : cycle.leftSec,
      rightSec:
        cycle.side === "breast_right" ? cycle.rightSec + banked : cycle.rightSec,
      sideSince: new Date().toISOString(),
    }
    setCycle(bumped)
    // アプリを閉じても回数・左右時間が消えないよう、切替ごとに保存する
    if (startedAt) persist(startedAt, bumped)
  }

  /** 手動入力のステッパー（左右の回数を直接増減する）。 */
  function handleCountChange(side: BreastSide, delta: number) {
    const next: CycleState =
      side === "breast_left"
        ? { ...cycle, leftCount: clampBreastCount(cycle.leftCount + delta) }
        : { ...cycle, rightCount: clampBreastCount(cycle.rightCount + delta) }
    setCycle(next)
    if (startedAt) persist(startedAt, next)
  }

  /**
   * 手動入力の開始側（クイックアクションでタップした側が既定）。現在側も揃える —
   * 手動入力では「現在側」は 0 秒救済（resolveBreastSideSeconds）の寄せ先にしか
   * 使われず、開始側と食い違わせる意味が無い。
   */
  function handleStartSideChange(next: BreastSide) {
    if (cycle.startSide === next) return
    const bumped: CycleState = { ...cycle, startSide: next, side: next }
    setCycle(bumped)
    if (startedAt) persist(startedAt, bumped)
  }

  const elapsedSeconds = startedAt
    ? Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000))
    : 0

  // 表示用の側ごと経過（banked + 現在側の走行分）。sidesUnknown は配分を持たない。
  const liveSideSec = cycle.sidesUnknown
    ? 0
    : Math.max(
        0,
        Math.floor((now.getTime() - new Date(cycle.sideSince).getTime()) / 1000),
      )
  const leftDisplaySec =
    cycle.leftSec + (cycle.side === "breast_left" ? liveSideSec : 0)
  const rightDisplaySec =
    cycle.rightSec + (cycle.side === "breast_right" ? liveSideSec : 0)

  // タイマー停止・手動記録の共通保存経路。母乳は「1 回の授乳 = 1 行」の母乳サイクル
  // （feeding_type='breast'）として左右の回数つきで記録し、durationSec（秒精度）で
  // 保存する（duration_min はサーバ側で round 併記）。通信断 reject を握って永久
  // disabled を防ぐ（recordFeeding は redirect しないため finally で isSaving を戻せる）。
  //
  // loggedAt はサイクルの**開始時刻**（終了時刻ではない）。タイマーは開始時刻、
  // 手動入力は「記録する」を押した時刻（サーバの時計で推定した値。推定できねば渡さず、
  // サーバの受信時刻で記録する。N3）を渡す。過去行も backfill migration
  // （20260726100003_baby_feeding_backfill_start_time）で開始基準へ揃えてある。
  //
  // **送信内容は最初の有効な押下で固定する**（2026-10-27 大型更新 A2 / 監査 F01）。結果が不明な間の
  // 押し直しは、開始時刻・左右秒・回数・開始側・id を作り直さず同じものを送る — 作り直すと同じ id に
  // 別の内容を送ることになり、サーバの内容照合（sameRecordedContent）に拒まれて、保存できているのに
  // 成功を確定できぬ。固定した内容は端末保存にも残し、再読込の後も同じ内容で照合する。
  async function saveFeeding(params: {
    /** 無い = サーバの受信時刻で記録する（手動記録で押した時刻を推定できなかった時だけ） */
    loggedAt: string | undefined
    /** sidesUnknown（旧形式復元）のサイクル: 合計のみで保存する */
    durationSec?: number
    /** 左右別秒（resolveBreastSideSeconds 通過済み）。合計はサーバが導出する */
    sides?: { leftSec: number; rightSec: number }
  }) {
    if (isSavingRef.current) return
    // 結果の分からぬ送信が在れば、今の画面の値ではなく固定した内容を送り直す
    const pending = submissionRef.current
    if (pending) {
      await sendSubmission(pending)
      return
    }
    const { loggedAt, sides } = params
    const { leftCount, rightCount } = cycle
    // 合計 0 のサイクル行は「授乳していない行」ゆえサーバ検証と DB CHECK
    // chk_breast_counts_required に弾かれる。往復ぶんの通信を待たせず手前で止める
    // （手動入力のステッパーを両方 0 にできるのが唯一の入口。サーバ側と二重防御）。
    if (leftCount + rightCount < 1) {
      toast.error("左右の回数は合計1回以上にしてください")
      return
    }
    const clientId = clientIdRef.current ?? newClientId()
    clientIdRef.current = clientId
    const payload: PersistedFeedingPayload = {
      feedingType: "breast",
      breastLeftCount: leftCount,
      breastRightCount: rightCount,
      // 開始側。タイマーはタップした側で確定、旧形式復元は推定（不能なら null = 不明）。
      breastStartSide: toDbStartSide(cycle.startSide),
      // sides あり → 合計はサーバ導出（durationSec の同時指定はサーバが拒否する契約）。
      // sides なし（sidesUnknown）→ 従来どおり合計のみ
      ...(sides
        ? { breastLeftSec: sides.leftSec, breastRightSec: sides.rightSec }
        : { durationSec: params.durationSec ?? 0 }),
      // 時刻が無いことも固定する（再送で後から時刻を足さぬ。PersistedFeedingPayload の注記）
      ...(loggedAt !== undefined ? { loggedAt } : {}),
      clientId,
    }
    await sendSubmission({
      firstAttemptAt: new Date().toISOString(),
      phase: "sending",
      payload,
    })
  }

  /** 固定した送信内容を送る（初回も再送も同じ経路）。 */
  async function sendSubmission(base: PersistedFeedingSubmission) {
    if (!activeRef.current || isSavingRef.current || !startedAt) return
    isSavingRef.current = true
    setIsSaving(true)
    setLookup("idle")
    // 初めての送信は saveFeeding が sending で渡す。それ以外（unknown・conflict・再読込で戻した
    // もの）は、先の送信が保存されておりうる操作の送り直し
    const mayHaveLanded = base.phase !== "sending"
    const sending: PersistedFeedingSubmission = { ...base, phase: "sending" }
    setSubmission(sending)
    // 送る前に端末へ残す（送信中に閉じた・落ちた時も、再読込の後に同じ内容で照合できる）
    persist(startedAt, cycle)

    let result: Awaited<ReturnType<typeof recordFeeding>>
    try {
      result = await recordFeeding(sending.payload)
    } catch (err) {
      // 持ち主が替わった後の応答で、新しい持ち主の計測や表示へ触れぬ。
      if (!activeRef.current) return
      // 通信断・応答の喪失で reject する。届かなかったのか、保存の後で応答だけが失われたのかは
      // 区別できぬ（reject ＝ 未到達と決めつけぬ）。固定した内容のまま結果不明として残す
      console.error("[feeding-timer] recordFeeding が例外を投げました", {
        message: err instanceof Error ? err.message : String(err),
        clientId: sending.payload.clientId,
      })
      // 照合で確定済み・破棄済みなら、遅れて届いた失敗で「確認中」を蘇らせぬ
      if (submissionRef.current?.payload.clientId !== sending.payload.clientId) return
      markSubmission({ ...sending, phase: "unknown" })
      // デプロイを跨いだ古い画面（action が見つからぬ）。送り直しても同じ失敗ゆえ、読み直しを案内する。
      // 送信内容は端末に残っており、読み直した新しい画面から同じ内容で照合・送り直しできる
      toast.error(noteServerActionFailure(err) ? STALE_CLIENT_ACTION_MESSAGE : SAVE_UNKNOWN_MESSAGE)
      return
    } finally {
      // throw / 正常のいずれの経路でも必ず解除する（永久 disabled の防止）。
      // recordFeeding は redirect しないため finally で戻して問題ない。
      isSavingRef.current = false
      if (activeRef.current) setIsSaving(false)
    }

    if (!activeRef.current) return
    if (result.error !== null) {
      if (submissionRef.current?.payload.clientId !== sending.payload.clientId) return
      const phase = phaseAfterFailure({ thrown: false, failure: result.failure })
      if (phase === "rejected" && mayHaveLanded) {
        // この送り直しが拒まれた（ログイン切れ・一時的な失敗等）ことは、先の結果不明の送信が保存
        // されておらぬことを意味せぬ。固定した内容を捨てると、次の押下が時刻・秒数を作り直し、
        // 破棄の文言が「記録していません」と偽る（独立レビュー 2026-10-28 v7 F1。クイック記録・
        // 記録シート・確認中の記録と同じ規則）。結果不明のまま残し、理由と確かめ方を伝える
        markSubmission({ ...sending, phase: "unknown" })
        toast.error(`${result.error}（前の送信が保存されたかは「記録されたか確かめる」で確かめられます）`)
        return
      }
      if (phase === "rejected") {
        // 保存の前に拒まれた（検証・認証）。行は無いゆえ、入力へ戻して直せるようにする。
        // id はこの計測のまま（同じ計測の記録ゆえ）。有効な保存操作ではなかったゆえ、
        // 持ち越した時刻も捨て、次の押下の時刻を開始時刻にする
        keptOriginRef.current = null
        markSubmission(null)
        toast.error(result.error)
        return
      }
      if (phase === "conflict" && result.conflict?.current) {
        // 同じ id で別の内容が先に記録済み（古い版の画面からの送信など）。記録は既に在る
        setConflictLog(result.conflict.current)
      }
      markSubmission({ ...sending, phase })
      toast.error(phase === "conflict" ? SAVE_CONFLICT_MESSAGE : result.error)
      return
    }

    // 確定行はサーバが返す（insertBabyLog の log）。行を持たぬ応答（古い形）だけは、送った内容と
    // サーバの返した時刻・版で組む — 送った値は DB に書かれた値そのもので、手元の時計ではない。
    // 時刻をどちらも持たぬ（受信時刻で記録した送信への古い形の応答）なら、手元の時計で行を組まず
    // 照合の読みで DB の行を取りに行く
    const knownLoggedAt = result.loggedAt ?? sending.payload.loggedAt
    if (!result.log && knownLoggedAt === undefined) {
      await checkSubmission(sending)
      return
    }
    finishRecorded(
      result.log ??
        buildOptimisticLog({
          id: result.id,
          updatedAt: result.updatedAt ?? null,
          logType: "feeding",
          loggedBy: userId,
          feedingType: "breast",
          breastLeftCount: sending.payload.breastLeftCount,
          breastRightCount: sending.payload.breastRightCount,
          breastLeftSec: sending.payload.breastLeftSec ?? null,
          breastRightSec: sending.payload.breastRightSec ?? null,
          breastStartSide: sending.payload.breastStartSide,
          durationSec:
            sending.payload.breastLeftSec !== undefined && sending.payload.breastRightSec !== undefined
              ? sending.payload.breastLeftSec + sending.payload.breastRightSec
              : sending.payload.durationSec ?? 0,
          loggedAt: knownLoggedAt,
        }),
      sending.payload,
    )
  }

  /** 送信内容の状態を画面と端末保存の両方へ反映する。 */
  function markSubmission(next: PersistedFeedingSubmission | null) {
    setSubmission(next)
    if (startedAtRef.current && cycleRef.current) persist(startedAtRef.current, cycleRef.current)
  }

  /**
   * 「記録されたか確かめる」— DB に同じ id の行が在るかを読むだけ（送り直さぬ）。
   * 在ればサーバの確定行で記録済みとして終える。見つからぬのは「まだ」かもしれぬ（応答の失われた
   * 要求が処理中でありうる）ゆえ、保存されなかったとは断定せず、同じ内容での送り直しを勧める。
   */
  async function checkSubmission(
    target: PersistedFeedingSubmission,
    opts: { auto: boolean } = { auto: false },
  ) {
    if (!activeRef.current) return
    // 送信中でも照合はできる（GET は Server Action の直列送信の列に並ばぬ）。応答の返らぬ送信の
    // 結果を、利用者が待たずに確かめられるように
    lookupAbortRef.current?.abort()
    const controller = new AbortController()
    lookupAbortRef.current = controller
    setLookup("checking")
    const outcome = await lookupBabyLogs([target.payload.clientId], { signal: controller.signal })
    if (lookupAbortRef.current === controller) lookupAbortRef.current = null
    if (!activeRef.current || outcome.status === "cancelled") return
    // 照合の間に確定・破棄されておれば、その結果を優先する
    if (submissionRef.current?.payload.clientId !== target.payload.clientId) return
    if (outcome.status === "found") {
      const found = outcome.logs.find((l) => l.id === target.payload.clientId)
      if (found) {
        finishRecorded(found, target.payload, { reconciled: true })
        return
      }
    }
    if (outcome.status === "notFound") {
      setLookup("notFound")
      return
    }
    setLookup("error")
    if (!opts.auto) {
      toast.error(
        outcome.status === "auth"
          ? "ログインの有効期限が切れています。ログインし直してから確かめてください（送った内容はこの端末に残っています）"
          : outcome.status === "timeout"
            ? "記録を確かめる応答がありませんでした。通信状況を確認してもう一度お試しください。"
            : "記録を確かめられませんでした。通信状況を確認してください。",
      )
    }
  }

  /**
   * 記録の確定（新規・再送の吸収・照合で見つかった）。成功の表示はサーバの確定行（id・logged_at・
   * updated_at）で組み、手元の時計や入力中の値で架空の成功行を作らぬ。
   */
  function finishRecorded(
    log: BabyLogData,
    payload: PersistedFeedingPayload,
    opts: { reconciled?: boolean } = {},
  ) {
    // 照合と送り直しが並んで届いた・閉じた後に遅れて届いた応答は、二度目を捨てる
    // （確定は 1 回だけ。成功の知らせと閉じる操作を二重にせぬ）
    if (submissionRef.current?.payload.clientId !== payload.clientId) return
    // 深夜跨ぎ: logged_at が開始時刻になったため、日付が変わってから停止すると
    // 前日の行が生まれる（停め忘れなら 2 日以上前の行も）。どの配列へ入れるかは親の
    // appendLog が行の日付で決める（選択日の logs・週窓・成長・最終授乳の fallback）ゆえ、
    // ここでは日付で分岐せず常に渡す。トーストだけは「どの日の記録として保存したか」を
    // 明示する（無言だと「記録されていない」と誤解して再タップし、二重記録になる）。
    onLogRecorded?.(log)

    clearPersistedTimer()
    clientIdRef.current = null
    keptOriginRef.current = null
    setSubmission(null)
    setConflictLog(null)
    setLookup("idle")
    setStartedAt(null)
    setStale(false)

    const logDate = toJstDateString(log.logged_at)
    const today = todayJstString()
    const isSameJstDay = logDate === today
    // 内訳（左から・左2・右1）と時間を添えて「何が記録されたか」を確認できるようにする。
    // 表示は DB の行から組む（送った内容と同じはずだが、確定値を正とする）
    const leftCount = log.breast_left_count ?? payload.breastLeftCount
    const rightCount = log.breast_right_count ?? payload.breastRightCount
    const breakdown =
      log.breast_left_sec != null && log.breast_right_sec != null
        ? formatBreastSideBreakdown(
            leftCount,
            rightCount,
            log.breast_left_sec,
            log.breast_right_sec,
          )
        : [formatBreastCounts(leftCount, rightCount), formatDurationSec(log.duration_sec ?? 0)]
            .filter(Boolean)
            .join("・")
    const startLabel =
      log.breast_start_side === "left"
        ? "左から"
        : log.breast_start_side === "right"
          ? "右から"
          : ""
    const detail = [startLabel, breakdown].filter(Boolean).join("・")
    // 前日なら「前日」、それより前（停め忘れ）は「M/D」で示す（2 日前の行を「前日」と
    // 偽らぬ。P3-8）
    const [, m, d] = logDate.split("-")
    const dayLabel =
      logDate === shiftYmd(today, -1) ? "前日" : `${Number(m)}/${Number(d)}`
    const head = opts.reconciled ? "授乳は記録済みでした" : "授乳を記録しました"
    // 押した時刻を推定できず、サーバの受信時刻で記録した時は、その時刻と直し方を伝える
    // （「押した時刻」とは偽らぬ。N3: 圏外・時計の変更・スリープの後・初回が届かなかった送り直し）
    const receiptNote =
      payload.loggedAt === undefined
        ? `。開始時刻は記録が届いた時刻（${formatTimeJst(log.logged_at)}）です。違う時は記録を開いて直せます`
        : ""
    toast.success(
      isSameJstDay
        ? `${head}（${detail}）${receiptNote}`
        : `${head}（${detail}／${dayLabel}の記録として保存）${receiptNote}`,
    )
    onOpenChange(false)
  }

  /**
   * 照合で見つからなんだ後に、利用者が内容を直すと決めた（AC05: 確認後の明確な意図）。
   * id はこの計測のまま — 先の要求が遅れて保存されておれば、直した内容の送信はサーバに
   * 「別の内容で記録済み」と止められ、二重記録にはならぬ。
   */
  function handleEditAfterNotFound() {
    // 直すのは内容だけ。開始時刻（または「時刻を送らぬ」こと）は最初の押下のまま持ち越す —
    // 同じ id の同じ計測ゆえ、直した後の押下の時刻で作り直すと、押した時刻を黙って後ろへずらす
    // （独立レビュー 2026-10-28 v7 N3-02）
    const frozen = submissionRef.current
    if (frozen) {
      keptOriginRef.current = {
        clientId: frozen.payload.clientId,
        loggedAt: frozen.payload.loggedAt,
      }
    }
    markSubmission(null)
    setLookup("idle")
  }

  function handleStop() {
    // startedAt が無いのは「記録成功 → 親が閉じるまで」の一瞬だけ。開始時刻が
    // 無いまま now を代用すると logged_at の意味（開始時刻）が壊れるため記録しない。
    if (!startedAt) return
    // 結果の分からぬ送信が在れば、経過を計り直さず固定した内容を送り直す（A2）
    if (submissionRef.current) {
      void sendSubmission(submissionRef.current)
      return
    }
    // 停め忘れはタイマーの経過で記録しない（手動入力に限る。画面でも停止は出さぬ）
    if (stale) return
    // 開いたまま（wake lock で画面が点いたまま）上限を超えた計測も同じ扱い: 膨らんだ
    // 時間で記録せず、開始時刻を保って手動入力へ回す（判定は開いた時だけでなく停止時にも。
    // レビュー P3-6）
    if (isTimerStale(startedAt.toISOString(), Date.now())) {
      setStale(true)
      setMode("manual")
      setManualLeftMin(0)
      setManualRightMin(0)
      toast.error(
        "計測が 2 時間を超えています。授乳時間を入力して記録してください",
      )
      return
    }
    // 開始時刻は端末の時計で測ってある。停めた時のサーバ時刻のサンプルで、端末の時計のずれ分だけ
    // サーバの時計へ写して送る（独立レビュー v7 N3-01: 進んだ端末で 5 分未満の計測を停めると「未来の
    // 時刻」で拒まれ、遅れた端末は黙って早い時刻で残った）。± に同じく効き（対称）、誤差は往復の
    // 半分＋許す時計の食い違い 2 秒以内（有界）。写せぬ時（サンプル無し・時計の変更・スリープ）は従来
    // どおり端末の時刻を送る。
    // 授乳時間（経過）は端末の時計の差ゆえ、ずれの影響を受けぬ。送信内容は固定され、送り直しでは
    // 写し直さぬ（saveFeeding）。停め忘れ（手動入力で開始時刻を保つ）は、画面が端末の時刻で
    // 「HH:mm のまま保存します」と約束しておるゆえ写さぬ（handleManualRecord）
    // 照合で見つからず内容を直した後の停止は、最初の停止で送った開始時刻を持ち越す（同じ id の同じ計測。
    // 写し直すと、直す間に時計が変わった・サンプルが古くなった時に別の時刻へずれる。v8rc2 INFO・N3-02）
    const kept =
      keptOriginRef.current && keptOriginRef.current.clientId === clientIdRef.current
        ? keptOriginRef.current
        : null
    // 持ち越すのは「時刻を送らぬ」ことも含む（`??` で写し直さぬ。handleManualRecord と同じ凍結の規則）
    const loggedAt = kept ? kept.loggedAt : (toServerIso(startedAt) ?? startedAt.toISOString())
    if (cycle.sidesUnknown) {
      // 旧形式から復元したサイクル: 配分は復元不能ゆえ合計のみで保存（従来形）
      void saveFeeding({
        durationSec: clampFeedingDurationSec(elapsedSeconds),
        loggedAt,
      })
      return
    }
    // 現在側の走行分を banking してから左右別に正規化する。
    // **合計を clamp してはならない**（duration_sec は左右の和で導出される —
    // resolveBreastSideSeconds の docstring 参照。合計 clamp は等式 CHECK と衝突し
    // 記録が恒久失敗する）。上限超過は resolve が側ごとに比例縮小する。
    const banked = elapsedSinceSideStart(cycle.sideSince)
    const sides = resolveBreastSideSeconds(
      cycle.leftSec + (cycle.side === "breast_left" ? banked : 0),
      cycle.rightSec + (cycle.side === "breast_right" ? banked : 0),
      cycle.side,
    )
    void saveFeeding({ sides, loggedAt })
  }

  function handleManualRecord() {
    // 結果の分からぬ送信が在れば、押下時刻を作り直さず固定した内容を送り直す（A2）
    if (submissionRef.current) {
      void sendSubmission(submissionRef.current)
      return
    }
    const leftTotal = manualLeftMin * 60 + manualLeftSec
    const rightTotal = manualRightMin * 60 + manualRightSec
    // resolve 前の生値で 0 を弾く（resolveBreastSideSeconds は 0 を 1 秒へ持ち上げる
    // 救済を持つため、後に判定すると「時間未選択」を無音で 1 秒として記録してしまう）
    if (leftTotal + rightTotal <= 0) {
      toast.error("授乳時間を選んでください")
      return
    }
    const sides = resolveBreastSideSeconds(leftTotal, rightTotal, cycle.side)
    // 手動入力の logged_at（サイクル開始時刻）は「記録する」を押した時刻そのもの。
    // 授乳時間ぶん遡らせない（押した時刻がそのまま開始時刻として残る、という利用者の要望）。
    // シートを開いた時刻（startedAt）でもない — 入力に手間取るほど押下時刻からずれる。
    // 停め忘れの復元では本当の開始時刻（端末保存の startedAt）を保つ — 押下時刻にすると
    // 数時間前の授乳が今の時刻に化け、最終授乳・目安の起点が嘘になる。
    //
    // 押した時刻は**端末の時計で作らぬ**（2026-10-28 N3）: 進んだ時計は「未来の時刻」で拒まれ、
    // 遅れた時計は黙って誤った時刻で残る。サーバの時刻のサンプルと経過の時計で推定し
    // （`@/lib/domain/server-clock`）、推定できねば時刻を送らずサーバの受信時刻で記録する。
    // どちらでも送信内容として固定し、送り直しでは作り直さぬ（saveFeeding の注記）。
    // 照合で見つからず内容を直した後の押下は、最初の押下の時刻を持ち越す（handleEditAfterNotFound）
    const kept =
      keptOriginRef.current && keptOriginRef.current.clientId === clientIdRef.current
        ? keptOriginRef.current
        : null
    const loggedAt =
      stale && startedAt
        ? startedAt.toISOString()
        : kept
          ? kept.loggedAt
          : (serverNowIso() ?? undefined)
    void saveFeeding({ sides, loggedAt })
  }

  /**
   * 「キャンセル（記録しない）」の 1 段目。計測中は確認を挟む（P1-05）— 破棄は
   * 開始時刻・左右の回数・左右の秒数をすべて失い、復元する手段が無い。
   * 計測していなければ失うものが無いゆえそのまま閉じる。
   */
  function handleCancelRequest() {
    if (!startedAt) {
      onOpenChange(false)
      return
    }
    setConfirmingDiscard(true)
  }

  /** 計測を記録せずに捨てて閉じる（確認済みの破棄と、誤って開いた直後の取り消し）。 */
  function discardTimer(message: string) {
    clearPersistedTimer()
    clientIdRef.current = null
    keptOriginRef.current = null
    setSubmission(null)
    setConflictLog(null)
    setLookup("idle")
    setStartedAt(null)
    setStale(false)
    setConfirmingDiscard(false)
    toast.success(message)
    onOpenChange(false)
  }

  /** 確認を経た明示の破棄。計測を捨てる唯一の経路（誤って開いた直後の取り消しを除く）。 */
  function handleConfirmDiscard() {
    // 送った後の破棄は「記録していない」と言えぬ（応答の失われた保存が成立しておりうる）
    discardTimer(
      submissionRef.current
        ? "授乳の計測を閉じました。記録されているかはタイムラインで確かめてください"
        : "授乳の計測を破棄しました（記録していません）",
    )
  }

  /** 同じ id で別の内容が記録済みだった: 記録は既に在るゆえ、その確定行で終える。 */
  function handleFinishWithStored() {
    const pending = submissionRef.current
    if (!pending) return
    if (conflictLog) {
      finishRecorded(conflictLog, pending.payload, { reconciled: true })
      return
    }
    // 再読込の後は確定行を持たぬ。読み直して終える
    void checkSubmission(pending)
  }

  /**
   * Base UI からの開閉要求（Esc・暗幕・×・Android の戻る）。
   *
   * 計測中に閉じても**計測は捨てぬ**（UX-04a）: 端末保存はそのまま残り、ダッシュボードの
   * 「授乳を計測中」チップから戻れる。予定を見に行く・別の記録を付ける間も計測は続く。
   * 破棄は「キャンセル（記録しない）→ 破棄する」の明示の操作だけ（P1-05）。
   * 例外は、開いて 1 分未満かつ未操作の計測 — 誤って開いた 0 秒の計測がチップに居座らぬ
   * よう、閉じる操作で取り消す（ACCIDENTAL_OPEN_GRACE_MS。判定は押した時点の時刻）。
   * 記録成功と確認済みの破棄は親の onOpenChange を直接呼ぶため、この門は通らない。
   */
  function handleOpenChange(isOpen: boolean) {
    if (!isOpen && startedAt && !isSavingRef.current) {
      // 送った後は「誤って開いた直後」の取り消しをせぬ（記録が成立しておりうる操作を無言で捨てぬ）
      if (!submissionRef.current && isAccidentalOpen(startedAt, Date.now(), cycle)) {
        discardTimer("授乳の計測を取り消しました")
        return
      }
      toast.success(
        submissionRef.current
          ? "保存の確認は残っています。「授乳の保存を確認中」から戻れます"
          : stale
            ? "計測は残っています。「授乳の計測が残っています」から記録か破棄を選べます"
            : "計測は続いています。「授乳を計測中」から戻れます",
      )
    }
    onOpenChange(isOpen)
  }

  const countsLabel = formatBreastCounts(cycle.leftCount, cycle.rightCount)
  const staleStartLabel = startedAt ? formatTimeJst(startedAt.toISOString()) : ""
  const staleElapsedLabel = startedAt
    ? formatElapsedMinutes(Math.floor(elapsedSeconds / 60))
    : ""
  // 「閉じる」を押した時に何が起きるかを、押す前に釦の文言で示す（handleOpenChange と同じ
  // 判定）。開いて 1 分未満・未操作の計測は誤って開いたものとして取り消され、それ以外は
  // 端末に残ってチップから戻れる。表示と結果を食い違わせぬため、判定は同じ関数で行う
  const closeDiscardsTimer =
    !!startedAt && !submission && isAccidentalOpen(startedAt, now.getTime(), cycle)

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[85dvh] overflow-hidden rounded-t-2xl safe-bottom"
      >
        <SheetHeader className="pb-2">
          <SheetTitle>授乳を記録</SheetTitle>
          <SheetDescription>
            {submission
              ? "記録を送りました。保存できたかを確かめるまで、送った内容は変えられません"
              : stale
              ? "停め忘れた計測です。授乳にかかった時間と左右の回数を入れて記録するか、破棄してください"
              : mode === "timer"
                ? "吸わせる側を替えたら、その側を押してください。停止すると1回の授乳として記録します"
                : "左右の授乳時間と回数を選び、記録ボタンを押した時刻を開始時刻として保存します"}
          </SheetDescription>
        </SheetHeader>

        {/* 本文だけを縦スクロールにする（見出しは残す）。小型画面で記録・キャンセル・
            破棄の確認が下で切れて押せなくならぬよう、記録シート・日記シートと同じ型。 */}
        <div className="flex flex-col items-center gap-5 overflow-y-auto px-4 pt-2 pb-6">
          {/* 停め忘れの案内。黙って捨てず、本当の開始時刻を保ったまま記録か破棄を選ばせる */}
          {stale && startedAt && !submission && (
            <div
              role="status"
              className="flex w-full flex-col gap-1 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm"
            >
              <p className="flex items-start gap-2 font-medium text-amber-800 dark:text-amber-200">
                <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                {staleStartLabel} に始めた計測が残っています（{staleElapsedLabel}前）
              </p>
              <p className="text-xs text-muted-foreground">
                開始時刻は {staleStartLabel} のまま保存します。経過時間は授乳時間として使いません。
              </p>
              {/* 2026-10-28 製品判断: 停め忘れの開始時刻は推し量って書き換えぬ（開始の時のサーバ時刻の
                  手がかりが無い）。今のサンプルが端末の時計のずれを示す時だけ、その時刻が端末の時計に
                  よるものでずれておりうることと、保存の後に直せることを伝える */}
              {deviceSkewMs !== null && (
                <p className="text-xs text-amber-800 dark:text-amber-200">
                  この端末の時計は約{Math.max(1, Math.round(Math.abs(deviceSkewMs) / 60_000))}分
                  {deviceSkewMs > 0 ? "進んで" : "遅れて"}います。開始時刻 {staleStartLabel}
                  はこの端末の時計で測ったため、実際とずれている可能性があります。記録した後、タイムラインの記録を開いて開始時刻を直せます。
                </p>
              )}
            </div>
          )}

          {/* 入力方式の切替（タイマー / 手動）。停め忘れは手動入力のみ。
              左右の釦（橙の塗り）と見間違えぬよう、控えめなタブの見た目にする — 以前は同じ
              セグメントが縦に 2 段並び、活性の橙が 2 つ見えて「どちらが吸わせ中の側か」を
              夜間に読み違えうった */}
          {!stale && !submission && (
            <div
              role="group"
              aria-label="入力方法"
              className="flex w-full gap-1 rounded-xl bg-muted p-1"
            >
              {(["timer", "manual"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  onClick={() => setMode(m)}
                  className={`min-h-11 flex-1 rounded-lg text-sm font-medium transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                    mode === m
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {m === "timer" ? "タイマー" : "手動入力"}
                </button>
              ))}
            </div>
          )}

          {submission ? (
            // 記録を押した後、結果が確かめられておらぬ（A2）。入力は出さず、固定した送信内容と
            // 次の操作だけを見せる — 直した値を同じ id で送るとサーバに拒まれ、新しい id で
            // 送ると本当の二重記録になるゆえ、確かめるまで内容は変えさせぬ（AC05）
            <>
              <div
                role="status"
                className="flex w-full flex-col gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-sm"
              >
                <p className="flex items-start gap-2 font-medium text-amber-800 dark:text-amber-200">
                  <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                  {submission.phase === "sending"
                    ? slowSend
                      ? "応答を待っています。保存できたかは下の「記録されたか確かめる」で確かめられます。"
                      : "記録を送っています"
                    : submission.phase === "conflict"
                      ? SAVE_CONFLICT_MESSAGE
                      : SAVE_UNKNOWN_MESSAGE}
                </p>
                <p className="text-xs text-muted-foreground">
                  送った内容: {describeSubmission(submission.payload)}
                </p>
                {lookup === "checking" && (
                  <p className="text-xs text-muted-foreground">記録を確かめています</p>
                )}
                {lookup === "notFound" && (
                  <p className="text-xs text-muted-foreground">
                    まだ記録は見つかりません。同じ内容でもう一度送っても二重にはなりません。内容を直して記録することもできます。
                  </p>
                )}
                {lookup === "error" && (
                  <p className="text-xs text-muted-foreground">
                    記録を確かめられませんでした。通信状況を確認してください。
                  </p>
                )}
              </div>
              {submission.phase === "conflict" ? (
                <Button
                  onClick={handleFinishWithStored}
                  disabled={isSaving || lookup === "checking"}
                  size="lg"
                  className="min-h-14 w-full rounded-2xl text-lg font-semibold"
                >
                  <Check size={20} />
                  記録済みの内容で閉じる
                </Button>
              ) : (
                <div className="flex w-full flex-col gap-2">
                  <Button
                    onClick={() => void sendSubmission(submission)}
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
                      SAVE_RESEND_LABEL
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void checkSubmission(submission)}
                    // 送信中でも、応答が遅い時は照合（GET）を先に使える
                    disabled={(isSaving && !slowSend) || lookup === "checking"}
                    className="min-h-11 w-full rounded-xl"
                  >
                    記録されたか確かめる
                  </Button>
                  {lookup === "notFound" && (
                    <Button
                      variant="ghost"
                      onClick={handleEditAfterNotFound}
                      disabled={isSaving}
                      className="min-h-11 w-full rounded-xl"
                    >
                      内容を直して記録し直す
                    </Button>
                  )}
                </div>
              )}
            </>
          ) : mode === "timer" ? (
            <>
              {/* 経過時間（合計）。最も大きく出す */}
              <div className="flex flex-col items-center">
                <span className="text-sm text-muted-foreground">
                  {cycle.startSide === "breast_left"
                    ? "左から開始・合計"
                    : cycle.startSide === "breast_right"
                      ? "右から開始・合計"
                      : "合計"}
                </span>
                <div className="font-mono text-6xl font-bold tabular-nums tracking-tight">
                  {formatTimer(elapsedSeconds)}
                </div>
              </div>

              {/* 吸わせている側。左右を大きな 2 枚に分け、今の側を塗りと「吸わせ中」の語の
                  両方で示す（色だけに頼らぬ）。反対側をタップすると stint が +1 される。
                  名前は「左」「右」（テスト・支援技術が引く名前）で、状態は aria-pressed */}
              <div className="grid w-full grid-cols-2 gap-3">
                {(["breast_left", "breast_right"] as const).map((side) => {
                  const active = cycle.side === side
                  const label = side === "breast_left" ? "左" : "右"
                  const count = side === "breast_left" ? cycle.leftCount : cycle.rightCount
                  const sec = side === "breast_left" ? leftDisplaySec : rightDisplaySec
                  return (
                    <button
                      key={side}
                      type="button"
                      aria-label={label}
                      // 名前は「左」「右」のまま、側ごとの回数・時間は説明として読ませる
                      aria-describedby={`timer-side-${side}-detail`}
                      aria-pressed={active}
                      onClick={() => handleSideTap(side)}
                      disabled={isSaving}
                      // 活性は太い橙の枠 + 淡い橙の面 + 「吸わせ中」の語。白文字×橙の塗りは
                      // 小さな文字で 3.45:1 しか出ず（axe 実測）、夜間に読みにくいゆえ使わぬ
                      className={`flex min-h-28 flex-col items-center justify-center gap-1 rounded-2xl px-2 py-3 text-foreground transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 ${
                        active
                          ? "border-4 border-primary bg-primary/15 dark:bg-primary/25"
                          : "border-2 border-border bg-muted/40 hover:bg-muted active:bg-muted"
                      }`}
                    >
                      <span className="text-3xl font-bold leading-none">{label}</span>
                      <span
                        className={`flex items-center gap-1 text-sm ${
                          active ? "font-bold" : "font-medium text-muted-foreground"
                        }`}
                      >
                        {active && (
                          <span
                            className="size-2.5 rounded-full bg-primary"
                            aria-hidden="true"
                          />
                        )}
                        {active ? "吸わせ中" : "押して切り替え"}
                      </span>
                      {/* 側ごとの回数と時間（sidesUnknown は配分を持たぬゆえ回数のみ） */}
                      <span
                        id={`timer-side-${side}-detail`}
                        className="font-mono text-base font-semibold tabular-nums"
                      >
                        {cycle.sidesUnknown
                          ? `${count}回`
                          : `${count}回 ${formatTimer(sec)}`}
                      </span>
                    </button>
                  )
                })}
              </div>

              {/* 停止すると記録される内容（左右の回数と時間）。押す前に確かめられるように */}
              <div className="flex flex-col items-center gap-0.5">
                <span className="text-sm text-muted-foreground">記録される内容</span>
                {/* 手動入力で両側 0 にしてから timer へ戻ると空になるため 0回 と出す
                    （反対側をタップすればその側が 1 になり復帰できる）。
                    sidesUnknown（旧形式復元）は配分を持たないため回数のみ。 */}
                <span className="text-base font-semibold tabular-nums">
                  {cycle.sidesUnknown
                    ? countsLabel || "0回"
                    : `左${cycle.leftCount}回 ${formatTimer(leftDisplaySec)}・右${cycle.rightCount}回 ${formatTimer(rightDisplaySec)}`}
                </span>
              </div>

              {/* 停止ボタン */}
              <Button
                onClick={handleStop}
                disabled={isSaving}
                size="lg"
                className="min-h-16 w-full rounded-2xl text-lg font-semibold"
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
              {/* 開始側（タップした側が既定）。手動入力は順序を自動で知り得ぬためここで選ぶ */}
              <div className="flex w-full flex-col gap-1">
                <span className="px-1 text-xs font-medium text-muted-foreground">
                  開始側
                </span>
                <div className="flex w-full gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleStartSideChange("breast_left")}
                    disabled={isSaving}
                    className={segmentCn(cycle.startSide === "breast_left")}
                  >
                    左から
                  </button>
                  <button
                    type="button"
                    onClick={() => handleStartSideChange("breast_right")}
                    disabled={isSaving}
                    className={segmentCn(cycle.startSide === "breast_right")}
                  >
                    右から
                  </button>
                </div>
              </div>

              {/* 左右の回数（ステッパー） */}
              <div className="flex w-full gap-3">
                <BreastCountStepper
                  label="左"
                  value={cycle.leftCount}
                  disabled={isSaving}
                  onStep={(delta) => handleCountChange("breast_left", delta)}
                />
                <BreastCountStepper
                  label="右"
                  value={cycle.rightCount}
                  disabled={isSaving}
                  onStep={(delta) => handleCountChange("breast_right", delta)}
                />
              </div>

              {/* 左右それぞれの分・秒ピッカー（各 0〜60 分）。回数と同じく
                  左右で別々に記録する（duration_sec はサーバが左右の和から導出） */}
              <div className="flex w-full flex-col items-center gap-3">
                <ManualSidePicker
                  label="左"
                  idPrefix="manual-left"
                  min={manualLeftMin}
                  sec={manualLeftSec}
                  onMinChange={setManualLeftMin}
                  onSecChange={setManualLeftSec}
                  disabled={isSaving}
                />
                <ManualSidePicker
                  label="右"
                  idPrefix="manual-right"
                  min={manualRightMin}
                  sec={manualRightSec}
                  onMinChange={setManualRightMin}
                  onSecChange={setManualRightSec}
                  disabled={isSaving}
                />
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

          {confirmingDiscard ? (
            // 2 段階の確認は編集シートの「この記録を削除 → 削除する」と同じ部品・配色で組む
            <div
              role="group"
              aria-label="記録せずに破棄するかの確認"
              className="flex w-full flex-col gap-2 border-t pt-3"
            >
              <p className="text-sm text-destructive">
                {submission
                  ? "この計測を閉じますか？送った記録が保存されている場合、記録は消えません（タイムラインで確かめてください）。送り直しはできなくなります。"
                  : "この授乳を記録せずに破棄しますか？開始時刻・左右の回数と時間は元に戻せません。"}
              </p>
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmingDiscard(false)}
                >
                  計測を続ける
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={handleConfirmDiscard}
                  disabled={isSaving}
                >
                  破棄する
                </Button>
              </div>
            </div>
          ) : (
            // 主操作（停止・記録）から間を空けた副操作の段。閉じる（計測は端末に残る）と
            // 破棄（確認を経る）を並べ、どちらが計測を消すのかを文言で分ける
            <div className="flex w-full flex-col items-stretch gap-2 border-t pt-4">
              {startedAt && (
                <button
                  type="button"
                  onClick={() => handleOpenChange(false)}
                  disabled={isSaving}
                  className="min-h-11 rounded-xl border px-4 text-sm font-medium text-foreground transition-colors duration-200 hover:bg-muted active:bg-muted disabled:opacity-50"
                >
                  {closeDiscardsTimer
                    ? "閉じる（開いたばかりの計測は取り消し）"
                    : submission
                      ? "閉じる（保存の確認は残ります）"
                      : stale
                      ? "閉じる（計測は残ります）"
                      : "閉じる（計測は続きます）"}
                </button>
              )}
              <button
                type="button"
                onClick={handleCancelRequest}
                disabled={isSaving}
                className="min-h-11 px-4 text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground disabled:opacity-50"
              >
                キャンセル（記録しない）
              </button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}


/**
 * 手動入力モードの片側（左 or 右）の分・秒ピッカー。
 * ラベルは「左の分」等（sr-only）で支援技術とテストの両方から一意に引ける。
 * タッチターゲットは 44px 以上（min-h-11）。
 */
function ManualSidePicker({
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
  min: number
  sec: number
  onMinChange: (v: number) => void
  onSecChange: (v: number) => void
  disabled: boolean
}) {
  const selectCn =
    "min-h-11 rounded-lg border bg-background px-3 text-xl font-bold tabular-nums transition-colors duration-200 disabled:opacity-50"
  return (
    <div className="flex items-center justify-center gap-2">
      <span className="w-6 shrink-0 text-sm font-medium text-muted-foreground">
        {label}
      </span>
      <label htmlFor={`${idPrefix}-min`} className="sr-only">
        {label}の分
      </label>
      <select
        id={`${idPrefix}-min`}
        value={min}
        onChange={(e) => onMinChange(Number(e.target.value))}
        disabled={disabled}
        className={selectCn}
      >
        {MANUAL_MINUTE_OPTIONS.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <span className="text-xl font-bold text-muted-foreground">:</span>
      <label htmlFor={`${idPrefix}-sec`} className="sr-only">
        {label}の秒
      </label>
      <select
        id={`${idPrefix}-sec`}
        value={sec}
        onChange={(e) => onSecChange(Number(e.target.value))}
        disabled={disabled}
        className={selectCn}
      >
        {MANUAL_SECOND_OPTIONS.map((v) => (
          <option key={v} value={v}>
            {String(v).padStart(2, "0")}
          </option>
        ))}
      </select>
    </div>
  )
}

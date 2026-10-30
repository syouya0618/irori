"use client"

import { useChildScope } from "./child-scope"

import { useState, useEffect, useMemo, useCallback, useRef } from "react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { logRealtimeStatus, logRealtimeEvent } from "@/lib/supabase/realtime-log"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { BabyAgeHeader } from "./baby-age-header"
import { BabyDateNav } from "./baby-date-nav"
import { BabySummaryBar } from "./baby-summary-bar"
import { BabyQuickActions } from "./baby-quick-actions"
import { BabyPastDayActions } from "./baby-past-day-actions"
import { BabyTimeline } from "./baby-timeline"
import { BabyDailyDiary } from "./baby-daily-diary"
import { BabyDiaryEditSheet } from "./baby-diary-edit-sheet"
import { BabyLogFormSheet } from "./baby-log-form-sheet"
import { BabyTemperatureCard } from "./baby-temperature-card"
import { FeedingTimer, type RunningTimer } from "./feeding-timer"
import { RunningTimerChip } from "./running-timer-chip"
import { PendingSavesNotice } from "./pending-saves-notice"
import {
  isTimerStale,
  readPersistedTimer,
  summarizePersistedTimer,
} from "@/lib/domain/feeding-timer-storage"
import { BarChart3, Thermometer, TrendingUp } from "lucide-react"
import { BabyWeeklySummary } from "./weekly-summary/baby-weekly-summary"
import {
  GrowthChartSection,
  growthLatestSummary,
} from "./charts/growth-chart-section"
import {
  BabyCollapsibleSection,
  HomeFoldFrame,
  useHomeFolds,
} from "./baby-collapsible-section"
import {
  BabyFreshnessNotice,
  BabyHandoffSummary,
  BabyLastRecord,
} from "./baby-handoff-summary"
import { isDiaryDraftContent } from "./baby-diary-edit-sheet"
import { readDraft, type DraftOwner } from "@/lib/domain/draft-storage"
import {
  describeStale,
  freshnessClockNow,
  initialFreshness,
  markFreshness,
  staleRanges,
  type FreshnessRange,
  type HomeFreshness,
} from "@/lib/domain/freshness"
import {
  latestSeenMark,
  readLastSeen,
  summarizeHandoff,
  writeLastSeen,
} from "@/lib/domain/handoff"
import { UpcomingEventsCard } from "@/components/calendar/upcoming-events-card"
import type { CalendarEventRecord } from "@/components/calendar/use-month-events"
import { useNow } from "@/lib/hooks/use-now"
import { useVisibilityRefetch } from "@/lib/hooks/use-visibility-refetch"
import { useBottleDefault } from "@/lib/hooks/use-bottle-default"
import type { BottleDefaultState } from "@/lib/domain/bottle-default"
import {
  jstDayStartIso,
  todayJstString,
  toJstDateString,
  shiftYmd,
} from "@/lib/utils/date-jst"
import {
  selectBabyLogsOfDay,
  selectBabyLogsOfWeek,
  selectGrowthLogs,
  selectLastFeedingBefore,
  selectLastNursingBefore,
} from "@/lib/supabase/baby-log-queries"
import {
  AVERAGE_WINDOW_DAYS,
  WEEKLY_DISPLAY_DAYS,
  WEEKLY_FETCH_DAYS,
  averageBabyWeeklySummary,
  buildBabyWeeklySummary,
} from "@/lib/domain/baby-weekly-summary"
import {
  advanceFeedingFallback,
  deriveDashboardSummary,
  isOlderLogVersion,
  mergeDateNavLogs,
} from "@/lib/domain/baby-dashboard-summary"
import {
  summarizeTodayCounts,
  buildGrowthSeries,
  aggregateDiapers,
  sumDiaperBreakdown,
} from "@/lib/domain/baby-log-aggregation"
import { findLastNursing } from "@/lib/domain/baby-feeding-interval"
import {
  reconcileResyncedFallback,
  reconcileResyncedLogs,
} from "@/lib/domain/baby-log-resync"
import {
  recorderLabelFor,
  shouldShowRecorder,
  type HouseholdMember,
} from "@/lib/domain/recorder-label"
import type { BabyLogData, BabyDiaryData } from "@/lib/types/baby"
import type { BabyLogType, FeedingType } from "@/lib/types/database"

/** 再取得（P1-04）で取り直す行の窓。fallback 2 本は真偽値で別に持つ。 */
type ResyncWindow = "logs" | "weekly" | "growth"

/**
 * in-flight の再取得 1 世代ぶんの状態。`touched` は**取得開始後**に手元で触った id を
 * 窓ごとに持つ（appendLog / removeLog は logs しか触らぬため、窓を混ぜると取得結果に
 * 在る行を週窓から誤って落とす）。合流規則は reconcileResyncedLogs を参照。
 */
interface ResyncInFlight {
  generation: number
  controller: AbortController
  touched: Record<ResyncWindow, Set<string>>
  lastFeedingTouched: boolean
  lastNursingTouched: boolean
}

/**
 * 作成の応答の版（`created`）が、手元で消した行の版（`removed`）と同じか古いか。
 * そうなら、それは**消す前に送った作成の応答が遅れて着いたもの**で、行はもう DB に無い。
 *
 * 根拠: 作成系の insert は `updated_at` を書かず、DB の `DEFAULT now()`
 * （migration 20260410000001 の baby_logs.updated_at）に任せる（actions.ts の insert は
 * `.select("id, updated_at")` で版を受け取るだけ）。ゆえに消した後に同じ冪等 id で作り直された
 * 行は、必ず消した版より新しい版を持つ。
 *
 * 表記の文字列が一致すれば同じ版。表記が違えば時刻で比べる（Realtime と PostgREST で表記が
 * 揃わぬ場合の保険。同じミリ秒の作り直しは、削除と再試行の往復を挟むゆえ起こりえぬ）。
 * どちらかの版が無い・読めぬ時は判別できぬゆえ false（行を出す側に倒す — 本物の記録を
 * 画面から隠すと、利用者が押し直して二重に記録する。B-03 が防いでおる失敗そのもの）。
 */
function isStaleCreateOfRemoved(
  created: string | null | undefined,
  removed: string | null | undefined,
): boolean {
  if (!created || !removed) return false
  if (created === removed) return true
  const c = new Date(created).getTime()
  const r = new Date(removed).getTime()
  if (Number.isNaN(c) || Number.isNaN(r)) return false
  return c <= r
}

/**
 * Realtime の **INSERT** 通知の版（`incoming`）が、手元で消した行の版（`removed`）より厳密に新しいか。
 * INSERT の通知は作成時の版しか持たぬ。消した行そのものの INSERT は、画面が持っておった版（＝控えの版）
 * 以下ゆえ、新しい版の INSERT は同じ冪等 id で作り直された行じゃ。作成の応答が失われても、通知で行を
 * 出せる（隠すと押し直しで二重に記録される）。どちらかの版が無い・読めぬ時は false（従来どおり弾く）。
 * UPDATE の通知には使わぬ（Realtime の UPDATE 側の注記）。
 */
function isNewerThanRemoved(
  incoming: string | null | undefined,
  removed: string | null | undefined,
): boolean {
  if (!incoming || !removed || incoming === removed) return false
  const c = new Date(incoming).getTime()
  const r = new Date(removed).getTime()
  if (Number.isNaN(c) || Number.isNaN(r)) return false
  return c > r
}

/**
 * 自動の再取得の結果を反映してよいか（＝利用者の JWT で問い合わせられるか）を確かめる。
 *
 * access token が失効して refresh も失敗した間（圏外からの復帰・GoTrue の部分障害・
 * 他端末での global signOut）、auth-js は session: null を返し、supabase-js は anon キーで
 * PostgREST を叩く。RLS は error ではなく 0 行を返すため、それを真値として描くと記録・
 * 最終授乳・目安・日記が無音で消える。session が無ければ取得も反映もせず、構造化ログ
 * だけ残して現在の表示を保つ（次の visible / focus / SUBSCRIBED で取り直す）。
 * supabase-js がリクエストごとに積む token も同じ getSession() から来るため、判定がずれない。
 */
async function hasUsableSession(
  supabase: ReturnType<typeof createClient>,
  summary: string,
  context: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await supabase.auth.getSession()
  if (error) {
    logSupabaseError("baby", `${summary} skipped: session unavailable`, error, context)
    return false
  }
  if (!data.session) {
    console.warn(`[baby] ${summary} skipped: no session`, context)
    return false
  }
  return true
}

/** 手元の state を変える各所（setX の直前）から呼ぶ。in-flight が無ければ何もしない。 */
function markResyncTouched(
  inFlight: ResyncInFlight | null,
  window: ResyncWindow,
  id: string,
): void {
  inFlight?.touched[window].add(id)
}

interface BabyDashboardProps {
  initialLogs: BabyLogData[]
  initialWeeklyLogs: BabyLogData[]
  initialGrowthLogs: BabyLogData[]
  householdId: string
  userId: string
  initialDate: string
  /** 今日の育児日記（1日1本・無ければ null）。選択日変更時は refetch で入れ替える。 */
  initialDiary: BabyDiaryData | null
  /**
   * 今日より前の最後の授乳（批判レビュー P3）。深夜跨ぎサイクル（開始時刻が前日）は
   * 今日窓の logs に現れないため、当日に授乳が無い間の「最終授乳」表示を補完する。
   * isToday の時のみ使う（過去日のまとめへ漏らすと別日の時刻を表示してしまう）。
   */
  lastFeedingFallback: BabyLogData | null
  /**
   * 今日より前の最後の「授乳」（搾乳を除く）。次の授乳の目安の起点フォールバック。
   *
   * `lastFeedingFallback` と**別に持つ**理由: あちらは搾乳を含む（最終授乳表示の
   * 契約）ため、そのまま目安に流用すると「搾乳しただけで目安が飛ぶ」が残る。
   * 深夜跨ぎ（前日 23:00 授乳 → 翌 01:00 に閲覧）でも目安が消えないための経路。
   */
  lastNursingFallback: BabyLogData | null
  babyName: string | null
  babySex?: "male" | "female" | null
  babyBirthDate: string | null
  /** 授乳間隔（分）。次の授乳の目安の算出に使う（設定で変更可能） */
  feedingIntervalMin: number
  /**
   * いつものミルク量（サーバの初回描画が読んだ値）。クイック記録の「ミルク」の量。
   * 一度だけ seed し、以後は useBottleDefault が取り直す（未設定と取得失敗は区別する）。
   */
  initialBottleDefault: BottleDefaultState
  /**
   * 今日・明日に重なる予定（CAL-4「今日・明日の予定」カード）。起動時のページが
   * /baby になったため、旧 /meals から移設した。サーバ（baby/page.tsx）が
   * `calendar_events` を引いて渡す。省略時は空（カードは 0 件で何も描かない）。
   */
  initialUpcomingEvents?: CalendarEventRecord[]
  /**
   * 世帯員（id と表示名）。タイムラインの各行に記録者を添える（機能 A）。二人以上の
   * 世帯でだけ出す。省略・空なら出さぬ（取得失敗でも画面は成立する）。
   */
  members?: HouseholdMember[]
  /**
   * 初回描画（page.tsx）の取得の失敗（2026-10-27 C1）。page は失敗した結果を `[]` / null へ
   * 倒して渡すゆえ、旗が無いと「読み込めなかった」を「記録なし」「予定なし」と描いてしまう。
   */
  initialLoadErrors?: InitialLoadErrors
}

/** 初回描画の取得で失敗した範囲（page.tsx が渡す） */
export interface InitialLoadErrors {
  logs?: boolean
  weekly?: boolean
  growth?: boolean
  diary?: boolean
  upcoming?: boolean
}

export function BabyDashboard({
  initialLogs,
  initialWeeklyLogs,
  initialGrowthLogs,
  householdId,
  userId,
  initialDate,
  initialDiary,
  lastFeedingFallback,
  lastNursingFallback,
  babyName,
  babyBirthDate,
  babySex,
  feedingIntervalMin,
  initialBottleDefault,
  initialUpcomingEvents = [],
  members = [],
  initialLoadErrors = {},
}: BabyDashboardProps) {
  const childScope = useChildScope()
  const childId = childScope?.id
  // 端末に残すもの（下書き・面の開閉・前回の確認の印）の持ち主
  const owner = useMemo<DraftOwner>(() => ({ userId, householdId, ...(childScope && !childScope.isLegacy ? { childId } : {}) }), [userId, householdId, childId, childScope])
  const folds = useHomeFolds(owner)
  // 範囲ごとの最新の確認（C1）。初回描画の失敗は最初から「確認できません」
  // 時刻は応答を受け取った瞬間の端末の時計（freshness.ts の既定）。描画中には読まぬ
  const [freshness, setFreshness] = useState<HomeFreshness>(() =>
    initialFreshness({
      logs: initialLoadErrors.logs,
      weekly: initialLoadErrors.weekly,
      growth: initialLoadErrors.growth,
    }),
  )
  const markRange = useCallback((range: FreshnessRange, ok: boolean) => {
    // 取得の応答を受けた時（描画の外）に時計を読む
    const at = freshnessClockNow()
    setFreshness((prev) => markFreshness(prev, range, ok, at))
  }, [])
  // この画面で最後に記録が付いた行の id（C1「保存の後の確認」）。中身は logs の state から導く
  const [lastSavedId, setLastSavedId] = useState<string | null>(null)
  // いつものミルク量。日付を選び直しても（過去日はクイック記録を出さぬ）持ち続けるよう、
  // クイック記録ではなく常に居るダッシュボードが持つ
  const bottleDefault = useBottleDefault(householdId, initialBottleDefault, childId)
  // 記録者の表示（機能 A）。一人の世帯では null（出さぬ）。退出済みの id は「家族」。
  const recorderLabel = useMemo(() => {
    if (!shouldShowRecorder(members)) return null
    return (loggedBy: string) => recorderLabelFor(members, loggedBy)
  }, [members])
  const [logs, setLogs] = useState<BabyLogData[]>(initialLogs)
  const [weeklyLogs, setWeeklyLogs] =
    useState<BabyLogData[]>(initialWeeklyLogs)
  const [growthLogs, setGrowthLogs] =
    useState<BabyLogData[]>(initialGrowthLogs)
  const [selectedDate, setSelectedDate] = useState(initialDate)
  // 手元の logs が属する日（＝取得が済んだ日）。選択日と違う間は取得中か失敗中で、
  // タイムライン・まとめ・体温カードへは前の日の行を見せぬ（P2-10: 新しい日付の見出しの
  // 下に前の日の記録を混ぜない）。logs そのものは残す — in-flight 中に届いた Realtime の
  // 行を合流で守るため（mergeDateNavLogs）。
  // 初回描画の取得が失敗しておれば「取得済み」にせぬ（`[]` を「まだ記録がありません」と描かぬ）
  const [logsDate, setLogsDate] = useState(initialLoadErrors.logs ? "" : initialDate)
  // 日付ナビの取得が失敗した日。選択日と一致する間だけ失敗表示（再読み込みの導線つき）。
  const [logsFailedDate, setLogsFailedDate] = useState<string | null>(
    initialLoadErrors.logs ? initialDate : null,
  )
  // 「もう一度読み込む」。増やすと日付ナビの取得 effect が同じ日で再発火する。
  const [dateNavRetry, setDateNavRetry] = useState(0)
  // 選択日の育児日記（1日1本）。日付変更で refetch、保存/削除は編集シートから反映。
  // `diaryDate` は「この diary がどの日のものか」。logs の logsDate と同じ理由で持つ:
  // 日付を切り替えた直後の取得中に前の日の本文を新しい日の見出しの下に出すと、そのまま
  // 編集 → 保存で前の日の本文を新しい日の日記として書く経路になる（レビュー P2-4 / W-1）。
  const [diary, setDiary] = useState<BabyDiaryData | null>(initialDiary)
  // 初回描画で日記を読めなんだら「取得済み」にせぬ（「日記を書く」＝日記が無い、と言わぬ）
  const [diaryDate, setDiaryDate] = useState(initialLoadErrors.diary ? "" : initialDate)
  // 日記の取得に失敗した日（選択日と一致する間だけ失敗表示）
  const [diaryFailedDate, setDiaryFailedDate] = useState<string | null>(
    initialLoadErrors.diary ? initialDate : null,
  )
  const [diaryEditOpen, setDiaryEditOpen] = useState(false)
  const [diaryKey, setDiaryKey] = useState(0)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editingLog, setEditingLog] = useState<BabyLogData | null>(null)
  const [createLogType, setCreateLogType] = useState<BabyLogType | null>(null)
  // 搾乳など量ベースの授乳を create シートで開く際の初期授乳タイプ（B: 搾乳導線）
  const [createFeedingType, setCreateFeedingType] =
    useState<FeedingType | null>(null)
  // 「今回だけ別の量」で開いた記録シートの量の初期値（2026-10-27 C2）。世帯の設定とは別
  const [createAmountMl, setCreateAmountMl] = useState<number | null>(null)
  const [formKey, setFormKey] = useState(0)
  const [timerOpen, setTimerOpen] = useState(false)
  const [timerFeedingType, setTimerFeedingType] = useState<FeedingType>("breast_left")
  // 端末に残っている授乳の計測（UX-04a）。シートを閉じても計測は続くため、チップで
  // 戻る導線を出す。初期値はタイマー（FeedingTimer）が開いた時と、下の effect が
  // 端末保存を読んだ時に入る。
  const [runningTimer, setRunningTimer] = useState<RunningTimer | null>(null)
  // 「今日より前の最後の授乳」フォールバック（P3）。state 保持にするのは、深夜跨ぎ
  // サイクルの記録直後（timeline へは入場できない）に FeedingTimer からこの値を
  // 即時更新するため（さもなくばリロードまで最終授乳が旧値/「---」に留まる）。
  const [serverLastFeeding, setServerLastFeeding] =
    useState<BabyLogData | null>(lastFeedingFallback)
  // 「今日より前の最後の授乳（搾乳を除く）」フォールバック。次の授乳の目安の起点。
  // 上と同じ理由で state 保持（深夜跨ぎ記録直後にタイマーから即時更新するため）。
  const [serverLastNursing, setServerLastNursing] =
    useState<BabyLogData | null>(lastNursingFallback)
  const now = useNow(60_000)

  // タイマー（FeedingTimer）からの最新の報告。端末保存が効かぬ環境（容量不足・プライベート
  // モード）では保存が無くとも計測は手元で続いており、この報告だけが真値になる。
  const timerReportedRef = useRef<RunningTimer | null>(null)
  const handleRunningChange = useCallback((running: RunningTimer | null) => {
    timerReportedRef.current = running
    setRunningTimer(running)
  }, [])

  // 端末保存の計測を拾う（リロード・再起動後もチップを出す）。分ごとの時計で停め忘れの
  // 判定も更新する。タイマーが開いた後は onRunningChange が即時に上書きする。
  // 持ち主が違う保存は拾わぬ（タイマーを開いた時に捨てる。P3-08）。
  // 保存が無くてもタイマーの報告が残っておれば消さぬ（「閉じても計測は続きます」の文言
  // どおり。端末保存に失敗した環境でチップが 1 分で消える欠陥の修正。レビュー P3-7）。
  useEffect(() => {
    const fromStorage: RunningTimer | null = summarizePersistedTimer(
      readPersistedTimer(childScope?.isLegacy ? undefined : childId),
      { userId, householdId, ...(childScope && !childScope.isLegacy ? { childId } : {}) },
      now.getTime(),
    )
    const reported = timerReportedRef.current
    setRunningTimer(
      fromStorage ??
        (reported
          ? {
              ...reported,
              stale: !reported.pendingSave && isTimerStale(reported.startedAt, now.getTime()),
            }
          : null),
    )
  }, [userId, householdId, now, childId, childScope])

  // 「今日」は時計（now）から導く。引数なしの todayJstString() は React Compiler が
  // 依存の無い値とみなしてマウント時に一度だけ評価し凍結する（コンパイル出力で確認）—
  // PWA を開いたまま日を跨ぐと「今日」が前日のまま残り、新しい日の行を編集すると
  // 選択日に属さぬと判定されてタイムラインから消える。now をキーにすれば毎分追従する。
  // 回帰の番人: __tests__/today-clock-contract.test.ts（vitest は Compiler を通さぬ）
  const today = todayJstString(now)

  // 開いたまま日を跨いだ瞬間の調整（描画中の state 調整 — effect にすると isToday=false の
  // 中間状態が commit され、予定カード等が一瞬外れる）。
  // 1. 「今日」を見ておったなら選択日も新しい今日へ進める。過去日を見ておれば動かさぬ。
  //    記録シート・日記シートが開いておる間も動かさぬ — 周りの部品は「選択日が動くのは
  //    利用者が日付ナビを押した時だけ（＝シートは閉じておる）」を前提にしておる。開いた
  //    まま動かすと、日記は前日の本文を翌日として upsert し（W-1 の禁じる経路）、記録は
  //    前日の行を新しい日のタイムラインへ前置きする。閉じた後は「昨日」表示のまま残り、
  //    「今日」を押せば戻る。授乳タイマーは選択日を受け取らず前日行を自前で振り分ける
  //    （isSameJstDay / onPrevDayLogRecorded）ゆえ止める理由にせぬ。
  // 2. 「今日より前の最後の授乳」フォールバックを手元の記録で前へ進める。進めねば、新しい
  //    今日にまだ授乳が無い間、前夜の授乳を飛ばしてページ読込時点（2 日前など）の授乳を
  //    最終授乳・目安の起点にしてしまう。logs と weeklyLogs の両方から拾う（楽観 append は
  //    logs にしか入らず、過去日へ移った後の logs には前夜の行が無い）。DB からの取り直しは
  //    下の effect が担い（真値として手元の削除済みの行も正す）、ここは圏外でも効く一段目じゃ。
  const [prevToday, setPrevToday] = useState(today)
  if (today !== prevToday) {
    setPrevToday(today)
    if (selectedDate === prevToday && !sheetOpen && !diaryEditOpen) {
      setSelectedDate(today)
    }
    const newTodayStart = jstDayStartIso(today)
    const carried = [...logs, ...weeklyLogs]
    setServerLastFeeding((prev) =>
      advanceFeedingFallback(prev, carried, newTodayStart, { excludePumped: false }),
    )
    setServerLastNursing((prev) =>
      advanceFeedingFallback(prev, carried, newTodayStart, { excludePumped: true }),
    )
  }

  // 窓は 2 本。混ぜると既存の「授乳◯回」「おしっこN・うんちM」が無音で 8 日集計に化ける。
  // - fetchStartDate: 取得窓（8日）。Realtime の週窓 in/out 判定もこちら
  // - displayStartDate: 表示窓（7日）。グラフ・合計・おむつ内訳は全てこちら
  const fetchStartDate = useMemo(
    () => shiftYmd(today, -(WEEKLY_FETCH_DAYS - 1)),
    [today],
  )
  const displayStartDate = useMemo(
    () => shiftYmd(today, -(WEEKLY_DISPLAY_DAYS - 1)),
    [today],
  )
  const isToday = selectedDate === today

  // Ref for selectedDate so Realtime callback sees the latest value
  const selectedDateRef = useRef(selectedDate)
  // Realtime の in/out 判定は**取得窓**（8日）で行う。表示窓（7日）にすると
  // 8 日目の行が state に入らず、平均だけが静かにズレる。
  const fetchStartDateRef = useRef(fetchStartDate)
  const todayRef = useRef(today)
  useEffect(() => {
    selectedDateRef.current = selectedDate
  }, [selectedDate])
  useEffect(() => {
    fetchStartDateRef.current = fetchStartDate
    todayRef.current = today
  }, [fetchStartDate, today])

  // 復帰・再接続時の再取得（P1-04）の世代と in-flight 状態。
  const resyncGenerationRef = useRef(0)
  const resyncInFlightRef = useRef<ResyncInFlight | null>(null)
  // 購読の effect（deps は householdId のみ）から最新の再取得関数を呼ぶための ref。
  const resyncLogsRef = useRef<() => Promise<void>>(async () => {})

  // 更新後の行を 3 本の state（成長・週窓・選択日）へ反映する。Realtime の UPDATE と
  // 編集シートの成功（onLogUpdated）の両方がここを通る — 同じ版の置換ゆえ、楽観反映の
  // 後に echo が届いても二重にならぬ（冪等）。到着順は保証されぬため、手元の行より古い版
  // （updated_at が古い）は置換も窓外への除去もせず捨てる（isOlderLogVersion の注記）。
  // 窓の判定は ref 経由で常に最新値を読む。
  //
  // state 内の行との比較だけでは足りぬ: 新しい版が行を窓外へ動かして state から除去した後、
  // 古い版が着くと比べる相手がおらず、古い値で復活する。ゆえに id ごとに「最後に見た版」
  // を ref に覚え、そちらでも比べる。判定と更新は setState の updater の外で一度だけ行う
  // （updater は StrictMode で二度呼ばれうるゆえ、そこで ref を書くと純粋性が崩れる）。
  //
  // 再取得（P1-04）の in-flight 中に届いた更新は、窓ごとに touched へ控える — 取得結果
  // （更新前の snapshot）で巻き戻さぬため。各 setX の直前で控える規約は購読側と同じ。
  const seenVersionsRef = useRef(new Map<string, string>())
  // 手元で削除に成功した行の id（取り消し・編集シートの削除・他端末で削除済みの確認）。
  // 削除の後に同じ行の INSERT / UPDATE 通知が遅れて届くと（Realtime の遅延・#92）、消えた行が
  // 画面に蘇る — DB には無いのに「おしっこ1」と数え、取り消しの帯まで戻る。ゆえに **Realtime の
  // 通知**と、**消した版と同じか古い版の作成の応答**（下の段落）をこの控えで弾く（編集の保存・
  // 衝突の最新版というサーバの応答は applyUpdatedLog へ直に入り、控えを見ぬ）。
  //
  // ⚠️ 同じ id の行が作り直されることはある: 冪等 id は通信断で reject した時に再試行のため
  // 残る（クイック記録は 2 分・タイマーは計測ごと・記録シートは入力が変わるまで）。応答だけが
  // 失われて行が出来ており、それを消した後に同じ id で再試行すると、サーバは新しい行として
  // 作る。ゆえに「行が在る」とサーバが示した時（appendLog の作成応答・再取得の結果・消した版より新しい版の
  // Realtime の INSERT 通知）は控えから外す。
  //
  // 値は**消した時に画面が持っておった版**（不明なら null）。作成の応答が控えを外してよいのは、
  // 応答の版が消した版より新しい時（= 作り直された行）だけ。同じか古い版の応答は、消す前に送った
  // 作成の応答が遅れて着いたもので、行はもう DB に無い（isStaleCreateOfRemoved の注記）。
  // 通信が遅い時、Realtime の INSERT が作成の応答より先に着き、その行を編集シートで消した後に
  // 応答が着くと、以前はここで控えを外して消した行を画面へ戻しておった（次の再取得まで幽霊が残る）。
  const removedIdsRef = useRef(new Map<string, string | null>())
  // 画面に載っておる行の版（id → updated_at の表記のまま）。削除の控えに「消した版」を添えるため
  // だけに持つ。描画の後に写し、event handler（removeLog）からだけ読む。3 本の窓で版が食い違えば
  // 新しい方を採る（applyUpdatedLog は 3 本を同じ版へ揃えるゆえ、通常は一致する）。
  const shownVersionsRef = useRef(new Map<string, string>())
  useEffect(() => {
    const versions = new Map<string, string>()
    for (const list of [growthLogs, weeklyLogs, logs]) {
      for (const l of list) {
        if (!l.updated_at) continue
        const prev = versions.get(l.id)
        if (prev === undefined || isOlderLogVersion({ updated_at: prev }, l)) {
          versions.set(l.id, l.updated_at)
        }
      }
    }
    shownVersionsRef.current = versions
  }, [growthLogs, weeklyLogs, logs])
  const applyUpdatedLog = useCallback((updated: BabyLogData) => {
    const seen = seenVersionsRef.current.get(updated.id)
    if (seen !== undefined && isOlderLogVersion(updated, { updated_at: seen })) return
    if (updated.updated_at) seenVersionsRef.current.set(updated.id, updated.updated_at)

    const inFlight = resyncInFlightRef.current
    const isStaleFor = (prev: BabyLogData[]) => {
      const existing = prev.find((l) => l.id === updated.id)
      return existing !== undefined && isOlderLogVersion(updated, existing)
    }
    if (updated.log_type === "growth") {
      markResyncTouched(inFlight, "growth", updated.id)
      setGrowthLogs((prev) => {
        if (isStaleFor(prev)) return prev
        const exists = prev.some((l) => l.id === updated.id)
        const next = exists
          ? prev.map((l) => (l.id === updated.id ? updated : l))
          : [...prev, updated]
        return next.sort((a, b) => a.logged_at.localeCompare(b.logged_at))
      })
    }
    // 週窓の in/out は取得窓（8日）で判定する（fetchStartDateRef の注記を参照）
    const updatedDate = toJstDateString(updated.logged_at)
    const belongsToWeek =
      updatedDate >= fetchStartDateRef.current &&
      updatedDate <= todayRef.current
    markResyncTouched(inFlight, "weekly", updated.id)
    setWeeklyLogs((prev) => {
      if (isStaleFor(prev)) return prev
      const exists = prev.some((l) => l.id === updated.id)
      if (belongsToWeek && exists)
        return prev.map((l) => (l.id === updated.id ? updated : l))
      if (belongsToWeek && !exists) return [updated, ...prev]
      if (!belongsToWeek && exists)
        return prev.filter((l) => l.id !== updated.id)
      return prev
    })

    const belongsToDate = updatedDate === selectedDateRef.current
    markResyncTouched(inFlight, "logs", updated.id)
    setLogs((prev) => {
      if (isStaleFor(prev)) return prev
      const exists = prev.some((l) => l.id === updated.id)
      if (belongsToDate && exists)
        return prev.map((l) => (l.id === updated.id ? updated : l))
      if (belongsToDate && !exists) return [updated, ...prev]
      if (!belongsToDate && exists)
        return prev.filter((l) => l.id !== updated.id)
      return prev
    })
  }, [])

  // Realtime subscription
  useEffect(() => {
    const supabase = createClient(childId)
    const isRelevantToCurrentWeek = (log: BabyLogData) => {
      const logDate = toJstDateString(log.logged_at)
      return (
        logDate >= fetchStartDateRef.current && logDate <= todayRef.current
      )
    }
    const channel = supabase
      .channel("baby_logs")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "baby_logs",
          filter: childId ? `child_id=eq.${childId}` : `household_id=eq.${householdId}`,
        },
        (payload) => {
          logRealtimeEvent("baby_logs", payload)
          // 再取得の in-flight 中に触った id は窓ごとに控える（P1-04: 取得結果で
          // 手元の新しい変更を巻き戻さない）。各 setX の直前で控えること。
          const inFlight = resyncInFlightRef.current
          if (payload.eventType === "INSERT") {
            const newLog = payload.new as BabyLogData
            if (childId && newLog.child_id !== childId) return
            // 手元で消した行の遅れた通知（removedIdsRef の注記）。消した版より新しい版は作り直された行ゆえ通す
            if (removedIdsRef.current.has(newLog.id)) {
              if (!isNewerThanRemoved(newLog.updated_at, removedIdsRef.current.get(newLog.id))) return
              removedIdsRef.current.delete(newLog.id)
            }
            if (newLog.log_type === "growth") {
              markResyncTouched(inFlight, "growth", newLog.id)
              setGrowthLogs((prev) => {
                if (prev.some((l) => l.id === newLog.id)) return prev
                // 昇順維持のため logged_at で挿入位置を保つ（末尾追加後にソート）
                return [...prev, newLog].sort((a, b) =>
                  a.logged_at.localeCompare(b.logged_at),
                )
              })
            }
            if (isRelevantToCurrentWeek(newLog)) {
              markResyncTouched(inFlight, "weekly", newLog.id)
              setWeeklyLogs((prev) => {
                if (prev.some((l) => l.id === newLog.id)) return prev
                return [newLog, ...prev]
              })
            }
            if (toJstDateString(newLog.logged_at) !== selectedDateRef.current) {
              return
            }
            markResyncTouched(inFlight, "logs", newLog.id)
            setLogs((prev) => {
              if (prev.some((l) => l.id === newLog.id)) return prev
              return [newLog, ...prev]
            })
          } else if (payload.eventType === "UPDATE") {
            const updatedLog = payload.new as BabyLogData
            if (childId && updatedLog.child_id !== childId) return
            // 手元で消した行の遅れた通知（removedIdsRef の注記）。編集の保存・衝突の応答は
            // applyUpdatedLog へ直に入るゆえ、更新の経路ではここ（Realtime の入口）でだけ見る。
            // ⚠️ UPDATE は版が新しくても控えを外さぬ: 他端末が消した行（alreadyDeleted）の控えは画面が
            // 持っておった古い版になりうる。他端末が消す直前に直した版の通知が遅れて着くと「新しい版」に
            // 見え、DB に無い行が蘇る。作り直された行は INSERT の通知・作成の応答・再取得で控えから外れる
            if (removedIdsRef.current.has(updatedLog.id)) return
            // 版の比較と窓への反映（と in-flight の touched 控え）は applyUpdatedLog に集約
            applyUpdatedLog(updatedLog)
          } else if (payload.eventType === "DELETE") {
            // フィルタ付き購読では本番で届かぬ（下の再取得が回収する）。届いた時のための経路。
            const deleted = payload.old as { id: string }
            markResyncTouched(inFlight, "logs", deleted.id)
            markResyncTouched(inFlight, "weekly", deleted.id)
            markResyncTouched(inFlight, "growth", deleted.id)
            setLogs((prev) => prev.filter((l) => l.id !== deleted.id))
            setWeeklyLogs((prev) => prev.filter((l) => l.id !== deleted.id))
            setGrowthLogs((prev) => prev.filter((l) => l.id !== deleted.id))
          }
        },
      )
      .subscribe((status, err) => {
        logRealtimeStatus("baby_logs", status, err)
        if (status !== "SUBSCRIBED") return
        // 初回を含むすべての SUBSCRIBED で取り直す（P1-04）。postgres_changes は購読が
        // 生きる前と切断中のイベントを再送しない。初回はマウント時の取得（下）から購読
        // 開始までの隙間を、2 回目以降は網の切断からの再接続を回収する。マウント時の
        // 取得と重なっても、世代ガードが古い方を abort して捨てる。
        void resyncLogsRef.current()
      })

    return () => {
      supabase.removeChannel(channel)
    }
  }, [householdId, childId, applyUpdatedLog])

  // 育児日記（1日1本）の Realtime 購読（issue #155）。baby_logs とは別 channel で
  // 分離し、購読ブロックの blast radius を最小化する。
  // INSERT/UPDATE のみ反映する: household_id フィルタ付き購読では DELETE の old が
  // PK のみで配信されない（migration 20260723000001 / calendar_events と同制約）。
  // DELETE（配偶者の空保存）は date-nav refetch と下の visibilitychange refetch で回収する。
  useEffect(() => {
    const supabase = createClient(childId)
    const channel = supabase
      .channel("baby_diaries")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "baby_diaries",
          filter: childId ? `child_id=eq.${childId}` : `household_id=eq.${householdId}`,
        },
        (payload) => {
          logRealtimeEvent("baby_diaries", payload)
          if (
            payload.eventType === "INSERT" ||
            payload.eventType === "UPDATE"
          ) {
            const next = payload.new as BabyDiaryData
            if (childId && next.child_id !== childId) return
            // 選択日と一致する日記だけ反映する（selectedDate は deps 外のため ref 読み）。
            // diary_date は DATE 列で Realtime は "YYYY-MM-DD" を配信するが、万一
            // 時刻付き（"...T00:00:00"）で来ても guard が silent 全滅しないよう
            // 先頭10文字で比較する（mock では検出不能な wire フォーマット境界の保険。
            // DATE 列ゆえ toJstDateString の timestamptz 変換は使わない）。
            // `?.` は diary_date 欠落の payload（本番の channel 分離下では届かないが
            // 防御）を安全に no-op にする。
            if (next.diary_date?.slice(0, 10) !== selectedDateRef.current) return
            setDiary(next)
            setDiaryDate(selectedDateRef.current)
            setDiaryFailedDate(null)
          }
          // DELETE は配信されない（上記）。refetch 経路で回収する。
        },
      )
      .subscribe((status, err) => {
        logRealtimeStatus("baby_diaries", status, err)
      })

    return () => {
      supabase.removeChannel(channel)
    }
  }, [householdId, childId])

  // タブ復帰時に選択日の日記を再取得し、DELETE 非配信（配偶者の空保存）を回収する
  // （calendar use-month-events と同流儀。issue #91/#92/#155）。
  // 選択日の stale ガードは下のコールバック側に残す — フックはリスナの張り外しのみ。
  useVisibilityRefetch(
    useCallback(() => {
      const date = selectedDateRef.current
      const context = { householdId, date }
      void (async () => {
        try {
          const supabase = createClient(childId)
          // anon の 0 行（data: null）を「配偶者が消した」と取り違えて本文を消さない
          // （hasUsableSession。logs の再取得と同じ失敗類型）。
          if (!(await hasUsableSession(supabase, "diary visibility refetch", context))) {
            return
          }
          const { data, error } = await supabase
            .from("baby_diaries")
            .select("id, diary_date, content, updated_at")
            .eq("household_id", householdId)
            .eq("diary_date", date)
            .maybeSingle()
          if (error) {
            logSupabaseError("baby", "diary visibility refetch failed", error, context)
            // 同一日の取り直しゆえ、失敗時は現在の本文を保持する（date-nav の
            // fail-to-empty とは異なり cross-date stale の危険が無い）。
            return
          }
          // refetch 中に日付が変わっていたら反映しない（往復中の stale 反映防止）。
          if (selectedDateRef.current !== date) return
          setDiary(data ?? null)
          setDiaryDate(date)
          setDiaryFailedDate((prev) => (prev === date ? null : prev))
        } catch (err) {
          // getSession / createClient の例外を unhandled rejection にしない。
          console.error("[baby] diary visibility refetch threw", {
            ...context,
            message: err instanceof Error ? err.message : String(err),
          })
        }
      })()
    }, [householdId, childId]),
  )

  /**
   * 育児ログの再取得（P1-04）。選択日の logs・取得窓（8日）の weekly・成長・
   * 「今日より前の最後の授乳」fallback 2 本を page.tsx と同じクエリで取り直す。
   *
   * 契機はマウント・タブ復帰（visible / focus）・購読の SUBSCRIBED（初回と再接続）。
   * フィルタ付き購読は DELETE を配信せず、本番では postgres_changes 自体が間欠不達
   * （#92）ゆえ、これが配偶者の記録・削除・編集を画面へ揃える唯一の担保になる。
   * マウント時に取る理由: 戻る/進むでは Next がキャッシュ済みの RSC payload を古さを
   * 問わず再利用する（staleTimes の対象外）ため、props は SSR 直後の真値とは限らない。
   *
   * 防御（画面固有ゆえフックではなくここに置く）:
   * - session が無ければ取得も反映もしない（hasUsableSession: anon の 0 行を空の真値と
   *   取り違えない）
   * - 世代 + AbortController: 新しい再取得が始まれば前の in-flight を abort し、
   *   遅れて届いた古い世代の応答は捨てる
   * - 取得開始後に手元で触った行は窓ごとに控え、取得結果で巻き戻さない
   *   （reconcileResyncedLogs）
   * - 取得中に選択日が変わったら logs へは反映しない。今日（JST）が変わったら
   *   週窓と fallback へは反映しない（窓の起点がずれるため）
   * - error は窓ごとに現在の表示を保ち、構造化ログだけ残す（復帰のたびのトーストは
   *   ノイズになるため出さない。日付ナビの取得失敗トーストとは役割が違う）
   */
  const resyncLogs = useCallback(async () => {
    resyncInFlightRef.current?.controller.abort()
    const generation = ++resyncGenerationRef.current
    const controller = new AbortController()
    const inFlight: ResyncInFlight = {
      generation,
      controller,
      touched: { logs: new Set(), weekly: new Set(), growth: new Set() },
      lastFeedingTouched: false,
      lastNursingTouched: false,
    }
    resyncInFlightRef.current = inFlight

    const date = selectedDateRef.current
    // 「今日」は描画と同じ値（useNow 由来の today の鏡）を使い、壁時計を直に読まぬ
    // （週窓・fallback の起点を表示と揃える。today-clock-contract.test.ts の契約でもある）
    const todayYmd = todayRef.current
    // 週窓の合流で使う暦日の下限（クエリの窓は baby-log-queries.ts の selectBabyLogsOfWeek）
    const weeklyStartYmd = shiftYmd(todayYmd, -(WEEKLY_FETCH_DAYS - 1))

    const logContext = { householdId, date, today: todayYmd }
    try {
      const supabase = createClient(childId)
      // anon の 0 行を真値として描かない（hasUsableSession）。取得前に確かめ、anon の
      // 問い合わせ自体を出さない。待つ間に次の世代へ替わっていたら黙って退く。
      const sessionOk = await hasUsableSession(supabase, "logs resync", logContext)
      if (controller.signal.aborted) return
      if (resyncGenerationRef.current !== generation) return
      if (!sessionOk) {
        // 取り直せなんだ = どの範囲も最新を確認できておらぬ（表示は保つ）
        markRange("logs", false)
        markRange("weekly", false)
        markRange("growth", false)
        return
      }

      const [
        { data: dayLogs, error: dayError },
        { data: weekly, error: weeklyError },
        { data: growth, error: growthError },
        { data: lastFeeding, error: lastFeedingError },
        { data: lastNursing, error: lastNursingError },
      ] = await Promise.all([
        // 初回描画（page.tsx）と同じ組み立て（baby-log-queries.ts）。搾乳を除く
        // denylist などの条件をここで書き直さぬ
        selectBabyLogsOfDay(supabase, householdId, date, controller.signal),
        selectBabyLogsOfWeek(supabase, householdId, todayYmd, controller.signal),
        selectGrowthLogs(supabase, householdId, controller.signal),
        selectLastFeedingBefore(supabase, householdId, todayYmd, controller.signal),
        selectLastNursingBefore(supabase, householdId, todayYmd, controller.signal),
      ])

      // abort（次の再取得・unmount）は error 分岐へ入れない。古い世代も捨てる。
      if (controller.signal.aborted) return
      if (resyncGenerationRef.current !== generation) return
      resyncInFlightRef.current = null

      // DB の真値に行が在る = 削除済みの控えは古い（冪等 id で作り直された行）。ただし取得中に
      // 手元で触った（消した）行は、取得結果が削除前の snapshot でありうるゆえ控えを残す
      const releaseRemoved = (
        rows: BabyLogData[] | null,
        touched: Set<string>,
      ) => {
        for (const row of rows ?? []) {
          if (!touched.has(row.id)) removedIdsRef.current.delete(row.id)
        }
      }
      if (!dayError) releaseRemoved(dayLogs, inFlight.touched.logs)
      if (!weeklyError) releaseRemoved(weekly, inFlight.touched.weekly)
      if (!growthError) releaseRemoved(growth, inFlight.touched.growth)

      // 範囲ごとの最新の確認（C1）。週だけ取れても日次を「最新」と言わぬ。選択日・今日が
      // 取得中に変わった範囲は反映せぬゆえ、確認できたとも数えぬ
      if (dayError) markRange("logs", false)
      else if (selectedDateRef.current === date) markRange("logs", true)
      if (dayError) {
        logSupabaseError("baby", "logs resync (selected day) failed", dayError, logContext)
      } else if (selectedDateRef.current === date) {
        const touched = inFlight.touched.logs
        setLogs((prev) =>
          reconcileResyncedLogs(
            prev,
            dayLogs ?? [],
            touched,
            // Realtime の入場条件（選択日の JST 日付一致）と同じ窓
            (l) => toJstDateString(l.logged_at) === date,
          ),
        )
        // 選択日の行を取り直せたゆえ、その日は「取得済み」。日付ナビの失敗も癒える
        setLogsDate(date)
        setLogsFailedDate((prev) => (prev === date ? null : prev))
      }

      const sameToday = todayRef.current === todayYmd
      if (weeklyError) markRange("weekly", false)
      else if (sameToday) markRange("weekly", true)
      markRange("growth", !growthError)
      if (weeklyError) {
        logSupabaseError("baby", "logs resync (weekly) failed", weeklyError, logContext)
      } else if (sameToday) {
        const touched = inFlight.touched.weekly
        setWeeklyLogs((prev) =>
          reconcileResyncedLogs(prev, weekly ?? [], touched, (l) => {
            // 取得窓（8日）で判定する（表示窓 7 日にすると平均が静かにずれる）
            const d = toJstDateString(l.logged_at)
            return d >= weeklyStartYmd && d <= todayYmd
          }),
        )
      }

      if (growthError) {
        logSupabaseError("baby", "logs resync (growth) failed", growthError, logContext)
      } else {
        const touched = inFlight.touched.growth
        // 昇順維持（Realtime の成長行ハンドラと同じ並び）。合流結果は取得配列そのもの
        // でありうるため、写してから並べる（updater 内で受領データを破壊しない）。
        setGrowthLogs((prev) =>
          [
            ...reconcileResyncedLogs(
              prev,
              growth ?? [],
              touched,
              (l) => l.log_type === "growth",
            ),
          ].sort((a, b) => a.logged_at.localeCompare(b.logged_at)),
        )
      }

      if (lastFeedingError) {
        logSupabaseError("baby", "logs resync (last feeding) failed", lastFeedingError, logContext)
      } else if (sameToday) {
        setServerLastFeeding((current) =>
          reconcileResyncedFallback(
            current,
            lastFeeding ?? null,
            inFlight.lastFeedingTouched,
          ),
        )
      }

      if (lastNursingError) {
        logSupabaseError("baby", "logs resync (last nursing) failed", lastNursingError, logContext)
      } else if (sameToday) {
        setServerLastNursing((current) =>
          reconcileResyncedFallback(
            current,
            lastNursing ?? null,
            inFlight.lastNursingTouched,
          ),
        )
      }
    } catch (err) {
      // postgrest-js は失敗を { error } で返すが、createClient 等の同期例外に備える。
      if (controller.signal.aborted) return
      console.error("[baby] logs resync threw", {
        householdId,
        date,
        message: err instanceof Error ? err.message : String(err),
      })
      markRange("logs", false)
      markRange("weekly", false)
      markRange("growth", false)
    } finally {
      if (resyncInFlightRef.current === inFlight) resyncInFlightRef.current = null
    }
  }, [householdId, childId, markRange])

  useEffect(() => {
    resyncLogsRef.current = resyncLogs
  }, [resyncLogs])

  // マウント時に 1 回取り直す（P1-04）。戻る/進む（history traversal）では Next 16 が
  // キャッシュ済みの RSC payload を古さを問わず再利用し（router の bfcache。staleTimes は
  // 効かない）、この component は何分も前の initialLogs で作り直される。アプリは前面の
  // ままゆえ visible / focus も発火せず、ここで取らねば配偶者の記録・削除と「最終授乳」
  // 「次の授乳の目安」が嘘のまま残る。SSR 直後の通常の表示では重複取得になるが、結果は
  // 同じで、世代ガード・touched の合流規則が手元の変更を守る。
  // ref ではなく直接呼ぶ: effect は宣言順に走り、上の ref の差し替えより前に読みうる。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setState（鮮度の反映を含む）は getSession と取得を await した後にしか起きぬ（同期の連鎖描画ではない）
    void resyncLogs()
  }, [resyncLogs])

  // タブ復帰（visible / focus）で取り直す。世代ガード等は resyncLogs 側に残す
  // — フックはリスナの張り外しのみ（use-visibility-refetch.ts の境界）。
  useVisibilityRefetch(
    useCallback(() => {
      void resyncLogs()
    }, [resyncLogs]),
  )

  // unmount で in-flight の再取得を止める（離脱後の setState を走らせない）。
  useEffect(() => {
    return () => {
      resyncInFlightRef.current?.controller.abort()
    }
  }, [])

  // Fetch logs when navigating to a different date (skip initial mount — initialLogs covers it)
  const initialDateRef = useRef(initialDate)
  useEffect(() => {
    if (selectedDate === initialDateRef.current) {
      initialDateRef.current = "" // allow re-fetch if user navigates away and back
      return
    }
    const supabase = createClient(childId)
    const abortController = new AbortController()

    // 選択日の窓は初回描画・取り直しと同じ組み立て（baby-log-queries.ts）
    selectBabyLogsOfDay(supabase, householdId, selectedDate, abortController.signal)
      .then(({ data, error }) => {
        // 遷移離脱（abort）は成功/失敗いずれの分岐にも入れない。
        // 既存 AbortController 防御を保持し、離脱時の spurious toast を防ぐ。
        if (abortController.signal.aborted) return
        if (error) {
          // AUDIT-012: 従来は error を捨てて無言失敗していた（B-08）。
          logSupabaseError("baby", "date navigation fetch failed", error, {
            householdId,
            selectedDate,
          })
          toast.error("読み込みに失敗しました")
          // 画面にも失敗を残す（トーストは消える）。前の日の行は見せず、再読み込みの
          // 導線を出す（P2-10）。logs は捨てぬ（先着した Realtime 行を守るため）。
          setLogsFailedDate(selectedDate)
          markRange("logs", false)
          return
        }
        // H3-02: 無条件全置換だと in-flight 中に Realtime で先着した選択日の
        // 行が消える。id ベースの dedupe マージで先着行を保持する（B-08）。
        setLogs((prev) => mergeDateNavLogs(prev, data ?? [], selectedDate))
        setLogsDate(selectedDate)
        setLogsFailedDate(null)
        markRange("logs", true)
      })

    // 育児日記（1日1本）も選択日に合わせて refetch する。無い日は正常系（maybeSingle）。
    supabase
      .from("baby_diaries")
      .select("id, diary_date, content, updated_at")
      .eq("household_id", householdId)
      .eq("diary_date", selectedDate)
      .abortSignal(abortController.signal)
      .maybeSingle()
      .then(({ data, error }) => {
        if (abortController.signal.aborted) return
        if (error) {
          // logs 側の fetch が同時失敗時に toast を出すため、日記側は
          // 二重トースト回避で構造化ログのみ（握り潰しはしない）。
          logSupabaseError("baby", "diary navigation fetch failed", error, {
            householdId,
            selectedDate,
          })
          // logs の「stale 保持」流儀とあえて変えて前の日の本文を捨てる:
          // 前の日の本文が選択日の日記として残ると、タップ→保存で「前日の本文を
          // 別日として upsert する」事故経路になるため（レビュー W-1）。
          // 2026-10-27: 「日記を書く」（＝日記が無い）とも言わぬ。失敗と再読み込みを出し、
          // 書く・編集の導線も出さぬ（取得済みの日にせぬ）
          setDiary(null)
          setDiaryFailedDate(selectedDate)
          return
        }
        setDiary(data ?? null)
        setDiaryDate(selectedDate)
        setDiaryFailedDate(null)
      })

    return () => {
      abortController.abort()
    }
  }, [selectedDate, householdId, childId, dateNavRetry, markRange])

  // 表示用の logs と、日付ナビの取得状態（P2-10）。取得済みの日と選択日が一致する時だけ
  // 行を見せる。違う間は取得中（失敗した日なら失敗）で、前の日の行を新しい見出しの下に
  // 出さぬ。まとめ・最終授乳・体温カードも同じ配列を読む（見出しと数字の日付を揃える）。
  const logsReady = logsDate === selectedDate
  const visibleLogs = useMemo(
    () => (logsReady ? logs : []),
    [logsReady, logs],
  )
  // 画面が今持っておる行の id（選択日・週窓）。保存を確認中の操作の id が再取得・Realtime で
  // 現れたら、読みを待たず記録済みとして畳む（PendingSavesNotice）
  const knownLogIds = useMemo(
    () => new Set([...logs, ...weeklyLogs].map((l) => l.id)),
    [logs, weeklyLogs],
  )
  const dateNavStatus: "ready" | "loading" | "error" = logsReady
    ? "ready"
    : logsFailedDate === selectedDate
      ? "error"
      : "loading"
  const retryDateNav = useCallback(() => {
    setLogsFailedDate(null)
    setDateNavRetry((n) => n + 1)
  }, [])
  // 日記も同じ gate: 取得済みの日と選択日が一致する時だけ本文を見せ、編集を許す
  const diaryReady = diaryDate === selectedDate
  const visibleDiary = diaryReady ? diary : null
  const diaryFailed = !diaryReady && diaryFailedDate === selectedDate
  const retryDiary = useCallback(() => {
    setDiaryFailedDate(null)
    setDateNavRetry((n) => n + 1)
  }, [])

  // この日の日記の下書きがこの端末に残っておるか（畳まず、その旨を出す）。シートを閉じるたびと
  // 日付を替えるたびに読み直す。localStorage は描画の後にだけ読む（SSR と食い違わせぬ）
  const [diaryDraftExists, setDiaryDraftExists] = useState(false)
  useEffect(() => {
    if (diaryEditOpen) return
    const r = readDraft(owner, { kind: "diary", date: selectedDate }, isDiaryDraftContent)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 端末の保存は描画の後にだけ読む（SSR との食い違いを避ける）
    setDiaryDraftExists(r.status === "found")
  }, [owner, selectedDate, diaryEditOpen])

  // ── 引き継ぎ（C4）: 前回この端末で見てから ─────────────────────────────
  // マウント時に前回の印を読み（この表示の間は固定）、離れる時に今見えておる最新の版を残す。
  // 週の窓の取得に失敗しておる間は残さぬ（見ておらぬ記録を「見た」ことにせぬ）
  const [handoffSince, setHandoffSince] = useState<string | null>(null)
  const [handoffDismissed, setHandoffDismissed] = useState(false)
  const [handoffLoaded, setHandoffLoaded] = useState(false)
  // 前回の印は最初の 1 回だけ読む（StrictMode の作り直しの間に、離れる時の書き込みで
  // 今の印へ進んだ値を読み直さぬ）
  const handoffReadRef = useRef(false)
  useEffect(() => {
    if (handoffReadRef.current) return
    handoffReadRef.current = true
    // 端末の保存は描画の後にだけ読む（SSR との食い違いを避ける）
    setHandoffSince(readLastSeen(owner))
    setHandoffLoaded(true)
  }, [owner])
  // 引き継ぎは週の窓（直近 8 日）だけで数える。選択日の logs は過去日でありうる（窓の外）
  const seenMarkRef = useRef<string | null>(null)
  useEffect(() => {
    seenMarkRef.current = freshness.weekly.failed ? null : latestSeenMark(weeklyLogs)
  }, [freshness.weekly.failed, weeklyLogs])
  useEffect(() => {
    const save = () => {
      const mark = seenMarkRef.current
      if (mark) writeLastSeen(owner, mark)
    }
    const onHide = () => {
      if (document.visibilityState === "hidden") save()
    }
    window.addEventListener("pagehide", save)
    document.addEventListener("visibilitychange", onHide)
    return () => {
      window.removeEventListener("pagehide", save)
      document.removeEventListener("visibilitychange", onHide)
      save()
    }
  }, [owner])
  const acknowledgeHandoff = useCallback(() => {
    const mark = seenMarkRef.current
    if (mark) writeLastSeen(owner, mark)
    setHandoffDismissed(true)
  }, [owner])

  // マウント時の「今日」。日を跨いだかの判定に使う。initialDate prop は Server Action の
  // revalidatePath で今日へ追いつくゆえ発火条件に使えぬ — 使うと、日跨ぎ直後の操作で
  // 実行中の取り直しが abort され、条件も偽になって二度と走らぬ。
  const mountTodayRef = useRef(today)

  // 日を跨いだら DB から取り直す（二段目）。手元の記録で進める一段目（上の描画中調整）では、
  // 別端末の記録や Realtime 不達で手元に届かなかった記録を拾えず、逆に手元に残った
  // 削除済みの行（DELETE が届かぬ）を拾いうる。復帰時と同じ resyncLogs（P1-04）を使う:
  // 新しい今日を起点に、選択日の logs・週窓・成長・「今日より前の最後の授乳」2 本を
  // page.tsx と同じクエリで取り直し、取得中に手元で動いた値（タイマーの前日記録・前日
  // として保存した授乳）は touched の合流規則で新しい方を残す。session が無ければ
  // 反映せず一段目の値のまま（anon の 0 行を「授乳なし」と取り違えぬ）。
  // 失敗した時は次の契機（可視化・再接続・次の日跨ぎ）まで一段目の値のまま。
  useEffect(() => {
    if (today === mountTodayRef.current) return
    void resyncLogs()
  }, [today, resyncLogs])

  // Derive summary in a single pass
  // （導出は純関数へ抽出。P3: 深夜跨ぎサイクルは前日行になり logs に現れないため
  //   serverLastFeeding で補完する。ただし今日表示の時のみ。過去日は「その日の授乳」
  //   を表示する契約ゆえ、別日の fallback を混ぜると過去日のまとめに嘘の時刻が出る）
  const { lastFeeding } = useMemo(
    () => deriveDashboardSummary(visibleLogs, isToday ? serverLastFeeding : null),
    [visibleLogs, serverLastFeeding, isToday],
  )

  // 次の授乳の目安の起点: 選択日の logs から「最後の授乳（搾乳を除く）」を導出する。
  // 当日にまだ授乳が無い間は serverLastNursing（今日より前の最後の授乳）で補完する
  // — 深夜跨ぎ（前日 23:00 開始）の授乳は今日窓の logs に現れないため。
  // lastFeeding と同じく今日表示の時のみ fallback を混ぜる（過去日に別日の時刻を
  // 持ち込まない。なお目安カード自体もサマリバー側で isToday 限定）。
  const lastNursing = useMemo(
    () => findLastNursing(visibleLogs) ?? (isToday ? serverLastNursing : null),
    [visibleLogs, serverLastNursing, isToday],
  )

  // 今日のまとめ: 選択日の logs を date フィルタで集計する（週間/PDF と per-day 同値）。
  const todayCounts = useMemo(
    () => summarizeTodayCounts(visibleLogs, selectedDate),
    [visibleLogs, selectedDate],
  )

  // 成長曲線: 全期間の成長ログから体重/身長系列を組む
  const growthSeries = useMemo(
    () => buildGrowthSeries(growthLogs, "2000-01-01", today),
    [growthLogs, today],
  )

  // 取得窓ぶんの 8 バケット。ここから表示用と平均用を**別々に**切り出す。
  const weeklyBuckets = useMemo(
    () => buildBabyWeeklySummary(weeklyLogs, today, WEEKLY_FETCH_DAYS),
    [weeklyLogs, today],
  )

  // グラフは末尾 7 バケット（今日を含む直近 7 日）＝ **従来と同じ意味**。
  const weeklySummary = useMemo(
    () => weeklyBuckets.slice(WEEKLY_FETCH_DAYS - WEEKLY_DISPLAY_DAYS),
    [weeklyBuckets],
  )

  // 平均は先頭 7 バケット（昨日までの 7 日）。経過途中の今日は混ぜぬ。
  const weeklyAverage = useMemo(
    () => averageBabyWeeklySummary(weeklyBuckets.slice(0, AVERAGE_WINDOW_DAYS)),
    [weeklyBuckets],
  )

  // 週間のおしっこ/うんち内訳: aggregateDiapers（PDF と同じ日別集計）の出力から
  // pee+both / poop+both を導出する。**表示窓（7日）で数える** — 取得窓（8日）を
  // 渡すとグラフの隣に出る数字だけが 8 日集計になり、グラフと食い違う。
  const weeklyDiaperBreakdown = useMemo(
    () =>
      sumDiaperBreakdown(
        aggregateDiapers(weeklyLogs, displayStartDate, today),
      ),
    [weeklyLogs, displayStartDate, today],
  )

  const handleEdit = useCallback((log: BabyLogData) => {
    setCreateLogType(null)
    setCreateFeedingType(null)
    setCreateAmountMl(null)
    setEditingLog(log)
    setFormKey((k) => k + 1)
    setSheetOpen(true)
  }, [])

  const handleCreateLog = useCallback((type: BabyLogType) => {
    setEditingLog(null)
    setCreateLogType(type)
    // feeding 以外の create では前回の搾乳導線の残りを持ち越さない
    setCreateFeedingType(null)
    setCreateAmountMl(null)
    setFormKey((k) => k + 1)
    setSheetOpen(true)
  }, [])

  // 搾乳など量ベースの授乳を create シートで記録する導線（母乳のタイマーとは別）。
  // opts.amountMl は「今回だけ別の量」の初期値（いつもの量）。その記録だけに使い、いつもの量は変えぬ
  const handleCreateFeeding = useCallback(
    (type: FeedingType, opts?: { amountMl?: number }) => {
      setEditingLog(null)
      setCreateLogType("feeding")
      setCreateFeedingType(type)
      setCreateAmountMl(opts?.amountMl ?? null)
      setFormKey((k) => k + 1)
      setSheetOpen(true)
    },
    [],
  )

  // 体温カードの空きスロットから新規記録シートを開く（既存の create 導線へ相乗り。
  // 新しい書き込み経路は作らない）。カードが logType を知らずに済むよう束ねる。
  const handleCreateTemperature = useCallback(() => {
    handleCreateLog("temperature")
  }, [handleCreateLog])

  const handleStartTimer = useCallback((type: FeedingType) => {
    setTimerFeedingType(type)
    setTimerOpen(true)
  }, [])

  // B-03: 記録系 Server Action の成功時に、返却 id で組んだ楽観ログを logs へ前置きする。
  // 既存 Realtime INSERT ハンドラ（上）と同じ id 重複ガードを持たせ、echo が後追いで
  // 届いても二重 append しない（同 id INSERT はスキップされる）。
  // 楽観 append が正しいのは記録導線が全て isToday ゲート下にあるからこそ
  // （F-03 過去日クイック記録の解禁時は要再検討 — baby-optimistic-log.ts の注記参照）。
  // 開いたまま日を跨いだシートは開いた日の行を保存する。logs へ入れるのは選択日の行だけ
  // （Realtime INSERT の入場条件・mergeDateNavLogs と同じ）— 保存の通信中にシートを閉じると
  // 追従の抑止が外れ、選択日が新しい今日へ進んだ後に前日の行が戻ってきうるため。
  // その授乳は「新しい今日より前の最後の授乳」でもありうるゆえ、フォールバックは日付に
  // 関わらず前へ進める（日跨ぎの一段目はその前に済んでおり拾えぬ）。今日以降の行は無視される。
  const appendLog = useCallback((log: BabyLogData) => {
    // サーバの作成応答 = その id の行が在った（冪等 id の再試行で作り直された行を含む）。
    // ただし手元で消した版と同じか古い版の応答は、消す前の作成の応答が遅れて着いたもの —
    // 行はもう DB に無いゆえ、logs・週窓・成長・最終授乳のどれにも入れず控えも残す
    // （removedIdsRef の注記）。それ以外は削除済みの控えから外して入れる
    if (removedIdsRef.current.has(log.id)) {
      if (isStaleCreateOfRemoved(log.updated_at, removedIdsRef.current.get(log.id))) return
      removedIdsRef.current.delete(log.id)
    }
    // 保存の後の確認（C1）は、この id の行を state から引いて出す（別の保存状態を持たぬ）
    setLastSavedId(log.id)
    // 再取得の in-flight 中なら控え、取得結果（記録前の snapshot）で消さない（P1-04）
    const inFlight = resyncInFlightRef.current
    const logDate = toJstDateString(log.logged_at)
    if (logDate === selectedDateRef.current) {
      markResyncTouched(inFlight, "logs", log.id)
      setLogs((prev) => (prev.some((l) => l.id === log.id) ? prev : [log, ...prev]))
    }
    // 週窓（取得窓 8 日）と成長曲線にも即時に載せる。Realtime の INSERT echo は id 重複で
    // 吸収される。過去日への追記（機能 C）も、今日のクイック記録も、グラフと週の数字が
    // 次の再取得まで古いままにならぬ
    if (logDate >= fetchStartDateRef.current && logDate <= todayRef.current) {
      markResyncTouched(inFlight, "weekly", log.id)
      setWeeklyLogs((prev) =>
        prev.some((l) => l.id === log.id) ? prev : [log, ...prev],
      )
    }
    if (log.log_type === "growth") {
      markResyncTouched(inFlight, "growth", log.id)
      setGrowthLogs((prev) =>
        prev.some((l) => l.id === log.id)
          ? prev
          : [...prev, log].sort((a, b) => a.logged_at.localeCompare(b.logged_at)),
      )
    }
    if (log.log_type === "feeding") {
      const todayStart = jstDayStartIso(todayRef.current)
      if (inFlight) inFlight.lastFeedingTouched = true
      setServerLastFeeding((prev) =>
        advanceFeedingFallback(prev, [log], todayStart, { excludePumped: false }),
      )
      if (log.feeding_type !== "pumped") {
        if (inFlight) inFlight.lastNursingTouched = true
        setServerLastNursing((prev) =>
          advanceFeedingFallback(prev, [log], todayStart, { excludePumped: true }),
        )
      }
    }
  }, [])

  // 日記の保存結果は、書いた日が選択日の時だけ反映する（Realtime の日記ハンドラと同じ
  // 入場条件）。保存の通信中に閉じられて選択日が動いた後に、前日の日記を新しい日の
  // 日記として表示し、次の編集でその本文を新しい日へ upsert する（W-1）経路を塞ぐ。
  const handleDiarySaved = useCallback(
    (saved: BabyDiaryData | null, savedDate: string) => {
      if (savedDate !== selectedDateRef.current) return
      setDiary(saved)
      setDiaryDate(savedDate)
    },
    [],
  )

  // B-03: Undo（quick actions の取り消し）・削除の成功時にローカル state から除去する。
  // Realtime DELETE echo が後追いで来ても filter は冪等ゆえ二重除去にならない。
  // 週窓・成長の配列からも外す — household フィルタ付き購読では DELETE が届かぬため、
  // 残すと週次の数字が古いままになり、日跨ぎで最終授乳の候補に「幽霊」として拾われる。
  // 授乳タイマー・記録シート（クイック記録以外）で記録が付いた回数。クイック記録の「直前の記録」
  // の帯は、これが進んだら畳む（後の記録があるのに古い方を「直前」として取り消させぬ）
  const [externalRecordSeq, setExternalRecordSeq] = useState(0)
  const appendLogFromOtherPath = useCallback(
    (log: BabyLogData) => {
      appendLog(log)
      setExternalRecordSeq((n) => n + 1)
    },
    [appendLog],
  )

  const removeLog = useCallback((id: string) => {
    // 遅れて届く同じ行の INSERT / UPDATE 通知・作成の応答で蘇らせない（removedIdsRef の注記）。
    // 消した時に画面が持っておった版を添える（同じ id を二度消した時は、先に覚えた版を失わぬ）
    const removed = removedIdsRef.current
    removed.set(id, shownVersionsRef.current.get(id) ?? removed.get(id) ?? null)
    // 取得結果（削除前の snapshot）で蘇らせない（P1-04）
    const inFlight = resyncInFlightRef.current
    markResyncTouched(inFlight, "logs", id)
    markResyncTouched(inFlight, "weekly", id)
    markResyncTouched(inFlight, "growth", id)
    setLogs((prev) => prev.filter((l) => l.id !== id))
    setWeeklyLogs((prev) => prev.filter((l) => l.id !== id))
    setGrowthLogs((prev) => prev.filter((l) => l.id !== id))
  }, [])

  // 畳んだ「週間サマリー」の見出しに出す要約。中の数字（「3.0回/日」等）と同じ文字列を
  // 作らぬ形にする（既存の検証が exact 一致で掴むため、重複一致させぬ）
  const weeklyHeadline = weeklyAverage
    ? `1日平均 授乳${weeklyAverage.feedingPerDay.toFixed(1)}回・おむつ${weeklyAverage.diaperPerDay.toFixed(1)}回`
    : "直近7日のグラフを見る"

  // 保存の後の確認（C1）: この画面で最後に付いた記録の、今の state の行（編集・取り消しに追従。
  // 取り消して行が無くなれば出さぬ）
  const lastSavedLog = useMemo(() => {
    if (lastSavedId === null) return null
    return (
      logs.find((l) => l.id === lastSavedId) ??
      weeklyLogs.find((l) => l.id === lastSavedId) ??
      growthLogs.find((l) => l.id === lastSavedId) ??
      null
    )
  }, [lastSavedId, logs, weeklyLogs, growthLogs])

  // 最新を確認できぬ範囲（C1）。選択日の記録の取得失敗はタイムラインが失敗として出すゆえ重ねぬ
  const staleMessage = describeStale(
    freshness,
    staleRanges(freshness, dateNavStatus === "error" ? ["logs"] : []),
  )
  const retryFreshness = useCallback(() => {
    void resyncLogs()
  }, [resyncLogs])

  // 引き継ぎの要約（C4）。週の窓を一度も取れておらねば数えぬ
  const handoff = useMemo(
    () =>
      summarizeHandoff({
        lastSeenAt: handoffLoaded ? handoffSince : null,
        rows: weeklyLogs,
        userId,
        windowStartIso: jstDayStartIso(fetchStartDate),
        failed: freshness.weekly.lastOkAt === null,
      }),
    [handoffLoaded, handoffSince, weeklyLogs, userId, fetchStartDate, freshness.weekly.lastOkAt],
  )
  const temperatureSummary = (() => {
    if (dateNavStatus !== "ready") return null
    const temps = visibleLogs.filter((l) => l.log_type === "temperature" && l.temperature !== null)
    if (temps.length === 0) return "この日の記録なし"
    const latest = [...temps].sort((a, b) => b.logged_at.localeCompare(a.logged_at))[0]
    return `最新 ${latest.temperature}℃`
  })()

  // 並びの方針（片手・夜間・記録の速さ）:
  // 1. 日付（今日か過去日か）→ 計測中の授乳 → 最終授乳と次の目安 → 記録の釦 → その日の数
  //    → タイムライン。記録に要る情報と釦を最初の 1 画面に集める
  // 2. 予定・体温・日記はタイムラインの近くに。週の傾向と成長曲線は畳む（必要な時に開く）
  // 以前は月齢カード・予定・まとめ 3 枚の後に釦が来て、タイムラインはグラフ 2 枚の下（約 2 画面下）
  return (
    <div className="flex flex-col gap-4 px-4 pt-12 pb-8">
      <div className="flex flex-col gap-1">
        <BabyDateNav
          selectedDate={selectedDate}
          today={today}
          onDateChange={setSelectedDate}
        />
        <BabyAgeHeader
          babyName={babyName}
          babyBirthDate={babyBirthDate}
          referenceDate={today}
          compact
        />
      </div>

      {/* 閉じたタイマーへ戻る導線（UX-04a）。シートが開いている間は出さぬ。過去日を見て
          おる間も出す（計測は日付に関わらず走っておる） */}
      {runningTimer && !timerOpen && (
        <RunningTimerChip
          running={runningTimer}
          onOpen={() => handleStartTimer(runningTimer.side)}
        />
      )}
      {/* 保存を確認中の記録（2026-10-27 A2）。クイック記録・記録シートで結果の分からなかった
          操作を、再読込の後も確かめられる。自動で行うのは照合の読みだけ（送信キューではない） */}
      <PendingSavesNotice
        owner={owner}
        onConfirmed={appendLogFromOtherPath}
        knownLogIds={knownLogIds}
      />

      <BabySummaryBar
        lastFeeding={lastFeeding}
        lastNursing={lastNursing}
        feedingIntervalMin={feedingIntervalMin}
        now={now}
        todayCounts={todayCounts}
        date={selectedDate}
        status={dateNavStatus}
      >
        {isToday ? (
          <>
          <BabyQuickActions
            userId={userId}
            householdId={householdId}
            onCreateLog={handleCreateLog}
            onCreateFeeding={handleCreateFeeding}
            onStartTimer={handleStartTimer}
            onLogRecorded={appendLog}
            onLogRemoved={removeLog}
            onLogUpdated={applyUpdatedLog}
            visibleLogs={visibleLogs}
            now={now}
            externalRecordSeq={externalRecordSeq}
            bottleDefault={bottleDefault}
          />
          {/* 保存の後の確認（C1）。記録の釦のすぐ下の決まった場所に、サーバの確定行で出す */}
          <BabyLastRecord log={lastSavedLog} today={today} />
          </>
        ) : (
          // 過去日は「今」のクイック記録を出さず、日付を見える形で確かめるフォーム経由の
          // 追記だけ（機能 C。F-03 の懸念に対する答え）
          <>
          <BabyPastDayActions
            date={selectedDate}
            onCreateLog={handleCreateLog}
            onCreateFeeding={handleCreateFeeding}
          />
          <BabyLastRecord log={lastSavedLog} today={today} />
          </>
        )}
      </BabySummaryBar>

      {/* 前回この端末で見てから（C4）。記録された事実だけ。何も無ければ描かぬ */}
      {isToday && !handoffDismissed && (
        <BabyHandoffSummary
          summary={handoff}
          today={today}
          scopeLabel="直近8日"
          onAcknowledge={acknowledgeHandoff}
        />
      )}

      {/* 今日・明日の予定（CAL-4）。「今日」の概念ゆえ今日を表示している時だけ出す。
          0 件なら null を返し gap ごと消える。復帰時の refetch はカード自身が持つ。 */}
      {/* 今日ごとに作り直す（key）。サーバが渡した予定は読込日の「今日・明日」ゆえ、
          開いたまま日を跨いだ後は使わず空で始めて取り直す — さもなくば前日の予定を
          「今日」と出し続ける（復帰の visibilitychange が来るまで直らぬ）。 */}
      {isToday && (
        <UpcomingEventsCard
          key={today}
          initialEvents={today === initialDate ? initialUpcomingEvents : []}
          householdId={householdId}
          initialToday={today}
          refetchOnMount={today !== initialDate}
          initialLoadFailed={today === initialDate && Boolean(initialLoadErrors.upcoming)}
          // 予定は予定の版で「前回この端末で見た」印を持つ（育児ログの印を流用せぬ。2026-10-28）
          seenOwner={owner}
          folded={!folds.isOpen("upcoming")}
          onFoldChange={(f) => folds.setOpen("upcoming", !f)}
        />
      )}

      {/* 最新を確認できぬ範囲と再試行（C1）。重要な知らせゆえ畳まぬ */}
      <BabyFreshnessNotice message={staleMessage} onRetry={retryFreshness} />

      <BabyTimeline
        logs={visibleLogs}
        status={dateNavStatus}
        onRetry={retryDateNav}
        onEdit={handleEdit}
        recorderLabelFor={recorderLabel}
        isToday={isToday}
      />

      {/* 朝/夜の体温（訴え③）。読む配列は選択日の logs（週窓の weeklyLogs ではない —
          週窓の外の過去日を開いた時に静かに空になるため）。isToday ゲートの**外**に
          置き、過去日は閲覧のみ（記録ボタンはカード側で今日限定に出し分ける）。 */}
      <HomeFoldFrame
        title="体温"
        summary={temperatureSummary}
        icon={<Thermometer size={20} />}
        open={folds.isOpen("temperature") || dateNavStatus === "error"}
        onOpenChange={(o) => folds.setOpen("temperature", o)}
      >
        <BabyTemperatureCard
          logs={visibleLogs}
          date={selectedDate}
          isToday={isToday}
          status={dateNavStatus}
          onEdit={handleEdit}
          onCreate={handleCreateTemperature}
        />
      </HomeFoldFrame>

      {/* その日の育児日記（1日1本・ぴよログ流）。全文を常時表示する。
          /baby/diary への導線はセクションヘッダの「すべて」に集約（旧 Link カード廃止）。 */}
      <BabyDailyDiary
        diary={visibleDiary}
        isToday={isToday}
        loading={!diaryReady && !diaryFailed}
        failed={diaryFailed}
        onRetry={retryDiary}
        hasDraft={diaryDraftExists}
        folded={!folds.isOpen("diary")}
        onFoldChange={(f) => folds.setOpen("diary", !f)}
        onEdit={() => {
          // 取得中は開かぬ（前の日の本文を新しい日の下書きにせぬ）。ボタンも隠しておるが、
          // 二重の防御（レビュー P2-4）
          if (!diaryReady) return
          setDiaryKey((k) => k + 1)
          setDiaryEditOpen(true)
        }}
      />

      {/* 週の傾向と成長曲線は畳む（必要な時に開く）。窓の契約（表示 7 日・取得 8 日・
          平均は昨日まで）は中身の BabyWeeklySummary が従来どおり持つ */}
      <BabyCollapsibleSection
        title="週間サマリー"
        summary={weeklyHeadline}
        icon={<BarChart3 size={20} />}
        open={folds.isOpen("weekly")}
        onOpenChange={(o) => folds.setOpen("weekly", o)}
      >
        <BabyWeeklySummary
          days={weeklySummary}
          diaperBreakdown={weeklyDiaperBreakdown}
          average={weeklyAverage}
          embedded
        />
      </BabyCollapsibleSection>

      <BabyCollapsibleSection
        title="成長の記録"
        summary={growthLatestSummary(growthSeries)}
        icon={<TrendingUp size={20} />}
        open={folds.isOpen("growth")}
        onOpenChange={(o) => folds.setOpen("growth", o)}
      >
        <GrowthChartSection series={growthSeries} embedded birthDate={babyBirthDate} sex={babySex} />
      </BabyCollapsibleSection>

      {/* 再マウント用の key は兄弟（BabyLogFormSheet）と名前空間を分ける。どちらも
          0 から数える数値ゆえ、素の数値だと値が揃った瞬間に重複 key になり、React が
          fiber を取り違える（"Encountered two children with the same key"） */}
      <BabyDiaryEditSheet
        key={`diary-${diaryKey}`}
        open={diaryEditOpen}
        onOpenChange={setDiaryEditOpen}
        diaryDate={selectedDate}
        initialContent={visibleDiary?.content ?? ""}
        initialUpdatedAt={visibleDiary?.updated_at ?? null}
        onSaved={handleDiarySaved}
        owner={owner}
      />

      <BabyLogFormSheet
        key={`log-${formKey}`}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        log={editingLog}
        createLogType={createLogType}
        createFeedingType={createFeedingType}
        createAmountMl={createAmountMl}
        createDate={selectedDate}
        userId={userId}
        householdId={householdId}
        recorderLabel={
          editingLog && recorderLabel ? recorderLabel(editingLog.logged_by) : null
        }
        onLogRecorded={appendLogFromOtherPath}
        onLogUpdated={applyUpdatedLog}
        onLogRemoved={removeLog}
        // 保存の衝突の後、最新の行で開き直す（key で作り直し、最新の版から seed。P2-07）
        onReloadLog={handleEdit}
      />

      <FeedingTimer
        open={timerOpen}
        onOpenChange={setTimerOpen}
        initialFeedingType={timerFeedingType}
        userId={userId}
        householdId={householdId}
        onRunningChange={handleRunningChange}
        // 深夜跨ぎ（前日行）も同じ appendLog へ: 行の日付で logs・週窓・成長・最終授乳の
        // fallback を振り分ける（かつては前日行だけ別の callback で fallback のみ更新して
        // おり、昨日を表示中に昨日の行が出ず、週グラフも再取得まで古いままじゃった。P3-8）
        onLogRecorded={appendLogFromOtherPath}
      />
    </div>
  )
}

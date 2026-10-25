"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import {
  Thermometer,
  Ruler,
  StickyNote,
  ChevronLeft,
  Timer,
  Loader2,
  Undo2,
  CircleCheck,
} from "lucide-react"
import { toast } from "sonner"
import { formatTimeJst } from "@/lib/utils/date-jst"
import {
  recordFeeding,
  recordDiaper,
  deleteLog,
} from "@/app/(main)/baby/actions"
import { buildOptimisticLog } from "@/lib/domain/baby-optimistic-log"
import { newClientId } from "@/lib/utils/client-id"
import {
  formatDiaperSummary,
  getDiaperTypeLabel,
  getFeedingTypeLabel,
} from "@/lib/utils/baby-log-labels"
// 通信断で Server Action が reject すると、startTransition 内の unhandled reject が
// 最寄りの error boundary へ bubble し全画面エラー化 + 記録が無言で失われる。
// 各ハンドラの reject を握ってトーストへ倒す（機序の詳細は offline-error.ts）。
import { toastOfflineError } from "@/lib/utils/offline-error"
import type {
  BabyLogType,
  FeedingType,
  DiaperType,
  PoopAmount,
} from "@/lib/types/database"
import type { BabyLogData } from "@/lib/types/baby"

/**
 * 授乳の 1 段目。母乳（左/右）はタイマーを開く、搾乳は量のシートを開く、ミルク・離乳食は
 * その場で記録する。挙動が違う釦を同じ見た目で横一列に並べると、夜間に「左」のつもりで
 * 「ミルク」を押して無言で記録される — ゆえに母乳だけを大きな 2 釦の段に分け、タイマーの
 * 印を添える。釦の名前（左 / 右 / ミルク …）は e2e・単体テストが exact で掴む契約ゆえ
 * 文字は足さぬ（印は aria-hidden のアイコンだけ）。
 */
const BREAST_OPTIONS: { value: FeedingType; label: string }[] = [
  { value: "breast_left", label: "左" },
  { value: "breast_right", label: "右" },
]

const OTHER_FEEDING_OPTIONS: { value: FeedingType; label: string }[] = [
  { value: "bottle", label: "ミルク" },
  { value: "pumped", label: "搾乳" },
  { value: "solid", label: "離乳食" },
]

/**
 * 直前の記録の取り消しを、トーストが消えた後も画面に残す時間。トーストは数秒で消え、
 * 抱っこ中・夜間はそれに間に合わぬ。5 分は「押し間違いに気づいて戻す」には十分で、
 * 次の記録（最短でも数十分後）とは重ならぬ。
 */
export const INLINE_UNDO_MS = 5 * 60_000

/** 直前に記録した 1 件（取り消しの対象）。トーストとインラインの両方がこれを指す */
interface LastRecorded {
  logId: string
  /** 作成時にサーバが返した版。取り消しはこの版でしか消せぬ */
  version: string
  /** 「おむつ」「授乳」— 取り消しトーストの語 */
  label: string
  /** 何を記録したか（「おしっこ」「ミルク」）。インラインの帯に出す */
  summary: string
  /** 記録した時刻（epoch ms。event handler で読む） */
  at: number
  /**
   * 記録した時点での「他の経路（タイマー・記録シート）の記録」の通し番号。親の番号が進んだら
   * この記録はもう「直前」ではないゆえ帯を畳む（externalRecordSeq の注記）
   */
  seq: number
}

/** 取り消しの期限切れを伝える文言（帯・トーストで同じ） */
const UNDO_EXPIRED_MESSAGE =
  "取り消しの期限（5分）を過ぎました。消す場合は記録の一覧から開いて削除してください"

/** 取り消しトーストの id。インラインで取り消した時に同じトーストを閉じるため */
function undoToastId(logId: string): string {
  return `baby-undo:${logId}`
}

/**
 * 「直前の記録」を記録した時刻。時計（Date.now）は描画中に読まぬよう、component の外で
 * event handler / transition の中からだけ呼ぶ（resolveRetryClientId と同じ扱い）。
 */
function recordedAtNow(): number {
  return Date.now()
}

/** 押した瞬間の実時計で、インラインの取り消しの期限を過ぎたか（event handler からだけ呼ぶ） */
function isInlineUndoExpired(recordedAt: number): boolean {
  return Date.now() - recordedAt >= INLINE_UNDO_MS
}

const QUICK_BASE =
  "flex items-center justify-center gap-1.5 rounded-xl font-medium transition-colors duration-200 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
const FEEDING_TONE =
  "bg-amber-50 text-amber-900 hover:bg-amber-100 active:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-100 dark:hover:bg-amber-900/50 dark:active:bg-amber-900/70"
const BREAST_TONE =
  "border border-amber-300 bg-amber-100 text-amber-900 hover:bg-amber-200 active:bg-amber-300 dark:border-amber-700/60 dark:bg-amber-900/50 dark:text-amber-50 dark:hover:bg-amber-900/70 dark:active:bg-amber-800/80"
const DIAPER_TONE =
  "bg-sky-50 text-sky-900 hover:bg-sky-100 active:bg-sky-200 dark:bg-sky-900/30 dark:text-sky-100 dark:hover:bg-sky-900/50 dark:active:bg-sky-900/70"

const DIAPER_OPTIONS: { value: DiaperType; label: string }[] = [
  { value: "pee", label: "おしっこ" },
  { value: "poop", label: "うんち" },
  { value: "both", label: "両方" },
]

/** うんちを含む種別（量を選ぶ 2 段目へ進む）。DB CHECK chk_poop_amount_only_poop と同じ集合 */
type PoopDiaperType = Extract<DiaperType, "poop" | "both">

/**
 * 通信断の後の再タップを「同じ操作の再試行」とみなす期限。これを過ぎた同じ種別のタップは
 * 新しい記録（新しい冪等 id）。2 分は、圏外から戻って押し直す間隔としては十分に長く、
 * 次の授乳・おむつ（最短でも数十分後）とは重ならぬ。
 */
export const RETRY_WINDOW_MS = 2 * 60_000

interface PendingRetryId {
  key: string
  id: string
  /** 作った時刻（epoch ms）。RETRY_WINDOW_MS を過ぎたら再利用せぬ */
  at: number
}

/**
 * 操作（key）に対する冪等 id。期限内の同じ操作なら前の id を返し、それ以外は新しく作る。
 * 時計（Date.now）は描画中に読まぬよう、component の外で event handler からだけ呼ぶ。
 */
function resolveRetryClientId(
  ref: { current: PendingRetryId | null },
  key: string,
): string {
  const pending = ref.current
  const now = Date.now()
  if (pending && pending.key === key && now - pending.at < RETRY_WINDOW_MS) {
    return pending.id
  }
  const id = newClientId()
  ref.current = { key, id, at: now }
  return id
}

/**
 * うんちの量の選択肢（2 段目）。「指定なし」は従来どおり量なし（poop_amount = null）で
 * 記録する逃げ道 — 見ていない・急いでいる時に 2 段目で詰まらせない。
 */
const POOP_AMOUNT_OPTIONS: { value: PoopAmount | null; label: string }[] = [
  { value: "small", label: "少量" },
  { value: "large", label: "大量" },
  { value: null, label: "指定なし" },
]

interface BabyQuickActionsProps {
  /** 記録者（logged_by）。楽観 append 行の作成に使う（B-03） */
  userId: string
  onCreateLog: (type: BabyLogType) => void
  /** 搾乳など量ベースの授乳を create シートで開く（母乳のタイマー導線とは別） */
  onCreateFeeding: (type: FeedingType) => void
  onStartTimer: (type: FeedingType) => void
  /**
   * 記録成功時に楽観 append する行を親へ渡す（B-03）。Realtime 単一経路を脱し、
   * #92 不達下でも timeline/回数を即時更新する。既存 echo は id 重複で吸収。
   *
   * 前提: quick actions は isToday ゲート下でのみ描画されるため、ここで作る行の
   * logged_at（client now）は常に選択日（当日）= timeline 窓と一致する（安全前提）。
   */
  onLogRecorded?: (log: BabyLogData) => void
  /** Undo 成功時にローカル state から除去する行の id を親へ渡す（B-03） */
  onLogRemoved?: (id: string) => void
  /**
   * 取り消しが衝突した時（記録の後に家族・自分の別端末が直していた）、サーバが返した最新の
   * 行を親へ渡す。行は消えておらぬゆえ画面から外さず、最新版へ揃える（編集シートの衝突と
   * 同じ反映関数 = BabyDashboard の applyUpdatedLog）。
   */
  onLogUpdated?: (log: BabyLogData) => void
  /**
   * 画面に今ある行（選択日の logs）。直前の記録が編集シートでの削除・再取得で消えた時に
   * インラインの取り消しを畳む（消えた行の「取り消す」は誤操作に見えるだけ）。
   * 省略時は存在を確かめぬ（期限だけで畳む）。
   */
  visibleLogs?: BabyLogData[]
  /**
   * 親の時計（ダッシュボードの useNow）。インラインの取り消しの期限判定に使う。描画中に
   * 壁時計を読まぬため（today-clock-contract と同じ理由）。省略時は期限で畳まぬ。
   */
  now?: Date
  /**
   * 他の経路（授乳タイマー・記録シート）で記録が付くたびに親が進める通し番号。クイック記録の
   * 後にタイマー等で記録したら、帯の記録はもう「直前」ではない — 「直前の記録を取り消す」が
   * 古い方を消す誤操作にならぬよう畳む。省略時は確かめぬ。
   */
  externalRecordSeq?: number
}

export function BabyQuickActions({
  userId,
  onCreateLog,
  onCreateFeeding,
  onStartTimer,
  onLogRecorded,
  onLogRemoved,
  onLogUpdated,
  visibleLogs,
  now,
  externalRecordSeq,
}: BabyQuickActionsProps) {
  const [isPending, startTransition] = useTransition()
  /** いま処理中の釦（押した釦だけにスピナーを出す。全釦の disabled は二重記録防止で維持） */
  const [busyKey, setBusyKey] = useState<string | null>(null)
  /**
   * 直前の記録（取り消しの対象）。トーストの「取り消す」とインラインの「取り消す」は
   * 同じこの 1 件を指し、どちらかを押せば両方とも消える（同じ行へ deleteLog を二度
   * 送って「既に削除」のエラーを見せぬ）。
   */
  const [lastRecorded, setLastRecorded] = useState<LastRecorded | null>(null)
  /**
   * 取り消しのトーストがまだ画面に出ておる記録の id。トーストはナビの上（下端）に出て
   * 釦群の直下の帯に重なり、帯の「取り消す」を覆う（統合検証で実測。safe-area のある
   * iPhone では帯の中央がトーストの下になる）。同じ 1 件の取り消しが二段に重なって見えぬよう、
   * トーストが出ておる間は帯を伏せ、消えた（自動で閉じた・閉じられた）後の残り時間だけ帯が受け持つ。
   */
  const [toastOpenFor, setToastOpenFor] = useState<string | null>(null)
  /** 取り消しを送った id（トーストとインラインの二重押しを 1 回に畳む） */
  const undoneIdsRef = useRef(new Set<string>())
  /**
   * 親の通し番号（externalRecordSeq）の最新値。記録の応答は通信の後に届き、その間にタイマー等で
   * 別の記録が付くと番号が進む。押した時点の値（描画の閉包）を使うと、後に届いたクイック記録の
   * 帯が誤って伏せられる。応答が届いた時点の値を読むため ref に写す。
   */
  const externalSeqRef = useRef(externalRecordSeq ?? 0)
  useEffect(() => {
    externalSeqRef.current = externalRecordSeq ?? 0
  }, [externalRecordSeq])
  /**
   * うんち / 両方 をタップした直後の「量を選ぶ」段。おしっこは従来どおり 1 タップで
   * 記録し、うんちを含む時だけ 2 タップ目で 少量 / 大量 / 指定なし を選ぶ。
   * 粘着する事前選択（先に量を選んでから種別を押す）にしないのは、押し忘れが
   * 前回の量を引き継ぐ無音の誤記録になるため。記録の成否にかかわらず必ず戻す。
   */
  const [pendingPoop, setPendingPoop] = useState<PoopDiaperType | null>(null)

  /**
   * 冪等 id（P2-08）。通信断で reject した直後に**同じ操作**をもう一度押した時は、前と
   * 同じ id を送る — 「保存は DB で成立したが応答だけ失われた」再試行で同じ記録が二重に
   * 増えぬよう、サーバが主キー重複を「記録済み」として吸収する。
   * サーバが拒んだ（検証エラー）・成功した後は意図が変わりうるゆえ捨てる。
   * 別の操作（種別が違う）を押した時も新しい id にする。
   *
   * 再利用には期限（RETRY_WINDOW_MS）を置く。期限が無いと、数時間後の「新しい授乳」の
   * タップが過去の保存に吸収され、成功と出るのに行が増えぬ（目に見える重複が、見えぬ
   * 消失に化ける）。期限内の再タップだけを再試行とみなす。
   */
  const retryIdRef = useRef<PendingRetryId | null>(null)
  function clientIdFor(key: string): string {
    return resolveRetryClientId(retryIdRef, key)
  }
  function settleClientId() {
    retryIdRef.current = null
  }

  // 片手操作での押し間違いをその場で取り消せるようにする（記録直後のトーストから）。
  // 取り消しは作成に成功した時の版でしか消せぬ — 記録の後に家族（または自分の別端末・
  // 編集シート）が直していたら、直された記録を消さず衝突として返る。
  function undoLog(
    logId: string,
    createdVersion: string,
    label: string,
    summary: string,
    /** 記録した時刻（epoch ms）。帯を戻す時にこの時刻のまま出す（失敗した時刻にせぬ） */
    recordedAt: number,
    /** 記録した時点の他経路の通し番号（LastRecorded.seq）。帯を戻す時もこの値のまま */
    seq: number,
  ) {
    // トーストとインラインのどちらから来ても 1 回だけ送る
    if (undoneIdsRef.current.has(logId)) return
    undoneIdsRef.current.add(logId)
    setLastRecorded((prev) => (prev?.logId === logId ? null : prev))
    toast.dismiss(undoToastId(logId))
    // トーストはもう無い（失敗して帯を戻す時に、伏せたままにせぬ）
    setToastOpenFor((prev) => (prev === logId ? null : prev))
    // 送れなかった（通信断・サーバの一時エラー）時は、取り消しの口を帯に戻して押し直せる
    // ようにする。衝突（家族が直した）と既に削除済みは戻さぬ（押しても同じ結果になる）。
    // 時刻は記録した時刻のまま — 失敗した時刻で作り直すと帯の時刻が嘘になり、期限も延びる
    const restore = () => {
      undoneIdsRef.current.delete(logId)
      setLastRecorded((prev) =>
        prev ?? { logId, version: createdVersion, label, summary, at: recordedAt, seq },
      )
    }
    setBusyKey("undo")
    startTransition(async () => {
      try {
        const result = await deleteLog(logId, createdVersion)
        if (result.conflict) {
          // 消えておらぬゆえ画面から外さず、最新版へ揃える。「取り消しました」とは偽らぬ
          onLogUpdated?.(result.conflict.current)
          toast.error(
            `${label}の記録は後から更新されていたため、取り消しませんでした（家族またはご自身）。必要なら記録の一覧から確かめてください`,
          )
          return
        }
        if (result.error) {
          toast.error(result.error)
          // 他端末で既に削除済み: 画面に残る幽霊行を外す（P1-04）
          if (result.alreadyDeleted) onLogRemoved?.(logId)
          else restore()
          return
        }
        // B-03: Realtime DELETE echo を待たずローカル state からも除去
        onLogRemoved?.(logId)
        toast.success(`${label}の記録を取り消しました`)
      } catch (err) {
        restore()
        toastOfflineError("[baby-quick-actions] deleteLog(undo)", err)
      }
    })
  }

  /**
   * 記録成功のトースト。「取り消す」は id とサーバが返した版（`updatedAt`）が揃った時だけ
   * 出す。版をローカルの時計（new Date()）から作ってはならぬ — 表記もマイクロ秒も DB と
   * 一致せず、取り消しが必ず衝突するか、版ガードを素通りする形に崩れる。版が無い応答では
   * 安全な取り消しを出せぬゆえ、一覧から消せることだけ伝える。
   */
  function successWithUndo(
    message: string,
    label: string,
    logId: string | null,
    createdVersion: string | null | undefined,
    summary: string,
  ) {
    if (logId && createdVersion) {
      const at = recordedAtNow()
      // 応答が届いた時点の番号（externalSeqRef の注記）
      const seq = externalSeqRef.current
      setLastRecorded({ logId, version: createdVersion, label, summary, at, seq })
      setToastOpenFor(logId)
      // トーストが消えたら帯へ引き継ぐ（toastOpenFor の注記）。別の記録のトーストへ
      // 替わった後に古い方が消えても、新しい方の伏せを解かぬよう id で比べる
      const handOver = () =>
        setToastOpenFor((prev) => (prev === logId ? null : prev))
      toast.success(message, {
        id: undoToastId(logId),
        action: {
          label: "取り消す",
          onClick: () => {
            // sonner は端末が眠っておる間トーストの時計を止める。何時間も後に戻った時の
            // トーストからも、帯と同じ 5 分の期限で取り消しを断る（帯との期限のずれを無くす）
            if (isInlineUndoExpired(at)) {
              setLastRecorded((prev) => (prev?.logId === logId ? null : prev))
              toast.error(UNDO_EXPIRED_MESSAGE)
              return
            }
            undoLog(logId, createdVersion, label, summary, at, seq)
          },
        },
        onAutoClose: handOver,
        onDismiss: handOver,
      })
    } else if (logId) {
      // 安全に取り消せぬ記録が「直前の記録」になった。前の記録の帯は畳む（帯が指す
      // 「直前」と実際の直前が食い違わぬよう）
      setLastRecorded(null)
      toast.success(message, {
        description: "取り消すには、記録の一覧から開いて削除してください",
      })
    } else {
      setLastRecorded(null)
      toast.success(message)
    }
  }

  // 授乳ボタンの振り分け: 母乳（左/右）はタイマー、搾乳は量入力のため create シート、
  // ミルク/離乳食は即時記録（従来どおり）。
  function handleFeedingOption(value: FeedingType) {
    if (value === "breast_left" || value === "breast_right") {
      onStartTimer(value)
    } else if (value === "pumped") {
      onCreateFeeding(value)
    } else {
      handleFeeding(value)
    }
  }

  function handleFeeding(feedingType: FeedingType) {
    const clientId = clientIdFor(`feeding:${feedingType}`)
    setBusyKey(`feeding:${feedingType}`)
    startTransition(async () => {
      try {
        const result = await recordFeeding({ feedingType, clientId })
        // 応答が届いた（成功でも拒否でも）ゆえ、この意図の id は役目を終えた
        settleClientId()
        if (result.error) {
          toast.error(result.error)
          return
        }
        // 応答を失った前回の保存が受理されていた（二重には記録していない）。手元の行は
        // 既に resync / Realtime で入っているか、これから入る。「取り消す」は出さぬ
        // （前回の本物の行を消す導線になる）
        if (result.replayed) {
          // 応答を失った前回の記録が「直前」になった。帯の古い記録は畳む（取り消しの誤指し防止）
          setLastRecorded(null)
          toast.success("授乳は既に記録されています（二重には記録していません）")
          return
        }
        // B-03: 返却 id で楽観 append（Realtime を待たず timeline/回数を即時更新）
        if (result.id) {
          onLogRecorded?.(
            buildOptimisticLog({
              id: result.id,
              updatedAt: result.updatedAt ?? null,
              logType: "feeding",
              loggedBy: userId,
              feedingType,
            }),
          )
        }
        successWithUndo(
          "授乳を記録しました",
          "授乳",
          result.id,
          result.updatedAt,
          getFeedingTypeLabel(feedingType),
        )
      } catch (err) {
        // 通信断: 記録がサーバで成立したか分からぬ。成立しておれば帯の記録は「直前」でない
        setLastRecorded(null)
        toastOfflineError("[baby-quick-actions] recordFeeding", err)
      }
    })
  }

  // おむつボタンの振り分け: おしっこは即時記録、うんち / 両方 は量を選ぶ 2 段目へ。
  function handleDiaperOption(value: DiaperType) {
    if (value === "poop" || value === "both") {
      setPendingPoop(value)
      return
    }
    handleDiaper(value, null)
  }

  function handleDiaper(diaperType: DiaperType, poopAmount: PoopAmount | null) {
    const clientId = clientIdFor(`diaper:${diaperType}:${poopAmount ?? ""}`)
    // 2 段目（量）から押した時は量の釦、1 段目（おしっこ）はその釦にスピナーを出す
    setBusyKey(
      diaperType === "poop" || diaperType === "both"
        ? `amount:${poopAmount ?? "none"}`
        : `diaper:${diaperType}`,
    )
    startTransition(async () => {
      try {
        const result = await recordDiaper({ diaperType, poopAmount, clientId })
        settleClientId()
        if (result.error) {
          toast.error(result.error)
          return
        }
        if (result.replayed) {
          // 応答を失った前回の記録が「直前」になった。帯の古い記録は畳む（取り消しの誤指し防止）
          setLastRecorded(null)
          toast.success("おむつ交換は既に記録されています（二重には記録していません）")
          return
        }
        // B-03: 返却 id で楽観 append（feeding/diaper は UNIQUE 防御が無いため、
        // #92 下の再タップ二重記録を止血する本命経路）
        if (result.id) {
          onLogRecorded?.(
            buildOptimisticLog({
              id: result.id,
              updatedAt: result.updatedAt ?? null,
              logType: "diaper",
              loggedBy: userId,
              diaperType,
              poopAmount,
            }),
          )
        }
        // 何を記録したか（うんち（大量）等）をトーストで確認できるようにする
        successWithUndo(
          `おむつ交換を記録しました（${formatDiaperSummary(diaperType, poopAmount)}）`,
          "おむつ",
          result.id,
          result.updatedAt,
          formatDiaperSummary(diaperType, poopAmount),
        )
      } catch (err) {
        // 通信断: 記録がサーバで成立したか分からぬ。成立しておれば帯の記録は「直前」でない
        setLastRecorded(null)
        toastOfflineError("[baby-quick-actions] recordDiaper", err)
      } finally {
        // 成否にかかわらず 1 段目へ戻す（失敗時に 2 段目へ張り付くと、再タップで
        // 種別を選び直せず「うんちだったのか」が分からなくなる）
        setPendingPoop(null)
      }
    })
  }

  // 押した釦だけにスピナー（処理中が終われば消える）。名前は変えぬ（アイコンは aria-hidden）
  const busy = (key: string) => isPending && busyKey === key
  const spinner = (key: string) =>
    busy(key) ? (
      <Loader2 size={16} className="animate-spin" aria-hidden="true" />
    ) : null

  // 直前の記録の取り消し（インライン）。期限内で、まだ画面に行が在る時だけ出す
  const showInlineUndo =
    lastRecorded !== null &&
    // 同じ記録の取り消しトーストが出ておる間は伏せる（重ならぬよう）
    toastOpenFor !== lastRecorded.logId &&
    (now === undefined || now.getTime() - lastRecorded.at < INLINE_UNDO_MS) &&
    (visibleLogs === undefined ||
      visibleLogs.some((l) => l.id === lastRecorded.logId)) &&
    // 後からタイマー・記録シートで付いた記録があれば、もう「直前」ではない
    (externalRecordSeq === undefined || lastRecorded.seq === externalRecordSeq)

  return (
    <section aria-label="すぐに記録" className="flex flex-col gap-4">
      {/* 授乳: 母乳（タイマーを開く）を大きな 2 釦に分け、その場で記録する釦と見分ける */}
      <div role="group" aria-labelledby="quick-feeding-heading" className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between px-1">
          <span id="quick-feeding-heading" className="text-sm font-semibold">
            授乳
          </span>
          <span className="text-sm text-muted-foreground">
            母乳の左・右はタイマーを開きます
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {BREAST_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => handleFeedingOption(opt.value)}
              disabled={isPending}
              className={`${QUICK_BASE} ${BREAST_TONE} min-h-16 text-xl font-semibold`}
            >
              <Timer size={20} aria-hidden="true" />
              {opt.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {OTHER_FEEDING_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => handleFeedingOption(opt.value)}
              disabled={isPending}
              className={`${QUICK_BASE} ${FEEDING_TONE} min-h-12 text-base`}
            >
              {spinner(`feeding:${opt.value}`)}
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Diaper: 1 段目は種別、うんちを含む種別を選ぶと同じ行が量の選択へ入れ替わる */}
      <div role="group" aria-labelledby="quick-diaper-heading" className="flex flex-col gap-2">
        <span id="quick-diaper-heading" className="px-1 text-sm font-semibold">
          {pendingPoop === null
            ? "おむつ"
            : `${getDiaperTypeLabel(pendingPoop)}・うんちの量`}
        </span>
        {pendingPoop === null ? (
          <div className="grid grid-cols-3 gap-2">
            {DIAPER_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleDiaperOption(opt.value)}
                disabled={isPending}
                className={`${QUICK_BASE} ${DIAPER_TONE} min-h-14 text-base`}
              >
                {spinner(`diaper:${opt.value}`)}
                {opt.label}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              aria-label="おむつの種類に戻る"
              onClick={() => setPendingPoop(null)}
              disabled={isPending}
              className="flex min-h-14 min-w-12 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground transition-colors duration-200 hover:text-foreground disabled:opacity-50"
            >
              <ChevronLeft size={20} />
            </button>
            {POOP_AMOUNT_OPTIONS.map((opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => handleDiaper(pendingPoop, opt.value)}
                disabled={isPending}
                className={`${QUICK_BASE} ${DIAPER_TONE} min-h-14 flex-1 text-base`}
              >
                {spinner(`amount:${opt.value ?? "none"}`)}
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* その他（体温・成長・メモ）。記録シートを開く */}
      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => onCreateLog("temperature")}
          disabled={isPending}
          className={`${QUICK_BASE} min-h-12 bg-rose-50 text-sm text-rose-900 hover:bg-rose-100 active:bg-rose-200 dark:bg-rose-900/30 dark:text-rose-100 dark:hover:bg-rose-900/50 dark:active:bg-rose-900/70`}
        >
          <Thermometer size={16} aria-hidden="true" />
          体温
        </button>
        <button
          type="button"
          onClick={() => onCreateLog("growth")}
          disabled={isPending}
          className={`${QUICK_BASE} min-h-12 bg-teal-50 text-sm text-teal-900 hover:bg-teal-100 active:bg-teal-200 dark:bg-teal-900/30 dark:text-teal-100 dark:hover:bg-teal-900/50 dark:active:bg-teal-900/70`}
        >
          <Ruler size={16} aria-hidden="true" />
          成長
        </button>
        <button
          type="button"
          onClick={() => onCreateLog("memo")}
          disabled={isPending}
          className={`${QUICK_BASE} min-h-12 bg-gray-100 text-sm text-gray-800 hover:bg-gray-200 active:bg-gray-300 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 dark:active:bg-gray-600`}
        >
          <StickyNote size={16} aria-hidden="true" />
          メモ
        </button>
      </div>

      {/* 直前の記録と取り消し。釦群の**下**に出す（上に出すと釦が押し下がり、次のタップが
          ずれる）。トーストの「取り消す」と同じ 1 件を指し、どちらかを押せば両方消える。
          釦の名前に記録の中身を入れぬ — タイムライン行（/うんち（大量）/ 等）と名前を
          奪い合わせぬため。代わりに記録の時刻を名前に入れ、読み上げでもどの記録かを判る
          ようにする。live region にはせぬ（記録の通知はトーストが既に読み上げる。二重にせぬ） */}
      {showInlineUndo && lastRecorded && (
        <div
          data-testid="inline-undo"
          className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/50 py-1 pr-1 pl-3"
        >
          <CircleCheck
            size={18}
            className="shrink-0 text-emerald-700 dark:text-emerald-400"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-sm">
            {formatTimeJst(new Date(lastRecorded.at).toISOString())}{" "}
            {lastRecorded.summary}を記録しました
          </span>
          <button
            type="button"
            aria-label={`直前の記録（${formatTimeJst(new Date(lastRecorded.at).toISOString())}）を取り消す`}
            onClick={() => {
              // 親の時計は分刻みで、端末が眠っていた間は止まる。押した瞬間の実時計で期限を
              // 確かめ、期限切れの記録は取り消さぬ（版ガードで安全ではあるが 5 分の約束を守る）
              if (isInlineUndoExpired(lastRecorded.at)) {
                setLastRecorded(null)
                toast.error(UNDO_EXPIRED_MESSAGE)
                return
              }
              undoLog(
                lastRecorded.logId,
                lastRecorded.version,
                lastRecorded.label,
                lastRecorded.summary,
                lastRecorded.at,
                lastRecorded.seq,
              )
            }}
            disabled={isPending}
            className="flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-3 text-sm font-medium text-foreground transition-colors duration-200 hover:bg-muted active:bg-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {busy("undo") ? (
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            ) : (
              <Undo2 size={16} aria-hidden="true" />
            )}
            取り消す
          </button>
        </div>
      )}
    </section>
  )
}

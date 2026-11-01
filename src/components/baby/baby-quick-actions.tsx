"use client"

import { useChildScope } from "./child-scope"

import { useEffect, useId, useRef, useState, useTransition } from "react"
import {
  Thermometer,
  Ruler,
  StickyNote,
  ChevronLeft,
  Timer,
  Loader2,
  Undo2,
  CircleCheck,
  Pencil,
  Settings2,
} from "lucide-react"
import { toast } from "sonner"
import { formatTimeJst } from "@/lib/utils/date-jst"
import { getLogSummary } from "@/lib/domain/baby-log-summary"
import { formatBottleAmount, type BottleDefaultState } from "@/lib/domain/bottle-default"
import type { BottleDefaultController } from "@/lib/hooks/use-bottle-default"
import {
  BottleDefaultSheet,
  type BottleDefaultSheetIntent,
} from "./bottle-default-sheet"
import {
  recordFeeding,
  recordDiaper,
  deleteLog,
} from "@/app/(main)/baby/actions"
import { buildOptimisticLog } from "@/lib/domain/baby-optimistic-log"
import { newClientId } from "@/lib/utils/client-id"
import {
  phaseAfterFailure,
  SAVE_CONFLICT_MESSAGE,
  type SaveOwner,
} from "@/lib/domain/save-attempt"
import {
  listPendingSaves,
  putPendingSave,
  removePendingSave,
  PENDING_SAVE_SCHEMA_VERSION,
  PAGE_LIFE_ID,
  mayHaveLanded,
  type PendingSave,
  type PendingSaveAction,
} from "@/lib/domain/pending-saves-storage"
import {
  formatDiaperSummary,
  getDiaperTypeLabel,
  getFeedingTypeLabel,
} from "@/lib/utils/baby-log-labels"
// 通信断で Server Action が reject すると、startTransition 内の unhandled reject が
// 最寄りの error boundary へ bubble し全画面エラー化 + 記録が無言で失われる。
// 各ハンドラの reject を握ってトーストへ倒す（機序の詳細は offline-error.ts）。
import { toastOfflineError } from "@/lib/utils/offline-error"
import { noteServerActionFailure, STALE_CLIENT_ACTION_MESSAGE } from "@/lib/pwa/app-version"
import type {
  BabyLogType,
  FeedingType,
  DiaperType,
  PoopAmount,
} from "@/lib/types/database"
import type { BabyLogData } from "@/lib/types/baby"

/**
 * 授乳の 1 段目。母乳（左/右）はタイマーを開く、搾乳は量のシートを開く、ミルクはいつもの量で・
 * 離乳食はそのまま、その場で記録する。挙動が違う釦を同じ見た目で横一列に並べると、夜間に「左」のつもりで
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
   * 記録時刻（DB が書いた logged_at）。画面に行が無い時の帯の時刻（行が在ればその行の時刻を
   * 出す — 記録の後に編集で直した時刻も帯へ映す）。端末時計で組むと、分を跨いだ時に行と帯の
   * 時刻が食い違う。取り消しの期限は端末時計どうしの at で測る
   */
  loggedAt: string
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

/** 期限の後に、確認中の同じ操作とは別の id で記録した時の知らせ（黙って二重にせぬ。v8） */
export const SEPARATE_FROM_PENDING_NOTE =
  "。「保存を確認中の記録」の前の操作とは別の記録です（同じ記録だった時は「取り消す」で戻せます）"
/** 同上で、記録済みでした（replayed）の時（取り消しの帯は出ぬゆえ、戻し方は記録の一覧で） */
export const SEPARATE_FROM_PENDING_REPLAY_NOTE =
  "。「保存を確認中の記録」の前の操作とは別の記録です（同じ記録だった時は記録を開いて削除できます）"
/** 同上で、新しい id の送信も結果不明になった時 */
export const SEPARATE_FROM_PENDING_UNKNOWN_NOTE =
  "（「保存を確認中の記録」の前の操作とは別の記録として送りました）"

/**
 * retryKey を持たぬ控え（記録シートの作成）の送信内容から、クイック記録の同じ操作の鍵を導く
 * （`feeding:<種別>` / `diaper:<種別>:<うんちの量>`。handleFeeding / handleDiaper の鍵と同じ形）。
 * 種類を読めぬ控えは null（どの鍵とも一致せぬ）。
 */
function quickKeyOfPayload(p: PendingSave): string | null {
  const payload = p.payload
  if (p.action === "recordFeeding" && typeof payload.feedingType === "string") {
    return `feeding:${payload.feedingType}`
  }
  if (p.action === "recordDiaper" && typeof payload.diaperType === "string") {
    const amount = typeof payload.poopAmount === "string" ? payload.poopAmount : ""
    return `diaper:${payload.diaperType}:${amount}`
  }
  return null
}

interface PendingRetryId {
  key: string
  id: string
  /** 最初の押下の時刻（epoch ms・端末の時計）。一覧の目印にだけ使い、記録時刻には使わぬ（N3） */
  at: number
  /**
   * 押し直しの期限の起点（epoch ms）。最初は押下の時刻、結果不明と分かったらその時刻へ進める —
   * 遅い失敗の後でも「2分以内に押し直せば同じ記録」の約束を守る（独立レビュー 2 周目）
   */
  windowFrom: number
  /**
   * 同じ画面での期限の起点（経過の時計 = performance.now）。同じ画面の中の期限はこれで測る —
   * 端末の時計を直す（壁時計が跳ぶ）と、壁時計の差では 1 分後の押し直しが「期限切れ」になって
   * 新しい id で二重に記録し、逆に跳び戻ると本当に新しい記録が前の id に吸われて消える
   * （独立レビュー 2026-10-28 v7 N3-04）
   */
  windowFromMono: number
}

/** 経過の時計（端末の時計の変更で動かぬ）。描画中には読まぬ */
function monoNow(): number {
  return performance.now()
}

/**
 * 操作（key）に対する冪等 id。期限内の同じ操作なら前の id を返し、それ以外は新しく作る。
 * 時計（Date.now）は描画中に読まぬよう、component の外で event handler からだけ呼ぶ。
 */
function resolveRetryClientId(
  ref: { current: PendingRetryId | null },
  key: string,
  owner: SaveOwner | null,
): PendingRetryId {
  const pending = ref.current
  const now = Date.now()
  const mono = monoNow()
  if (pending && pending.key === key && mono - pending.windowFromMono < RETRY_WINDOW_MS) {
    return pending
  }
  // 再読込・画面の作り直しで手元の記憶が消えても、端末に残した「結果の分からぬ同じ操作」が
  // 期限内なら同じ id を使う（2026-10-27 A2。新しい id で登録し直すと本当の二重記録になる）。
  // 画面を跨ぐと経過の時計は 0 に戻るゆえ壁時計の差で測る。負の差（時計を戻した）は期限内と
  // 言えぬゆえ使わぬ — 先の控えは「保存を確認中の記録」に残り、そこで確かめられる
  if (owner) {
    const stored = listPendingSaves(owner, now).find((p) => {
      const elapsed = now - new Date(p.unknownAt ?? p.firstAttemptAt).getTime()
      return (
        p.retryKey === key &&
        p.phase !== "conflict" &&
        elapsed >= 0 &&
        elapsed < RETRY_WINDOW_MS
      )
    })
    if (stored) {
      const windowFrom = new Date(stored.unknownAt ?? stored.firstAttemptAt).getTime()
      ref.current = {
        key,
        id: stored.clientId,
        at: new Date(stored.firstAttemptAt).getTime(),
        windowFrom,
        // 以後この画面の中では経過の時計で測る（残りの期限を写す）
        windowFromMono: mono - (now - windowFrom),
      }
      return ref.current
    }
  }
  ref.current = { key, id: newClientId(), at: now, windowFrom: now, windowFromMono: mono }
  return ref.current
}

/**
 * 結果の分からぬクイック記録の案内（「失敗」とも「記録済み」とも言わぬ）。押し直しが同じ記録に
 * なるのは期限（RETRY_WINDOW_MS）の内だけゆえ、期限を言い、期限の後は「保存を確認中の記録」の
 * 一覧（同じ id・同じ内容で送り直す）へ案内する（独立レビュー 2026-10-28）。
 */
function unknownQuickMessage(summary: string, keptOnDevice: boolean): string {
  return keptOnDevice
    ? `${summary}を保存できたか確認できていません。2分以内にもう一度押すか、「保存を確認中の記録」から送り直すと、同じ記録として確かめます（二重にはなりません）`
    : // 端末に控えを残せなかった（容量不足・保存が許されぬ・世帯が分からぬ）。一覧には出ぬゆえ
      // 一覧へは案内せぬ（独立レビュー 2026-10-28 v7 F3）
      `${summary}を保存できたか確認できていません。この端末に控えを残せなかったため、2分以内にもう一度押して確かめてください（同じ記録として確かめ、二重にはなりません）。過ぎた時は、記録の一覧で確かめてから記録してください`
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
  /**
   * 今の世帯。結果の分からぬ記録を持ち主付きで端末に残すのに使う（2026-10-27 A2）。
   * 省略時は端末に残さぬ（手元の記憶だけで同じ id を使う。従来どおり）。
   */
  householdId?: string
  onCreateLog: (type: BabyLogType) => void
  /**
   * 搾乳など量ベースの授乳を create シートで開く（母乳のタイマー導線とは別）。
   * `amountMl` は「今回の量を変える」の初期値（いつもの量）。その記録だけに使い、いつもの量は
   * 変えぬ（2026-10-27 C2）。
   */
  onCreateFeeding: (type: FeedingType, opts?: { amountMl?: number }) => void
  onStartTimer: (type: FeedingType) => void
  /**
   * 記録成功時に楽観 append する行を親へ渡す（B-03）。Realtime 単一経路を脱し、
   * #92 不達下でも timeline/回数を即時更新する。既存 echo は id 重複で吸収。
   *
   * 行の logged_at は DB が書いた記録時刻（応答の loggedAt）。端末時計で組むと、分を跨いだ
   * 時に画面と DB の HH:mm が食い違い、編集の保存後に表示が飛ぶ（echo は同じ id を捨てるゆえ
   * 自然には直らぬ）。quick actions は isToday ゲート下でのみ描画されるため、ふつうは選択日
   * （当日）の行になる。日付の振り分けは親の appendLog が行の日付で行う。
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
  /**
   * いつものミルク量（親の useBottleDefault）。「ミルク」の 1 タップはこの量で記録する。
   * 未設定なら量を決めるシートを開き、読めなかった時は量の分からぬまま記録せぬ。
   */
  bottleDefault: BottleDefaultController
}

/**
 * 押し直し（結果不明の後）が新しく記録した時の知らせ。時刻を送らぬクイック記録は、初回が DB に
 * 届いておらねば、押し直した時の受信時刻で記録される。それを「押した時刻」と偽らず、記録された
 * 時刻と直し方を伝える（2026-10-28 N3）。
 */
function receiptTimeNote(loggedAt: string | undefined): string {
  return loggedAt
    ? `。記録時刻は届いた時刻（${formatTimeJst(loggedAt)}）です。押した時刻と違う時は記録を開いて直せます`
    : ""
}

export function BabyQuickActions({
  userId,
  householdId,
  onCreateLog,
  onCreateFeeding,
  onStartTimer,
  onLogRecorded,
  onLogRemoved,
  onLogUpdated,
  visibleLogs,
  now,
  externalRecordSeq,
  bottleDefault,
}: BabyQuickActionsProps) {
  const childScope = useChildScope()
  const childId = childScope?.id
  const [isPending, startTransition] = useTransition()
  /**
   * いつものミルク量のシート。開くたびに key を進めて作り直す（入力・保存中・エラーの
   * state を前回から持ち越さぬ）。intent は開いた導線（未設定のミルク = 保存して記録 /
   * 量を変更 = 保存のみ）。
   */
  const [bottleSheet, setBottleSheet] = useState<{
    intent: BottleDefaultSheetIntent
    initialAmountMl: number | null
    key: number
  } | null>(null)
  const [bottleSheetOpen, setBottleSheetOpen] = useState(false)
  const bottleSheetKeyRef = useRef(0)
  /**
   * 利用者が閉じた（× / 背景 / Esc）シートのうち最も新しい key。保存は閉じた後も走り続けうる
   * （詰まった保存の間に閉じ込めぬよう、保存中でも閉じられる）。閉じた後に通った保存は量だけ
   * 反映し、記録はせぬ。key は単調に増えるゆえ「key <= この値」で閉じたシートと分かる。
   * 開いておるかを ref で読む形にせぬのは、閉じて開き直すと true に戻り、古いシートの保存が
   * 新しいシートを閉じたり記録したりするため。
   */
  const dismissedBottleSheetKeyRef = useRef(0)
  /**
   * 最後にいつもの量へ反映したシートの key。閉じたシートの保存の応答が、後で開いたシートの
   * 保存より遅れて届いた時に、新しい量を古い量で上書きせぬ（同じシートの衝突 → 保存し直しは同じ key ゆえ通す）
   */
  const lastAppliedBottleSheetKeyRef = useRef(0)
  /** 反映したら true。後で開いたシートが既に反映しておれば何もせず false */
  function applyFromSheet(sheetKey: number, next: BottleDefaultState): boolean {
    if (sheetKey < lastAppliedBottleSheetKeyRef.current) return false
    lastAppliedBottleSheetKeyRef.current = sheetKey
    bottleDefault.apply(next)
    return true
  }
  const bottleDescriptionId = useId()
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
  const owner: SaveOwner | null = householdId ? { userId, householdId, ...(childScope && !childScope.isLegacy ? { childId } : {}) } : null
  function clientIdFor(key: string): PendingRetryId {
    return resolveRetryClientId(retryIdRef, key, owner)
  }
  function settleClientId() {
    retryIdRef.current = null
  }
  // 一度でも結果が分からなかった操作の id（持ち主が分からず端末に残せぬ時の手元の控え）
  const unknownIdsRef = useRef(new Set<string>())

  type PendingEntry = {
    clientId: string
    action: PendingSaveAction
    payload: Record<string, unknown>
    summary: string
    retryKey: string
    /** 最初の押下の時刻（ISO・端末の時計）。期限と一覧の目印。記録時刻は DB の受信時刻（N3） */
    firstAttemptAt: string
  }

  /**
   * 端末に残す（送る前は sending、結果不明なら unknown）。送り直しは利用者の操作だけ。
   * 残せたかを返す（持ち主が分からぬ・容量不足・保存が許されぬ時は false — 呼び出し側は
   * 「保存を確認中の記録」に在るとは言わぬ。pending-saves-storage の putPendingSave の契約）
   */
  function rememberPending(entry: PendingEntry, phase: "sending" | "unknown"): boolean {
    if (!owner) return false
    return putPendingSave({
      schemaVersion: PENDING_SAVE_SCHEMA_VERSION,
      clientId: entry.clientId,
      owner,
      action: entry.action,
      payload: entry.payload,
      summary: entry.summary,
      firstAttemptAt: entry.firstAttemptAt,
      phase,
      retryKey: entry.retryKey,
      ...(phase === "sending"
        ? { pageId: PAGE_LIFE_ID, sentAt: new Date().toISOString() }
        : { unknownAt: new Date().toISOString() }),
    })
  }

  /**
   * 送る前の記録。この操作が既に「結果不明」だったか（= 先の送信が保存されておりうる）を返す。
   * 送る**前**に sending で残すのは、応答の前に再読込・更新・ログアウトしても手がかりを失わぬため
   * （独立レビュー 2026-10-28。更新・ログアウトの確認はこれを「端末に残る作業」として数える）。
   */
  function beforeSend(entry: PendingEntry): boolean {
    const wasUnknown =
      unknownIdsRef.current.has(entry.clientId) ||
      (owner
        ? listPendingSaves(owner).some(
            (p) => p.clientId === entry.clientId && mayHaveLanded(p),
          )
        : false)
    rememberPending(entry, "sending")
    return wasUnknown
  }

  /**
   * 同じ操作（同じ鍵）の、保存されておりうる**別の id**の控えが端末に在るか（押し直しの期限を
   * 過ぎた後のタップ）。期限の後の同じ釦は新しい記録として送る（1 タップを止めぬ）が、黙っては
   * 送らぬ — 成功の知らせで、確認中の前の操作とは別の記録になったことと戻し方を伝える（v8: 結果
   * 不明の後の 2 回目の送信が黙って二重にならぬ）。送る前に読む
   */
  function hasOtherPendingOfSameKey(entry: PendingEntry): boolean {
    if (!owner) return false
    // 記録シートの控えは retryKey を持たぬゆえ、送信内容の種類から同じ鍵を導いて照らす。送信中の控えも
    // 数える（閉じたシートのまだ返らぬ送信も 2 件目になりうる。独立レビュー v8rc1 V8-QN / V8-F2R）
    return listPendingSaves(owner).some(
      (p) => p.clientId !== entry.clientId && (p.retryKey ?? quickKeyOfPayload(p)) === entry.retryKey,
    )
  }

  /** 結果の分からぬ記録（例外・サーバの unknown）。同じ id を手元にも端末にも残す。端末に残せたかを返す */
  function rememberUnknown(entry: PendingEntry): boolean {
    unknownIdsRef.current.add(entry.clientId)
    // 押し直しの期限は、結果不明と分かった今から測り直す（遅い失敗でも約束どおり 2 分押し直せる）
    if (retryIdRef.current?.id === entry.clientId) {
      retryIdRef.current.windowFrom = recordedAtNow()
      retryIdRef.current.windowFromMono = monoNow()
    }
    return rememberPending(entry, "unknown")
  }

  /** 結果が確定した（成功・衝突・初めての操作の拒否）。手元と端末の控えを消す */
  function forgetPending(clientId: string) {
    settleClientId()
    unknownIdsRef.current.delete(clientId)
    removePendingSave(clientId)
  }

  /**
   * 記録の応答の振り分け（授乳・おむつで共有）。成功は DB の確定行で画面へ出す（無ければ送った値と
   * サーバの時刻・版で組む）。replayed は応答を失った前回の記録が成立しておった — その確定行を出し、
   * 「取り消す」は出さぬ。conflict は同じ id で別の内容が記録済み — 記録は在るゆえ確定行を出し、
   * 何が記録されたかを確かめるよう伝える。rejected は保存の前に拒まれた（行は無い）。
   * unknown は結果不明（同じ内容でだけ押し直す）。
   */
  function settleCreateResult(args: PendingEntry & {
    result: Awaited<ReturnType<typeof recordFeeding>>
    /** この送信の前に、同じ操作の結果が分からなかったか（beforeSend の戻り値） */
    wasUnknown: boolean
    /** 同じ操作の別の id の控えが確認中のまま、新しい id で送ったか（hasOtherPendingOfSameKey） */
    separateFromPending: boolean
    label: string
    successMessage: string
    replayMessage: string
    buildFallback: (id: string, updatedAt: string | null, loggedAt: string | undefined) => BabyLogData
  }) {
    const { result, clientId } = args
    if (result.error !== null) {
      const phase = phaseAfterFailure({ thrown: false, failure: result.failure })
      if (phase === "unknown") {
        // 期限内の押し直しが同じ id になるよう手元の記憶は残す
        const kept = rememberUnknown(args)
        setLastRecorded(null)
        toast.error(
          `${unknownQuickMessage(args.summary, kept)}${args.separateFromPending ? SEPARATE_FROM_PENDING_UNKNOWN_NOTE : ""}`,
        )
        return
      }
      if (phase === "rejected" && args.wasUnknown) {
        // この送信が拒まれた（ログイン切れ・一時的な失敗等）ことは、先の結果不明の送信が保存されて
        // おらぬことを意味せぬ。id と端末の控えを捨てると、次の押下が新しい id になり二重記録しうる
        // （独立レビュー 2026-10-28）。結果不明のまま残し、理由と確かめ方を伝える
        const kept = rememberUnknown(args)
        setLastRecorded(null)
        toast.error(
          kept
            ? `${result.error}（前の送信が保存されたかは「保存を確認中の記録」で確かめられます）`
            : `${result.error}（前の送信が保存されたかは、記録の一覧で確かめてください）`,
        )
        return
      }
      forgetPending(clientId)
      if (phase === "conflict") {
        setLastRecorded(null)
        if (result.conflict?.current) onLogRecorded?.(result.conflict.current)
        toast.error(SAVE_CONFLICT_MESSAGE)
        return
      }
      toast.error(result.error)
      return
    }
    // 応答が届いた（成功）ゆえ、この意図の id は役目を終えた
    forgetPending(clientId)
    if (result.replayed) {
      // 応答を失った前回の記録が「直前」になった。帯の古い記録は畳む（取り消しの誤指し防止）。
      // 確定行があれば画面へ出す（resync を待たずに「記録された」ことを確かめられるように）。
      // 行を持たぬ応答（古い形）では、時刻を知らぬゆえ行を組まぬ（端末時計で架空の行を作らぬ）
      setLastRecorded(null)
      if (result.log) onLogRecorded?.(result.log)
      toast.success(
        `${args.replayMessage}${args.separateFromPending ? SEPARATE_FROM_PENDING_REPLAY_NOTE : ""}`,
      )
      return
    }
    const confirmed =
      result.log ?? args.buildFallback(result.id, result.updatedAt ?? null, result.loggedAt)
    // B-03: 確定行で即時 append（Realtime を待たず timeline/回数を更新）。記録時刻は DB が
    // 書いた値 — 端末時計で組むと、分を跨いだ時に画面の時刻が DB と食い違い、編集の保存後に
    // 表示が飛ぶ（actions.ts の InsertOutcome）
    onLogRecorded?.(confirmed)
    successWithUndo(
      // 結果不明の後の送信が新しく記録した = 先の送信は届いておらず、この送信の受信時刻で記録した。
      // 期限の後の新しい id なら、確認中の前の操作とは別の記録であることも落とさず言う（どちらも立ちうる）
      `${args.successMessage}${
        args.wasUnknown ? receiptTimeNote(confirmed.logged_at ?? result.loggedAt) : ""
      }${args.separateFromPending ? SEPARATE_FROM_PENDING_NOTE : ""}`,
      args.label,
      result.id,
      confirmed.updated_at ?? result.updatedAt,
      args.summary,
      confirmed.logged_at ?? result.loggedAt,
    )
  }

  /** 例外（通信断・応答の喪失）。届かなかったのか、保存後に応答だけ失われたのか区別できぬ */
  function settleCreateThrown(
    where: string,
    err: unknown,
    entry: PendingEntry,
    separateFromPending: boolean,
  ) {
    // 記録がサーバで成立したか分からぬ。成立しておれば帯の記録は「直前」でない
    setLastRecorded(null)
    const kept = rememberUnknown(entry)
    console.error(`${where} が例外を投げました`, {
      message: err instanceof Error ? err.message : String(err),
    })
    // デプロイを跨いだ古い画面（action が見つからぬ）。押し直しても同じ失敗ゆえ読み直しを案内する
    toast.error(
      noteServerActionFailure(err)
        ? STALE_CLIENT_ACTION_MESSAGE
        : `${unknownQuickMessage(entry.summary, kept)}${separateFromPending ? SEPARATE_FROM_PENDING_UNKNOWN_NOTE : ""}`,
    )
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
    /** 記録時刻（LastRecorded.loggedAt）。帯を戻す時もこの値のまま */
    loggedAt: string,
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
        prev ?? {
          logId,
          version: createdVersion,
          label,
          summary,
          at: recordedAt,
          loggedAt,
          seq,
        },
      )
    }
    setBusyKey("undo")
    startTransition(async () => {
      try {
        const result = await deleteLog(logId, createdVersion, ...(childId ? [childId] as const : []))
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
    /** サーバが返した記録時刻（DB の logged_at）。無い応答では端末時計へ倒す */
    loggedAt: string | undefined,
  ) {
    if (logId && createdVersion) {
      const at = recordedAtNow()
      const shownAt = loggedAt ?? new Date(at).toISOString()
      // 応答が届いた時点の番号（externalSeqRef の注記）
      const seq = externalSeqRef.current
      setLastRecorded({
        logId,
        version: createdVersion,
        label,
        summary,
        at,
        loggedAt: shownAt,
        seq,
      })
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
            undoLog(logId, createdVersion, label, summary, at, seq, shownAt)
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
  // ミルクはいつもの量で即時記録、離乳食は即時記録（従来どおり）。
  function handleFeedingOption(value: FeedingType) {
    if (value === "breast_left" || value === "breast_right") {
      onStartTimer(value)
    } else if (value === "pumped") {
      onCreateFeeding(value)
    } else if (value === "bottle") {
      handleBottle()
    } else {
      handleFeeding(value)
    }
  }

  function openBottleSheet(intent: BottleDefaultSheetIntent, initialAmountMl: number | null) {
    bottleSheetKeyRef.current += 1
    setBottleSheet({ intent, initialAmountMl, key: bottleSheetKeyRef.current })
    setBottleSheetOpen(true)
  }

  /**
   * 「ミルク」: いつもの量が決まっておれば、その量で 1 タップ記録。量は**押した瞬間の表示**を
   * 捕まえて送る（押した後に別の端末の変更が届いても、見た量と記録が食い違わぬ）。
   * 未設定なら量を決めるシートへ（勝手な既定量で記録せぬ）。読めていない時は量の分からぬまま
   * 記録せず、取り直す。取り直せなければ量を手で入れる記録シートを開く。
   */
  function handleBottle() {
    const current = bottleDefault.state
    if (current.status === "set") {
      handleFeeding("bottle", current.amountMl)
      return
    }
    if (current.status === "unset") {
      openBottleSheet("record", null)
      return
    }
    setBusyKey("feeding:bottle")
    startTransition(async () => {
      try {
        const next = await bottleDefault.refetch()
        if (next === null || next.status === "error") {
          toast.error(
            "いつものミルク量を読み込めませんでした。量を入力して記録してください",
          )
          onCreateFeeding("bottle")
          return
        }
        if (next.status === "unset") {
          openBottleSheet("record", null)
          return
        }
        if (next.status === "set") {
          // 読めた量はまだ見せておらぬ。見ぬまま記録せず、表示してから押してもらう
          toast.info(
            `いつものミルク量（${formatBottleAmount(next.amountMl)}）を読み込みました。もう一度押すと記録します`,
          )
        }
      } catch (err) {
        console.error("[baby-quick-actions] bottle default refetch threw", {
          message: err instanceof Error ? err.message : String(err),
        })
        toast.error("いつものミルク量を読み込めませんでした。量を入力して記録してください")
        onCreateFeeding("bottle")
      }
    })
  }

  function handleBottleSaved(
    sheetKey: number,
    amountMl: number,
    intent: BottleDefaultSheetIntent,
  ) {
    // 量はこのシートの保存で DB に書けた値。後で開いたシートが既に反映しておれば上書きせぬ
    const applied = applyFromSheet(sheetKey, { status: "set", amountMl })
    const stale =
      sheetKey !== bottleSheetKeyRef.current ||
      sheetKey <= dismissedBottleSheetKeyRef.current
    if (stale) {
      // 後で開いたシートの保存が先に反映済み = この応答は追い越された古い結果。黙って捨てる
      if (!applied) return
      // 保存の通信中に閉じられた（または別のシートを開き直した）。閉じた・開き直した後の
      // シートには触れず、記録もせぬ — 取り消したつもりで 1 件記録される食い違いを作らぬ
      toast.success(
        intent === "record"
          ? `いつものミルク量を${formatBottleAmount(amountMl)}にしました。今回のミルクは記録していません`
          : `いつものミルク量を${formatBottleAmount(amountMl)}にしました。次の記録から使います`,
      )
      return
    }
    setBottleSheetOpen(false)
    if (intent === "record") {
      // 保存が通ってから記録する（保存が失敗・衝突なら何も記録しておらぬ）。記録が通信で
      // 落ちても量は保存済みゆえ、次のミルクの 1 タップが同じ冪等 id での再試行になる。
      // 確かめのトーストは記録の側（「授乳を記録しました（ミルク 120ml）」）の 1 枚に任せる
      handleFeeding("bottle", amountMl)
      return
    }
    toast.success(
      `いつものミルク量を${formatBottleAmount(amountMl)}にしました。次の記録から使います`,
    )
  }

  function handleBottleConflict(sheetKey: number, currentMl: number | null) {
    applyFromSheet(
      sheetKey,
      currentMl === null ? { status: "unset" } : { status: "set", amountMl: currentMl },
    )
  }

  /**
   * 授乳をその場で記録する。`amountMl` は押した時点で捕まえた量で、送信値・楽観行・
   * トースト・帯の四つに同じ値を使う（await の後に state を読み直さぬ）。
   *
   * 冪等 key は量を含めず `feeding:<種別>` のまま。量はタップの意図ではない — 応答だけ
   * 失われた 120ml の保存の後に、いつもの量を 160ml へ変えて押し直すと、同じ id・別の内容
   * としてサーバが REPLAY_MISMATCH で止める（行は 1 件のまま。量を key に入れると二重記録に化ける）。
   */
  function handleFeeding(feedingType: FeedingType, amountMl: number | null = null) {
    const retryKey = `feeding:${feedingType}`
    const { id: clientId, at } = clientIdFor(retryKey)
    setBusyKey(retryKey)
    const summary =
      amountMl === null
        ? getFeedingTypeLabel(feedingType)
        : `${getFeedingTypeLabel(feedingType)} ${formatBottleAmount(amountMl)}`
    // 送信値はここで一度だけ組み、送信・端末保持・楽観行で同じものを使う。
    //
    // 記録時刻は**送らぬ** — DB が受け取った時刻（now()）で記録する（2026-10-28 製品判断 N3）。
    // 端末の時計を送ると、進んだ時計は「未来の時刻」で全て拒まれ、遅れた時計は黙って誤った時刻で
    // 残る。時刻を送らぬことも送信内容として固定する: 押し直し・「確認中の記録」からの送り直しは
    // 同じ id・同じ内容ゆえ、先の送信が届いておれば初回の行（初回の受信時刻）が返る。届いて
    // おらねば送り直した時の受信時刻で記録され、それは成功の知らせで「届いた時刻」として伝える
    // （settleCreateResult。押した時刻とは偽らぬ）。`firstAttemptAt` は端末の時計で、押し直しの
    // 期限と一覧の目印にだけ使う
    const firstAttemptAt = new Date(at).toISOString()
    const payload = {
              ...(childId ? { childId } : {}),
      feedingType,
      clientId,
      ...(amountMl !== null && { amountMl }),
    }
    const entry: PendingEntry = {
      clientId,
      action: "recordFeeding",
      payload,
      summary,
      retryKey,
      firstAttemptAt,
    }
    const separateFromPending = hasOtherPendingOfSameKey(entry)
    const wasUnknown = beforeSend(entry)
    startTransition(async () => {
      try {
        const result = await recordFeeding(payload)
        settleCreateResult({
          ...entry,
          wasUnknown,
          separateFromPending,
          result,
          label: "授乳",
          // 量を記録した時は何 ml で記録したかをトーストで確かめられるようにする
          successMessage:
            amountMl === null ? "授乳を記録しました" : `授乳を記録しました（${summary}）`,
          replayMessage: `授乳（${summary}）は記録済みでした（二重には記録していません）`,
          buildFallback: (id, updatedAt, loggedAt) =>
            buildOptimisticLog({
              id,
              updatedAt,
              loggedAt,
              logType: "feeding",
              loggedBy: userId,
              feedingType,
              amountMl,
            }),
        })
      } catch (err) {
        settleCreateThrown("[baby-quick-actions] recordFeeding", err, entry, separateFromPending)
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
    const retryKey = `diaper:${diaperType}:${poopAmount ?? ""}`
    const { id: clientId, at } = clientIdFor(retryKey)
    // 2 段目（量）から押した時は量の釦、1 段目（おしっこ）はその釦にスピナーを出す
    setBusyKey(
      diaperType === "poop" || diaperType === "both"
        ? `amount:${poopAmount ?? "none"}`
        : `diaper:${diaperType}`,
    )
    const summary = formatDiaperSummary(diaperType, poopAmount)
    // 記録時刻は送らず DB の受信時刻（授乳と同じ理由。N3）
    const firstAttemptAt = new Date(at).toISOString()
    const payload = {
              ...(childId ? { childId } : {}), diaperType, poopAmount, clientId }
    const entry: PendingEntry = {
      clientId,
      action: "recordDiaper",
      payload,
      summary,
      retryKey,
      firstAttemptAt,
    }
    const separateFromPending = hasOtherPendingOfSameKey(entry)
    const wasUnknown = beforeSend(entry)
    startTransition(async () => {
      try {
        const result = await recordDiaper(payload)
        settleCreateResult({
          ...entry,
          wasUnknown,
          separateFromPending,
          result,
          label: "おむつ",
          // 何を記録したか（うんち（大量）等）をトーストで確認できるようにする
          successMessage: `おむつ交換を記録しました（${summary}）`,
          replayMessage: `おむつ交換（${summary}）は記録済みでした（二重には記録していません）`,
          buildFallback: (id, updatedAt, loggedAt) =>
            buildOptimisticLog({
              id,
              updatedAt,
              // 記録時刻は DB が書いた値（授乳と同じ理由）
              loggedAt,
              logType: "diaper",
              loggedBy: userId,
              diaperType,
              poopAmount,
            }),
        })
      } catch (err) {
        settleCreateThrown("[baby-quick-actions] recordDiaper", err, entry, separateFromPending)
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
  // 帯の時刻と要約は、画面に行が在ればその行から出す（記録の後に編集で時刻や量を直したら、帯も
  // 直した値を指す。行と帯で同じ記録の時刻・量が食い違わぬよう）。行が無ければ記録時の値
  const inlineUndoRow = lastRecorded
    ? visibleLogs?.find((l) => l.id === lastRecorded.logId)
    : undefined
  const inlineUndoTime = lastRecorded
    ? formatTimeJst(inlineUndoRow?.logged_at ?? lastRecorded.loggedAt)
    : ""
  const inlineUndoSummary = lastRecorded
    ? inlineUndoRow
      ? getLogSummary(inlineUndoRow)
      : lastRecorded.summary
    : ""

  // ミルク釦の量の表示（見える文字）と、同じ内容の読み上げ（aria-describedby）
  const bottleState = bottleDefault.state
  const bottleAmountLabel =
    bottleState.status === "set"
      ? formatBottleAmount(bottleState.amountMl)
      : bottleState.status === "unset"
        ? "量を設定"
        : "量を再読込"
  const bottleDescription =
    bottleState.status === "set"
      ? `押すと${formatBottleAmount(bottleState.amountMl)}で記録します`
      : bottleState.status === "unset"
        ? "いつもの量が未設定です。押すと量を決めて記録します"
        : "いつもの量を読み込めていません。押すと読み込み直します"

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
          {OTHER_FEEDING_OPTIONS.map((opt) =>
            opt.value === "bottle" ? (
              // ミルクは押せば記録される量を釦そのものに出す（見た量 = 記録する量）。量の文字は
              // aria-hidden にして釦の名前を「ミルク」のまま保ち（e2e・単体テストの exact 契約）、
              // 読み上げには aria-describedby で同じ内容を渡す
              <button
                key={opt.value}
                type="button"
                onClick={() => handleFeedingOption(opt.value)}
                disabled={isPending}
                aria-describedby={bottleDescriptionId}
                className={`${QUICK_BASE} ${FEEDING_TONE} min-h-12 flex-col gap-0 py-1 text-base`}
              >
                <span className="flex items-center gap-1.5">
                  {spinner(`feeding:${opt.value}`)}
                  {opt.label}
                </span>
                <span
                  aria-hidden="true"
                  data-testid="bottle-default-amount"
                  className="text-xs font-semibold tabular-nums"
                >
                  {bottleAmountLabel}
                </span>
              </button>
            ) : (
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
            ),
          )}
        </div>
        {/* 読み上げ専用の説明（aria-describedby の参照先）。hidden でも説明には使われ、
            読み上げの順路では二度読まれぬ */}
        <span id={bottleDescriptionId} hidden>
          {bottleDescription}
        </span>
        {/* 量の設定・変更（保存だけ。記録はせぬ）。未設定ならミルク自身も「量を決めて記録」へ
            進むが、記録せずに先に量だけ決めたい時の口をここに置く。読めていない時は出さぬ
            （決めてある量を知らぬまま上書きさせぬ）。保存しても過去の記録は変わらず、次のミルクから効く */}
        {bottleState.status !== "error" && (
          <div className="flex flex-wrap gap-x-1">
            {/* 今回だけ別の量（2026-10-27 C2）。いつもの量で開いた記録シートで量を直して記録する。
                いつもの量（世帯の設定）は変えぬ — 「ミルクの量を変更」とは別の意図 */}
            {bottleState.status === "set" && (
              <button
                type="button"
                onClick={() => {
                  const current = bottleDefault.state
                  onCreateFeeding(
                    "bottle",
                    current.status === "set" ? { amountMl: current.amountMl } : undefined,
                  )
                }}
                disabled={isPending}
                className="flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:bg-muted hover:text-foreground active:bg-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <Pencil size={16} aria-hidden="true" />
                今回だけ別の量
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                const current = bottleDefault.state
                if (current.status === "error") return
                openBottleSheet("save", current.status === "set" ? current.amountMl : null)
              }}
              disabled={isPending}
              className="flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:bg-muted hover:text-foreground active:bg-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <Settings2 size={16} aria-hidden="true" />
              {bottleState.status === "set" ? "ミルクの量を変更" : "ミルクの量を設定"}
            </button>
          </div>
        )}
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
            {inlineUndoTime} {inlineUndoSummary}を記録しました
          </span>
          <button
            type="button"
            aria-label={`直前の記録（${inlineUndoTime}）を取り消す`}
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
                lastRecorded.loggedAt,
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

      {bottleSheet && (
        <BottleDefaultSheet
          key={bottleSheet.key}
          open={bottleSheetOpen}
          onOpenChange={(open) => {
            if (!open) {
              dismissedBottleSheetKeyRef.current = Math.max(
                dismissedBottleSheetKeyRef.current,
                bottleSheet.key,
              )
            }
            setBottleSheetOpen(open)
          }}
          intent={bottleSheet.intent}
          initialAmountMl={bottleSheet.initialAmountMl}
          // 保存の結果は開いた時のシート（key）に結び付ける。閉じた・開き直した後に届いた古い
          // 保存が、新しいシートを閉じたり記録したりせぬように
          onSaved={(amountMl, intent) => handleBottleSaved(bottleSheet.key, amountMl, intent)}
          onConflict={(currentMl) => handleBottleConflict(bottleSheet.key, currentMl)}
        />
      )}
    </section>
  )
}

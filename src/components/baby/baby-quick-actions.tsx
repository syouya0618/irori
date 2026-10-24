"use client"

import { useRef, useState, useTransition } from "react"
import { Thermometer, Ruler, StickyNote, ChevronLeft } from "lucide-react"
import { toast } from "sonner"
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

const FEEDING_OPTIONS: { value: FeedingType; label: string }[] = [
  { value: "breast_left", label: "左" },
  { value: "breast_right", label: "右" },
  { value: "bottle", label: "ミルク" },
  { value: "pumped", label: "搾乳" },
  { value: "solid", label: "離乳食" },
]

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
}

export function BabyQuickActions({
  userId,
  onCreateLog,
  onCreateFeeding,
  onStartTimer,
  onLogRecorded,
  onLogRemoved,
  onLogUpdated,
}: BabyQuickActionsProps) {
  const [isPending, startTransition] = useTransition()
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
  function undoLog(logId: string, createdVersion: string, label: string) {
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
          return
        }
        // B-03: Realtime DELETE echo を待たずローカル state からも除去
        onLogRemoved?.(logId)
        toast.success(`${label}の記録を取り消しました`)
      } catch (err) {
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
  ) {
    if (logId && createdVersion) {
      toast.success(message, {
        action: {
          label: "取り消す",
          onClick: () => undoLog(logId, createdVersion, label),
        },
      })
    } else if (logId) {
      toast.success(message, {
        description: "取り消すには、記録の一覧から開いて削除してください",
      })
    } else {
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
        successWithUndo("授乳を記録しました", "授乳", result.id, result.updatedAt)
      } catch (err) {
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
    startTransition(async () => {
      try {
        const result = await recordDiaper({ diaperType, poopAmount, clientId })
        settleClientId()
        if (result.error) {
          toast.error(result.error)
          return
        }
        if (result.replayed) {
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
        )
      } catch (err) {
        toastOfflineError("[baby-quick-actions] recordDiaper", err)
      } finally {
        // 成否にかかわらず 1 段目へ戻す（失敗時に 2 段目へ張り付くと、再タップで
        // 種別を選び直せず「うんちだったのか」が分からなくなる）
        setPendingPoop(null)
      }
    })
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Feeding */}
      <div className="space-y-1.5">
        <span className="px-1 text-xs font-semibold text-muted-foreground">
          授乳
        </span>
        <div className="flex gap-1.5">
          {FEEDING_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleFeedingOption(opt.value)}
              disabled={isPending}
              className="flex min-h-11 flex-1 items-center justify-center rounded-xl bg-amber-50 text-sm font-medium text-amber-800 transition-colors duration-200 hover:bg-amber-100 active:bg-amber-200 disabled:opacity-50 dark:bg-amber-900/30 dark:text-amber-200 dark:hover:bg-amber-900/50 dark:active:bg-amber-900/70"
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Diaper: 1 段目は種別、うんちを含む種別を選ぶと同じ行が量の選択へ入れ替わる */}
      <div className="space-y-1.5">
        <span className="px-1 text-xs font-semibold text-muted-foreground">
          {pendingPoop === null
            ? "おむつ"
            : `${getDiaperTypeLabel(pendingPoop)}・うんちの量`}
        </span>
        {pendingPoop === null ? (
          <div className="flex gap-1.5">
            {DIAPER_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => handleDiaperOption(opt.value)}
                disabled={isPending}
                className="flex min-h-11 flex-1 items-center justify-center rounded-xl bg-sky-50 text-sm font-medium text-sky-800 transition-colors duration-200 hover:bg-sky-100 active:bg-sky-200 disabled:opacity-50 dark:bg-sky-900/30 dark:text-sky-200 dark:hover:bg-sky-900/50 dark:active:bg-sky-900/70"
              >
                {opt.label}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex gap-1.5">
            <button
              type="button"
              aria-label="おむつの種類に戻る"
              onClick={() => setPendingPoop(null)}
              disabled={isPending}
              className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground transition-colors duration-200 hover:text-foreground disabled:opacity-50"
            >
              <ChevronLeft size={18} />
            </button>
            {POOP_AMOUNT_OPTIONS.map((opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => handleDiaper(pendingPoop, opt.value)}
                disabled={isPending}
                className="flex min-h-11 flex-1 items-center justify-center rounded-xl bg-sky-50 text-sm font-medium text-sky-800 transition-colors duration-200 hover:bg-sky-100 active:bg-sky-200 disabled:opacity-50 dark:bg-sky-900/30 dark:text-sky-200 dark:hover:bg-sky-900/50 dark:active:bg-sky-900/70"
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* その他（体温・成長・メモ） */}
      <div className="flex gap-1.5">
        <button
          onClick={() => onCreateLog("temperature")}
          disabled={isPending}
          className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-rose-50 text-sm font-medium text-rose-800 transition-colors duration-200 hover:bg-rose-100 active:bg-rose-200 disabled:opacity-50 dark:bg-rose-900/30 dark:text-rose-200 dark:hover:bg-rose-900/50 dark:active:bg-rose-900/70"
        >
          <Thermometer size={16} />
          体温
        </button>
        <button
          onClick={() => onCreateLog("growth")}
          disabled={isPending}
          className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-teal-50 text-sm font-medium text-teal-800 transition-colors duration-200 hover:bg-teal-100 active:bg-teal-200 disabled:opacity-50 dark:bg-teal-900/30 dark:text-teal-200 dark:hover:bg-teal-900/50 dark:active:bg-teal-900/70"
        >
          <Ruler size={16} />
          成長
        </button>
        <button
          onClick={() => onCreateLog("memo")}
          disabled={isPending}
          className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-gray-100 text-sm font-medium text-gray-700 transition-colors duration-200 hover:bg-gray-200 active:bg-gray-300 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:active:bg-gray-600"
        >
          <StickyNote size={16} />
          メモ
        </button>
      </div>
    </div>
  )
}

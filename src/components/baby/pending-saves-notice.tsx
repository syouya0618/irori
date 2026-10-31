"use client"


import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import {
  recordDiaper,
  recordFeeding,
  recordGrowth,
  recordMemo,
  recordTemperature,
} from "@/app/(main)/baby/actions"
import {
  listPendingSaves,
  removePendingSave,
  isPendingSaveStorageKey,
  PENDING_SAVES_CHANGED_EVENT,
  isAwaitingConfirmation,
  nextVisibilityChangeAt,
  type PendingSave,
  type PendingSaveAction,
} from "@/lib/domain/pending-saves-storage"
import { lookupBabyLogs } from "@/lib/domain/baby-log-lookup-client"
import {
  phaseAfterFailure,
  SAVE_CONFLICT_MESSAGE,
  SAVE_RESEND_LABEL,
  type SaveOwner,
} from "@/lib/domain/save-attempt"
import { formatTimeJst } from "@/lib/utils/date-jst"
import type { BabyLogData } from "@/lib/types/baby"

/** 送り直しの Action（payload の形は各 Action の入力そのもの。端末保存の時点で組まれた値） */
const RESEND: Record<
  PendingSaveAction,
  (payload: Record<string, unknown>) => ReturnType<typeof recordFeeding>
> = {
  recordFeeding: (p) => recordFeeding(p as unknown as Parameters<typeof recordFeeding>[0]),
  recordDiaper: (p) => recordDiaper(p as unknown as Parameters<typeof recordDiaper>[0]),
  recordTemperature: (p) => recordTemperature(p as unknown as Parameters<typeof recordTemperature>[0]),
  recordGrowth: (p) => recordGrowth(p as unknown as Parameters<typeof recordGrowth>[0]),
  recordMemo: (p) => recordMemo(p as unknown as Parameters<typeof recordMemo>[0]),
}

/**
 * 送信内容が記録時刻を持たぬ（サーバの受信時刻で記録する）か。クイック記録は時刻を送らぬ（N3）。
 * 先の送信が届いておらねば、送り直した時刻で記録される — 一覧と知らせでそう伝える。
 */
function sendsServerReceiptTime(item: PendingSave): boolean {
  return item.payload.loggedAt === undefined
}

interface PendingSavesNoticeProps {
  owner: SaveOwner
  /** 確定した記録（照合で見つかった・送り直しが成立した）。画面の行へ反映する */
  onConfirmed: (log: BabyLogData) => void
  /**
   * 画面に今ある行の id（再取得・Realtime で入った行）。確認中の操作の id が現れたら、読みを待たず
   * 記録済みとして畳む。
   */
  knownLogIds?: ReadonlySet<string>
}

/**
 * 「保存を確認中の記録」の通知（2026-10-27 大型更新 A2 / AC06）。クイック記録・記録シートで結果の
 * 分からなかった操作を、再読込・再起動の後も確かめられるようにする。
 *
 * **送信キューではない**: 自動で行うのは照合の**読み**（GET /api/baby-logs/lookup）だけ。送り直しは
 * 利用者が「同じ内容でもう一度送る」を押した時だけ（端末に残した送信内容そのまま・同じ id ゆえ、
 * 先の保存が成立しておれば二重にならぬ）。「確認をやめる」は端末の記録だけを消す（DB の行には
 * 触れぬ — 記録されておれば一覧に残る）。
 *
 * 計測中・確認中の授乳（タイマー）はタイマー自身のチップが受け持つゆえ、ここには出ぬ。
 */
export function PendingSavesNotice({ owner, onConfirmed, knownLogIds }: PendingSavesNoticeProps) {
  const { userId, householdId } = owner
  const [items, setItems] = useState<PendingSave[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const lookupAbortRef = useRef<AbortController | null>(null)
  const onConfirmedRef = useRef(onConfirmed)
  useEffect(() => {
    onConfirmedRef.current = onConfirmed
  })

  const reload = useCallback(() => {
    setItems(listPendingSaves(owner).filter((p) => isAwaitingConfirmation(p)))
  }, [owner])

  const confirm = useCallback(
    (log: BabyLogData) => {
      removePendingSave(log.id)
      onConfirmedRef.current(log)
      reload()
    },
    [reload],
  )

  /** 端末に残した操作が DB に在るかを読む（書かぬ）。見つかったものを記録済みとして畳む。 */
  const reconcile = useCallback(
    async (opts: { announce: boolean }) => {
      const pending = listPendingSaves(owner).filter((p) => isAwaitingConfirmation(p))
      if (pending.length === 0) return
      lookupAbortRef.current?.abort()
      const controller = new AbortController()
      lookupAbortRef.current = controller
      setChecking(true)
      const outcome = await lookupBabyLogs(
        pending.map((p) => p.clientId),
        { signal: controller.signal, ...(owner.childId ? { childId: owner.childId } : {}) },
      )
      if (lookupAbortRef.current === controller) lookupAbortRef.current = null
      setChecking(false)
      if (outcome.status === "found") {
        for (const log of outcome.logs) confirm(log)
        if (opts.announce) {
          toast.success(
            outcome.logs.length === 1
              ? "確認中だった記録は保存されていました"
              : `確認中だった記録 ${outcome.logs.length}件は保存されていました`,
          )
        }
        return
      }
      if (opts.announce) {
        if (outcome.status === "notFound") {
          toast.info(
            "まだ見つかりません。同じ内容でもう一度送っても二重にはなりません",
          )
        } else if (outcome.status === "auth") {
          toast.error("ログインし直してから確かめてください（送った内容はこの端末に残っています）")
        } else if (outcome.status !== "cancelled") {
          toast.error("記録を確かめられませんでした。通信状況を確認してください")
        }
      }
    },
    [confirm, owner],
  )

  // 開いた時・画面へ戻った時に読みで照合する（自動の書込みはせぬ）。別タブの変更も拾う
  useEffect(() => {
    // 別のタブの送信中を伏せる猶予が切れる時に読み直して照合する（伏せたまま放っておかぬ。独立レビュー
    // 3 周目 G3: 出来事が無ければ、猶予の後も一覧に出ず照合もされなんだ）
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleGraceRecheck = () => {
      if (graceTimer) clearTimeout(graceTimer)
      graceTimer = null
      const at = nextVisibilityChangeAt(listPendingSaves(owner))
      if (at === null) return
      graceTimer = setTimeout(() => {
        reload()
        void reconcile({ announce: false })
        scheduleGraceRecheck()
      }, Math.max(0, at - Date.now()) + 50)
    }
    const refresh = () => {
      reload()
      scheduleGraceRecheck()
    }
    refresh() // 端末保存（外部の状態）を読み込む
    void reconcile({ announce: false }) // eslint-disable-line react-hooks/set-state-in-effect -- 照合の読み（外部の状態）を始める
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        refresh()
        void reconcile({ announce: false })
      }
    }
    const onStorage = (e: StorageEvent) => {
      if (isPendingSaveStorageKey(e.key)) refresh()
    }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("storage", onStorage)
    // 同じタブの書込み（クイック記録・記録シートが結果不明を残した）も即座に拾う
    window.addEventListener(PENDING_SAVES_CHANGED_EVENT, refresh)
    return () => {
      if (graceTimer) clearTimeout(graceTimer)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("storage", onStorage)
      window.removeEventListener(PENDING_SAVES_CHANGED_EVENT, refresh)
      lookupAbortRef.current?.abort()
    }
  }, [reload, reconcile, userId, householdId, owner])

  // 再取得・Realtime で同じ id の行が画面に入ったら記録済み（確定行は画面が既に持つ）
  useEffect(() => {
    if (!knownLogIds || items.length === 0) return
    const landed = items.filter((p) => knownLogIds.has(p.clientId))
    if (landed.length === 0) return
    for (const p of landed) removePendingSave(p.clientId)
    reload() // eslint-disable-line react-hooks/set-state-in-effect -- 端末の記録を読み直して一覧を畳む
  }, [knownLogIds, items, reload])

  async function resend(item: PendingSave) {
    setBusyId(item.clientId)
    try {
      const result = await RESEND[item.action](item.payload)
      if (result.error !== null) {
        const phase = phaseAfterFailure({ thrown: false, failure: result.failure })
        if (phase === "unknown") {
          toast.error("まだ保存できたか確認できていません。少し待ってからもう一度お試しください")
          return
        }
        if (phase === "rejected") {
          // この送り直しが拒まれた（ログイン切れ・一時的な失敗等）ことは、先の結果不明の送信が
          // 保存されておらぬことを意味せぬ。控えは消さず、理由と確かめ方を伝える（独立レビュー
          // 2026-10-28）。やめるかは利用者が「確認をやめる」で選ぶ
          toast.error(
            `${item.summary}: ${result.error}（前の送信が保存されたかは「記録されたか確かめる」で確かめられます）`,
          )
          return
        }
        removePendingSave(item.clientId)
        reload()
        if (result.conflict?.current) onConfirmedRef.current(result.conflict.current)
        toast.error(SAVE_CONFLICT_MESSAGE)
        return
      }
      if (result.log) {
        confirm(result.log)
      } else {
        // 確定行を持たぬ応答（古い形）。行は再取得で揃う
        removePendingSave(item.clientId)
        reload()
      }
      // 時刻を持たぬ送信内容（クイック記録）が送り直しで新しく記録された = 先の送信は届いておらず、
      // 送り直した時の受信時刻で記録した。押した時刻とは偽らず、記録された時刻と直し方を伝える（N3）
      const storedAt = result.log?.logged_at ?? result.loggedAt
      const receiptNote =
        !result.replayed && sendsServerReceiptTime(item) && storedAt
          ? `。記録時刻は届いた時刻（${formatTimeJst(storedAt)}）です。押した時刻と違う時は記録を開いて直せます`
          : ""
      toast.success(
        result.replayed
          ? `${item.summary}は記録済みでした（二重には記録していません）`
          : `${item.summary}を記録しました${receiptNote}`,
      )
    } catch (err) {
      console.error("[pending-saves-notice] 送り直しが例外を投げました", {
        message: err instanceof Error ? err.message : String(err),
      })
      toast.error("まだ保存できたか確認できていません。通信状況を確認してもう一度お試しください")
    } finally {
      setBusyId(null)
    }
  }

  function stopTracking(item: PendingSave) {
    removePendingSave(item.clientId)
    reload()
    toast.info(
      "この端末での確認をやめました。記録されていれば記録の一覧に出ます",
    )
  }

  if (items.length === 0) return null

  return (
    <section
      role="status"
      aria-label="保存を確認中の記録"
      className="flex flex-col gap-2 rounded-2xl border-2 border-amber-500/60 bg-amber-50 px-3 py-3 shadow-lg shadow-black/[0.04] dark:border-amber-500/50 dark:bg-amber-950/60"
    >
      <p className="flex items-start gap-2 text-sm font-semibold">
        <TriangleAlert size={18} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
        保存できたか確認できていない記録があります（{items.length}件）
      </p>
      <p className="text-xs text-foreground/80">
        同じ内容でもう一度送っても二重にはなりません。この一覧はこの端末にだけ残ります。
      </p>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.clientId} className="flex flex-col gap-1.5 rounded-xl bg-background/70 px-3 py-2">
            <span className="text-sm font-medium">
              {item.summary}
              <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">
                この端末の時計で {formatTimeJst(item.firstAttemptAt)} に押した操作
              </span>
            </span>
            {sendsServerReceiptTime(item) && (
              <span className="text-xs text-muted-foreground">
                まだ届いていなければ、送り直した時刻で記録されます（後から記録を開いて直せます）
              </span>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void resend(item)}
                disabled={busyId !== null}
                className="flex min-h-11 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {busyId === item.clientId && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                {SAVE_RESEND_LABEL}
              </button>
              <button
                type="button"
                onClick={() => stopTracking(item)}
                disabled={busyId !== null}
                className="min-h-11 rounded-lg px-3 text-sm text-muted-foreground transition-colors duration-200 hover:bg-muted hover:text-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                確認をやめる
              </button>
            </div>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => void reconcile({ announce: true })}
        disabled={checking || busyId !== null}
        className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors duration-200 hover:bg-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {checking && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
        記録されたか確かめる
      </button>
    </section>
  )
}

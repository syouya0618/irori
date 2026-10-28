"use client"

import { useCallback, useEffect, useState } from "react"
import { TriangleAlert } from "lucide-react"
import {
  beginCalendarCreateAttempt,
  CALENDAR_CREATE_KEY_PREFIX,
  CALENDAR_CREATES_CHANGED_EVENT,
  clearMemoryOnlyCalendarCreatesForTest,
  displayOfCalendarCreate,
  dropMemoryOnlyCalendarCreate,
  getMemoryOnlyCalendarCreate,
  listCalendarPendingCreates,
  listMemoryOnlyCalendarCreates,
  putMemoryOnlyCalendarCreate,
  removeCalendarPendingCreate,
  settleCalendarCreateAttempt,
  settleCalendarCreateOutcome,
  startCalendarCreateAttempt,
  type CalendarCreatePayload,
  type CalendarPendingCreate,
} from "@/lib/domain/calendar-pending-creates"
import { SAVE_RESEND_LABEL, type SaveOwner } from "@/lib/domain/save-attempt"
import type { CalendarEventFormValue } from "@/lib/domain/calendar-form"
import type { ReminderChoice } from "@/lib/domain/event-reminder"
import { eventWhenLabel } from "./calendar-display"

/** 画面の控え。memoryOnly = 端末に残せず、このページの間だけ持つ（再読込で消える） */
export interface PendingCreateItem {
  entry: CalendarPendingCreate
  memoryOnly: boolean
}

export interface PendingCreatesApi {
  items: PendingCreateItem[]
  /** このページで今送っておる作成の id（描画用の写し） */
  inFlight: ReadonlySet<string>
  /** 押した時点の控え（端末 + このページ）。描画の state ではなく、今の端末を読み直す */
  snapshot: () => PendingCreateItem[]
  get: (clientId: string) => PendingCreateItem | null
  begin: (args: {
    clientId: string
    payload: CalendarCreatePayload
    formValue: CalendarEventFormValue
    reminderChoice: ReminderChoice
  }) => PendingCreateItem
  /**
   * 送信の結果（成功以外）を書く。superseded = 控えは確定・取り下げで既に消えておった（遅れて届いた
   * 結果で蘇らせぬ。呼び出し側はこの結果を知らせぬ）
   */
  settle: (
    known: CalendarPendingCreate,
    outcome: { kind: "unknown" } | { kind: "rejected"; message: string },
  ) => PendingCreateItem & { superseded?: true }
  remove: (clientId: string) => void
  /** このページで今送っておるか（画面を作り直しても、同じページの送信を数える） */
  isInFlight: (clientId: string) => boolean
  markInFlight: (clientId: string, on: boolean) => void
}

// 持ち主の無い画面（userId 無し）の控えの持ち主。端末へは書かぬ
const NO_OWNER: SaveOwner = { userId: "", householdId: "" }

/**
 * このページ（モジュールの読み込み = PAGE_LIFE_ID と同じ寿命）の状態。画面（CalendarView）は別の画面へ
 * 移ると作り直されるが、送信中の Server Action は続く（独立レビュー v9rc1 PI-2: 作り直した画面が、まだ
 * 送信中の作成を「確認できていない」と出して送り直させた）。ゆえに instance ごとの ref ではなくここに置く。
 * - IN_FLIGHT: いま送っておる作成の id
 * - 端末に書けなんだ控えは domain（`listMemoryOnlyCalendarCreates` 等）が同じ寿命で持つ（local-work が数える）
 */
const IN_FLIGHT = new Set<string>()

/** 試験だけが使う: このページの状態（送信中・端末に書けなんだ控え）を空にする（再読込の模し） */
export function resetPendingCreatesPageStateForTest(): void {
  IN_FLIGHT.clear()
  clearMemoryOnlyCalendarCreatesForTest()
}

function notifyChanged(): void {
  window.dispatchEvent(new Event(CALENDAR_CREATES_CHANGED_EVENT))
}

/**
 * 予定の作成の控え（`@/lib/domain/calendar-pending-creates`）を画面へ繋ぐ。端末に書けなんだ控えは
 * このページの間だけ握る（memoryOnly。再読込で消えると利用者に伝える）。別のタブの変更・同じタブの変更を
 * 拾って読み直す。持ち主が無い画面（owner null）は端末へ書かず、このページの間だけ握る。
 */
export function useCalendarPendingCreates(owner: SaveOwner | null): PendingCreatesApi {
  const userId = owner?.userId ?? null
  const householdId = owner?.householdId ?? null
  const [items, setItems] = useState<PendingCreateItem[]>([])
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(() => new Set())

  const snapshot = useCallback((): PendingCreateItem[] => {
    const o = userId !== null && householdId !== null ? { userId, householdId } : NO_OWNER
    const stored = o === NO_OWNER ? [] : listCalendarPendingCreates(o)
    const storedIds = new Set(stored.map((e) => e.clientId))
    const memory = listMemoryOnlyCalendarCreates(o).filter((e) => !storedIds.has(e.clientId))
    return [
      ...stored.map((entry) => ({ entry, memoryOnly: false })),
      ...memory.map((entry) => ({ entry, memoryOnly: true })),
    ].sort((a, b) => a.entry.firstAttemptAt.localeCompare(b.entry.firstAttemptAt))
  }, [userId, householdId])

  const reload = useCallback(() => {
    setItems(snapshot())
    setInFlight(new Set(IN_FLIGHT))
  }, [snapshot])

  useEffect(() => {
    reload() // eslint-disable-line react-hooks/set-state-in-effect -- 端末保存（外部の状態）を読み込む
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key.startsWith(CALENDAR_CREATE_KEY_PREFIX)) reload()
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") reload()
    }
    window.addEventListener("storage", onStorage)
    window.addEventListener(CALENDAR_CREATES_CHANGED_EVENT, reload)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.removeEventListener("storage", onStorage)
      window.removeEventListener(CALENDAR_CREATES_CHANGED_EVENT, reload)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [reload])

  const keep = useCallback(
    (entry: CalendarPendingCreate, persisted: boolean): PendingCreateItem => {
      if (persisted) dropMemoryOnlyCalendarCreate(entry.clientId)
      else putMemoryOnlyCalendarCreate(entry)
      notifyChanged()
      return { entry, memoryOnly: !persisted }
    },
    [],
  )

  const get = useCallback(
    (clientId: string) => snapshot().find((i) => i.entry.clientId === clientId) ?? null,
    [snapshot],
  )

  const begin = useCallback<PendingCreatesApi["begin"]>(
    (args) => {
      const known = getMemoryOnlyCalendarCreate(args.clientId)
      if (userId === null || householdId === null) {
        const entry = startCalendarCreateAttempt(known, { ...args, owner: NO_OWNER }, new Date().toISOString())
        return keep(entry, false)
      }
      const { entry, persisted } = beginCalendarCreateAttempt({ ...args, owner: { userId, householdId }, known })
      return keep(entry, persisted)
    },
    [userId, householdId, keep],
  )

  const settle = useCallback<PendingCreatesApi["settle"]>(
    (known, outcome) => {
      // 端末に書けなんだ控えは、このページの控えだけで遷移する
      const memory = getMemoryOnlyCalendarCreate(known.clientId)
      if (memory) return keep(settleCalendarCreateOutcome(memory, outcome), false)
      if (userId === null || householdId === null) {
        // 持ち主の無い画面の控えは常にこのページだけに在る。無ければ確定・取り下げで消えておった（PI-1）
        notifyChanged()
        return { entry: settleCalendarCreateOutcome(known, outcome), memoryOnly: true, superseded: true }
      }
      const res = settleCalendarCreateAttempt(known, outcome)
      if (res.superseded) {
        // 確定・取り下げで消えておった。遅れて届いた結果で蘇らせぬ（PI-1）
        notifyChanged()
        return { entry: res.entry, memoryOnly: false, superseded: true }
      }
      return keep(res.entry, res.persisted)
    },
    [userId, householdId, keep],
  )

  const remove = useCallback(
    (clientId: string) => {
      dropMemoryOnlyCalendarCreate(clientId)
      if (userId !== null && householdId !== null) {
        removeCalendarPendingCreate({ userId, householdId }, clientId)
      }
      notifyChanged()
    },
    [userId, householdId],
  )

  const isInFlight = useCallback((clientId: string) => IN_FLIGHT.has(clientId), [])
  const markInFlight = useCallback((clientId: string, on: boolean) => {
    if (on) IN_FLIGHT.add(clientId)
    else IN_FLIGHT.delete(clientId)
    notifyChanged()
  }, [])

  return { items, inFlight, snapshot, get, begin, settle, remove, isInFlight, markInFlight }
}

/** 控えの予定の 1 行の要約（日時は送信内容から。本文は出さぬ） */
function whenOf(entry: CalendarPendingCreate): string {
  const p = entry.payload
  const label = eventWhenLabel({
    is_all_day: p.isAllDay,
    start_date: p.startDate,
    end_date: p.endDate,
    start_at: p.startAt,
    end_at: p.endAt,
  })
  return p.repeat ? `${label}・繰り返し` : label
}

interface PanelProps {
  items: PendingCreateItem[]
  /** このページで今送っておる控えの id */
  inFlight: ReadonlySet<string>
  /** この画面の一覧に楽観行（「保存中」）として既に出ておる作成の id。一覧と二重に出さぬ */
  shownAsRow: ReadonlySet<string>
  onResend: (clientId: string) => void
  onStopTracking: (clientId: string) => void
  onReopenRejected: (clientId: string) => void
  onDiscardRejected: (clientId: string) => void
}

/**
 * 「予定の追加の確認」（v9 / AC28）。作成ごとに状態と選べる操作を出す:
 * - 確認中: 同じ内容でもう一度送る（同じ id・凍結した内容。二重にならぬ）／確認をやめる（端末の控えだけ）
 * - 保存できなかった（1 度きりの送信が拒まれた）: 入力に戻る（直して新しく追加）／破棄
 * - 送信中（このページ）: 「送信中です」だけ（操作は出さぬ）。単発で一覧に楽観行が出ておるものは出さぬ
 *   （繰り返しは楽観行を作らぬ・画面を作り直すと楽観行は消えるゆえ、ここに出す。v9rc1 UX-06）
 *
 * region の名前は見出し「予定の追加の確認」。「〜の予定」で終わる名前にせぬ — 日の予定の region
 * （「{日付} の予定」。e2e calendar.spec が `/の予定$/` で絞る）と取り違えさせぬため。
 */
export function CalendarPendingCreatesPanel({
  items,
  inFlight,
  shownAsRow,
  onResend,
  onStopTracking,
  onReopenRejected,
  onDiscardRejected,
}: PanelProps) {
  const shown = items.filter((i) => !(inFlight.has(i.entry.clientId) && shownAsRow.has(i.entry.clientId)))
  if (shown.length === 0) return null
  const sending = shown.filter((i) => inFlight.has(i.entry.clientId)).length
  const rejected = shown.filter((i) => i.entry.status === "rejected" && !inFlight.has(i.entry.clientId)).length
  const unconfirmed = shown.length - sending - rejected
  const anyMemoryOnly = shown.some((i) => i.memoryOnly)
  const allMemoryOnly = shown.every((i) => i.memoryOnly)
  const counts = [
    unconfirmed > 0 ? `保存できたか確認できていない予定 ${unconfirmed}件` : null,
    rejected > 0 ? `保存できなかった予定 ${rejected}件` : null,
    sending > 0 ? `送信中 ${sending}件` : null,
  ].filter((s): s is string => s !== null)
  return (
    <section
      aria-labelledby="calendar-pending-creates-title"
      className="glass flex flex-col gap-2 rounded-2xl border border-amber-500/40 px-3 py-3 shadow-lg shadow-black/[0.04]"
    >
      <h2 id="calendar-pending-creates-title" className="flex items-start gap-2 text-sm font-semibold">
        <TriangleAlert size={18} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
        予定の追加の確認
      </h2>
      <p className="text-xs">{counts.join("・")}</p>
      <p className="text-xs text-muted-foreground">
        {unconfirmed > 0 ? "確認できていない予定は、同じ内容でもう一度送っても二重にはなりません。" : ""}
        {allMemoryOnly
          ? "この一覧はこの端末に残せていません（画面を閉じたり再読み込みしたりすると消えます）。"
          : anyMemoryOnly
            ? "この一覧はこの端末のこのブラウザにだけ残ります（印のある項目は残せていません）。"
            : "この一覧はこの端末のこのブラウザにだけ残ります。"}
      </p>
      <ul className="flex flex-col gap-2">
        {shown.map(({ entry, memoryOnly }) => {
          const display = displayOfCalendarCreate(entry, { inFlight: inFlight.has(entry.clientId) })
          return (
            <li key={entry.clientId} className="flex flex-col gap-1.5 rounded-xl bg-background/70 px-3 py-2">
              <span className="text-sm font-medium break-words">{entry.payload.title.trim() || "（タイトルなし）"}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{whenOf(entry)}</span>
              <span role="status" className="text-xs">
                {display === "in-flight"
                  ? "送信中です…"
                  : display === "other-sending"
                    ? "別の画面で送信中か、送信の途中で画面が閉じられました。保存できたか確認できていません。"
                    : display === "rejected"
                      ? `保存できませんでした${entry.lastError ? `（${entry.lastError}）` : ""}。予定は作られていません。`
                      : `保存できたか確認できていません。${
                          entry.lastError ? `前回の送り直しは受け付けられませんでした（${entry.lastError}）。` : ""
                        }`}
              </span>
              {memoryOnly && (
                <span className="text-xs text-destructive">
                  この端末に残せていません。画面を閉じたり再読み込みしたりすると、確かめる手がかりが消えます。
                </span>
              )}
              {display !== "in-flight" && (
                <div className="flex flex-wrap gap-2">
                  {display === "rejected" ? (
                    <>
                      <button
                        type="button"
                        onClick={() => onReopenRejected(entry.clientId)}
                        className="min-h-11 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        入力に戻る
                      </button>
                      <button
                        type="button"
                        onClick={() => onDiscardRejected(entry.clientId)}
                        className="min-h-11 rounded-lg px-3 text-sm text-muted-foreground transition-colors duration-200 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        破棄
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => onResend(entry.clientId)}
                        className="min-h-11 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        {SAVE_RESEND_LABEL}
                      </button>
                      <button
                        type="button"
                        onClick={() => onStopTracking(entry.clientId)}
                        className="min-h-11 rounded-lg px-3 text-sm text-muted-foreground transition-colors duration-200 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        確認をやめる
                      </button>
                    </>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

"use client"

import { useEffect, useMemo, useRef, useState, useTransition } from "react"
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react"
import {
  discardDraft,
  readDraft,
  writeDraft,
  type DraftOwner,
} from "@/lib/domain/draft-storage"
import {
  phaseAfterFailure,
  SAVE_RESEND_LABEL,
  SAVE_UNKNOWN_MESSAGE,
} from "@/lib/domain/save-attempt"
import {
  mayExistOnServer,
  probeLocalStorageWritable,
  type CalendarCreatePayload,
  type CalendarPendingCreate,
} from "@/lib/domain/calendar-pending-creates"
import { newClientId } from "@/lib/utils/client-id"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
// 送信値(start_at/end_at)の導出はシートの保存前検証と同じ関数を使い、
// 「検証した値」と「送る値」がずれないようにする。
import {
  formValueToTimestamps,
  type CalendarEventFormValue,
} from "@/lib/domain/calendar-form"
import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  deleteCalendarEventSeries,
  fetchGoogleSyncSignal,
  fetchEventReminder,
  setEventReminder,
} from "@/app/(main)/calendar/actions"
import {
  defaultReminderChoice,
  reminderRowToState,
  reminderTargetFromCreateResult,
  type ReminderChoice,
  type ReminderState,
  type ReminderTarget,
} from "@/lib/domain/event-reminder"
// startTransition 内の未処理 reject は error boundary へ bubble する（offline-error.ts）。
// 楽観挿入/削除を持つため、reject 経路でも result.error と同じ巻き戻しを行う。
import { logOfflineError, toastOfflineError } from "@/lib/utils/offline-error"
// 型のみの import ゆえ "use client" 境界を跨いでも安全（値ではない）。
import type { CalendarDateView } from "@/lib/domain/calendar-link"
import {
  useMonthEvents,
  OPTIMISTIC_EVENT_ID_PREFIX,
  type CalendarEventRecord,
} from "./use-month-events"
import { CalendarMonthView } from "./calendar-month-view"
import { CalendarAgenda } from "./calendar-agenda"
import {
  CalendarEventFormSheet,
  calendarDraftTarget,
  initialValue as formValueOfEvent,
  isCalendarDraftContent,
  sameFormValue,
  type CalendarDraftAttempt,
  type CalendarDraftContent,
} from "./calendar-event-form-sheet"
import { CalendarUpcomingList } from "./calendar-upcoming-list"
import { CalendarPendingCreatesPanel, useCalendarPendingCreates } from "./calendar-pending-creates"
import { useGoogleSyncPoll } from "./use-google-sync-poll"
import { formatDayJa } from "./calendar-display"
import { CalendarAddFab } from "./calendar-add-fab"

interface CalendarViewProps {
  initialEvents: CalendarEventRecord[]
  householdId: string
  /**
   * B-6: 最初に描く「日と月」。`resolveCalendarDateView` の戻り値をそのまま渡す。
   *
   * **日と月を別々の prop にせぬ**のが要点じゃ: 別々なら「9月20日を選びながら
   * 7月のグリッドを描く」を型が許してしまい、どのセルも光らぬまま
   * 「9月20日 の予定」が出る割れが呼び出し側の自由として残る。
   */
  initialView: CalendarDateView
  /**
   * V7: サーバが `after()` で Google 同期を予約したか。
   * true のときだけ `last_synced_at` を数回ポーリングして前進を待つ。
   */
  syncScheduled?: boolean
  /** 予約時点の `last_synced_at`（ポーリングの基準値）。 */
  initialGoogleSyncedAt?: string | null
  /**
   * B-2: `notification_preferences.event_default_minutes`。新規予定の通知の既定値。
   * null = 既定は「なし」。
   */
  defaultReminderMinutes?: number | null
  /**
   * サーバでの初回の月取得が失敗したか。true なら「予定はありません」ではなく
   * 「読み込めませんでした」と再試行を出す（`[]` を空の月と偽らぬ）。
   */
  initialLoadFailed?: boolean
  /**
   * 端末下書きの持ち主（2026-10-27 テーマ B）。省略時は端末へ書かず、保存の失敗の入力は
   * この画面の間だけ握る（従来どおり）。
   */
  userId?: string
}

/** "YYYY-MM" を "YYYY年M月" へ */
function monthTitle(monthFirst: string): string {
  const [y, m] = monthFirst.split("-")
  return `${y}年${Number(m)}月`
}

let optimisticSeq = 0

/**
 * 予定の**編集**の保存に失敗した入力。シートは保存を押した時点で閉じる（楽観更新）ゆえ、失敗の後に
 * 打ち直しを強いぬよう、ここで握って次に同じ予定を開いた時に戻す。
 * - `key`: 予定 id
 * - `baseVersion`: 送った版。**同じ版の行にしか戻さぬ** —— 家族が先に直した後で
 *   古い入力を新しい版へ載せると、版ガードを素通りして家族の変更を上書きする
 *
 * 新規の作成はここに入れぬ（v9）。送った作成は作成ごとの控え（`@/lib/domain/calendar-pending-creates`。
 * 送信内容は凍結・状態は単調）が持ち、画面の「予定の追加の確認」から件ごとに確かめる。
 */
interface FailedDraft {
  key: string
  baseVersion: string | null
  value: CalendarEventFormValue
  /** 編集は常に null（型は端末の下書きの中身と揃える） */
  clientId: null
  /** 送った結果（rejected = 保存されておらぬ / unknown = 保存されたかもしれぬ） */
  attempt: "rejected" | "unknown"
}

/**
 * 編集の保存の失敗の入力は 2 層で持つ（PRODUCT_SPEC B「保存失敗時の画面内 state と、閉じる・再読込を
 * 越える下書きを区別する」）:
 * - 画面内: FailedDraft（この画面を開いておる間。端末へ書けぬ環境でも「入力に戻る」が効く）
 * - 端末: `@/lib/domain/draft-storage` の下書き（再読込・離脱の後に戻す。持ち主・対象・版つき）
 * 開く時は画面内を先に見る（同じ画面の最新の失敗）。無ければ端末の下書きを読む。
 *
 * 新規の端末の下書き（calendar-event-new）は**送っておらぬ入力だけ**を持つ。「追加」を押した入力は
 * 作成の控えへ移し、下書きからは消す（同じ入力を新しい id で送り直す道を残さぬ）。拒まれた作成を
 * 直す入力は、その作成の id を scope にした別の枠に書く（他の入力を上書きせぬ）。
 */

/** 失敗の toast に操作を付ける時の表示時間（読んで押せる長さ）。 */
const DRAFT_TOAST_MS = 10_000

/** フォームの値から createCalendarEvent の入力（凍結する送信内容）を組む */
function createPayloadOf(v: CalendarEventFormValue, clientId: string): CalendarCreatePayload {
  const { startAt, endAt } = formValueToTimestamps(v)
  return {
    title: v.title,
    memo: v.memo,
    isAllDay: v.isAllDay,
    startDate: v.startDate,
    endDate: v.endDate,
    startAt,
    endAt,
    ...(v.repeat !== "none" && { repeat: v.repeat, repeatUntil: v.repeatUntil }),
    clientId,
  }
}

export function CalendarView({
  initialEvents,
  householdId,
  initialView,
  syncScheduled = false,
  initialGoogleSyncedAt = null,
  defaultReminderMinutes = null,
  initialLoadFailed = false,
  userId,
}: CalendarViewProps) {
  const draftOwner = useMemo<DraftOwner | null>(
    () => (userId ? { userId, householdId } : null),
    [userId, householdId],
  )
  const m = useMonthEvents({
    initialEvents,
    householdId,
    initialView,
    initialLoadFailed,
  })
  const [pending, startTransition] = useTransition()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<CalendarEventRecord | null>(null)
  // 保存の往復中の予定 id（一覧に「保存中」を出す。作成の楽観行は id の prefix で分かる）
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(() => new Set())
  const markSaving = (id: string, on: boolean) =>
    setSavingIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  // 画面内の失敗の入力（対象ごと。別の予定の失敗で上書きせぬ）
  const [failedDrafts, setFailedDrafts] = useState<ReadonlyMap<string, FailedDraft>>(
    () => new Map(),
  )
  const setFailedDraft = (draft: FailedDraft) =>
    setFailedDrafts((prev) => new Map(prev).set(draft.key, draft))
  // シートへ渡す復元入力（開いた時に決める）
  const [sheetDraft, setSheetDraft] = useState<CalendarEventFormValue | null>(null)
  const [sheetDraftNotice, setSheetDraftNotice] = useState<CalendarDraftAttempt>("rejected")
  // 開いた予定が下書きの後に更新されていた時の、読むだけの下書き
  const [staleDraft, setStaleDraft] = useState<CalendarEventFormValue | null>(null)
  // 予定の作成の控え（作成ごと。v9 / AC28）
  const pendingCreates = useCalendarPendingCreates(draftOwner)
  // このページで今送っておる作成の冪等 id（ref は同期の判定、state は一覧の表示）
  // （送信中の集合はページの寿命で pendingCreates が持つ — 画面を作り直しても送信中を数える。v9rc1 PI-2）
  // この画面で楽観行を作った作成（clientId → 一時 id）。楽観行が**今の一覧に在る間だけ**控えの一覧から
  // 外す（二重に出さぬ。v9rc1 UX-06）— 月送り・取り直しで楽観行が消えたら、控えの一覧に「送信中」で出す
  // （v9rc2: 作った事実だけで外すと、取り直しの後は送信中の表示がどこにも無くなった）
  const [rowTempIds, setRowTempIds] = useState<ReadonlyMap<string, string>>(() => new Map())
  const markRowCreate = (clientId: string, tempId: string | null) =>
    setRowTempIds((prev) => {
      const next = new Map(prev)
      if (tempId) next.set(clientId, tempId)
      else next.delete(clientId)
      return next
    })
  // 新規のシートが直しておる「保存できなかった作成」の id（null = 新しい入力）。端末の下書きの scope にも使う
  const [reworkOf, setReworkOf] = useState<string | null>(null)
  // 直しておる作成の控えが端末に書けておらぬ（memoryOnly）か — 直す入力を端末に書かぬ（控えが無ければ開く道が無い）
  const [reworkMemoryOnly, setReworkMemoryOnly] = useState(false)
  // 開いた時に確かめた、端末へ下書きを書けるか（書けぬ環境で「7日間残ります」と言わぬ。N1）
  const [draftStorageOk, setDraftStorageOk] = useState(true)
  // 新規の作成で、保存されておりうる別の作成（送信中・結果不明）が在る時の確認（v8rc2 CAL-INFLIGHT-SECOND-
  // CREATE: 同じ予定を打ち直すと黙って別の id で 2 件目になった）。確認すれば別の予定として送る
  const [createGuard, setCreateGuard] = useState<string[] | null>(null)
  const createGuardAckRef = useRef(false)

  /**
   * 端末の下書きを読む（持ち主が無い・読めぬ時は null）。楽観行の一時 id は対象にせぬ。新規は
   * `scope`（直しておる拒まれた作成の id。無ければ新しい入力の枠）
   */
  const readDeviceDraft = (editingId: string | null, scope: string | null = null) => {
    if (!draftOwner) return null
    if (editingId?.startsWith(OPTIMISTIC_EVENT_ID_PREFIX)) return null
    const r = readDraft(draftOwner, calendarDraftTarget(editingId, scope), isCalendarDraftContent)
    return r.status === "found" ? r.draft : null
  }
  /** 端末の下書きへ編集の送信の結果を残す（書けなんだら画面内の失敗の入力だけが残る） */
  const persistDraft = (
    editingId: string,
    baseVersion: string | null,
    content: CalendarDraftContent,
  ) => {
    if (!draftOwner) return
    if (editingId.startsWith(OPTIMISTIC_EVENT_ID_PREFIX)) return
    const r = writeDraft(draftOwner, calendarDraftTarget(editingId), baseVersion, content)
    if (!r.ok) console.warn("[calendar-view] draft persist failed", { reason: r.reason })
  }
  /** 端末の下書きを消す（保存成功・明示の破棄・送った新規の入力）。他の対象の下書きには触れぬ */
  const dropDeviceDraft = (editingId: string | null, scope: string | null = null) => {
    if (!draftOwner) return
    discardDraft(draftOwner, calendarDraftTarget(editingId, scope))
  }

  // ── B-2: 通知設定 ────────────────────────────────────────────
  // 既存予定は**シートを開いた時に 1 件だけ**引く。月ぶんを先読みせぬのは、
  // `event_uid` を `CALENDAR_EVENT_COLUMNS` へ入れておらぬためじゃ(入れると
  // migration より先にコードが出た瞬間に 4 画面が同時に落ちる)。
  // 読み込み中を `loading` として出すのは、既に設定済みの通知を「なし」と
  // 表示して**利用者が気付かず上書きする**のを避けるためじゃ。
  const [reminder, setReminder] = useState<ReminderState>({
    status: "ready",
    choice: "none",
  })
  // 連打で古い応答が新しい選択を踏み潰さぬようにする世代番号。
  const reminderSeq = useRef(0)

  // V7: Google 同期の完了を拾う（Realtime を使わぬ唯一の削除反映経路）。
  useGoogleSyncPoll({
    enabled: syncScheduled,
    baseline: initialGoogleSyncedAt,
    fetchSignal: fetchGoogleSyncSignal,
    onAdvanced: () => {
      // 待つ間に月を送られても、いま表示中の月を取り直す（旧月で上書きせぬ）
      void m.refetchCurrent()
    },
  })

  /**
   * 新規のシートを開く。新しい入力は送っておらぬ下書き（calendar-event-new）だけから始める — 送った
   * 作成（控え）はフォームへ戻さぬ（凍結した送信内容を書き換えて同じ id で送る道を作らぬ）。
   * `reworkId` は「保存できなかった」作成を直す時（その作成の入力、または直しかけの下書きから始める）
   */
  const openNew = (reworkId: string | null = null) => {
    setEditing(null)
    setStaleDraft(null)
    setCreateGuard(null)
    createGuardAckRef.current = false
    setDraftStorageOk(probeLocalStorageWritable())
    const rework = reworkId ? pendingCreates.get(reworkId) : null
    if (reworkId && rework && rework.entry.status === "rejected") {
      const device = rework.memoryOnly ? null : readDeviceDraft(null, reworkId)
      setReworkOf(reworkId)
      setReworkMemoryOnly(rework.memoryOnly)
      setSheetDraft(device?.content.value ?? rework.entry.formValue)
      setSheetDraftNotice(device ? "unsaved" : "rejected")
    } else {
      const device = readDeviceDraft(null)
      setReworkOf(null)
      setReworkMemoryOnly(false)
      setSheetDraft(device?.content.value ?? null)
      setSheetDraftNotice("unsaved")
    }
    setSheetOpen(true)
    // 新規は個人の既定値から始める(まだ DB に行は無い)。
    reminderSeq.current += 1
    setReminder({
      status: "ready",
      choice: defaultReminderChoice(defaultReminderMinutes),
    })
  }

  const openEvent = (event: CalendarEventRecord) => {
    setEditing(event)
    setSheetDraft(null)
    setStaleDraft(null)
    setReworkOf(null)
    setDraftStorageOk(probeLocalStorageWritable())
    // 画面内の失敗の入力を先に、無ければ端末の下書きを見る
    const inMemory = failedDrafts.get(event.id) ?? null
    const device = inMemory ? null : readDeviceDraft(event.id)
    const found = inMemory
      ? { baseVersion: inMemory.baseVersion, value: inMemory.value, attempt: inMemory.attempt }
      : device
        ? {
            baseVersion: device.baseVersion,
            value: device.content.value,
            attempt: device.content.attempt ?? ("unsaved" as const),
          }
        : null
    if (found) {
      if (found.baseVersion === event.updated_at) {
        setSheetDraft(found.value)
        setSheetDraftNotice(found.attempt)
      } else if (sameFormValue(found.value, formValueOfEvent(event, event.start_date))) {
        // 版は進んだが中身は下書きと同じ = 応答を失った自分の保存が成立しておった。家族の
        // 更新と取り違えず、保存済みとして下書きを片付ける
        forgetDraft(event.id)
        if (found.attempt === "unknown") toast.success("前回の変更は保存されていました")
      } else {
        // 下書きの後に別の端末で更新された。古い入力を新しい版へ載せぬ（上書き事故の門）。
        // 捨てずに読むだけで見せ、フォームは最新の内容で始める
        setStaleDraft(found.value)
      }
    }
    setSheetOpen(true)
    // 楽観行(まだ確定 id を持たぬ)は問い合わせても見つからぬゆえ「なし」から始める。
    if (event.id.startsWith(OPTIMISTIC_EVENT_ID_PREFIX)) {
      reminderSeq.current += 1
      setReminder({ status: "ready", choice: "none" })
      return
    }
    const seq = (reminderSeq.current += 1)
    setReminder({ status: "loading" })
    // effect ではなくクリックハンドラの promise 内で state を触る
    // (effect 内の同期 setState は React Compiler の lint が落ちる)。
    void fetchEventReminder(event.id)
      .then((res) => {
        if (reminderSeq.current !== seq) return // 別の予定へ移った後の応答は捨てる
        if (res.error) {
          // 判定不能を「なし」と偽らぬ。変更させずに理由を出す。
          setReminder({ status: "unsupported" })
          toast.error(res.error)
          return
        }
        setReminder(reminderRowToState(res.row))
      })
      .catch((err) => {
        if (reminderSeq.current !== seq) return
        setReminder({ status: "unsupported" })
        toastOfflineError("[calendar-view] fetchEventReminder", err)
      })
  }

  /**
   * 通知 Select の変更。**既存予定は即時保存**する(google の read-only 詳細シートには
   * 保存ボタンが無く、native の編集でも本文とは独立した設定として扱うほうが読みやすい)。
   * 新規予定はまだ行が無いゆえ値を保持し、作成成功後に書き込む。
   */
  const handleReminderChange = (choice: ReminderChoice) => {
    const previous = reminder
    setReminder({ status: "ready", choice })

    const target = editing
    if (!target || target.id.startsWith(OPTIMISTIC_EVENT_ID_PREFIX)) return

    const seq = (reminderSeq.current += 1)
    startTransition(async () => {
      try {
        const res = await setEventReminder({ eventId: target.id }, choice)
        if (res.error) {
          if (reminderSeq.current === seq) setReminder(previous) // 復元
          toast.error(res.error)
        }
      } catch (err) {
        // 例外は結果不明（設定が届いた後に応答だけが失われたかもしれぬ）。「未保存」と決めつけて
        // 元の選択を見せると、保存済みの設定を偽ることになる。読み直して真値を出す
        logOfflineError("[calendar-view] setEventReminder", err)
        toast.error("通知の設定を確かめられませんでした。表示を読み直します。")
        if (reminderSeq.current !== seq) return
        setReminder({ status: "loading" })
        try {
          const reread = await fetchEventReminder(target.id)
          if (reminderSeq.current !== seq) return
          setReminder(reread.error ? { status: "unsupported" } : reminderRowToState(reread.row))
        } catch (rereadErr) {
          if (reminderSeq.current !== seq) return
          // 読み直せぬ間は「なし」とも元の値とも言わず、変更させぬ
          setReminder({ status: "unsupported" })
          logOfflineError("[calendar-view] fetchEventReminder(after set)", rereadErr)
        }
      }
    })
  }

  /**
   * 予定を作った直後に通知を書く。**予定の作成は既に成功しておる**ゆえ、ここが
   * 失敗しても作成を巻き戻さず、通知が付かなかったことだけを告げる
   * (黙って落とすと「設定したのに来ぬ」という最も不快な壊れ方になる)。
   */
  const applyReminderAfterCreate = async (
    target: ReminderTarget | null,
    choice: ReminderChoice,
  ): Promise<boolean> => {
    // 宛先が決まらぬ（作成失敗・id 不明）ときと「なし」のときは何もせぬ。
    if (target === null || choice === "none") return true
    try {
      const res = await setEventReminder(target, choice)
      if (res.error) {
        toast.error("予定は作成しましたが、通知の設定に失敗しました。")
        return false
      }
      return true
    } catch (err) {
      toastOfflineError("[calendar-view] setEventReminder(create)", err)
      return false
    }
  }

  /**
   * 保存に失敗した入力を握る（画面内 + 端末の下書き）。`baseVersion` は送った版（新規は null）。
   * 端末の下書きには送信の結果も残す — 再読込の後に「保存できなかった」か「確認できていない」かを
   * 言い分け、新規なら同じ冪等 id で送り直せるように。
   */
  const holdFailedDraft = (draft: FailedDraft) => {
    setFailedDraft(draft)
    persistDraft(draft.key, draft.baseVersion, {
      value: draft.value,
      clientId: null,
      attempt: draft.attempt,
    })
  }
  /** 保存に失敗した入力を握り、toast から戻れるようにする。 */
  const keepFailedDraft = (draft: FailedDraft, message: string) => {
    holdFailedDraft(draft)
    toast.error(message, {
      duration: DRAFT_TOAST_MS,
      action: { label: "入力に戻る", onClick: () => reopenRef.current(draft.key) },
    })
  }
  /** 保存が通ったら、その対象の握っていた入力を捨てる（画面内だけ）。 */
  const clearFailedDraft = (key: string) =>
    setFailedDrafts((prev) => {
      if (!prev.has(key)) return prev
      const next = new Map(prev)
      next.delete(key)
      return next
    })
  /** 編集の保存成功・明示の破棄: 画面内と端末の両方から、その予定の入力だけを消す */
  const forgetDraft = (key: string) => {
    clearFailedDraft(key)
    dropDeviceDraft(key)
  }

  /**
   * toast の操作は失敗した時点の closure から呼ばれる。押された時点の一覧・入力を見るよう
   * ref で最新の「開き直し」を指す（ref の更新は effect で行う。render 中に書かぬ）。
   */
  const reopenRef = useRef<(key: string) => void>(() => {})
  // 作成を、控えの凍結した内容・同じ冪等 id で送り直す（toast・一覧の操作から呼ぶ。押した時点の控えを読む）
  const resendCreateRef = useRef<(clientId: string) => void>(() => {})
  // 拒まれた作成を直す新規のシートを開く（toast の「入力に戻る」から呼ぶ）
  const reworkRef = useRef<(clientId: string) => void>(() => {})
  useEffect(() => {
    reopenRef.current = (key: string) => {
      const row = m.events.find((e) => e.id === key)
      if (row) openEvent(row)
      else toast.error("予定が見つかりませんでした。削除された可能性があります。")
    }
    reworkRef.current = (clientId: string) => openNew(clientId)
  })

  /**
   * フォーム値を action 入力 + 楽観行へ変換。`meta` は楽観行が持つ id・版・シリーズ
   * （編集は保存前の行のものを保ち、保存の応答で版だけ進める。作成は版もシリーズも null）。
   */
  function toRecord(
    v: CalendarEventFormValue,
    meta: { id: string; updatedAt: string | null; seriesId: string | null },
  ): { record: CalendarEventRecord; startAt: string | null; endAt: string | null } {
    const { startAt, endAt } = formValueToTimestamps(v)
    return {
      record: {
        id: meta.id,
        title: v.title.trim(),
        memo: v.memo,
        is_all_day: v.isAllDay,
        start_date: v.startDate,
        end_date: v.endDate,
        start_at: startAt,
        end_at: endAt,
        source: "native",
        // 編集でシリーズを落とすと、取り直すまで「シリーズをすべて削除」が消える
        series_id: meta.seriesId,
        updated_at: meta.updatedAt,
      },
      startAt,
      endAt,
    }
  }

  /**
   * **自分の保存**で進んだ id と版の対応（`${id}@${版}` → 進んだ先）。
   *
   * シートは開いた時点の行を握る。保存の応答を待つ間（保存ボタンは無効）に同じ予定を
   * 開き直すと、握った行は保存後の中身・保存前の版になり、そのまま送ると自分の保存と
   * 衝突して 2 回目の編集が捨てられる。作成の応答前に開いた行は一時 id と版 null の
   * ままで、送れる id すら無い。
   *
   * ゆえに送る直前に、自分の保存が進めた分だけを辿って id と版を置き換える。手元の
   * 最新行（取り直しで家族の更新を含みうる）の版を読むのではない — それだと家族の
   * 変更を古い画面から上書きでき、版ガードが無意味になる。
   */
  const ownAdvanceRef = useRef(
    new Map<string, { id: string; updatedAt: string | null }>(),
  )
  const ownAdvanceKey = (id: string, version: string | null) =>
    `${id}@${version ?? "null"}`
  function recordOwnAdvance(
    from: { id: string; updatedAt: string | null },
    to: { id: string; updatedAt: string | null },
  ) {
    ownAdvanceRef.current.set(ownAdvanceKey(from.id, from.updatedAt), to)
  }
  function resolveOwnAdvance(row: CalendarEventRecord): CalendarEventRecord {
    let id = row.id
    let version = row.updated_at
    // 自分の保存の連鎖だけを辿る（1 シートの操作ゆえ短い。循環への歯止めに上限を置く）
    for (let i = 0; i < 32; i++) {
      const next = ownAdvanceRef.current.get(ownAdvanceKey(id, version))
      if (!next) break
      id = next.id
      version = next.updatedAt
    }
    return id === row.id && version === row.updated_at
      ? row
      : { ...row, id, updated_at: version }
  }

  const handleSubmit = (v: CalendarEventFormValue) => {
    if (!v.title.trim()) {
      toast.error("タイトルを入力してください")
      return
    }
    // 以下 3 つはシート側の保存前検証(validateCalendarFormValue)で先に弾かれるが、
    // onSubmit を呼ぶ他経路・将来の変更に対する二重防御として残す。
    // 元々は toRecord の jstWallClockToIso が空値で RangeError を投げ、event handler の
    // 未捕捉例外で「保存も toast も出ない無反応」になる経路の防御だった(現在は
    // formValueToTimestamps が null へ倒すため throw はしないが、null のまま送ると
    // サーバー往復で弾かれるため手元の toast に倒す)。
    if (!v.startDate || !v.endDate) {
      toast.error("日付を入力してください")
      return
    }
    if (!v.isAllDay && !v.startTime) {
      toast.error("開始時刻を入力してください")
      return
    }
    // 新規作成時に書き込む通知の選択(保存ボタンを押した時点の値で固定する)。
    const reminderChoice: ReminderChoice =
      reminder.status === "ready" ? reminder.choice : "none"
    // 開いた後に自分の保存が進めた id と版へ置き換える（家族の更新は辿らぬ）
    const editingSnapshot = editing ? resolveOwnAdvance(editing) : null
    if (editingSnapshot) {
      // 編集: 楽観置換 → 失敗で復元
      const { record, startAt, endAt } = toRecord(v, {
        id: editingSnapshot.id,
        updatedAt: editingSnapshot.updated_at,
        seriesId: editingSnapshot.series_id,
      })
      m.upsertOptimistic(record)
      const draftKey = editingSnapshot.id
      // 送る**前**に「送った・結果を確認中」として端末へ残す。送信の途中で画面が落ちても、再読込の
      // 後に「保存していない入力」と偽らぬ（届いておれば版が進み、開いた時に保存済みと分かる。
      // 独立レビュー 2026-10-28 v7）。シートの書き出しは送る前に書き切ってある（handleSave）
      persistDraft(draftKey, editingSnapshot.updated_at, {
        value: v,
        clientId: null,
        attempt: "unknown",
      })
      setSheetOpen(false)
      markSaving(draftKey, true)
      startTransition(async () => {
        try {
          const res = await updateCalendarEvent({
            id: editingSnapshot.id,
            title: v.title,
            memo: v.memo,
            isAllDay: v.isAllDay,
            startDate: v.startDate,
            endDate: v.endDate,
            startAt,
            endAt,
            // 開いた時点の版（自分の保存で進んだ分は上で辿った）。別の端末が先に直して
            // いれば上書きせず衝突が返る。版の無い行は送れる版が無く、サーバが断る
            expectedUpdatedAt: editingSnapshot.updated_at ?? "",
          })
          if (res.error !== null) {
            m.upsertOptimistic(editingSnapshot) // 復元
            if (res.conflict) {
              // 画面の予定が古い（先に更新・削除された）。いま表示中の月を取り直して見せる。
              // ⚠️ 入力を新しい版へ載せて送り直させぬ（家族の変更を上書きする。版ガードの趣旨）。
              // 画面内の失敗の入力は捨てる。端末の下書きは送った版のまま残る — 開き直すと
              // 最新の内容で始まり、残っていた入力は読むだけで見せる（staleDraft）
              clearFailedDraft(draftKey)
              void m.refetchCurrent()
              toast.warning(res.error, {
                duration: DRAFT_TOAST_MS,
                action: {
                  label: "最新を開く",
                  onClick: () => reopenRef.current(draftKey),
                },
              })
              return
            }
            keepFailedDraft(
              {
                key: draftKey,
                baseVersion: editingSnapshot.updated_at,
                value: v,
                clientId: null,
                attempt: "rejected",
              },
              res.error,
            )
            return
          }
          // 新しい版を手元へ。開き直したシートが握る古い版からも辿れるよう対応を残す
          recordOwnAdvance(
            { id: editingSnapshot.id, updatedAt: editingSnapshot.updated_at },
            { id: editingSnapshot.id, updatedAt: res.updatedAt },
          )
          m.upsertOptimistic({ ...record, updated_at: res.updatedAt })
          // 端末の下書きは、送った内容のままの時だけ消す。保存の往復中に開き直して打った別の入力
          // （同じ鍵へ書かれる）を、先の保存の成功で消さぬ（独立レビュー 2026-10-28 v7）
          clearFailedDraft(draftKey)
          const onDevice = readDeviceDraft(draftKey)
          if (!onDevice || sameFormValue(onDevice.content.value, v)) dropDeviceDraft(draftKey)
          toast.success("予定を更新しました")
        } catch (err) {
          // 例外（通信断・応答の喪失）は**結果不明**: 更新が届いて成立した後に応答だけが
          // 失われた形と区別できぬ（「reject = 未到達」と決めつけぬ。CONTRACT §1）。表示は
          // 開いた時点へ戻し、取り直しで真値を待つ。入力は同じ版のまま握る — 開き直した時、
          // 取り直した予定の中身が入力と同じなら自分の更新が成立しておったと分かる
          // （家族が先に更新したと取り違えぬ）。同じ内容の送り直しはサーバが成功として扱う
          m.upsertOptimistic(editingSnapshot) // 復元
          void m.refetchCurrent()
          holdFailedDraft({
            key: draftKey,
            baseVersion: editingSnapshot.updated_at,
            value: v,
            clientId: null,
            attempt: "unknown",
          })
          logOfflineError("[calendar-view] updateCalendarEvent", err)
          toast.error(SAVE_UNKNOWN_MESSAGE, {
            duration: DRAFT_TOAST_MS,
            action: { label: "入力に戻る", onClick: () => reopenRef.current(draftKey) },
          })
        } finally {
          markSaving(draftKey, false)
        }
      })
    } else {
      // 新規（単発・繰り返し）。保存されておりうる別の作成が在れば、送らず確かめさせる
      // （押した時に読む — 開いた後に結果不明になった作成・別のタブの送信中も拾う）
      if (!createGuardAckRef.current) {
        const others = unconfirmedCreates()
        if (others.length > 0) {
          setCreateGuard(others)
          return
        }
      }
      setCreateGuard(null)
      setSheetOpen(false)
      // 冪等 id はこの押下で 1 回だけ作り、送信内容と一緒に控えへ凍結する（以後の送り直しは控えから）
      startCreate(v, newClientId(), reminderChoice, reworkOf)
    }
  }

  /**
   * 保存されておりうる作成（送信中・結果不明の控え。このページ・別のタブ・再読込の前の全て）。表示用の
   * 短い要約を返す。保存できなかった（拒まれた）作成は行が無いゆえ数えぬ
   */
  function unconfirmedCreates(): string[] {
    return pendingCreates
      .snapshot()
      .filter((i) => mayExistOnServer(i.entry))
      .map((i) =>
        pendingCreates.isInFlight(i.entry.clientId)
          ? `「${i.entry.payload.title}」（送信中）`
          : `「${i.entry.payload.title}」（確認中）`,
      )
  }

  /**
   * 新しい作成を始める（AC28 / v9）。押した時の入力から送信内容を組み、冪等 id と一緒に**送る前に**
   * 作成の控えへ凍結する。送った入力は新規の下書きから消す — 再読込の後に「保存していない入力」として
   * 戻り、新しい id で送り直されて二重になる道を残さぬ（控えが端末に書けなんだ時も同じ。その時は
   * 結果不明の知らせで「端末に残せていない」と言う）。拒まれた作成を直した入力なら、その作成は
   * 新しい作成に置き換わる（行は無かったと分かっておるゆえ消してよい）。
   */
  function startCreate(
    v: CalendarEventFormValue,
    clientId: string,
    reminderChoice: ReminderChoice,
    replaces: string | null,
  ) {
    const item = pendingCreates.begin({
      clientId,
      payload: createPayloadOf(v, clientId),
      formValue: v,
      reminderChoice,
    })
    dropDeviceDraft(null, replaces)
    if (replaces) {
      const old = pendingCreates.get(replaces)
      if (old && old.entry.status === "rejected") pendingCreates.remove(replaces)
    }
    setReworkOf(null)
    sendCreate(item.entry, { alreadyBegun: true })
  }

  /**
   * 作成を 1 回送る（初回も送り直しも、控えの**凍結した送信内容そのまま**）。単発は一時 id で楽観挿入し、
   * 成功で**サーバの eventId と版**で確定する。繰り返しは楽観挿入せず、成功後に取り直す。
   *
   * 結果の扱い（`@/lib/domain/save-attempt`・`@/lib/domain/calendar-pending-creates`）:
   * - 成功（replayed を含む）・conflict: 行は在る。控えを消す（conflict は内容か回の並びが今は違う）
   * - unknown（例外・分類なしの失敗）: 作られたかもしれぬ。控えに残し、同じ内容・同じ id でだけ送り直す
   * - rejected: この送信は書いておらぬ。先の送信が成立しておりうる控えは unknown のまま（単調）。
   *   1 度きりの送信の拒否だけが「保存できなかった」（入力を直して新しく送れる）
   */
  function sendCreate(known: CalendarPendingCreate, opts: { alreadyBegun?: boolean } = {}) {
    const clientId = known.clientId
    if (pendingCreates.isInFlight(clientId)) return
    const entry = opts.alreadyBegun
      ? known
      : pendingCreates.begin({
          clientId,
          payload: known.payload,
          formValue: known.formValue,
          reminderChoice: known.reminderChoice,
        }).entry
    const payload = entry.payload
    const title = payload.title.trim()
    const reminderChoice = entry.reminderChoice
    const repeat = payload.repeat !== undefined
    const tempId = repeat ? null : `${OPTIMISTIC_EVENT_ID_PREFIX}${optimisticSeq++}`
    if (tempId) {
      m.upsertOptimistic({
        id: tempId,
        title,
        memo: payload.memo,
        is_all_day: payload.isAllDay,
        start_date: payload.startDate,
        end_date: payload.endDate,
        start_at: payload.startAt,
        end_at: payload.endAt,
        source: "native",
        series_id: null,
        updated_at: null,
      })
      markRowCreate(clientId, tempId)
    }
    pendingCreates.markInFlight(clientId, true)
    const onUnknown = () => {
      const settled = pendingCreates.settle(entry, { kind: "unknown" })
      // 作られておれば取り直しで一覧に出る（その時は控えを確定として畳む）
      void m.refetchCurrent()
      // 控えは確定・取り下げで既に消えておった。蘇らせず、送った画面にも結果の確認先を伝える（RC2-3）
      if (settled.superseded) {
        toast.info(`「${title}」の確認は既に終了しています。追加できたかは予定の一覧で確かめてください。`, { duration: DRAFT_TOAST_MS })
        return
      }
      toast.error(
        settled.memoryOnly
          ? `${SAVE_UNKNOWN_MESSAGE}この端末に残せていないため、画面を閉じると確かめる手がかりが消えます。`
          : SAVE_UNKNOWN_MESSAGE,
        {
          duration: DRAFT_TOAST_MS,
          action: { label: SAVE_RESEND_LABEL, onClick: () => resendCreateRef.current(clientId) },
        },
      )
    }
    startTransition(async () => {
      try {
        const res = await createCalendarEvent(payload)
        if (res.error !== null) {
          if (tempId) m.removeOptimistic(tempId)
          const phase = phaseAfterFailure({ thrown: false, failure: res.failure })
          if (phase === "unknown") {
            onUnknown()
          } else if (phase === "conflict") {
            // 同じ id の予定は在る（作成は成立しておった）が、今は内容か回の並びが送った内容と違う
            // （家族が直した・一部の回を消した）。二重には作らぬ。控えを畳み、一覧で確かめさせる
            pendingCreates.remove(clientId)
            void m.refetchCurrent()
            toast.warning(`「${title}」は作成済みでした。${res.error}`, { duration: DRAFT_TOAST_MS })
          } else {
            const settled = pendingCreates.settle(entry, { kind: "rejected", message: res.error })
            if (settled.superseded) {
              // 控えは別の送信の確定・利用者の取り下げで既に消えておった。遅れて届いた拒否で
              // 「保存できなかった」と蘇らせぬ（v9rc1 PI-1: 打ち直しで二重になった）
            } else if (settled.entry.status === "unknown") {
              // 先に送った作成が保存されておりうる。この拒否で「保存できなかった」とは言わぬ
              toast.error(
                `${res.error}。先に送った「${title}」は保存されているかもしれません。「予定の追加の確認」から同じ内容で送り直せます（二重にはなりません）。`,
                { duration: DRAFT_TOAST_MS },
              )
            } else {
              toast.error(res.error, {
                duration: DRAFT_TOAST_MS,
                action: { label: "入力に戻る", onClick: () => reworkRef.current(clientId) },
              })
            }
          }
          return
        }
        // 確定（replayed = 応答を失った前回の作成が成立しておった）
        pendingCreates.remove(clientId)
        if (res.seriesId !== undefined) {
          void m.refetchCurrent()
          // 宛先の決め方は単発と共通の 1 規則
          // (シリーズは id を運ばず series_id を渡す = 400 件の UUID は URL に載らぬ)。
          const reminderOk = await applyReminderAfterCreate(
            reminderTargetFromCreateResult(res),
            reminderChoice,
          )
          // 件数はサーバの値（replayed なら今のシリーズの行数）
          if (reminderOk) {
            toast.success(
              res.replayed
                ? `「${title}」は保存されていました（繰り返し${res.count}件。二重には追加していません）`
                : `繰り返し予定を${res.count}件追加しました`,
            )
          }
          return
        }
        if (tempId) {
          // 版も受け取る（無いと作成直後の打ち直しが古い画面として断られる）。
          // 応答の前に開いたシートは一時 id を握るゆえ、確定 id と版へ辿れるよう残す
          recordOwnAdvance(
            { id: tempId, updatedAt: null },
            { id: res.eventId, updatedAt: res.updatedAt },
          )
          m.replaceOptimisticId(tempId, res.eventId, res.updatedAt)
        }
        const reminderOk = await applyReminderAfterCreate(
          reminderTargetFromCreateResult(res),
          reminderChoice,
        )
        if (reminderOk) {
          toast.success(
            res.replayed ? `「${title}」は保存されていました（二重には追加していません）` : "予定を追加しました",
          )
        }
      } catch (err) {
        // 例外は結果不明（作られた後に応答だけが失われたかもしれぬ）。一時 id の行は確定 id を
        // 持たぬ幽霊になるゆえ外し、控えは同じ冪等 id のまま残す（新しい id で作り直さぬ）
        if (tempId) m.removeOptimistic(tempId)
        logOfflineError("[calendar-view] createCalendarEvent", err)
        onUnknown()
      } finally {
        pendingCreates.markInFlight(clientId, false)
        if (tempId) markRowCreate(clientId, null)
      }
    })
  }
  // toast・一覧の「同じ内容でもう一度送る」は、押された時点の控え（端末 + 画面）を読み直して送る
  // （失敗した時点の closure の値で送らぬ。reopenRef と同じ理由で effect で更新する）
  useEffect(() => {
    resendCreateRef.current = (clientId: string) => {
      const item = pendingCreates.get(clientId)
      if (!item) {
        toast.info("この予定の確認は既に終わっています。予定の一覧で確かめてください。")
        return
      }
      if (item.entry.status === "rejected") return
      sendCreate(item.entry)
    }
  })

  // 取り直した一覧に、確認中の作成の行（単発は id、繰り返しは series_id = 冪等 id）が現れたら、作成は
  // 成立しておった。読むだけで確定として畳む（このページで送信中のものは応答を待つ）
  const { items: pendingItems } = pendingCreates
  useEffect(() => {
    const landed = pendingItems.filter(
      (i) =>
        mayExistOnServer(i.entry) &&
        !pendingCreates.isInFlight(i.entry.clientId) &&
        m.events.some((e) => e.id === i.entry.clientId || e.series_id === i.entry.clientId),
    )
    for (const i of landed) {
      pendingCreates.remove(i.entry.clientId)
      toast.success(`確認中だった「${i.entry.payload.title.trim()}」は保存されていました`)
    }
  }, [m.events, pendingItems, pendingCreates])

  const handleDelete = (id: string) => {
    const snapshot = m.events.find((e) => e.id === id)
    m.removeOptimistic(id)
    setSheetOpen(false)
    startTransition(async () => {
      try {
        const res = await deleteCalendarEvent(id)
        if (res.error) {
          if (snapshot) m.upsertOptimistic(snapshot) // 復元
          toast.error(res.error)
          return
        }
        forgetDraft(id)
        toast.success(
          snapshot ? `「${snapshot.title}」を削除しました` : "予定を削除しました",
        )
      } catch (err) {
        // 例外は結果不明（削除が届いた後に応答だけが失われたかもしれぬ）。「消えた」とも
        // 「残っている」とも決めつけず、一旦戻して取り直しで真値を出す（消えておれば消える）
        if (snapshot) m.upsertOptimistic(snapshot) // 復元
        void m.refetchCurrent()
        logOfflineError("[calendar-view] deleteCalendarEvent", err)
        toast.error("削除できたか確認できていません。一覧を読み直しています。")
      }
    })
  }

  // シリーズ一括削除: 楽観的に同 series_id の行を全除去 → 失敗でスナップショット復元。
  // 単発削除(単一 id 除去)と違い複数行を消すため setAllEvents で一括置換する。
  const handleDeleteSeries = (seriesId: string) => {
    const snapshot = m.events
    m.setAllEvents(m.events.filter((e) => e.series_id !== seriesId))
    setSheetOpen(false)
    startTransition(async () => {
      try {
        const res = await deleteCalendarEventSeries(seriesId)
        if (res.error) {
          m.setAllEvents(snapshot) // 復元
          toast.error(res.error)
          return
        }
        // 件数はサーバの実削除数（手元の月に読み込んだ分ではない）
        const count = "count" in res && typeof res.count === "number" ? res.count : null
        toast.success(
          count !== null
            ? `繰り返し予定を${count}件削除しました`
            : "繰り返し予定を削除しました",
        )
      } catch (err) {
        // 例外は結果不明（単発の削除と同じ）。一旦戻して取り直しで真値を出す
        m.setAllEvents(snapshot) // 復元
        void m.refetchCurrent()
        logOfflineError("[calendar-view] deleteCalendarEventSeries", err)
        toast.error("削除できたか確認できていません。一覧を読み直しています。")
      }
    })
  }

  // 楽観行が今の一覧に在る作成（控えの一覧から外すもの）。取り直しで行が消えた作成は含めぬ
  const createsShownAsRow = useMemo(() => {
    const ids = new Set<string>()
    for (const [clientId, tempId] of rowTempIds) {
      if (m.events.some((e) => e.id === tempId)) ids.add(clientId)
    }
    return ids
  }, [rowTempIds, m.events])

  const selectedIsToday = m.selectedDate === m.today
  const isSaving = (e: CalendarEventRecord) =>
    e.id.startsWith(OPTIMISTIC_EVENT_ID_PREFIX) || savingIds.has(e.id)

  return (
    // pb-24: 一覧の最後の行が FAB（下端から nav + 1rem + 56px）に隠れぬ余白
    <div className="flex flex-col gap-4 px-4 pt-12 pb-24">
      {/* 月ナビ。h1 は画面名（予定）ではなく、いま見ている月を言う */}
      <div className="glass flex items-center justify-between rounded-2xl px-1.5 py-1.5 shadow-lg shadow-black/[0.04]">
        <Button
          variant="ghost"
          onClick={m.goPrevMonth}
          aria-label="前の月"
          className="size-11 cursor-pointer"
        >
          <ChevronLeft size={20} />
        </Button>
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="text-base font-semibold tabular-nums" aria-live="polite">
            {monthTitle(m.monthFirst)}
          </h1>
          {m.loadState === "loading" && (
            <Loader2
              size={16}
              className="animate-spin text-muted-foreground"
              aria-label="読み込み中"
            />
          )}
        </div>
        <div className="flex items-center">
          {/* 今日以外を見ている間は常に戻れる（同じ月の別の日を選んでいる時も） */}
          {!selectedIsToday && (
            <button
              type="button"
              onClick={m.goToday}
              aria-label="今日に戻る"
              className="touch-target cursor-pointer rounded-full px-3 text-sm font-medium text-primary transition-colors duration-200 hover:bg-primary/10 dark:hover:bg-primary/20"
            >
              今日
            </button>
          )}
          <Button
            variant="ghost"
            onClick={m.goNextMonth}
            aria-label="次の月"
            className="size-11 cursor-pointer"
          >
            <ChevronRight size={20} />
          </Button>
        </div>
      </div>

      <CalendarMonthView
        grid={m.grid}
        eventsByDate={m.eventsByDate}
        selectedDate={m.selectedDate}
        onSelectDate={m.setSelectedDate}
        onNavigateDate={m.goToDate}
        busy={m.loadState === "loading"}
        countsUnknown={m.loadState === "loading" || m.loadState === "error"}
      />

      <p className="-mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-1 w-2.5 rounded-full bg-primary" />
          irori の予定
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-1 w-2.5 rounded-full bg-muted-foreground/60" />
          Google の予定（閲覧のみ）
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-muted-foreground/60" />
          時刻あり
        </span>
      </p>

      {/* 予定の追加の確認（作成ごと。v9 / AC28）。件ごとに送り直す・確認をやめるを選ぶ */}
      <CalendarPendingCreatesPanel
        items={pendingCreates.items}
        inFlight={pendingCreates.inFlight}
        shownAsRow={createsShownAsRow}
        onResend={(clientId) => resendCreateRef.current(clientId)}
        onStopTracking={(clientId) => {
          pendingCreates.remove(clientId)
          toast.info("この端末での確認をやめました。作成されていれば予定の一覧に出ます")
        }}
        onReopenRejected={(clientId) => openNew(clientId)}
        onDiscardRejected={(clientId) => {
          pendingCreates.remove(clientId)
          dropDeviceDraft(null, clientId)
        }}
      />

      <CalendarAgenda
        dateLabel={formatDayJa(m.selectedDate)}
        events={m.selectedEvents}
        selectedDate={m.selectedDate}
        onTapEvent={openEvent}
        isToday={selectedIsToday}
        loadState={m.loadState}
        onRetry={() => void m.retry()}
        onAdd={() => openNew()}
        isSaving={isSaving}
      />

      {/* 直近の予定（月表示は保ち、読み込んでいる範囲から今日以降を並べる。2026-10-27 D） */}
      <CalendarUpcomingList
        events={m.events}
        monthFirst={m.monthFirst}
        today={m.today}
        loadState={m.loadState}
        onSelectDate={m.goToDate}
        onGoToday={m.goToday}
      />

      {/* FAB(親指圏)。位置（ナビの上・列の右端・下端トーストの回避）は部品が持つ */}
      <CalendarAddFab
        label={`${formatDayJa(m.selectedDate)}に予定を追加`}
        onClick={() => openNew()}
      />

      <CalendarEventFormSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        editing={editing}
        defaultDate={m.selectedDate}
        saving={pending}
        onSubmit={handleSubmit}
        onDelete={handleDelete}
        onDeleteSeries={handleDeleteSeries}
        reminder={reminder}
        onReminderChange={handleReminderChange}
        initialDraft={sheetDraft}
        draftNotice={sheetDraftNotice}
        draftOwner={draftOwner}
        draftScope={editing ? null : reworkOf}
        draftStorageAvailable={draftStorageOk}
        // 直す入力は元の控えと同じ期限で消える（控えが期限で消える時に一緒に消す。v9rc1 UX-04）。控えが端末に
        // 書けておらねば、直す入力も端末に書かぬ（再読込で控えが消え、開く道が無くなる）
        draftRetentionNote={
          !editing && reworkOf
            ? "この入力は、元の予定を最初に追加しようとしてから7日間、この端末のこのブラウザにだけ残ります（バックアップではなく、家族とも共有されません）"
            : null
        }
        draftDisabledReason={
          !editing && reworkOf && reworkMemoryOnly
            ? "元の予定の控えをこの端末に残せていないため、この入力も残せません。閉じると消えます"
            : !editing && reworkOf && !pendingCreates.items.some((i) => i.entry.clientId === reworkOf)
              ? // 開いておる間に、元の控えが別の画面で片付けられた・期限で消えた（v9rc2 UX-04 の変種: 控え無しの
                // 下書きを書き続け、開く道の無い下書きが残った）。書かぬ。追加すれば新しい予定として送る
                "元の予定の控えはもうこの端末にありません。この入力は残せません（追加すると新しい予定として送ります）"
              : null
        }
        staleDraft={staleDraft}
        createGuard={editing ? null : createGuard}
        onCreateAsSeparate={() => {
          // 確認を経た別の予定の作成。シートは押した時の最新の入力で送り直す（handleSave → handleSubmit）
          createGuardAckRef.current = true
        }}
        onDiscardStaleDraft={() => {
          if (!editing) return
          setStaleDraft(null)
          forgetDraft(editing.id)
        }}
        onDiscardDraft={() => {
          // 開いておる予定・入力だけを捨てる（他の予定の入力・他の作成の控えには触れぬ）
          setSheetDraft(null)
          if (editing) {
            forgetDraft(editing.id)
            return
          }
          dropDeviceDraft(null, reworkOf)
          // 保存できなかった作成を直す入力の破棄 = その作成を捨てた（行は無いと分かっておる）。シートは閉じる
          // — 開いたまま書き先を新しい入力の枠へ切り替えると、そこに在る送っておらぬ別の下書きを次の打鍵で
          // 黙って上書きする（v9rc1 UX-01）
          if (reworkOf) {
            const old = pendingCreates.get(reworkOf)
            if (old && old.entry.status === "rejected") pendingCreates.remove(reworkOf)
            setReworkOf(null)
            setSheetOpen(false)
            toast.info("保存できなかった予定の入力を破棄しました")
          }
        }}
      />
    </div>
  )
}

"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react"
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
import { toastOfflineError } from "@/lib/utils/offline-error"
// 型のみの import ゆえ "use client" 境界を跨いでも安全（値ではない）。
import type { CalendarDateView } from "@/lib/domain/calendar-link"
import {
  useMonthEvents,
  OPTIMISTIC_EVENT_ID_PREFIX,
  type CalendarEventRecord,
} from "./use-month-events"
import { CalendarMonthView } from "./calendar-month-view"
import { CalendarAgenda } from "./calendar-agenda"
import { CalendarEventFormSheet } from "./calendar-event-form-sheet"
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
}

/** "YYYY-MM" を "YYYY年M月" へ */
function monthTitle(monthFirst: string): string {
  const [y, m] = monthFirst.split("-")
  return `${y}年${Number(m)}月`
}

let optimisticSeq = 0

/**
 * 保存に失敗した入力。シートは保存を押した時点で閉じる（楽観更新）ゆえ、失敗の後に
 * 打ち直しを強いぬよう、ここで握って次に同じ予定を開いた時に戻す。
 * - `key`: "new"（新規）か予定 id（編集）
 * - `baseVersion`: 編集の時に送った版。**同じ版の行にしか戻さぬ** —— 家族が先に直した後で
 *   古い入力を新しい版へ載せると、版ガードを素通りして家族の変更を上書きする
 */
interface FailedDraft {
  key: string
  baseVersion: string | null
  value: CalendarEventFormValue
}

/** 失敗の toast に「入力に戻る」を付ける時の表示時間（読んで押せる長さ）。 */
const DRAFT_TOAST_MS = 10_000

export function CalendarView({
  initialEvents,
  householdId,
  initialView,
  syncScheduled = false,
  initialGoogleSyncedAt = null,
  defaultReminderMinutes = null,
  initialLoadFailed = false,
}: CalendarViewProps) {
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
  const [failedDraft, setFailedDraft] = useState<FailedDraft | null>(null)
  // シートへ渡す復元入力（開いた時に決める）
  const [sheetDraft, setSheetDraft] = useState<CalendarEventFormValue | null>(null)

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

  const openNew = () => {
    setEditing(null)
    setSheetDraft(failedDraft?.key === "new" ? failedDraft.value : null)
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
    if (failedDraft?.key === event.id) {
      if (failedDraft.baseVersion === event.updated_at) {
        setSheetDraft(failedDraft.value)
      } else {
        // 家族（または同期）が先に直した。古い入力を新しい版へ載せぬ（上書き事故の門）
        setSheetDraft(null)
        setFailedDraft(null)
        toast.warning(
          "保存できなかった入力は、この予定が先に更新されたため破棄しました。最新の内容を表示しています。",
        )
      }
    } else {
      setSheetDraft(null)
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
        // reject はサーバー未到達 = 未保存。選択を元へ戻す。
        if (reminderSeq.current === seq) setReminder(previous)
        toastOfflineError("[calendar-view] setEventReminder", err)
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

  /** 保存に失敗した入力を握り、toast から戻れるようにする。 */
  const keepFailedDraft = (draft: FailedDraft, message: string) => {
    setFailedDraft(draft)
    toast.error(message, {
      duration: DRAFT_TOAST_MS,
      action: { label: "入力に戻る", onClick: () => reopenRef.current(draft.key) },
    })
  }
  /** 保存が通ったら、その対象の握っていた入力を捨てる。 */
  const clearFailedDraft = (key: string) =>
    setFailedDraft((prev) => (prev?.key === key ? null : prev))

  /**
   * toast の操作は失敗した時点の closure から呼ばれる。押された時点の一覧・入力を見るよう
   * ref で最新の「開き直し」を指す（ref の更新は effect で行う。render 中に書かぬ）。
   */
  const reopenRef = useRef<(key: string) => void>(() => {})
  useEffect(() => {
    reopenRef.current = (key: string) => {
      if (key === "new") {
        openNew()
        return
      }
      const row = m.events.find((e) => e.id === key)
      if (row) openEvent(row)
      else toast.error("予定が見つかりませんでした。削除された可能性があります。")
    }
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
      setSheetOpen(false)
      const draftKey = editingSnapshot.id
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
              // ⚠️ 入力は握らぬ: 新しい版へ載せて送り直せば家族の変更を上書きする（版ガードの趣旨）
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
              { key: draftKey, baseVersion: editingSnapshot.updated_at, value: v },
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
          clearFailedDraft(draftKey)
          toast.success("予定を更新しました")
        } catch (err) {
          // reject はサーバー未到達 = 確実に未更新。楽観置換を元へ戻す。
          m.upsertOptimistic(editingSnapshot) // 復元
          setFailedDraft({
            key: draftKey,
            baseVersion: editingSnapshot.updated_at,
            value: v,
          })
          toastOfflineError("[calendar-view] updateCalendarEvent", err)
        } finally {
          markSaving(draftKey, false)
        }
      })
    } else if (v.repeat !== "none") {
      // 繰り返し作成: 複数行 materialize の楽観再現はコストに見合わないため楽観挿入を
      // スキップし、action 成功後に refetch(use-month-events の既存 refetch)。
      const { startAt, endAt } = toRecord(v, {
        id: "recurring",
        updatedAt: null,
        seriesId: null,
      })
      setSheetOpen(false)
      startTransition(async () => {
        try {
          const res = await createCalendarEvent({
            title: v.title,
            memo: v.memo,
            isAllDay: v.isAllDay,
            startDate: v.startDate,
            endDate: v.endDate,
            startAt,
            endAt,
            repeat: v.repeat,
            repeatUntil: v.repeatUntil,
          })
          if (res.error) {
            keepFailedDraft({ key: "new", baseVersion: null, value: v }, res.error)
          } else {
            clearFailedDraft("new")
            void m.refetchCurrent()
            // 宛先の決め方は単発と共通の 1 規則
            // (シリーズは id を運ばず series_id を渡す = 400 件の UUID は URL に載らぬ)。
            const reminderOk = await applyReminderAfterCreate(
              reminderTargetFromCreateResult(res),
              reminderChoice,
            )
            if (reminderOk) {
              const count = "count" in res && typeof res.count === "number" ? res.count : null
              toast.success(
                count !== null
                  ? `繰り返し予定を${count}件追加しました`
                  : "繰り返し予定を追加しました",
              )
            }
          }
        } catch (err) {
          // この分岐だけは楽観挿入をしていない（上のコメント参照）ため巻き戻し不要。
          setFailedDraft({ key: "new", baseVersion: null, value: v })
          toastOfflineError("[calendar-view] createCalendarEvent(repeat)", err)
        }
      })
    } else {
      // 新規: temp id で楽観挿入 → 成功で確定 id 差し替え / 失敗で除去
      const tempId = `${OPTIMISTIC_EVENT_ID_PREFIX}${optimisticSeq++}`
      const { record, startAt, endAt } = toRecord(v, {
        id: tempId,
        updatedAt: null,
        seriesId: null,
      })
      m.upsertOptimistic(record)
      setSheetOpen(false)
      startTransition(async () => {
        try {
          const res = await createCalendarEvent({
            title: v.title,
            memo: v.memo,
            isAllDay: v.isAllDay,
            startDate: v.startDate,
            endDate: v.endDate,
            startAt,
            endAt,
          })
          if (res.error || !("eventId" in res) || !res.eventId) {
            m.removeOptimistic(tempId)
            keepFailedDraft(
              { key: "new", baseVersion: null, value: v },
              res.error ?? "予定の作成に失敗しました。",
            )
          } else {
            clearFailedDraft("new")
            // 版も受け取る（無いと作成直後の打ち直しが古い画面として断られる）。
            // 応答の前に開いたシートは一時 id を握るゆえ、確定 id と版へ辿れるよう残す
            const createdVersion = "updatedAt" in res ? (res.updatedAt ?? null) : null
            recordOwnAdvance(
              { id: tempId, updatedAt: null },
              { id: res.eventId, updatedAt: createdVersion },
            )
            m.replaceOptimisticId(tempId, res.eventId, createdVersion)
            const reminderOk = await applyReminderAfterCreate(
              reminderTargetFromCreateResult(res),
              reminderChoice,
            )
            if (reminderOk) toast.success("予定を追加しました")
          }
        } catch (err) {
          // reject はサーバー未到達 = 予定は作られていない。temp 行を残すと
          // 確定 id を持たない幽霊が居座るため必ず除去する。
          m.removeOptimistic(tempId)
          setFailedDraft({ key: "new", baseVersion: null, value: v })
          toastOfflineError("[calendar-view] createCalendarEvent", err)
        }
      })
    }
  }

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
        clearFailedDraft(id)
        toast.success(
          snapshot ? `「${snapshot.title}」を削除しました` : "予定を削除しました",
        )
      } catch (err) {
        // reject はサーバー未到達 = 予定は残っている。復元しないと
        // 「消えたはずの予定が復帰で蘇る」不整合になる。
        if (snapshot) m.upsertOptimistic(snapshot) // 復元
        toastOfflineError("[calendar-view] deleteCalendarEvent", err)
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
        // reject はサーバー未到達 = シリーズは残っている。一括除去を巻き戻す。
        m.setAllEvents(snapshot) // 復元
        toastOfflineError("[calendar-view] deleteCalendarEventSeries", err)
      }
    })
  }

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

      <CalendarAgenda
        dateLabel={formatDayJa(m.selectedDate)}
        events={m.selectedEvents}
        selectedDate={m.selectedDate}
        onTapEvent={openEvent}
        isToday={selectedIsToday}
        loadState={m.loadState}
        onRetry={() => void m.retry()}
        onAdd={openNew}
        isSaving={isSaving}
      />

      {/* FAB(親指圏)。位置（ナビの上・列の右端・下端トーストの回避）は部品が持つ */}
      <CalendarAddFab
        label={`${formatDayJa(m.selectedDate)}に予定を追加`}
        onClick={openNew}
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
        onDiscardDraft={() => {
          // 開いておる予定の入力だけを捨てる（裏で別の予定の保存が失敗して握り直した入力は残す）
          const key = editing?.id ?? "new"
          setSheetDraft(null)
          clearFailedDraft(key)
        }}
      />
    </div>
  )
}

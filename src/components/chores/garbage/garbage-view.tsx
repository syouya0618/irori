"use client"

import { useState } from "react"
import Link from "next/link"
import { AlertCircle, BellOff, BellRing, CalendarPlus, CircleCheck, CircleHelp, Lock, Repeat, Trash } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { formatDayJa, eventWhenLabel } from "@/components/calendar/calendar-display"
import type { ChoreOwner } from "@/lib/domain/chore-pending"
import { REMINDER_OPTIONS, reminderRowToState } from "@/lib/domain/event-reminder"
import {
  collectionDayRelativeLabel,
  garbageRequestLabel,
  isGarbageRequest,
  type EventPurposeScope,
  type GarbageAction,
  type GarbageCollectionView,
  type GarbageEventSummary,
  type GarbagePurposeEntry,
  type GarbageRequest,
  type GarbageSaveSuccess,
  type GarbageReminderChoice,
  type ResolvedEventPurpose,
} from "@/lib/domain/garbage"
import type { GarbagePageData } from "@/lib/supabase/garbage-overview-query"
import { submitGarbageRequest } from "@/app/(main)/chores/garbage/actions"
import { EmptyState } from "@/components/chores/shared/empty-state"
import { PendingChoreNotice } from "@/components/chores/shared/pending-chore-notice"
import { RefreshOnVisible } from "@/components/chores/shared/refresh-on-visible"
import { SectionError } from "@/components/chores/shared/section-error"
import { CHORE_SAVE_MESSAGES, createChoreEditSessions, useChoreSave } from "@/components/chores/shared/use-chore-save"
import { GarbageKindAvatar } from "./garbage-kind-icon"
import { GarbageNotificationStatus } from "./garbage-notification-status"
import { GarbagePurposeForm, type GarbageFormTarget } from "./garbage-purpose-form"

interface GarbageViewProps {
  owner: ChoreOwner
  data: GarbagePageData
}

/** 変更・解除のシートの中身（どの予定を、どの範囲で、どの操作から始めるか）。 */
interface Editing {
  target: GarbageFormTarget
  current: Exclude<ResolvedEventPurpose, { kind: "unknown" }>
  lockedScope?: EventPurposeScope
  initialMode?: GarbageAction
  initialReminder?: GarbageReminderChoice
  /** 開くたびに増える編集セッション（R35。同じ予定を開き直しても別の番号） */
  session: number
}

/** 送った後に場所が変わった操作の結果（どの操作かを添えて、シートの外にだけ出す）。 */
interface EarlierNotice {
  text: string
  tone: "status" | "alert"
}

function targetOf(event: GarbageEventSummary): GarbageFormTarget {
  return {
    id: event.id,
    title: event.title,
    whenLabel: eventWhenLabel({ ...event, end_at: null }),
    isSeries: event.isSeries,
    startDate: event.start_date,
  }
}

/**
 * 収集日の通知の有無を文で言う（読めなんだ時は「なし」と言わぬ）。
 * 通知の時刻がもう過ぎておる回には「通知」と言わぬ — 設定の行は在っても、これからは届かぬ
 * （当日に分類した回・前日 20:00 より後に分類した回）。既に届いた後でもありうるゆえ、
 * 「届かなかった」とも言わぬ。
 */
function reminderText(
  collection: GarbageCollectionView,
  reminders: GarbagePageData["reminders"],
): { text: string; on: boolean | null } {
  const key = collection.event.eventKey
  if (reminders.status === "failed" || key === null) {
    return { text: "通知の設定を確認できませんでした", on: null }
  }
  const row = Object.prototype.hasOwnProperty.call(reminders.byEventKey, key)
    ? reminders.byEventKey[key]
    : null
  if (!row) {
    const stopped = collection.purpose.kind === "garbage" && collection.purpose.reminderOptOut
    return { text: stopped ? "通知なし（この回は止めています）" : "通知なし", on: false }
  }
  const state = reminderRowToState(row)
  if (row.passed) {
    const when = state.status === "ready" && state.choice === "prev_day_20" ? "前日 20:00 は" : "通知の時刻は"
    return { text: `${when}過ぎています（この回の通知は、これからは届きません）`, on: false }
  }
  if (state.status !== "ready" || state.choice === "none") return { text: "通知あり", on: true }
  if (state.choice === "prev_day_20") return { text: "前日 20:00 に通知", on: true }
  const label = REMINDER_OPTIONS.find((o) => o.value === state.choice)?.label ?? ""
  return { text: `${label}に通知`, on: true }
}

const SECTION = "flex flex-col gap-3"
const HEADING = "text-sm font-semibold text-muted-foreground"
const CARD = "glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"

/**
 * ごみの画面の本体（次の収集日・分類の一覧・予定が見つからぬ分類の整理・通知の状態）。
 *
 * 表示は Server Component が読んだ `data` からだけ組む（手元に写しを持たぬ）。保存が確定したら
 * `router.refresh()`（共通 hook）で取り直す。他の端末（家族）の変更は、この画面へ戻った時に映る。
 *
 * 応答は、その操作を送ったシートだけを閉じる（R35）。シートは開くたびに新しい編集セッションの番号を持ち、
 * 送った後に閉じた・別の回（同じ回の開き直しも）を開いた時は、開いておるシートの選択には触れず、結果は
 * 「どの操作か」を添えてシートの外に出す。その操作自身の控えの確定と取り直しは、いつでも行う。
 */
export function GarbageView({ owner, data }: GarbageViewProps) {
  const [editing, setEditing] = useState<Editing | null>(null)
  const [confirmingOrphan, setConfirmingOrphan] = useState<string | null>(null)
  const [earlier, setEarlier] = useState<EarlierNotice | null>(null)
  // 編集セッションの番号札（応答の時に今のシートを読む。開閉と同時に書き換える）
  const [sessions] = useState(createChoreEditSessions)
  const closeEditor = () => {
    sessions.close()
    setEditing(null)
  }
  const save = useChoreSave<GarbageRequest, GarbageSaveSuccess>({
    owner,
    kind: "garbage",
    run: submitGarbageRequest,
    isPayload: isGarbageRequest,
    sessions,
    onOutcome: (outcome) => {
      const origin = outcome.origin
      // 確定（保存・拒否）したら、送ったシートだけを閉じる。結果不明の間は開いたまま、控えの一覧で確かめさせる
      if (outcome.kind === "settled" && outcome.status !== "conflict" &&
          outcome.result.purposeLoad?.status !== "failed" && (origin?.current ?? true)) closeEditor()
      if (outcome.kind === "settled" && outcome.result.purposeLoad?.status === "failed") {
        setEarlier({ text: "分類の保存結果は届きましたが、読み直しを確認できません。画面を再読込して確認してください。", tone: "alert" })
      }
      // 操作した場所が変わった（シートを閉じた・別のシートを開いた）時は、結果をどの操作かを添えてシートの外に出す
      // （結果不明は控えの一覧が、どの操作かを添えて伝える）
      if (origin && !origin.inPlace && outcome.kind !== "unknown") {
        const which = `先に送った操作（${origin.label}）`
        setEarlier(
          outcome.kind === "rejected"
            ? { text: `${which}は保存できませんでした。${outcome.error}`, tone: "alert" }
            : outcome.status === "conflict"
              ? { text: `${which}: ${CHORE_SAVE_MESSAGES.conflict}`, tone: "alert" }
              : { text: `${which}を保存しました。`, tone: "status" },
        )
      }
    },
  })

  const { overview, today } = data
  // 分類と予定の両方を読めた時だけ候補を出す（読めなんだ時に「未分類」「候補なし」と言わぬ）
  const candidatesReadable = data.purposes === "ok" && data.events !== "failed" && data.candidates !== undefined
  const candidates = candidatesReadable ? (data.candidates ?? []) : []
  const linked = overview.entries.filter((e) => e.state !== "orphan")
  const orphans = overview.entries.filter((e) => e.state === "orphan")
  const eventsReadable = data.events !== "failed"

  const openEditor = (
    event: GarbageEventSummary,
    current: ResolvedEventPurpose | null,
    options: { lockedScope?: EventPurposeScope; initialMode?: GarbageAction; initialReminder?: GarbageReminderChoice } = {},
  ) => {
    if (current === null || current.kind === "unknown") return
    setEditing({ target: targetOf(event), current, ...options, session: sessions.begin() })
  }

  /** シートの外から送る（一覧の整理）。先に送った操作の結果は、ここで次の操作をした = 見た */
  const sendFromPage = (request: GarbageRequest, label: string) => {
    setEarlier(null)
    save.send(request, label)
  }

  return (
    <>
      {earlier && (
        <p
          role={earlier.tone === "alert" ? "alert" : "status"}
          className="flex items-start gap-2 text-sm text-foreground"
        >
          {earlier.tone === "alert" ? (
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
          ) : (
            <CircleCheck size={16} className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
          )}
          <span className="min-w-0 break-words">{earlier.text}</span>
        </p>
      )}
      {/* シートを開いておる間の文言は、シートの中に出す（どのシートの操作の結果かを取り違えぬ） */}
      <PendingChoreNotice save={save} showMessage={editing === null} />

      {/* ── 次の収集日 ── */}
      <section aria-labelledby="garbage-next-heading" className={SECTION}>
        <h2 id="garbage-next-heading" className={HEADING}>
          次の収集日
        </h2>
        {data.purposes === "failed" ? (
          <SectionError what="ごみの分類" />
        ) : !eventsReadable ? (
          <SectionError what="今後の予定" />
        ) : overview.entries.length === 0 ? (
          <EmptyState
            icon={Trash}
            title="ごみの日はまだ登録されていません"
            description="カレンダーで予定を作り（毎週の収集は「繰り返し」で）、その予定を開いて「ごみの日にする」を押すと、ここに並びます。"
          >
            {/* 素の Link（Base UI の Button に Link を描かせると role / type が食い違う）。見た目だけ主ボタン */}
            <Link
              href="/calendar"
              className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors duration-200 hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-ring"
            >
              <CalendarPlus size={16} aria-hidden="true" />
              カレンダーで予定を作る
            </Link>
          </EmptyState>
        ) : overview.collections.length === 0 ? (
          <div className={CARD}>
            <p className="text-sm">今日から{data.windowDays}日のあいだに、収集日はありません。</p>
            <p className="text-xs text-muted-foreground">
              繰り返しの予定は最長 1 年ぶんまでです。続きはカレンダーで予定を足してください。
            </p>
            <Link
              href="/calendar"
              className="flex min-h-11 w-fit items-center gap-1 rounded-lg px-2 text-sm font-medium text-primary transition-colors duration-200 hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <CalendarPlus size={16} aria-hidden="true" />
              カレンダーを開く
            </Link>
          </div>
        ) : (
          <>
            <ul className="flex flex-col gap-2" data-testid="garbage-collections">
              {overview.collections.map((c) => {
                const reminder = reminderText(c, data.reminders)
                const relative = collectionDayRelativeLabel(c.date, today)
                return (
                  <li key={c.event.id} className="glass flex items-start gap-3 rounded-2xl p-3 shadow-lg shadow-black/[0.04]">
                    <GarbageKindAvatar label={c.label} />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <p className="text-sm font-semibold break-words">{c.label}</p>
                      <p className="text-sm tabular-nums">
                        {formatDayJa(c.date)}
                        {relative && <span className="text-muted-foreground">（{relative}）</span>}
                      </p>
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        <span className="min-w-0 break-words">予定「{c.event.title}」</span>
                        {c.event.source === "google" && (
                          <span className="flex items-center gap-1">
                            <Lock size={12} aria-hidden="true" />
                            Google
                          </span>
                        )}
                        {c.event.isSeries && (
                          <span className="flex items-center gap-1">
                            <Repeat size={12} aria-hidden="true" />
                            {c.scope === "event" ? "この回だけの分類" : "繰り返し"}
                          </span>
                        )}
                      </p>
                      <p className="flex items-center gap-1 text-xs text-muted-foreground">
                        {reminder.on === true ? (
                          <BellRing size={12} aria-hidden="true" />
                        ) : reminder.on === false ? (
                          <BellOff size={12} aria-hidden="true" />
                        ) : (
                          <CircleHelp size={12} aria-hidden="true" />
                        )}
                        {reminder.text}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      aria-label={`${formatDayJa(c.date)}の${c.label}を変更`}
                      onClick={() => openEditor(c.event, c.purpose)}
                      className="shrink-0 cursor-pointer"
                    >
                      変更
                    </Button>
                  </li>
                )
              })}
            </ul>
            {overview.moreCollections > 0 && (
              <p className="text-xs text-muted-foreground">
                ほかに{overview.moreCollections}件の収集日があります（近い順に{overview.collections.length}件を表示しています）。
              </p>
            )}
            {data.events === "truncated" && (
              <p className="text-xs text-muted-foreground">
                予定が多いため、期間の後ろのほうの収集日は表示できていない可能性があります。
              </p>
            )}
          </>
        )}
      </section>

      {/* ── 既存カレンダー予定の確認（自動登録・通知変更をしない）── */}
      {candidatesReadable && (candidates.length > 0 || overview.entries.length === 0) && (
        <section aria-labelledby="garbage-candidates-heading" className={SECTION} data-testid="garbage-candidates">
          <h2 id="garbage-candidates-heading" className={HEADING}>既存の予定から候補を確認</h2>
          {candidates.length > 0 ? (
            <>
              <p className="text-xs text-muted-foreground">
                予定名から見つけた候補です。ごみの日と決めつけず、1件ずつ確認して分類してください。
                通知は「変えない」が初期値です。予定そのものは変更しません。
              </p>
              <ul className="flex flex-col gap-2">
                {candidates.map((candidate) => (
                  <li key={candidate.event.id} className={CARD}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-sm font-medium">{candidate.event.title}</p>
                        <p className="text-xs text-muted-foreground">{formatDayJa(candidate.event.start_date)}{candidate.event.isSeries ? "・繰り返し" : ""}{candidate.event.source === "google" ? "・Google" : ""}</p>
                        {candidate.suggestedKind && <p className="text-xs text-muted-foreground">名称の候補: {candidate.suggestedKind}（未確定）</p>}
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        aria-label={`予定「${candidate.event.title}」（${formatDayJa(candidate.event.start_date)}）を確認して分類`}
                        className="shrink-0 cursor-pointer"
                        onClick={() => openEditor(candidate.event, candidate.current, { initialReminder: "keep" })}
                      >
                        確認して分類
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              {data.candidatesMore && (
                <p className="text-xs text-muted-foreground">
                  ほかにも候補があります（近い順に{candidates.length}件を表示しています）。分類すると次の候補が出ます。
                </p>
              )}
            </>
          ) : (
            <p className="text-sm">ごみの日らしい名前の予定は見つかりませんでした。</p>
          )}
          {data.events === "truncated" && <p className="text-xs text-muted-foreground">予定が多いため候補は一部だけかもしれません。</p>}
          <p className="text-xs text-muted-foreground" data-testid="garbage-candidates-scope">
            探したのは、今日から{data.windowDays}日のあいだの予定の名前だけです。それより先の予定や、名前から判断できない予定は候補に出ません。カレンダーで予定を開いて分類できます。
          </p>
        </section>
      )}

      {/* ── 分類の一覧 ── */}
      {data.purposes === "ok" && linked.length > 0 && (
        <section aria-labelledby="garbage-kinds-heading" className={SECTION}>
          <h2 id="garbage-kinds-heading" className={HEADING}>
            分類した予定
          </h2>
          <ul className="flex flex-col gap-2" data-testid="garbage-entries">
            {linked.map((entry) => (
              <EntryRow
                key={entry.row.id}
                entry={entry}
                today={today}
                windowDays={data.windowDays}
                eventsReadable={eventsReadable}
                onChange={() =>
                  entry.anchor && openEditor(entry.anchor, entry.anchorPurpose, { lockedScope: entry.row.scope })
                }
                onClear={() =>
                  entry.anchor &&
                  openEditor(entry.anchor, entry.anchorPurpose, {
                    lockedScope: entry.row.scope,
                    initialMode: "clear",
                  })
                }
              />
            ))}
          </ul>
        </section>
      )}

      {/* ── 予定が見つからぬ分類（手動で整理）── */}
      {data.purposes === "ok" && orphans.length > 0 && (
        <section aria-labelledby="garbage-orphans-heading" className={SECTION}>
          <h2 id="garbage-orphans-heading" className={HEADING}>
            予定が見つからない分類
          </h2>
          <p className="text-xs text-muted-foreground">
            予定が見つかりません（Google カレンダーの同期中は、予定が一時的に見えなくなることがあります）。
            同期が終わっても戻らない分類は、ここから整理できます。予定が見つかった分類は整理されません。
          </p>
          <ul className="flex flex-col gap-2" data-testid="garbage-orphans">
            {orphans.map((entry) => {
              const name = entry.row.purpose === "garbage" ? (entry.row.garbageKind ?? "ごみ") : "この回だけ通常の予定"
              return (
                <li key={entry.row.id} className={CARD}>
                  <div className="flex items-start gap-3">
                    <GarbageKindAvatar label={entry.row.garbageKind} />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <p className="text-sm font-semibold break-words">{name}</p>
                      <p className="text-xs text-muted-foreground">
                        {entry.row.scope === "series" ? "繰り返しの予定への分類" : "1 回の予定への分類"}
                      </p>
                    </div>
                  </div>
                  {confirmingOrphan === entry.row.id ? (
                    <>
                      <p className="text-sm text-muted-foreground">
                        この分類を削除します。あとで予定が戻った場合は、分類し直してください。
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="destructive"
                          disabled={save.blocked}
                          onClick={() => {
                            const request: GarbageRequest = { op: "delete-orphan", purposeId: entry.row.id }
                            sendFromPage(request, garbageRequestLabel(request, null))
                            setConfirmingOrphan(null)
                          }}
                          className="cursor-pointer"
                        >
                          削除する
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setConfirmingOrphan(null)}
                          className="cursor-pointer"
                        >
                          やめる
                        </Button>
                      </div>
                    </>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      aria-label={`予定が見つからない分類「${name}」を整理`}
                      onClick={() => setConfirmingOrphan(entry.row.id)}
                      className="cursor-pointer self-start"
                    >
                      整理する
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {/* ── 足し方（登録が在る時も、次の一歩が分かるよう置く）── */}
      {data.purposes === "ok" && overview.entries.length > 0 && (
        <section aria-labelledby="garbage-add-heading" className={SECTION}>
          <h2 id="garbage-add-heading" className={HEADING}>
            ごみの日を足す
          </h2>
          <div className={CARD}>
            <p className="text-sm">
              カレンダーで予定を作り、その予定を開いて「ごみの日にする」を押します。Google
              カレンダーの予定も、開いて同じように分類できます。
            </p>
            <Link
              href="/calendar"
              className="flex min-h-11 w-fit items-center gap-1 rounded-lg px-2 text-sm font-medium text-primary transition-colors duration-200 hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <CalendarPlus size={16} aria-hidden="true" />
              カレンダーを開く
            </Link>
          </div>
        </section>
      )}

      {/* ── 通知の状態 ── */}
      <section aria-labelledby="garbage-notify-heading" className={SECTION}>
        <h2 id="garbage-notify-heading" className={HEADING}>
          前日のお知らせ
        </h2>
        <div className={CARD}>
          <p className="text-sm">
            ごみの日にした予定には、前日の 20:00 にお知らせを付けられます（分類するときに選びます）。
            通知をタップすると、その日のカレンダーが開きます。
          </p>
          <GarbageNotificationStatus />
        </div>
      </section>

      <RefreshOnVisible />

      <Sheet open={editing !== null} onOpenChange={(open) => !open && closeEditor()}>
        <SheetContent side="bottom" className="max-h-[85dvh] overflow-hidden rounded-t-2xl safe-bottom">
          <SheetHeader>
            <SheetTitle>ごみの分類</SheetTitle>
            <SheetDescription>予定の内容は変えず、ごみの日かどうかと通知だけを保存します</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-3 overflow-y-auto px-4 pb-4">
            {editing && (
              <GarbagePurposeForm
                // 編集セッションごとに作り直す（同じ予定を開き直しても、前の選択を持ち越さぬ）
                key={`${editing.target.id}:${editing.lockedScope ?? "any"}:${editing.initialMode ?? "garbage"}:${editing.session}`}
                target={editing.target}
                current={editing.current}
                lockedScope={editing.lockedScope}
                initialMode={editing.initialMode}
                initialReminder={editing.initialReminder}
                disabled={save.blocked}
                onSubmit={(request, label) => {
                  save.send(request, label, editing.session)
                }}
                onCancel={closeEditor}
              />
            )}
            {/* 送れなんだ理由・結果不明の案内は、シートの中でも読めるようにする。文言は、このシートの操作の
                ものと、どの操作にも属さぬもの（端末の控えを読めぬ等）だけ */}
            <PendingChoreNotice
              save={save}
              showMessage={editing !== null && (save.messageSession === editing.session || save.messageSession === null)}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

function EntryRow({
  entry,
  today,
  windowDays,
  eventsReadable,
  onChange,
  onClear,
}: {
  entry: GarbagePurposeEntry
  today: string
  windowDays: number
  eventsReadable: boolean
  onChange: () => void
  onClear: () => void
}) {
  const { row, anchor } = entry
  const isGarbage = row.purpose === "garbage"
  const name = isGarbage
    ? (row.garbageKind ?? "ごみ")
    : row.purpose === "normal"
      ? "この回だけ通常の予定に戻しています"
      : "この版のアプリでは表示できない分類"
  const relative = entry.nextDate ? collectionDayRelativeLabel(entry.nextDate, today) : null
  const operable =
    entry.state === "linked" && anchor !== null && entry.anchorPurpose !== null && entry.anchorPurpose.kind !== "unknown"

  return (
    <li className={CARD} data-purpose-scope={row.scope}>
      <div className="flex items-start gap-3">
        <GarbageKindAvatar label={isGarbage ? row.garbageKind : null} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-sm font-semibold break-words">{name}</p>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              {row.scope === "series" && <Repeat size={12} aria-hidden="true" />}
              {row.scope === "series" ? "繰り返しのすべての回" : "この回だけ"}
            </span>
            {anchor && <span className="min-w-0 break-words">予定「{anchor.title}」</span>}
            {anchor?.source === "google" && (
              <span className="flex items-center gap-1">
                <Lock size={12} aria-hidden="true" />
                Google
              </span>
            )}
          </p>
          {entry.state === "unchecked" ? (
            <p className="flex items-start gap-1 text-xs text-muted-foreground">
              <CircleHelp size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
              予定を確認できませんでした（予定が無い、とは限りません）。時間をおいて読み直してください。
            </p>
          ) : !eventsReadable ? null : entry.nextDate ? (
            <p className="text-xs tabular-nums text-muted-foreground">
              {isGarbage ? "次の収集日" : "対象の日"}: {formatDayJa(entry.nextDate)}
              {relative ? `（${relative}）` : ""}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              今日から{windowDays}日のあいだに、この分類の回はありません
              {anchor ? `（見つかった回: ${formatDayJa(anchor.start_date)}）` : ""}。
            </p>
          )}
          {isGarbage && row.scope === "series" && (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              {row.remindDefault === "prev_day_20" ? (
                <>
                  <BellRing size={12} aria-hidden="true" />
                  これから追加される回にも、前日 20:00 の通知を付けます
                </>
              ) : (
                <>
                  <BellOff size={12} aria-hidden="true" />
                  これから追加される回には、通知を自動で付けません
                </>
              )}
            </p>
          )}
        </div>
      </div>
      {operable && (
        <div className="flex flex-wrap gap-2">
          {isGarbage && (
            <Button
              type="button"
              variant="outline"
              aria-label={`${name}（${row.scope === "series" ? "繰り返し" : "この回だけ"}）を変更`}
              onClick={onChange}
              className="cursor-pointer"
            >
              変更
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            aria-label={`${name}（${row.scope === "series" ? "繰り返し" : "この回だけ"}）を解除`}
            onClick={onClear}
            className="cursor-pointer"
          >
            {isGarbage ? "解除" : "例外を取り消す"}
          </Button>
        </div>
      )}
    </li>
  )
}

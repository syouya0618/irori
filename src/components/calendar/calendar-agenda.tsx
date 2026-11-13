"use client"

import {
  AlertCircle,
  CalendarDays,
  ChevronRight,
  Clock3,
  Eye,
  NotebookPen,
  Pencil,
  Stethoscope,
  Trash2,
  CloudOff,
  Loader2,
  Lock,
  Plus,
  Repeat,
  RotateCw,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { formatTimeJst, toJstDateString } from "@/lib/utils/date-jst"
import { garbageOf } from "@/lib/domain/garbage"
import { GarbageKindIcon, GarbageKindLabel } from "@/components/chores/garbage/garbage-kind-icon"
import type { CalendarEventRecord, MonthLoadState } from "./use-month-events"
import { formatShortDay, multiDayProgress } from "./calendar-display"

interface CalendarAgendaProps {
  dateLabel: string
  events: CalendarEventRecord[]
  /** アジェンダの対象日(YYYY-MM-DD, JST)。多日イベントの表示分岐に使う。 */
  selectedDate: string
  onTapEvent: (event: CalendarEventRecord) => void
  /** 一覧から削除の確認を開く。Google・医療記録由来の予定には表示しない。 */
  onRequestDelete?: (event: CalendarEventRecord) => void
  /** 選択日が今日か（見出しに「今日」を添える）。 */
  isToday?: boolean
  /** 月の取得状態。loading / error の間は「予定はありません」と言わぬ。 */
  loadState?: MonthLoadState
  /** 「もう一度読み込む」。 */
  onRetry?: () => void
  /** 空の日の「この日に予定を追加」。 */
  onAdd?: () => void
  /** 行が保存の往復中か（楽観行・更新中）。 */
  isSaving?: (event: CalendarEventRecord) => boolean
}

/** アジェンダ時刻セルの表示。primary=1段目, secondary=任意の2段目。 */
export interface AgendaTimeDisplay {
  primary: string
  secondary?: string
}

/**
 * selectedDate 視点でイベントの時刻セル表示を決める(表示分岐の完全表)。
 * - 終日: 「終日」
 * - timed・当日開始・end 同日 or なし: 「14:00」(+終了あれば 2 段目「〜15:00」)
 * - timed・当日開始・end 翌日以降: 「14:00 →」
 * - timed・開始日 < selectedDate・end の JST 日 > selectedDate: 「→」(継続中)
 * - timed・開始日 < selectedDate・end の JST 日 = selectedDate: 「→ 02:00」
 * - timed・開始日 < selectedDate・end_at なし: 「→」(継続中扱いフォールバック)
 *
 * 開始日判定は start_date(グリッドのバケット基準と同一)、終了日判定は end_at の
 * JST 日(toJstDateString)を用いる。eventsForDate が start_date <= selectedDate を
 * 保証するため、開始判定は「= selectedDate」か「< selectedDate」の二択で網羅する。
 */
export function agendaTimeDisplay(
  e: CalendarEventRecord,
  selectedDate: string,
): AgendaTimeDisplay {
  if (e.is_all_day) return { primary: "終日" }

  const endJstDay = e.end_at ? toJstDateString(e.end_at) : null

  if (e.start_date === selectedDate) {
    const startTime = e.start_at ? formatTimeJst(e.start_at) : ""
    if (!e.end_at) return { primary: startTime }
    // end 同日: 2 段表示 / end 翌日以降: 開始時刻 + 継続矢印
    if (endJstDay === selectedDate) {
      return { primary: startTime, secondary: `〜${formatTimeJst(e.end_at)}` }
    }
    return { primary: `${startTime} →` }
  }

  // start_date < selectedDate(前日以前に開始し当日へ継続)
  if (e.end_at && endJstDay === selectedDate) {
    return { primary: `→ ${formatTimeJst(e.end_at)}` }
  }
  return { primary: "→" }
}

/** 一覧の 1 行の補足（期間・繰り返し・出どころ・保存中）。色だけに頼らず文字で言う。 */
function eventMeta(
  e: CalendarEventRecord,
  selectedDate: string,
): string[] {
  const meta: string[] = []
  const progress = multiDayProgress(e, selectedDate)
  if (progress) {
    meta.push(
      `${formatShortDay(e.start_date)}〜${formatShortDay(e.end_date)}（${progress.day}/${progress.total}日目）`,
    )
  }
  if (e.series_id && e.source !== "google") meta.push("繰り返し")
  return meta
}

export function CalendarAgenda({
  dateLabel,
  events,
  selectedDate,
  onTapEvent,
  onRequestDelete,
  isToday = false,
  loadState = "idle",
  onRetry,
  onAdd,
  isSaving,
}: CalendarAgendaProps) {
  const headingId = `agenda-${selectedDate}`
  // 読み込み中・失敗の間は「予定はありません」と言わぬ（範囲外の旧データで空に見えるだけ）
  const unreliable = loadState === "loading" || loadState === "error"

  return (
    <section className="flex flex-col gap-2" aria-labelledby={headingId}>
      <div className="flex min-h-8 items-center gap-2 px-1">
        <CalendarDays size={17} className="shrink-0 text-primary" aria-hidden="true" />
        <h2 id={headingId} className="text-sm font-semibold">
          {dateLabel}
          <span className="sr-only"> の予定</span>
        </h2>
        {isToday && (
          <span className="rounded-full bg-primary/12 px-2 py-0.5 text-xs font-medium text-primary dark:bg-primary/20">
            今日
          </span>
        )}
        {!unreliable && events.length > 0 && (
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {events.length}件
          </span>
        )}
      </div>

      {loadState === "stale" && (
        <div className="flex items-center gap-2 rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          <CloudOff size={14} className="shrink-0" aria-hidden="true" />
          <span className="flex-1">最新の予定を確認できませんでした。表示が古い可能性があります。</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="touch-target shrink-0 cursor-pointer rounded-lg px-2 font-medium text-primary transition-colors duration-200 hover:bg-primary/10"
            >
              更新
            </button>
          )}
        </div>
      )}

      {loadState === "loading" ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">予定を読み込み中</span>
          <Skeleton className="h-14 w-full rounded-xl" />
          <Skeleton className="h-14 w-full rounded-xl" />
        </div>
      ) : loadState === "error" ? (
        <div
          role="alert"
          className="flex flex-col items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm"
        >
          <p className="flex items-start gap-2 text-destructive">
            <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            予定を読み込めませんでした。予定がないとは限りません。
          </p>
          {onRetry && (
            <Button
              type="button"
              variant="outline"
              onClick={onRetry}
              className="cursor-pointer"
            >
              <RotateCw size={16} />
              もう一度読み込む
            </Button>
          )}
        </div>
      ) : events.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl px-3 py-6 text-center">
          <CalendarDays size={28} className="text-muted-foreground/60" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">予定はありません</p>
          {onAdd && (
            <Button
              type="button"
              variant="outline"
              onClick={onAdd}
              className="cursor-pointer"
            >
              <Plus size={16} />
              この日に予定を追加
            </Button>
          )}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {events.map((e) => {
            const isGoogle = e.source === "google"
            const time = agendaTimeDisplay(e, selectedDate)
            const meta = eventMeta(e, selectedDate)
            const saving = isSaving?.(e) ?? false
            // 用途（ごみの日）。出どころ（irori / Google）とは別の軸ゆえ、帯の色は変えず補足の行に
            // アイコン + 文字で足す（行のアクセシブル名に「ごみ・燃えるごみ」が入る）
            const garbage = garbageOf(e)
            const canRemove = !!onRequestDelete && !isGoogle && !e.medical_record_id
            return (
              <li key={e.id}>
                <div className="glass flex items-stretch rounded-xl">
                  <button
                  type="button"
                  onClick={() => onTapEvent(e)}
                  aria-busy={saving || undefined}
                  className={cn(
                    "flex min-h-14 min-w-0 flex-1 items-stretch gap-2 rounded-xl py-2 pr-2 pl-2 text-left transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-ring",
                    "cursor-pointer hover:bg-muted/50 dark:hover:bg-muted/20",
                  )}
                >
                  {/* 出どころの帯。色は補助で、意味は右の文字（Google・閲覧のみ）が運ぶ */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "w-1 shrink-0 rounded-full",
                      isGoogle ? "bg-muted-foreground/40" : "bg-primary",
                    )}
                  />
                  <span className="flex w-14 shrink-0 flex-col justify-center text-xs tabular-nums text-muted-foreground">
                    {time.primary && <span>{time.primary}</span>}
                    {time.secondary && <span>{time.secondary}</span>}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={cn(
                          "flex size-7 shrink-0 items-center justify-center rounded-lg",
                          isGoogle ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary",
                        )}
                      >
                        {garbage !== null ? (
                          <GarbageKindIcon label={garbage.label} size={16} />
                        ) : e.medical_record_id ? (
                          <Stethoscope size={16} />
                        ) : e.memo?.trim() ? (
                          <NotebookPen size={16} />
                        ) : e.is_all_day ? (
                          <CalendarDays size={16} />
                        ) : (
                          <Clock3 size={16} />
                        )}
                      </span>
                      <span className="truncate text-sm font-medium">{e.title}</span>
                    </span>
                    {(meta.length > 0 || isGoogle || saving || garbage !== null || Boolean(e.memo?.trim())) && (
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        {saving && (
                          <span className="flex items-center gap-1 text-primary">
                            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                            保存中
                          </span>
                        )}
                        {garbage !== null && <GarbageKindLabel label={garbage.label} />}
                        {e.memo?.trim() && (
                          <span className="flex items-center gap-1">
                            <NotebookPen size={12} aria-hidden="true" />
                            メモあり
                          </span>
                        )}
                        {meta.map((m) => (
                          <span key={m} className="flex items-center gap-1">
                            {m === "繰り返し" && <Repeat size={12} aria-hidden="true" />}
                            {m}
                          </span>
                        ))}
                        {isGoogle && (
                          <span className="flex items-center gap-1">
                            <Lock size={12} aria-hidden="true" />
                            Google・閲覧のみ
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                  {e.medical_record_id ? (
                    <ChevronRight size={16} className="shrink-0 self-center text-muted-foreground" aria-hidden="true" />
                  ) : isGoogle ? (
                    <Eye size={16} className="shrink-0 self-center text-muted-foreground" aria-hidden="true" />
                  ) : (
                    <Pencil size={16} className="shrink-0 self-center text-muted-foreground" aria-hidden="true" />
                  )}
                  </button>
                  {canRemove && (
                    <div className="flex shrink-0 items-center pr-1">
                      <button
                        type="button"
                        aria-label={`「${e.title}」を削除`}
                        title="削除"
                        onClick={() => onRequestDelete?.(e)}
                        disabled={saving}
                        className="flex size-11 cursor-pointer items-center justify-center rounded-xl text-muted-foreground transition-colors duration-200 hover:bg-destructive/10 hover:text-destructive focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Trash2 size={18} aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

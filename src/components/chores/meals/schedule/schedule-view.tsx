"use client"

import { useRef, useState } from "react"
import Link from "next/link"
import {
  AlertCircle,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  CookingPot,
  Sparkles,
} from "lucide-react"

import { MEALS_PANTRY_HREF, mealRecipeHref } from "@/components/chores/meals/shared/meal-routes"
import { MealPhoto } from "@/components/chores/meals/shared/meal-photo"
import { PendingChoreNotice } from "@/components/chores/shared/pending-chore-notice"
import { RefreshOnVisible } from "@/components/chores/shared/refresh-on-visible"
import { useChoreSave, type ChoreSaveOutcome } from "@/components/chores/shared/use-chore-save"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { ChoreOwner } from "@/lib/domain/chore-pending"
import { formatMealDate, formatMinutes, SUFFICIENCY_LABELS } from "@/lib/meals/server/format"
import type { DinnerDayView, DinnerEntryView, DinnerPlanView } from "@/lib/meals/server/plan-views"
import type { ScheduleDishDetails } from "@/lib/meals/server/schedule-details"
import { newClientId } from "@/lib/utils/client-id"
import { shiftYmd } from "@/lib/utils/date-jst"

import { isMealRequest, runMealRequest, type MealRequest, type MealSaveSuccess } from "../plan/meal-request"
import { planEntryHref, planHref, planStartBounds } from "../plan/plan-query"
import { scheduleHref } from "./schedule-query"
import { RoleSuggestionPanel } from "./role-suggestion-panel"

const POLL_MS = 60_000
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const

function weekdayOf(ymd: string): string {
  return WEEKDAYS[new Date(`${ymd}T12:00:00Z`).getUTCDay()]
}

function shortDate(ymd: string): string {
  return `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`
}

function weekTitle(from: string, to: string): string {
  return `${Number(from.slice(5, 7))}月${Number(from.slice(8, 10))}日〜${Number(to.slice(5, 7)) === Number(from.slice(5, 7)) ? "" : `${Number(to.slice(5, 7))}月`}${Number(to.slice(8, 10))}日`
}

function roleIcon(entry: DinnerEntryView): string {
  if (entry.role === "soup") return "🍲"
  if (entry.role === "side") return "🥗"
  if (entry.role === "staple") return "🍚"
  return "🍳"
}

function dayTitle(day: DinnerDayView): string {
  return day.entries.length > 0 ? day.entries.map((entry) => entry.title).join(" / ") : "未定"
}

export function ScheduleView({
  owner,
  view,
  details,
}: {
  owner: ChoreOwner
  view: DinnerPlanView
  details: ScheduleDishDetails
}) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const sheetTitleRef = useRef<HTMLHeadingElement | null>(null)
  const [confirmGenerate, setConfirmGenerate] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const selected = view.days.find((day) => day.date === selectedDate)
  const { min, max } = planStartBounds(view.today)
  const previous = shiftYmd(view.from, -7)
  const next = shiftYmd(view.from, 7)
  const canPrevious = previous >= min
  const canNext = next <= max
  const firstGenerationDay = view.from > view.today ? view.from : view.today
  let remainingDays = 0
  for (let day = firstGenerationDay; day <= view.to && remainingDays < 7; day = shiftYmd(day, 1)) {
    remainingDays += 1
  }
  const hasReplaceable = view.days.some((day) =>
    day.entries.some((entry) => entry.status === "proposed" || entry.status === "confirmed"),
  )
  const canGenerate = remainingDays > 0 && view.unreadableEntries === 0

  function onOutcome(outcome: ChoreSaveOutcome<MealRequest, MealSaveSuccess>) {
    if (outcome.kind === "unknown") {
      if (outcome.payload.op === "add_recipe") setSelectedDate(null)
      setNotice(null)
      return
    }
    if (outcome.kind === "rejected") {
      if (outcome.payload.op === "add_recipe") setSelectedDate(null)
      setNotice({ text: outcome.error, error: true })
      return
    }
    if (outcome.status === "conflict") {
      setSelectedDate(null)
      setNotice({ text: "別の端末で献立が変更されました。最新の内容を確認してから選び直してください。", error: true })
      return
    }
    setConfirmGenerate(false)
    if (outcome.payload.op === "add_recipe") {
      setSelectedDate(null)
      setNotice({ text: "選んだ料理を献立に追加しました。曜日を開いて内容をご確認ください。", error: false })
    } else {
      setNotice({ text: "献立の提案を保存しました。各曜日を押して内容を確認してください。", error: false })
    }
  }

  const save = useChoreSave<MealRequest, MealSaveSuccess>({
    owner,
    kind: "meal",
    run: runMealRequest,
    isPayload: isMealRequest,
    onOutcome,
  })

  function generate() {
    if (!canGenerate || save.blocked) return
    setNotice(null)
    const request: MealRequest = {
      op: "generate",
      operationId: newClientId(),
      expectedRevision: view.revision,
      startDate: firstGenerationDay,
      days: remainingDays,
      constraints: null,
      mode: "auto",
    }
    if (save.send(request, "この週の献立を提案") !== null) setConfirmGenerate(false)
  }

  return (
    <div className="flex flex-col gap-4" data-testid="meals-schedule">
      <section aria-label="週間の献立" className="flex flex-col gap-3">
        <div className="glass flex items-center justify-between gap-2 rounded-2xl px-3 py-2">
          {canPrevious ? (
            <Link
              href={scheduleHref(previous, view.today)}
              aria-label="前の週"
              prefetch={false}
              className="inline-flex size-11 items-center justify-center rounded-xl focus-visible:outline-2 focus-visible:outline-ring"
            >
              <ChevronLeft size={21} aria-hidden="true" />
            </Link>
          ) : <span aria-hidden="true" className="size-11" />}
          <h2 className="min-w-0 text-center text-sm font-semibold sm:text-base">{weekTitle(view.from, view.to)}</h2>
          {canNext ? (
            <Link
              href={scheduleHref(next, view.today)}
              aria-label="次の週"
              prefetch={false}
              className="inline-flex size-11 items-center justify-center rounded-xl focus-visible:outline-2 focus-visible:outline-ring"
            >
              <ChevronRight size={21} aria-hidden="true" />
            </Link>
          ) : <span aria-hidden="true" className="size-11" />}
        </div>

        {/* Do not animate disabled opacity to enabled: intermediate contrast is below WCAG AA. */}
        <Button
          type="button"
          className="min-h-12 w-full rounded-xl bg-primary-hover text-base text-primary-foreground shadow-sm hover:bg-primary-hover transition-[color,background-color,border-color,outline-color,box-shadow,translate]"
          disabled={save.blocked || !canGenerate}
          onClick={() => {
            if (hasReplaceable) setConfirmGenerate(true)
            else generate()
          }}
        >
          <Sparkles size={18} aria-hidden="true" />
          この週の献立を提案
        </Button>
        {remainingDays < 7 && remainingDays > 0 && (
          <p className="text-xs text-muted-foreground">過ぎた日は変えず、{shortDate(firstGenerationDay)}から{remainingDays}日分を提案します。</p>
        )}
        {!canGenerate && (
          <p role="note" className="text-sm text-muted-foreground">
            {view.unreadableEntries > 0 ? "読めない献立があるため、上書きする提案を止めています。" : "過ぎた週の献立は作り直せません。"}
          </p>
        )}
        {confirmGenerate && (
          <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/50 p-3 text-sm" role="group" aria-label="献立の作り直しを確認">
            <p>すでに料理が登録されておる。提案を作り直すと、固定していない未調理の料理が変わる場合があります。固定済み・調理済みの料理は保護します。</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={save.blocked} onClick={generate}>提案を作り直す</Button>
              <Button type="button" variant="outline" onClick={() => setConfirmGenerate(false)}>やめる</Button>
            </div>
          </div>
        )}
        {notice !== null && (
          <p role={notice.error ? "alert" : "status"} className="flex items-start gap-2 rounded-xl bg-muted/50 px-3 py-2 text-sm">
            {notice.error ? <AlertCircle size={18} aria-hidden="true" /> : <Check size={18} className="text-emerald-700" aria-hidden="true" />}
            {notice.text}
          </p>
        )}
        <PendingChoreNotice save={save} />
        <ul className="flex flex-col gap-1 rounded-2xl bg-card p-1 shadow-sm ring-1 ring-border/70" data-testid="schedule-week">
          {view.days.map((day) => (
            <li key={day.date}>
              <button
                type="button"
                aria-label={`${day.label}の献立を見る`}
                onClick={() => setSelectedDate(day.date)}
                className={`grid min-h-12 w-full grid-cols-[3.5rem_minmax(0,1fr)_1.25rem] items-center gap-2 rounded-xl px-2 py-1 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring ${day.isToday ? "border-l-4 border-primary bg-muted" : ""}`}
              >
                <span className="flex flex-col items-center justify-center gap-0.5 text-xs">
                  <span className={`font-semibold ${day.isToday ? "text-primary" : ""}`}>{weekdayOf(day.date)}</span>
                  <span className={day.isToday ? "text-foreground" : "text-muted-foreground"}>{shortDate(day.date)}</span>
                </span>
                <span className={`min-w-0 text-sm font-medium leading-relaxed break-words ${day.entries.length === 0 && !day.isToday ? "text-muted-foreground" : "text-foreground"}`}>
                  {dayTitle(day)}
                  {day.isToday && <span className="ml-1.5 text-xs font-semibold text-foreground">今日</span>}
                </span>
                <ChevronRight size={19} aria-hidden="true" className="text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
        <Link href={planHref(firstGenerationDay, view.today)} prefetch={false}
          className="inline-flex min-h-11 self-start items-center rounded-lg px-2 text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
          希望を伝えて献立を作る・細かく編集する
        </Link>
        <p className="text-xs text-muted-foreground">曜日を押すと、献立・材料・在庫の目安を確認できます。</p>
      </section>

      {view.counts.conflicts > 0 && (
        <p role="note" className="flex items-start gap-2 rounded-xl border border-destructive/30 p-3 text-sm">
          <AlertCircle size={18} className="shrink-0 text-destructive" aria-hidden="true" />
          使わない食材の設定に当たる、または原材料を確認できない料理が{view.counts.conflicts}品あります。各曜日の詳細で確認してください。
        </p>
      )}
      <RefreshOnVisible pollMs={POLL_MS} paused={selected !== undefined || confirmGenerate} />

      <Sheet open={selected !== undefined} onOpenChange={(open) => { if (!open) setSelectedDate(null) }}>
        <SheetContent side="bottom" initialFocus={() => sheetTitleRef.current ?? true} className="max-h-[88dvh] overflow-hidden rounded-t-3xl safe-bottom">
          {selected !== undefined && (
            <>
              <SheetHeader className="pb-1 pr-12">
                <SheetTitle ref={sheetTitleRef} tabIndex={-1}>{formatMealDate(selected.date)}の献立</SheetTitle>
                <SheetDescription>
                  {selected.entries.length === 0 ? "この日の料理はまだ決まっていません。" : `${selected.entries.length}品の料理を確認できます。`}
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-3 overflow-y-auto px-4 pb-6">
                {selected.entries.length === 0 && (
                  <p className="rounded-xl bg-muted/50 px-4 py-5 text-sm">まだ決まっていません。料理の提案または手動追加から決められます。</p>
                )}
                {selected.entries.map((entry) => {
                  const detail = details[entry.id]
                  return (
                    <section key={entry.id} className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-3" aria-label={entry.title}>
                      <div className="flex items-center gap-3">
                        <MealPhoto recipeId={entry.recipeId} fallback={roleIcon(entry)} className="size-14" />
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <p className="text-base font-semibold break-words">{entry.title}</p>
                          <p className="text-xs text-muted-foreground">
                            {entry.roleLabel}・{entry.statusLabel}・{entry.servings}人分
                            {entry.minutes !== null && `・${formatMinutes(entry.minutes)}`}
                          </p>
                        </div>
                      </div>
                      {detail && detail.ingredients.length > 0 && (
                        <div className="rounded-xl bg-muted/30 p-3">
                          <h3 className="mb-2 text-sm font-semibold">
                            材料{detail.recipeServings === null ? "" : `（レシピ${detail.recipeServings}人分の目安）`}
                          </h3>
                          <ul className="flex flex-col gap-1">
                            {detail.ingredients.map((ingredient, i) => (
                              <li key={`${i}:${ingredient.name}`} className="flex items-center justify-between gap-2 text-sm">
                                <span className="min-w-0 break-words">{ingredient.optional ? "任意：" : ""}{ingredient.name}</span>
                                <span className="shrink-0 text-muted-foreground">{ingredient.quantityText}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {entry.stock !== null && (
                        <div className={`rounded-xl px-3 py-2 text-sm ${entry.stock.level === "ready" ? "bg-emerald-100/70 text-emerald-950 dark:bg-emerald-900/30 dark:text-emerald-200" : "bg-amber-100/60 text-amber-950 dark:bg-amber-900/30 dark:text-amber-200"}`}>
                          <p className="font-medium">在庫：{SUFFICIENCY_LABELS[entry.stock.level]}</p>
                          {entry.stock.missing.map((item) => <p key={`missing:${item.name}`}>買い足し：{item.name}（{item.detail}）</p>)}
                          {entry.stock.toCheck.map((item) => <p key={`check:${item.name}`}>分量確認：{item.name}（{item.detail}）</p>)}
                        </div>
                      )}
                      {entry.conflict !== null && <p className="text-sm text-destructive" role="note">{entry.conflict.message}</p>}
                      {(entry.ageWarnings ?? []).map((warning) => (
                        <p key={`${warning.childId}:${warning.ingredientName}`} className="text-sm text-destructive" role="note">
                          {warning.text}
                        </p>
                      ))}
                      <div className="flex flex-wrap gap-2">
                        {entry.recipeId !== null && (
                          <Link
                            href={mealRecipeHref(entry.recipeId)}
                            prefetch={false}
                            className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus-visible:outline-2 focus-visible:outline-ring"
                          >
                            料理の詳細を見る
                          </Link>
                        )}
                        <Link
                          href={planEntryHref(selected.date, entry.id, view.today)}
                          prefetch={false}
                          className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border border-border px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          {entry.status === "proposed" || entry.status === "confirmed" ? "この料理を変更・削除" : "この料理の記録を見る"}
                        </Link>
                      </div>
                    </section>
                  )
                })}
                <RoleSuggestionPanel
                  key={`${selected.date}:${view.revision}`}
                  day={selected}
                  revision={view.revision}
                  servings={view.servings.value}
                  disabled={save.blocked || view.unreadableEntries > 0}
                  onAdd={(request) => save.send(request, "選んだ料理を献立へ追加") !== null}
                />
                {view.ageRulesChecked === false && selected.entries.length > 0 && (
                  <p className="text-sm text-muted-foreground">子どもの年齢に関する注意は確認できていません。料理の詳細で確認してください。</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Link href={planHref(selected.date < view.today ? view.today : selected.date, view.today)} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-medium">
                    <CalendarDays size={17} aria-hidden="true" />この日の献立を編集
                  </Link>
                  <Link href={MEALS_PANTRY_HREF} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-medium">
                    <CookingPot size={17} aria-hidden="true" />在庫を見る
                  </Link>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

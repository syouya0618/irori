"use client"

import { useId, useState } from "react"
import { ArrowDownUp, BrushCleaning, ChevronDown, ChevronRight, PauseCircle, Plus } from "lucide-react"
import { EmptyState } from "@/components/chores/shared/empty-state"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { daysAgoJa } from "@/lib/domain/cleaning"
import { cadenceSpanJa, formatYmdJa, type CleaningRoutine, type RoutineStatus } from "@/lib/domain/cleaning-schedule"
import { CleaningRoutineIcon } from "./cleaning-routine-icon"

export interface CleaningStatusEntry {
  routine: CleaningRoutine
  status: RoutineStatus
  historyPending?: boolean
}

type Sort = "oldest" | "newest" | "name"

function compareEntries(a: CleaningStatusEntry, b: CleaningStatusEntry, sort: Sort): number {
  const nameOrder = a.routine.name.localeCompare(b.routine.name, "ja") || a.routine.id.localeCompare(b.routine.id)
  if (sort === "name") return nameOrder
  const aDate = a.status.lastDoneOn
  const bDate = b.status.lastDoneOn
  // 未記録に架空の日付を入れない。日付順のどちらでも末尾にまとめる。
  if (aDate === null) return bDate === null ? nameOrder : 1
  if (bDate === null) return -1
  if (aDate === bDate) return nameOrder
  const dateOrder = aDate < bDate ? -1 : 1
  return sort === "oldest" ? dateOrder : -dateOrder
}

/** 直近のログ一覧の件数ではなく、有効な全履歴の要約から「前回」を表示する。 */
export function CleaningStatus({
  today,
  entries,
  onOpenRoutine,
  onAddRoutine,
  routinesTruncated = false,
}: {
  today: string
  entries: readonly CleaningStatusEntry[]
  onOpenRoutine: (id: string) => void
  onAddRoutine: () => void
  /** 項目が一部しか表示できない時は、件数が全体の総数ではないと示す。 */
  routinesTruncated?: boolean
}) {
  const [sort, setSort] = useState<Sort>("oldest")
  const sortId = useId()
  const summaryId = useId()
  const doneToday = entries.filter(({ status }) => status.lastDoneOn === today).length
  const hasPendingHistory = entries.some((entry) => entry.historyPending)
  const ordered = [...entries].sort((a, b) => compareEntries(a, b, sort))

  return (
    <section aria-labelledby="cleaning-status-heading" className="flex min-w-0 flex-col gap-5" data-testid="cleaning-status">
      <dl className="grid grid-cols-2 gap-3" aria-label="掃除の状況の集計">
        <div className="glass min-w-0 rounded-2xl p-3 shadow-lg shadow-black/[0.04]">
          <dt className="text-sm text-muted-foreground">{hasPendingHistory ? "確認済みの今日の実施" : routinesTruncated ? "表示中の今日の実施" : "今日の実施"}</dt>
          <dd className="mt-1 text-sm text-muted-foreground">
            <span className="mr-1 text-2xl font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">{doneToday}</span>項目
          </dd>
        </div>
        <div className="glass min-w-0 rounded-2xl p-3 shadow-lg shadow-black/[0.04]">
          <dt className="text-sm text-muted-foreground">{routinesTruncated ? "表示中の登録済み" : "登録済み"}</dt>
          <dd className="mt-1 text-sm text-muted-foreground">
            <span className="mr-1 text-2xl font-semibold tabular-nums text-primary">{entries.length}</span>項目
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="cleaning-status-heading" className="text-base font-semibold">前回の実施から</h2>
        <div className="relative">
          <Label htmlFor={sortId} className="sr-only">掃除状況の並び順</Label>
          <ArrowDownUp size={16} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
          <select
            id={sortId}
            value={sort}
            onChange={(event) => setSort(event.target.value as Sort)}
            className="min-h-11 min-w-32 cursor-pointer appearance-none rounded-xl border border-border bg-background pr-9 pl-9 text-sm transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            <option value="oldest">古い順</option>
            <option value="newest">新しい順</option>
            <option value="name">名前順</option>
          </select>
          <ChevronDown size={16} aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground" />
        </div>
      </div>

      {entries.length === 0 ? (
        <EmptyState
          icon={BrushCleaning}
          title={routinesTruncated ? "表示できる項目がありません" : "掃除の項目がまだありません"}
          description="よく行う掃除を追加すると、最後に実施した日と経過日数を確認できます。"
        />
      ) : (
        <ul className="glass min-w-0 divide-y divide-border rounded-2xl px-3 shadow-lg shadow-black/[0.04]" aria-labelledby="cleaning-status-heading">
          {ordered.map(({ routine, status, historyPending }) => {
            const hasHistory = status.lastDoneOn !== null
            const elapsed = historyPending ? "確認中" : !hasHistory ? "未記録" : status.daysSinceLastDone === null ? "記録あり" : daysAgoJa(status.daysSinceLastDone)
            const date = formatYmdJa(status.lastDoneOn, today)?.replace(/(\d+)月(\d+)日/, "$1/$2") ?? status.lastDoneOn
            const isToday = status.lastDoneOn === today
            const descriptionId = `${summaryId}-${routine.id}`
            return (
              <li key={routine.id} data-testid="cleaning-status-item">
                <button
                  type="button"
                  aria-label={`${routine.name}の詳細を開く`}
                  aria-describedby={descriptionId}
                  onClick={() => onOpenRoutine(routine.id)}
                  className="flex min-h-20 w-full cursor-pointer items-center gap-2 rounded-xl py-3 text-left transition-colors duration-200 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring sm:gap-3"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <CleaningRoutineIcon name={routine.name} location={routine.location} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-base font-semibold break-words [overflow-wrap:anywhere]">{routine.name}</span>
                    <span className="text-sm text-muted-foreground">{cadenceSpanJa(routine.cadence_unit, routine.cadence_interval).replace("ヶ月", "か月")}ごと</span>
                    {status.isPaused && (
                      <span className="flex items-center gap-1 text-sm text-muted-foreground"><PauseCircle size={14} aria-hidden="true" />休止中</span>
                    )}
                  </span>
                  <span id={descriptionId} className="flex min-w-0 max-w-[45%] shrink-0 flex-col gap-1 text-right">
                    <span className={`text-lg font-semibold tabular-nums ${isToday ? "text-emerald-700 dark:text-emerald-300" : !hasHistory ? "text-muted-foreground" : "text-foreground"}`}>{elapsed}</span>
                    <span className="text-sm text-muted-foreground">{historyPending ? "前回の実施日を更新中" : hasHistory ? date : "実施履歴なし"}</span>
                  </span>
                  <ChevronRight size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <div className="flex justify-center">
        <Button type="button" variant="outline" className="px-4" onClick={onAddRoutine}>
          <Plus aria-hidden="true" />掃除項目を追加
        </Button>
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">
        未記録は、一度も実施を記録していない項目です。項目を開くと、履歴・周期・次回の目安を確認できます。
      </p>
      {routinesTruncated && (
        <p role="note" className="text-sm text-muted-foreground">一部の項目だけを表示しています。上の件数は表示中の項目の集計です。</p>
      )}
    </section>
  )
}

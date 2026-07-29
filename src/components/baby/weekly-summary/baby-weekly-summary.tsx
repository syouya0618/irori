import { Droplets, Milk } from "lucide-react"
import { BarChart } from "@/components/baby/charts/bar-chart"
import {
  WEEKLY_CHART_BASELINE,
  totalBabyWeeklySummary,
  type BabyWeeklySummaryDay,
} from "@/lib/domain/baby-weekly-summary"
import type { DiaperBreakdown } from "@/lib/domain/baby-log-aggregation"

interface BabyWeeklySummaryProps {
  days: BabyWeeklySummaryDay[]
  /** 週間のおしっこ/うんち内訳（aggregateDiapers の出力から導出、both は双方に加算） */
  diaperBreakdown: DiaperBreakdown
}

function diaperBreakdownLabel(breakdown: DiaperBreakdown): string {
  return `おしっこ${breakdown.peeCount}・うんち${breakdown.poopCount}`
}

function shortDate(ymd: string): string {
  const [, month, day] = ymd.split("-")
  return `${Number(month)}/${Number(day)}`
}

function countLabel(count: number): string {
  return `${count}回`
}

function StatHeader({
  icon: Icon,
  label,
  value,
  toneClassName,
}: {
  icon: typeof Milk
  label: string
  value: string
  toneClassName: string
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div
        className={`flex size-8 shrink-0 items-center justify-center rounded-full ${toneClassName}`}
      >
        <Icon size={16} />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] text-muted-foreground">{label}</p>
        <p className="truncate font-mono text-sm font-semibold">{value}</p>
      </div>
    </div>
  )
}

export function BabyWeeklySummary({
  days,
  diaperBreakdown,
}: BabyWeeklySummaryProps) {
  const totals = totalBabyWeeklySummary(days)
  const labels = days.map((day) => shortDate(day.date))

  const feedingData = days.map((day, index) => ({
    label: labels[index],
    value: day.feedingCount,
  }))
  const diaperData = days.map((day, index) => ({
    label: labels[index],
    value: day.diaperCount,
  }))

  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-xs font-semibold text-muted-foreground">
        週間サマリー
      </h2>

      <div className="glass rounded-2xl p-4 shadow-lg shadow-black/[0.04]">
        <div className="grid grid-cols-2 gap-3">
          <StatHeader
            icon={Milk}
            label="授乳"
            value={countLabel(totals.feedingCount)}
            toneClassName="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
          />
          <StatHeader
            icon={Droplets}
            label="おむつ"
            value={diaperBreakdownLabel(diaperBreakdown)}
            toneClassName="bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
          />
        </div>

        <div className="mt-4 flex flex-col gap-4">
          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="font-medium">授乳</span>
              <span className="font-mono text-muted-foreground">
                {countLabel(totals.feedingCount)}
              </span>
            </div>
            <BarChart
              ariaLabel="直近7日の授乳回数"
              data={feedingData}
              maxValue={WEEKLY_CHART_BASELINE.feedingCount}
              barColorClassName="text-amber-500 dark:text-amber-300"
              valueFormatter={countLabel}
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="font-medium">おむつ</span>
              <span className="font-mono text-muted-foreground">
                {diaperBreakdownLabel(diaperBreakdown)}
              </span>
            </div>
            <BarChart
              ariaLabel="直近7日のおむつ交換回数"
              data={diaperData}
              maxValue={WEEKLY_CHART_BASELINE.diaperCount}
              barColorClassName="text-sky-500 dark:text-sky-300"
              valueFormatter={countLabel}
            />
          </div>
        </div>
      </div>
    </section>
  )
}

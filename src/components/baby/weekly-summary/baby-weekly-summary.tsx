import { Droplets, Milk } from "lucide-react"
import { BarChart } from "@/components/baby/charts/bar-chart"
import {
  AVERAGE_WINDOW_DAYS,
  WEEKLY_CHART_BASELINE,
  totalBabyWeeklySummary,
  type BabyWeeklyAverage,
  type BabyWeeklySummaryDay,
} from "@/lib/domain/baby-weekly-summary"
import type { DiaperBreakdown } from "@/lib/domain/baby-log-aggregation"

interface BabyWeeklySummaryProps {
  /** グラフに描く日別バケット（今日を含む直近 7 日） */
  days: BabyWeeklySummaryDay[]
  /** 週間のおしっこ/うんち内訳（aggregateDiapers の出力から導出、both は双方に加算） */
  diaperBreakdown: DiaperBreakdown
  /** 1日あたりの平均（昨日までの 7 日）。記録が 1 日も無ければ null */
  average: BabyWeeklyAverage | null
}

/**
 * 平均の期間を明示する。**これは飾りではない** — 上段の平均（昨日まで）と
 * 下段のグラフ（今日を含む）は窓が違うため、期間を書かねば「数字が合わぬ」となる。
 */
function averagePeriodLabel(average: BabyWeeklyAverage | null): string {
  // 文言は**このカード固有**にする。「まだ記録がありません」はタイムラインの
  // 空状態が既に使っており、同じ文字列だと getByText が複数一致して既存テストを割る。
  if (average === null) return "平均を出せる記録がまだありません"
  if (average.sampleDays >= AVERAGE_WINDOW_DAYS) {
    return `昨日まで${AVERAGE_WINDOW_DAYS}日の平均`
  }
  return `記録のあった${average.sampleDays}日の平均`
}

function perDayLabel(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}回/日`
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
  average,
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
            value={perDayLabel(average?.feedingPerDay ?? null)}
            toneClassName="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
          />
          <StatHeader
            icon={Droplets}
            label="おむつ"
            value={perDayLabel(average?.diaperPerDay ?? null)}
            toneClassName="bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
          />
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">
          {averagePeriodLabel(average)}
        </p>

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

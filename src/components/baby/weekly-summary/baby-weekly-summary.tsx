import { Droplets, Milk, Moon } from "lucide-react"
import { BarChart } from "@/components/baby/charts/bar-chart"
import { formatElapsedMinutes } from "@/lib/utils/baby-log-labels"
import {
  totalBabyWeeklySummary,
  type BabyWeeklySummaryDay,
} from "@/lib/domain/baby-weekly-summary"

interface BabyWeeklySummaryProps {
  days: BabyWeeklySummaryDay[]
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

export function BabyWeeklySummary({ days }: BabyWeeklySummaryProps) {
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
  const sleepData = days.map((day, index) => ({
    label: labels[index],
    value: day.sleepMinutes,
  }))

  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-xs font-semibold text-muted-foreground">
        週間サマリー
      </h2>

      <div className="glass rounded-2xl p-4 shadow-lg shadow-black/[0.04]">
        <div className="grid grid-cols-3 gap-3">
          <StatHeader
            icon={Milk}
            label="授乳"
            value={countLabel(totals.feedingCount)}
            toneClassName="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
          />
          <StatHeader
            icon={Moon}
            label="睡眠"
            value={formatElapsedMinutes(totals.sleepMinutes)}
            toneClassName="bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
          />
          <StatHeader
            icon={Droplets}
            label="おむつ"
            value={countLabel(totals.diaperCount)}
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
              barColorClassName="text-amber-500 dark:text-amber-300"
              valueFormatter={countLabel}
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="font-medium">睡眠</span>
              <span className="font-mono text-muted-foreground">
                {formatElapsedMinutes(totals.sleepMinutes)}
              </span>
            </div>
            <BarChart
              ariaLabel="直近7日の睡眠時間"
              data={sleepData}
              barColorClassName="text-violet-500 dark:text-violet-300"
              valueFormatter={formatElapsedMinutes}
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="font-medium">おむつ</span>
              <span className="font-mono text-muted-foreground">
                {countLabel(totals.diaperCount)}
              </span>
            </div>
            <BarChart
              ariaLabel="直近7日のおむつ交換回数"
              data={diaperData}
              barColorClassName="text-sky-500 dark:text-sky-300"
              valueFormatter={countLabel}
            />
          </div>
        </div>
      </div>
    </section>
  )
}

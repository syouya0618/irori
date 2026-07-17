import { TrendingUp } from "lucide-react"
import { LineChart, type LineChartPoint } from "./line-chart"
import type { GrowthSeries, GrowthPoint } from "@/lib/domain/baby-log-aggregation"

interface GrowthChartSectionProps {
  series: GrowthSeries
}

/** "YYYY-MM-DD" → "M/D"（先頭ゼロを落とす） */
function toMonthDay(ymd: string): string {
  const [, m, d] = ymd.split("-")
  return `${Number(m)}/${Number(d)}`
}

function toWeightPoints(points: GrowthPoint[]): LineChartPoint[] {
  return points.map((p) => ({ label: toMonthDay(p.date), value: p.value }))
}

/** g → "5.2kg"（末尾の 0 を残さない） */
function formatKg(grams: number): string {
  return `${Number((grams / 1000).toFixed(2))}kg`
}

/** cm → "58cm" */
function formatCm(cm: number): string {
  return `${Number(cm.toFixed(1))}cm`
}

export function GrowthChartSection({ series }: GrowthChartSectionProps) {
  const hasData = series.weight.length > 0 || series.height.length > 0

  const latestWeight = series.weight.at(-1)?.value ?? null
  const latestHeight = series.height.at(-1)?.value ?? null

  return (
    <section className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]">
      <div className="flex items-center gap-2">
        <TrendingUp size={16} className="text-primary" />
        <h2 className="text-sm font-semibold">成長の記録</h2>
      </div>

      {!hasData ? (
        <p className="py-4 text-center text-xs text-muted-foreground">
          成長記録を追加すると、体重・身長の曲線が表示されます
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-muted-foreground">体重</span>
              <span className="text-sm font-semibold tabular-nums text-primary">
                {latestWeight !== null ? formatKg(latestWeight) : "---"}
              </span>
            </div>
            <LineChart
              ariaLabel="体重の推移"
              data={toWeightPoints(series.weight)}
              lineColorClassName="text-primary"
              valueFormatter={formatKg}
            />
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-muted-foreground">身長</span>
              <span className="text-sm font-semibold tabular-nums text-sky-600 dark:text-sky-400">
                {latestHeight !== null ? formatCm(latestHeight) : "---"}
              </span>
            </div>
            <LineChart
              ariaLabel="身長の推移"
              data={toWeightPoints(series.height)}
              lineColorClassName="text-sky-500"
              valueFormatter={formatCm}
            />
          </div>
        </div>
      )}
    </section>
  )
}

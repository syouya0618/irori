import { PercentileChart } from "./percentile-chart"
import { GROWTH_REFERENCE,type GrowthSex } from "@/lib/domain/growth-reference"
import { TrendingUp } from "lucide-react"
import { LineChart, type LineChartPoint } from "./line-chart"
import { daysBetweenYmd } from "@/lib/utils/date-jst"
import type { GrowthSeries, GrowthPoint } from "@/lib/domain/baby-log-aggregation"

interface GrowthChartSectionProps {
  birthDate?: string | null
  sex?: GrowthSex | null
  series: GrowthSeries
  /** 畳み込みの中に置く形（見出しとガラスの枠は外側が持つ） */
  embedded?: boolean
}

/** 数値一覧に出す直近の測定数。グラフの補助ゆえ短く、全件は PDF / エクスポートが担う */
const RECENT_POINTS = 4

/** "YYYY-MM-DD" → "M/D"（先頭ゼロを落とす） */
function toMonthDay(ymd: string): string {
  const [, m, d] = ymd.split("-")
  return `${Number(m)}/${Number(d)}`
}

/** "YYYY-MM-DD" → "YYYY/M/D"（一覧用。年を跨ぐ系列で M/D だけでは読めぬため） */
function toYearMonthDay(ymd: string): string {
  const [y, m, d] = ymd.split("-")
  return `${y}/${Number(m)}/${Number(d)}`
}

/**
 * 横軸を**時間に比例**させる。`t` は系列の最初の測定からの経過日数（同じ日の複数回は
 * 同じ位置）。配列順に等間隔で並べると 1 日後と 30 日後が同じ幅になり、傾きが嘘になる。
 * 日付が読めぬ行（想定外）は t を省き、LineChart 側が等間隔へ退化させる。
 */
function toChartPoints(points: GrowthPoint[]): LineChartPoint[] {
  const first = points[0]?.date
  return points.map((p) => {
    const days = first ? daysBetweenYmd(first, p.date) : null
    return {
      label: toMonthDay(p.date),
      value: p.value,
      ...(days !== null ? { t: days } : {}),
    }
  })
}

/** g → "5.2kg"（末尾の 0 を残さない） */
function formatKg(grams: number): string {
  return `${Number((grams / 1000).toFixed(2))}kg`
}

/** cm → "58cm" */
function formatCm(cm: number): string {
  return `${Number(cm.toFixed(1))}cm`
}

/**
 * グラフの横に置く小さな数値一覧（直近 RECENT_POINTS 件・新しい順）。
 * SVG の <title> はホバーでしか出ず、タッチ端末や読み上げでは届かぬため、日付・値・単位を
 * 通常のテキストで併記する。全件は PDF / エクスポートが担う。
 */
function RecentMeasurements({
  points,
  format,
  label,
}: {
  points: GrowthPoint[]
  format: (value: number) => string
  label: string
}) {
  const recent = points.slice(-RECENT_POINTS).reverse()
  if (recent.length === 0) return null
  return (
    <ul aria-label={`${label}の直近の測定`} className="flex flex-col gap-0.5">
      {recent.map((p, index) => (
        <li
          key={`${p.date}-${index}`}
          className="flex items-baseline justify-between text-xs text-muted-foreground"
        >
          <span className="font-mono">{toYearMonthDay(p.date)}</span>
          <span className="font-mono tabular-nums text-foreground">{format(p.value)}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * 畳んだ見出しに出す最新値の要約（「最新 5.15kg・57cm」）。記録が無ければ案内文。
 * 形式は下のグラフの見出しと同じ formatKg / formatCm に揃える。
 */
export { growthLatestSummary } from "@/lib/domain/growth-summary"

export function GrowthChartSection({
  series,
  embedded = false,
  birthDate,sex,
}: GrowthChartSectionProps) {
  const hasData = series.weight.length > 0 || series.height.length > 0

  const latestWeight = series.weight.at(-1)?.value ?? null
  const latestHeight = series.height.at(-1)?.value ?? null

  return (
    <section
      className={
        embedded
          ? "flex flex-col gap-3"
          : "glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"
      }
    >
      {!embedded && (
        <div className="flex items-center gap-2">
          <TrendingUp size={16} className="text-primary" />
          <h2 className="text-sm font-semibold">成長の記録</h2>
        </div>
      )}

      {!hasData ? (
        <p className="py-4 text-center text-xs text-muted-foreground">
          成長記録を追加すると、体重・身長の曲線が表示されます
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-muted-foreground">体重</span>
              <span className="text-sm font-semibold tabular-nums text-amber-700 dark:text-amber-300">
                {latestWeight !== null ? formatKg(latestWeight) : "---"}
              </span>
            </div>
            {birthDate&&sex?<PercentileChart points={series.weight} birthDate={birthDate} sex={sex} measure="weightKg" label="体重"/>:<LineChart
              ariaLabel="体重の推移"
              data={toChartPoints(series.weight)}
              lineColorClassName="text-primary"
              valueFormatter={formatKg}
            />}
            <RecentMeasurements points={series.weight} format={formatKg} label="体重" />
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-muted-foreground">身長</span>
              <span className="text-sm font-semibold tabular-nums text-sky-700 dark:text-sky-300">
                {latestHeight !== null ? formatCm(latestHeight) : "---"}
              </span>
            </div>
            {birthDate&&sex?<PercentileChart points={series.height} birthDate={birthDate} sex={sex} measure="heightCm" label="身長"/>:<LineChart
              ariaLabel="身長の推移"
              data={toChartPoints(series.height)}
              lineColorClassName="text-sky-500"
              valueFormatter={formatCm}
            />}
            <RecentMeasurements points={series.height} format={formatCm} label="身長" />
          </div>
        </div>
      )}
      {hasData&&<p className="text-xs leading-relaxed text-muted-foreground">{!birthDate||!sex?"基準帯の表示には子どもの生年月日・性別が必要です。":"暦月齢の集団分布で、早産の修正月齢や診断を表しません。"} <a href={GROWTH_REFERENCE.url} target="_blank" rel="noreferrer" className="underline">出典: {GROWTH_REFERENCE.source}</a>（{GROWTH_REFERENCE.published}公表）をiroriで加工。公表区分の値を表示し、補間は行いません。</p>}
    </section>
  )
}

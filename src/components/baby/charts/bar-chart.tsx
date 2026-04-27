export interface BarChartDatum {
  label: string
  value: number
}

interface BarChartProps {
  ariaLabel: string
  data: BarChartDatum[]
  barColorClassName: string
  maxValue?: number
  valueFormatter?: (value: number) => string
}

const CHART_WIDTH = 280
const CHART_HEIGHT = 104
const PLOT_TOP = 12
const PLOT_HEIGHT = 64
const LABEL_Y = 96
const BAR_GAP = 8

export function BarChart({
  ariaLabel,
  data,
  barColorClassName,
  maxValue,
  valueFormatter = (value) => String(value),
}: BarChartProps) {
  const safeMax = Math.max(maxValue ?? 0, ...data.map((item) => item.value), 1)
  const barWidth =
    data.length > 0
      ? (CHART_WIDTH - BAR_GAP * (data.length - 1)) / data.length
      : CHART_WIDTH

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      className="h-28 w-full overflow-visible"
    >
      <line
        x1={0}
        x2={CHART_WIDTH}
        y1={PLOT_TOP + PLOT_HEIGHT}
        y2={PLOT_TOP + PLOT_HEIGHT}
        stroke="currentColor"
        className="text-border"
        strokeWidth={1}
      />

      {data.map((item, index) => {
        const normalized = item.value / safeMax
        const height =
          item.value > 0 ? Math.max(4, normalized * PLOT_HEIGHT) : 0
        const x = index * (barWidth + BAR_GAP)
        const y = PLOT_TOP + PLOT_HEIGHT - height
        const centerX = x + barWidth / 2

        return (
          <g key={`${item.label}-${index}`}>
            <title>{`${item.label}: ${valueFormatter(item.value)}`}</title>
            <rect
              x={x}
              y={y}
              width={barWidth}
              height={height}
              rx={4}
              fill="currentColor"
              className={barColorClassName}
            />
            <text
              x={centerX}
              y={LABEL_Y}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {item.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

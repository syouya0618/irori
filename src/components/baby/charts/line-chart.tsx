export interface LineChartPoint {
  label: string
  value: number
}

interface LineChartProps {
  ariaLabel: string
  data: LineChartPoint[]
  lineColorClassName: string
  valueFormatter?: (value: number) => string
}

const CHART_WIDTH = 280
const CHART_HEIGHT = 120
const PLOT_TOP = 12
const PLOT_HEIGHT = 76
const LABEL_Y = 112
const PLOT_LEFT = 6
const PLOT_RIGHT = 6

/**
 * 成長曲線などの折れ線チャート。
 * y 軸は 0 起点ではなく値域 [min, max] で自動スケールする（体重/身長は 0 付近に無いため）。
 */
export function LineChart({
  ariaLabel,
  data,
  lineColorClassName,
  valueFormatter = (value) => String(value),
}: LineChartProps) {
  if (data.length === 0) {
    return (
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="h-32 w-full"
      >
        <text
          x={CHART_WIDTH / 2}
          y={CHART_HEIGHT / 2}
          textAnchor="middle"
          className="fill-muted-foreground text-[11px]"
        >
          記録なし
        </text>
      </svg>
    )
  }

  const values = data.map((d) => d.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  const plotWidth = CHART_WIDTH - PLOT_LEFT - PLOT_RIGHT

  const coords = data.map((d, index) => {
    const x =
      data.length === 1
        ? CHART_WIDTH / 2
        : PLOT_LEFT + (index / (data.length - 1)) * plotWidth
    // span が 0（全て同値）なら中央に置く
    const normalized = span === 0 ? 0.5 : (d.value - min) / span
    const y = PLOT_TOP + PLOT_HEIGHT - normalized * PLOT_HEIGHT
    return { x, y, datum: d }
  })

  const polylinePoints = coords.map((c) => `${c.x},${c.y}`).join(" ")

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      className="h-32 w-full overflow-visible"
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

      {coords.length >= 2 && (
        <polyline
          points={polylinePoints}
          fill="none"
          stroke="currentColor"
          className={lineColorClassName}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}

      {coords.map((c, index) => (
        <g key={`${c.datum.label}-${index}`}>
          <title>{`${c.datum.label}: ${valueFormatter(c.datum.value)}`}</title>
          <circle
            cx={c.x}
            cy={c.y}
            r={3}
            fill="currentColor"
            className={lineColorClassName}
          />
          {/* ラベルは端の重なりを避け、最初と最後のみ表示 */}
          {(index === 0 || index === coords.length - 1) && (
            <text
              x={c.x}
              y={LABEL_Y}
              textAnchor={index === 0 ? "start" : "end"}
              className="fill-muted-foreground text-[10px]"
            >
              {c.datum.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  )
}

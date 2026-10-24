export interface LineChartPoint {
  label: string
  value: number
  /**
   * 横軸上の位置（時間）。全点で同じ単位（例: 最初の測定からの経過日数）であれば
   * 何でもよい。**省略すると配列の順番で等間隔に並べる**（時間を表さぬ系列向け）。
   * 成長記録のように測定間隔が不規則な系列は必ず渡すこと — 等間隔に並べると
   * 1 日後と 30 日後が同じ幅になり、推移の傾きが嘘になる。
   */
  t?: number
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
 * 各点の横位置（0..1）を決める。`t` が全点に在り、かつ幅を持つなら時間に比例させる。
 * `t` が欠ける・全て同値なら配列順の等間隔へ退化する（1 点なら中央）。
 */
export function resolveHorizontalPositions(data: readonly LineChartPoint[]): number[] {
  if (data.length === 1) return [0.5]
  const times = data.map((d) => d.t)
  const allTimed = times.every((t): t is number => typeof t === "number" && Number.isFinite(t))
  if (allTimed) {
    const min = Math.min(...(times as number[]))
    const max = Math.max(...(times as number[]))
    if (max > min) return (times as number[]).map((t) => (t - min) / (max - min))
  }
  return data.map((_, index) => index / (data.length - 1))
}

/**
 * 成長曲線などの折れ線チャート。
 * y 軸は 0 起点ではなく値域 [min, max] で自動スケールする（体重/身長は 0 付近に無いため）。
 * x 軸は `t` を渡せば時間に比例する（不規則な測定間隔をそのまま横幅に写す）。
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
  const positions = resolveHorizontalPositions(data)

  const coords = data.map((d, index) => {
    const x = PLOT_LEFT + positions[index] * plotWidth
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

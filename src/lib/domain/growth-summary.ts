import type { GrowthSeries } from "./baby-log-aggregation"
/** Small header summary, kept separate from the lazily loaded chart and reference tables. */
export function growthLatestSummary(series:GrowthSeries):string{
 const w=series.weight.at(-1)?.value??null,h=series.height.at(-1)?.value??null
 const parts=[w!==null?`${Number((w/1000).toFixed(2))}kg`:null,h!==null?`${Number(h.toFixed(1))}cm`:null].filter(Boolean)
 return parts.length?`最新 ${parts.join("・")}`:"体重・身長の測定はまだありません"
}

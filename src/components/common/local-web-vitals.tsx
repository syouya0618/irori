"use client"
import { useReportWebVitals } from "next/web-vitals"
type Metric=Parameters<typeof useReportWebVitals>[0] extends (metric:infer M)=>void?M:never
/** Explicit local opt-in only. No URL, metric id, entries, user/child identifiers or external transport. */
export function reportLocalVital(metric:Metric){
 try{if(localStorage.getItem("irori:measure-performance:v1")!=="1")return
  window.dispatchEvent(new CustomEvent("irori:web-vital",{detail:{name:metric.name,value:metric.value,rating:metric.rating,navigationType:metric.navigationType}}))
 }catch{ /* unavailable storage leaves measurement disabled */ }
}
export function LocalWebVitals(){useReportWebVitals(reportLocalVital);return null}

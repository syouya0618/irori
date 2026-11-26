import { createHash } from "node:crypto"
import { isValidYmd, shiftYmd } from "@/lib/utils/date-jst"
import { EXPORT_MARKER, isExportMirror, type ExportRemoteEvent } from "@/lib/domain/google-calendar-export"
import type { Json } from "@/lib/types/database"

export type ManagedDoc = { title: string; timing: { start: string; end: string } | { startAt: string; endAt: string } }
type Item = ExportRemoteEvent & { recurringEventId?: string; eventType?: string; attendeesOmitted?: boolean; recurrence?: string[]; start?: {date?:string;dateTime?:string;timeZone?:string}; end?: {date?:string;dateTime?:string;timeZone?:string} }

export function googleEventObservation(item: Item, marker: string) {
  if (!item.id) throw new Error("missing event identity")
  const none = { doc: null, legacy: null, series: null }
  if (item.status === "cancelled") return { ...none, state: "cancelled" }
  const legacy = item.id.match(/^irori([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/)
  if (item.attendees?.length || item.attendeesOmitted ||
      (item.eventType && item.eventType !== "default") ||
      (/^[sr][0-9a-f]{32}$/.test(item.id) && item.extendedProperties?.private?.[EXPORT_MARKER]!==marker) ||
      (legacy && (!isExportMirror(item) || item.extendedProperties?.private?.[EXPORT_MARKER] !== marker))) {
    return { ...none, state: "protected" }
  }
  if (!item.etag) throw new Error("missing event version")
  const title = item.summary?.trim() || "（タイトルなし）"
  if (Array.from(title).length > 200) return { ...none, state: "protected" }
  let timing: ManagedDoc["timing"]
  if (isValidYmd(item.start?.date) && isValidYmd(item.end?.date) && item.end!.date! > item.start!.date!) {
    timing = { start: item.start!.date!, end: shiftYmd(item.end!.date!, -1) }
  } else {
    const start = Date.parse(item.start?.dateTime ?? "")
    const end = Date.parse(item.end?.dateTime ?? "")
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("invalid event interval")
    timing = { startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() }
  }
  const doc: ManagedDoc & {rule?: {lines:string[];startZone:string;endZone:string}} = {title,timing}
  if (item.recurrence) {
    if (!Array.isArray(item.recurrence) || !item.recurrence.length ||
        !item.recurrence.every(line=>typeof line==="string" && /^(RRULE|RDATE|EXDATE|EXRULE)[:;]/.test(line) && !/[\r\n]/.test(line))) throw new Error("incomplete recurrence")
    doc.rule={lines:[...item.recurrence].sort(),startZone:item.start?.timeZone ?? "Asia/Tokyo",endZone:item.end?.timeZone ?? item.start?.timeZone ?? "Asia/Tokyo"}
  }
  return { state: "present", doc, legacy: legacy?.slice(1).join("-") ?? null, series: item.recurringEventId ?? null }
}

export function managedSeriesId(calendar: string, series: string) {
  const hex = createHash("sha256").update(JSON.stringify([calendar, series])).digest("hex")
  return [hex.slice(0,8),hex.slice(8,12),"8"+hex.slice(13,16),"a"+hex.slice(17,20),hex.slice(20,32)].join("-")
}

export function googleFields(doc: Json) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || typeof doc.title !== "string") throw new Error("invalid sync plan")
  const t = doc.timing
  if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error("invalid sync interval")
  const rule=doc.rule
  const recurrence=rule && typeof rule==="object" && !Array.isArray(rule) && Array.isArray(rule.lines)
    ? { recurrence:rule.lines, startZone:String(rule.startZone), endZone:String(rule.endZone) } : null
  const common={summary:doc.title,...(recurrence ? {recurrence:recurrence.recurrence} : {})}
  if (typeof t.start === "string" && typeof t.end === "string") return { ...common, start: { date: t.start }, end: { date: shiftYmd(t.end,1) } }
  if (typeof t.startAt !== "string" || typeof t.endAt !== "string") throw new Error("invalid sync interval")
  return { ...common, start: {dateTime:t.startAt,...(recurrence?{timeZone:recurrence.startZone}:{})}, end:{dateTime:t.endAt,...(recurrence?{timeZone:recurrence.endZone}:{})} }
}

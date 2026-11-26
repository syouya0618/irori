import { createHash } from "node:crypto"
import { isValidYmd, shiftYmd } from "@/lib/utils/date-jst"
import { EXPORT_MARKER, isExportMirror, type ExportRemoteEvent } from "@/lib/domain/google-calendar-export"
import type { Json } from "@/lib/types/database"

export type ManagedDoc = { title: string; timing: { start: string; end: string } | { startAt: string; endAt: string } }
type Item = ExportRemoteEvent & { recurringEventId?: string; eventType?: string; attendeesOmitted?: boolean; recurrence?: unknown }

export function googleEventObservation(item: Item, marker: string) {
  if (!item.id) throw new Error("missing event identity")
  const none = { doc: null, legacy: null, series: null }
  if (item.status === "cancelled") return { ...none, state: "cancelled" }
  const legacy = item.id.match(/^irori([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/)
  if (item.attendees?.length || item.attendeesOmitted || item.recurrence ||
      (item.eventType && item.eventType !== "default") ||
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
  return { state: "present", doc: { title, timing }, legacy: legacy?.slice(1).join("-") ?? null, series: item.recurringEventId ?? null }
}

export function managedSeriesId(calendar: string, series: string) {
  const hex = createHash("sha256").update(JSON.stringify([calendar, series])).digest("hex")
  return [hex.slice(0,8),hex.slice(8,12),"8"+hex.slice(13,16),"a"+hex.slice(17,20),hex.slice(20,32)].join("-")
}

export function googleFields(doc: Json) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || typeof doc.title !== "string") throw new Error("invalid sync plan")
  const t = doc.timing
  if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error("invalid sync interval")
  if (typeof t.start === "string" && typeof t.end === "string") return { summary: doc.title, start: { date: t.start }, end: { date: shiftYmd(t.end,1) } }
  if (typeof t.startAt !== "string" || typeof t.endAt !== "string") throw new Error("invalid sync interval")
  return { summary: doc.title, start: { dateTime: t.startAt }, end: { dateTime: t.endAt } }
}

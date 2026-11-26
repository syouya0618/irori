import { shiftYmd } from "@/lib/utils/date-jst"

/** Scope is intentionally limited to calendars created by this app. */
export const GOOGLE_CALENDAR_EXPORT_SCOPE = "https://www.googleapis.com/auth/calendar.app.created"
export const EXPORT_CALENDAR_NAME = "irori 家族の予定"
export const EXPORT_DESCRIPTION_PREFIX = "irori-managed-calendar-v1:"
export const EXPORT_MARKER = "iroriMirror"
export const EXPORT_SHARED_MARKER = "iroriExport"
export const EXPORT_SHARED_VALUE = "v1"
export const EXPORT_PAST_DAYS = 90
export const EXPORT_FUTURE_DAYS = 365
export const EXPORT_MAX_EVENTS = 500

export function hasCalendarExportScope(scope: string | null | undefined): boolean {
  return typeof scope === "string" && scope.split(/\s+/).includes(GOOGLE_CALENDAR_EXPORT_SCOPE)
}

export function exportDescription(connectionId: string): string {
  return EXPORT_DESCRIPTION_PREFIX + connectionId
}

export function isManagedCalendarDescription(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(EXPORT_DESCRIPTION_PREFIX)
}

export interface ExportSource {
  id: string
  title: string
  is_all_day: boolean
  start_date: string
  end_date: string
  start_at: string | null
  end_at: string | null
}

type EventDate = { date: string } | { dateTime: string }
export interface ExportEvent {
  id: string
  summary: string
  start: EventDate
  end: EventDate
  extendedProperties: {
    private: Record<string, string>
    shared: Record<string, string>
  }
}

export interface ExportRemoteEvent {
  id?: string
  etag?: string
  summary?: string
  start?: { date?: string; dateTime?: string }
  end?: { date?: string; dateTime?: string }
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> }
  attendees?: unknown[]
  status?: string
}

/** Stable Google event IDs use the base32hex alphabet (0-9,a-v). No random re-insert on retry. */
export function exportEventId(id: string): string {
  const normalized = id.toLowerCase().replaceAll("-", "")
  if (!/^[0-9a-f]{32}$/.test(normalized)) throw new Error("Invalid native event ID")
  return "irori" + normalized
}

/** Only ordinary native event titles and dates are exported. Memo and child/medical data never enter this object. */
export function toExportEvent(row: ExportSource, connectionId: string): ExportEvent {
  const id = exportEventId(row.id)
  let start: EventDate
  let end: EventDate
  if (row.is_all_day) {
    start = { date: row.start_date }
    end = { date: shiftYmd(row.end_date, 1) }
  } else {
    const startMs = Date.parse(row.start_at ?? "")
    const endMs = Date.parse(row.end_at ?? "")
    if (!Number.isFinite(startMs)) throw new Error("Invalid timed event")
    start = { dateTime: new Date(startMs).toISOString() }
    // Google requires an end. Preserve explicit duration; a missing/zero end is a 1-minute marker.
    end = { dateTime: new Date(Number.isFinite(endMs) && endMs > startMs ? endMs : startMs + 60_000).toISOString() }
  }
  return {
    id, summary: row.title, start, end,
    extendedProperties: {
      private: { [EXPORT_MARKER]: connectionId },
      shared: { [EXPORT_SHARED_MARKER]: EXPORT_SHARED_VALUE },
    },
  }
}

export function isExportMirror(raw: { id?: string | null; extendedProperties?: ExportRemoteEvent["extendedProperties"] | null }): boolean {
  return typeof raw.id === "string" && /^irori[0-9a-f]{32}$/.test(raw.id) &&
    raw.extendedProperties?.shared?.[EXPORT_SHARED_MARKER] === EXPORT_SHARED_VALUE
}

function sameDate(a: EventDate, b: ExportRemoteEvent["start"]): boolean {
  if ("date" in a) return a.date === b?.date
  return typeof b?.dateTime === "string" && Date.parse(a.dateTime) === Date.parse(b.dateTime)
}

export type ExportChange =
  | { kind: "insert"; event: ExportEvent }
  | { kind: "patch"; event: ExportEvent; etag: string }
  | { kind: "delete"; id: string; etag: string }

/** Build the complete reconciliation before any mutation. Only owned, tagged rows are ever edited/deleted. */
export function planExport(
  desired: readonly ExportEvent[], remote: readonly ExportRemoteEvent[], connectionId: string,
): ExportChange[] {
  const owned = new Map<string, ExportRemoteEvent>()
  const desiredIds = new Set(desired.map((event) => event.id))
  if (desiredIds.size !== desired.length) throw new Error("Duplicate native event IDs")
  for (const item of remote) {
    if (!item.id || !isExportMirror(item) ||
        item.extendedProperties?.private?.[EXPORT_MARKER] !== connectionId ||
        item.status === "cancelled") continue
    if (owned.has(item.id) || !item.etag) throw new Error("Invalid remote snapshot")
    owned.set(item.id, item)
  }
  const changes: ExportChange[] = []
  for (const event of desired) {
    const prior = owned.get(event.id)
    if (!prior) {
      changes.push({ kind: "insert", event })
    } else if (prior.summary !== event.summary || !sameDate(event.start, prior.start) || !sameDate(event.end, prior.end)) {
      // Never modify a copy to which someone manually added guests.
      if (prior.attendees?.length) throw new Error("Managed event has attendees")
      changes.push({ kind: "patch", event, etag: prior.etag! })
    }
  }
  for (const [id, item] of owned) {
    if (!desiredIds.has(id)) {
      if (item.attendees?.length) throw new Error("Managed event has attendees")
      changes.push({ kind: "delete", id, etag: item.etag! })
    }
  }
  return changes
}

import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"
import { fetchWithTimeout, readJsonSafe } from "@/lib/google/fetch-with-timeout"
import { fetchCalendarList } from "@/lib/google/calendar-client"
import { refreshAccessToken, GoogleAuthError } from "@/lib/google/oauth"
import { loadGoogleTokens, updateGoogleAccessToken, type GoogleTokenOwner } from "@/lib/google/token-store"
import {
  EXPORT_CALENDAR_NAME, EXPORT_MARKER, EXPORT_MAX_EVENTS, EXPORT_PAST_DAYS, EXPORT_FUTURE_DAYS,
  exportDescription, hasCalendarExportScope, planExport, toExportEvent, type ExportChange, type ExportRemoteEvent,
} from "@/lib/domain/google-calendar-export"
import { shiftYmd, todayJstString } from "@/lib/utils/date-jst"

type Row = Database["public"]["Tables"]["google_calendar_exports"]["Row"]
type Patch = Database["public"]["Tables"]["google_calendar_exports"]["Update"]
type Db = SupabaseClient<Database>
type Action = "enable" | "sync" | "stop"
type ErrorCode = "partial" | "permission" | "provisioning" | "unavailable" | "limit" | "failed"
const COLUMNS = "connection_id,household_id,enabled,calendar_id,provisioning,lease_until,last_synced_at,last_error"
const GOOGLE = "https://www.googleapis.com/calendar/v3"
const LEASE_MS = 120_000
const WRITE_BUDGET = 12
const RUN_BUDGET_MS = 18_000
const MAX_REMOTE_PAGES = 8

export interface GoogleExportStatus {
  enabled: boolean
  configured: boolean
  permission: boolean
  provisioning: boolean
  busy: boolean
  lastSyncedAt: string | null
  lastError: string | null
}
class ExportFailure extends Error {
  constructor(readonly code: ErrorCode) { super(code) }
}
class RemoteFailure extends Error {
  constructor(readonly status: number | null) { super("Google calendar request failed") }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ExportFailure("failed")
  return value as Record<string, unknown>
}

async function api(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const outcome = await fetchWithTimeout(GOOGLE + path, {
    ...init,
    redirect: "error",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...init.headers },
  }, 5_000)
  if (!outcome.ok) throw new RemoteFailure(null)
  return outcome.response
}
async function json(token: string, path: string, init: RequestInit = {}) {
  const response = await api(token, path, init)
  if (!response.ok) throw new RemoteFailure(response.status)
  return object(await readJsonSafe(response))
}
const calendarPath = (id: string) => "/calendars/" + encodeURIComponent(id)
const eventPath = (calendar: string, id?: string) =>
  calendarPath(calendar) + "/events" + (id ? "/" + encodeURIComponent(id) : "")

async function readRow(supabase: Db, owner: GoogleTokenOwner): Promise<Row | null> {
  const { data, error } = await supabase.from("google_calendar_exports").select(COLUMNS)
    .eq("connection_id", owner.connectionId).eq("household_id", owner.householdId).maybeSingle()
  if (error) throw new ExportFailure("failed")
  return data
}
function statusOf(row: Row | null, permission: boolean): GoogleExportStatus {
  return {
    enabled: row?.enabled ?? false,
    configured: row?.calendar_id != null,
    permission,
    provisioning: row?.provisioning ?? false,
    busy: row?.lease_until != null && Date.parse(row.lease_until) > Date.now(),
    lastSyncedAt: row?.last_synced_at ?? null,
    lastError: row?.last_error ?? null,
  }
}

/** A revoked/removed household member must never continue exporting the household's events. */
async function requireCurrentMember(supabase: Db, owner: GoogleTokenOwner) {
  const { data, error } = await supabase.from("profiles").select("household_id,is_approved,role")
    .eq("id", owner.userId).maybeSingle()
  if (error || !data || data.household_id !== owner.householdId || data.is_approved !== true || data.role === "viewer") {
    throw new ExportFailure("permission")
  }
}

export async function getGoogleExportStatus(supabase: Db, owner: GoogleTokenOwner): Promise<GoogleExportStatus> {
  await requireCurrentMember(supabase, owner)
  const tokens = await loadGoogleTokens(supabase, owner)
  return statusOf(await readRow(supabase, owner), hasCalendarExportScope(tokens?.scope))
}

async function leaseRow(supabase: Db, owner: GoogleTokenOwner): Promise<Row | null> {
  const now = new Date().toISOString()
  const lease = new Date(Date.now() + LEASE_MS).toISOString()
  const { data, error } = await supabase.from("google_calendar_exports").update({ lease_until: lease })
    .eq("connection_id", owner.connectionId).eq("household_id", owner.householdId)
    .or("lease_until.is.null,lease_until.lt." + now).select(COLUMNS).maybeSingle()
  if (error) throw new ExportFailure("failed")
  return data
}

async function setRow(supabase: Db, owner: GoogleTokenOwner, lease: string, patch: Patch): Promise<Row> {
  const { data, error } = await supabase.from("google_calendar_exports").update(patch)
    .eq("connection_id", owner.connectionId).eq("household_id", owner.householdId)
    .eq("lease_until", lease).select(COLUMNS).maybeSingle()
  if (error || !data) throw new ExportFailure("failed")
  return data
}

async function accessToken(supabase: Db, owner: GoogleTokenOwner): Promise<string> {
  const stored = await loadGoogleTokens(supabase, owner)
  if (!stored || !hasCalendarExportScope(stored.scope)) throw new ExportFailure("permission")
  const fresh = await refreshAccessToken(stored.refreshToken)
  if (fresh.scope !== null && !hasCalendarExportScope(fresh.scope)) throw new ExportFailure("permission")
  await updateGoogleAccessToken(supabase, owner, {
    accessToken: fresh.accessToken, accessTokenExpiresAt: fresh.accessTokenExpiresAt, scope: fresh.scope,
  })
  return fresh.accessToken
}

/** Only explicit enable may provision a calendar. If create's outcome is unknown, recover by marker, never create again. */
async function provision(supabase: Db, owner: GoogleTokenOwner, row: Row, token: string): Promise<Row> {
  const lease = row.lease_until!
  if (row.calendar_id !== null) return row
  const description = exportDescription(owner.connectionId)
  const found = (await fetchCalendarList(token)).filter((item) => !item.primary && item.accessRole === "owner" && item.description === description)
  if (found.length > 1) throw new ExportFailure("provisioning")
  if (found.length === 1) {
    return setRow(supabase, owner, lease, { calendar_id: found[0].id, provisioning: false })
  }
  if (row.provisioning) throw new ExportFailure("provisioning")
  await setRow(supabase, owner, lease, { provisioning: true })
  let payload: Record<string, unknown>
  try {
    payload = await json(token, "/calendars", {
      method: "POST", body: JSON.stringify({ summary: EXPORT_CALENDAR_NAME, description, timeZone: "Asia/Tokyo" }),
    })
  } catch (error) {
    // A definitive invalid/unauthorized request cannot have created a calendar. Other failures may have.
    if (error instanceof RemoteFailure && [400, 401, 403].includes(error.status ?? 0)) {
      await setRow(supabase, owner, lease, { provisioning: false })
    }
    throw error
  }
  if (typeof payload.id !== "string" || !payload.id || payload.id === "primary") throw new ExportFailure("provisioning")
  return setRow(supabase, owner, lease, { calendar_id: payload.id, provisioning: false })
}

async function readRemote(token: string, calendarId: string, owner: GoogleTokenOwner): Promise<ExportRemoteEvent[]> {
  // Verify the destination's identity on every pass. Never accept a calendar ID from the browser.
  const calendar = await json(token, calendarPath(calendarId))
  if (calendar.id !== calendarId || calendar.description !== exportDescription(owner.connectionId)) {
    throw new ExportFailure("unavailable")
  }
  const events: ExportRemoteEvent[] = []
  const seen = new Set<string>()
  let page: string | null = null
  for (let count = 0; count < MAX_REMOTE_PAGES; count++) {
    const params = new URLSearchParams({
      maxResults: "250", showDeleted: "false", singleEvents: "true",
      privateExtendedProperty: EXPORT_MARKER + "=" + owner.connectionId,
    })
    if (page) params.set("pageToken", page)
    const payload = await json(token, eventPath(calendarId) + "?" + params.toString())
    // Never infer an empty authoritative snapshot from a malformed response.
    if (!Array.isArray(payload.items)) throw new ExportFailure("failed")
    for (const item of payload.items) {
      const value = object(item)
      if (typeof value.id !== "string") throw new ExportFailure("failed")
      events.push(value as ExportRemoteEvent)
    }
    if (payload.nextPageToken === undefined || payload.nextPageToken === null) return events
    if (typeof payload.nextPageToken !== "string" || !payload.nextPageToken || seen.has(payload.nextPageToken)) {
      throw new ExportFailure("failed")
    }
    page = payload.nextPageToken
    seen.add(page)
  }
  throw new ExportFailure("limit")
}

async function applyChange(token: string, calendarId: string, change: ExportChange) {
  const id = change.kind === "delete" ? change.id : change.event.id
  const path = eventPath(calendarId, change.kind === "insert" ? undefined : id) + "?sendUpdates=none"
  if (change.kind === "delete") {
    const response = await api(token, path, { method: "DELETE", headers: { "If-Match": change.etag } })
    if (!response.ok && response.status !== 404 && response.status !== 410) throw new RemoteFailure(response.status)
    return
  }
  const { id: eventId, ...fields } = change.event
  const response = await api(token, path, {
    method: change.kind === "insert" ? "POST" : "PATCH",
    ...(change.kind === "patch" ? { headers: { "If-Match": change.etag } } : {}),
    body: JSON.stringify(change.kind === "insert" ? { id: eventId, ...fields, reminders: { useDefault: false } } : fields),
  })
  if (!response.ok) throw new RemoteFailure(response.status)
  const saved = object(await readJsonSafe(response))
  if (saved.id !== eventId) throw new ExportFailure("failed")
}

async function reconcile(supabase: Db, owner: GoogleTokenOwner, row: Row, token: string): Promise<Patch> {
  if (!row.calendar_id) throw new ExportFailure("unavailable")
  const started = Date.now()
  await requireCurrentMember(supabase, owner)
  const today = todayJstString()
  const { data, error } = await supabase.from("calendar_events")
    .select("id,title,is_all_day,start_date,end_date,start_at,end_at")
    .eq("household_id", owner.householdId).eq("source", "native")
    .is("child_id", null).is("medical_record_id", null)
    .gte("end_date", shiftYmd(today, -EXPORT_PAST_DAYS))
    .lte("start_date", shiftYmd(today, EXPORT_FUTURE_DAYS))
    .order("id").limit(EXPORT_MAX_EVENTS + 1)
  if (error || !data) throw new ExportFailure("failed")
  if (data.length > EXPORT_MAX_EVENTS) throw new ExportFailure("limit")
  const desired = data.map((event) => toExportEvent(event, owner.connectionId))
  const remote = await readRemote(token, row.calendar_id, owner)
  const changes = planExport(desired, remote, owner.connectionId)
  let applied = 0
  for (const change of changes) {
    if (applied >= WRITE_BUDGET || Date.now() - started >= RUN_BUDGET_MS) break
    // A removed member may not resume a stale lease. No parallel writes to a single export.
    await requireCurrentMember(supabase, owner)
    await applyChange(token, row.calendar_id, change)
    applied++
  }
  return applied === changes.length
    ? { last_synced_at: new Date().toISOString(), last_error: null }
    : { last_error: "partial" }
}

function failureCode(error: unknown): ErrorCode {
  if (error instanceof ExportFailure) return error.code
  if (error instanceof GoogleAuthError && error.kind === "invalid_grant") return "permission"
  if (error instanceof RemoteFailure) {
    if (error.status === 401 || error.status === 403) return "permission"
    if (error.status === 404 || error.status === 410) return "unavailable"
  }
  return "failed"
}

/** Shared by manual controls and background sync. The row lease serializes stop, provisioning and sync. */
async function run(supabase: Db, owner: GoogleTokenOwner, action: Action, getToken: () => Promise<string>, permission: boolean): Promise<GoogleExportStatus> {
  await requireCurrentMember(supabase, owner)
  if (action === "enable") {
    const { error } = await supabase.from("google_calendar_exports")
      .upsert({ connection_id: owner.connectionId, household_id: owner.householdId }, { onConflict: "connection_id", ignoreDuplicates: true })
    if (error) throw new ExportFailure("failed")
  }
  const before = await readRow(supabase, owner)
  if (!before) return statusOf(null, permission)
  if (action === "sync" && !before.enabled) return statusOf(before, permission)
  const leased = await leaseRow(supabase, owner)
  if (!leased) return statusOf(await readRow(supabase, owner), permission)
  const lease = leased.lease_until!
  try {
    if (action === "stop") {
      return statusOf(await setRow(supabase, owner, lease, { enabled: false, lease_until: null, last_error: null }), permission)
    }
    // Stop may have won the lease between read and claim.
    if (action === "sync" && !leased.enabled) {
      return statusOf(await setRow(supabase, owner, lease, { lease_until: null }), permission)
    }
    if (!permission) throw new ExportFailure("permission")
    const token = await getToken()
    let row = leased
    if (action === "enable") {
      row = await provision(supabase, owner, row, token)
      // Before recording the opt-in, verify that the destination is still the app-created calendar.
      const calendar = await json(token, calendarPath(row.calendar_id!))
      if (calendar.id !== row.calendar_id || calendar.description !== exportDescription(owner.connectionId)) {
        throw new ExportFailure("unavailable")
      }
      row = await setRow(supabase, owner, lease, { enabled: true })
    }
    const patch = await reconcile(supabase, owner, row, token)
    return statusOf(await setRow(supabase, owner, lease, { ...patch, lease_until: null }), permission)
  } catch (error) {
    const code = failureCode(error)
    console.warn("[google-export] operation failed", { code, connectionId: owner.connectionId })
    return statusOf(await setRow(supabase, owner, lease, { last_error: code, lease_until: null }), code === "permission" ? false : permission)
  }
}

export async function manageGoogleExport(supabase: Db, owner: GoogleTokenOwner, action: Action): Promise<GoogleExportStatus> {
  const stored = await loadGoogleTokens(supabase, owner)
  const permission = hasCalendarExportScope(stored?.scope)
  if (action === "enable" && !permission) return statusOf(await readRow(supabase, owner), false)
  return run(supabase, owner, action, () => accessToken(supabase, owner), permission)
}

export async function syncExistingGoogleExport(supabase: Db, owner: GoogleTokenOwner, getToken: () => Promise<string>): Promise<void> {
  // Existing read-only integrations never call this path. No calendar is created by background jobs.
  const row = await readRow(supabase, owner)
  if (!row?.enabled) return
  await run(supabase, owner, "sync", getToken, true)
}

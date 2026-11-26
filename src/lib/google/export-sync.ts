import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"
import { fetchWithTimeout, readJsonSafe } from "@/lib/google/fetch-with-timeout"
import { fetchCalendarList } from "@/lib/google/calendar-client"
import { refreshAccessToken, GoogleAuthError } from "@/lib/google/oauth"
import { loadGoogleTokens, updateGoogleAccessToken, type GoogleTokenOwner } from "@/lib/google/token-store"
import { EXPORT_CALENDAR_NAME, exportDescription, hasCalendarExportScope, isManagedCalendarDescription } from "@/lib/domain/google-calendar-export"
import { accountTarget, bindTarget, syncManaged, type ManagedConflict } from "./managed-sync"

type Row = Database["public"]["Tables"]["google_calendar_exports"]["Row"]
type Patch = Database["public"]["Tables"]["google_calendar_exports"]["Update"]
type Db = SupabaseClient<Database>
type Action = "enable" | "sync" | "stop"
type ErrorCode = "partial" | "permission" | "provisioning" | "unavailable" | "limit" | "failed"
const COLUMNS = "connection_id,household_id,enabled,calendar_id,provisioning,lease_until,last_synced_at,last_error,bidirectional,worker_nonce"
const GOOGLE = "https://www.googleapis.com/calendar/v3"
const LEASE_MS = 120_000
export interface GoogleExportStatus {
  enabled: boolean
  configured: boolean
  permission: boolean
  provisioning: boolean
  busy: boolean
  lastSyncedAt: string | null
  retiring?: boolean
  conflicts?: ManagedConflict[]
  pending?: boolean
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
  if (outcome.response.status === 401) throw new RemoteFailure(401)
  if (outcome.response.status === 403) {
    const body = await readJsonSafe(outcome.response.clone()) as {error?: {errors?: {reason?: string}[]}} | null
    if (body?.error?.errors?.some(item=>["insufficientPermissions","forbidden","authError"].includes(item.reason ?? ""))) throw new RemoteFailure(403)
  }
  return outcome.response
}
async function json(token: string, path: string, init: RequestInit = {}) {
  const response = await api(token, path, init)
  if (!response.ok) throw new RemoteFailure(response.status)
  return object(await readJsonSafe(response))
}
const calendarPath = (id: string) => "/calendars/" + encodeURIComponent(id)
async function readRow(supabase: Db, owner: GoogleTokenOwner): Promise<Row | null> {
  const { data, error } = await supabase.from("google_calendar_exports").select(COLUMNS)
    .eq("connection_id", owner.connectionId).eq("household_id", owner.householdId).maybeSingle()
  if (error) throw new ExportFailure("failed")
  return data
}
function statusOf(row: Row | null, permission: boolean): GoogleExportStatus {
  return {
    enabled: Boolean(row?.enabled && row?.bidirectional),
    configured: row?.calendar_id != null,
    permission: permission && row?.last_error !== "permission",
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
  const row = await readRow(supabase, owner)
  const status = statusOf(row, hasCalendarExportScope(tokens?.scope))
  if (row?.bidirectional && row.calendar_id) {
    const { data, error } = await supabase.rpc("google_managed_status", { p_connection: owner.connectionId, p_user: owner.userId, p_household: owner.householdId })
    if (error || !data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.conflicts)) throw new ExportFailure("failed")
    status.conflicts = data.conflicts as ManagedConflict[]
    status.retiring = data.retiring === true
    status.pending = data.pending === true || status.retiring
  }
  return status
}

async function leaseRow(supabase: Db, owner: GoogleTokenOwner): Promise<Row | null> {
  const now = new Date().toISOString()
  const lease = new Date(Date.now() + LEASE_MS).toISOString()
  const { data, error } = await supabase.from("google_calendar_exports").update({ lease_until: lease, worker_nonce: crypto.randomUUID() })
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
async function provision(supabase: Db, owner: GoogleTokenOwner, row: Row, token: string, subject: string): Promise<{row: Row; marker: string}> {
  const lease = row.lease_until!
  const key = { household_id:owner.householdId, user_id:owner.userId, google_account_id:subject }
  const reservation = await supabase.from("google_calendar_provisioning")
    .upsert({...key, marker:owner.connectionId}, {onConflict:"household_id,user_id,google_account_id",ignoreDuplicates:true})
  if (reservation.error) throw new ExportFailure("provisioning")
  const {data:intent,error} = await supabase.from("google_calendar_provisioning").select("marker,attempted").match(key).single()
  if (error || !intent) throw new ExportFailure("provisioning")
  const marker=intent.marker
  if (row.calendar_id !== null) return {row,marker}
  const description = exportDescription(marker)
  const calendars = (await fetchCalendarList(token,true)).filter(item=>!item.primary && item.accessRole==="owner")
  const found = calendars.filter(item => item.description === description)
  if (found.length > 1) throw new ExportFailure("provisioning")
  if (found.length === 1) {
    return {row:await setRow(supabase, owner, lease, { calendar_id: found[0].id, provisioning: false }),marker}
  }
  // A disconnected v1 calendar without surviving ownership evidence needs reconciliation.
  if (intent.attempted || calendars.some(item=>isManagedCalendarDescription(item.description))) throw new ExportFailure("provisioning")
  const claim=await supabase.from("google_calendar_provisioning").update({attempted:true}).match(key).eq("attempted",false).select("marker").maybeSingle()
  if (claim.error || !claim.data) throw new ExportFailure("provisioning")
  await setRow(supabase, owner, lease, { provisioning: true })
  let payload: Record<string, unknown>
  try {
    payload = await json(token, "/calendars", {
      method: "POST", body: JSON.stringify({ summary: EXPORT_CALENDAR_NAME, description, timeZone: "Asia/Tokyo" }),
    })
  } catch (error) {
    // A definitive invalid/unauthorized request cannot have created a calendar. Other failures may have.
    if (error instanceof RemoteFailure && [400, 401, 403].includes(error.status ?? 0)) {
      const {error:resetError}=await supabase.from("google_calendar_provisioning").update({attempted:false}).match(key)
      if (resetError) throw new ExportFailure("provisioning")
      await setRow(supabase, owner, lease, { provisioning: false })
    }
    throw error
  }
  if (typeof payload.id !== "string" || !payload.id || payload.id === "primary") throw new ExportFailure("provisioning")
  return {row:await setRow(supabase, owner, lease, { calendar_id: payload.id, provisioning: false }),marker}
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
  if (action === "sync" && (!before.enabled || !before.bidirectional)) return statusOf(before, permission)
  const leased = await leaseRow(supabase, owner)
  if (!leased) return statusOf(await readRow(supabase, owner), permission)
  const lease = leased.lease_until!
  try {
    if (action === "stop") {
      return statusOf(await setRow(supabase, owner, lease, { enabled: false, lease_until: null, last_error: null }), permission)
    }
    // Stop may have won the lease between read and claim.
    if (action === "sync" && (!leased.enabled || !leased.bidirectional)) {
      return statusOf(await setRow(supabase, owner, lease, { lease_until: null }), permission)
    }
    if (!permission) throw new ExportFailure("permission")
    const token = await getToken()
    let row = leased
    const account = await accountTarget(supabase, owner)
    const subject = account.subject
    let target = account.target
    if (action === "enable") {
      if (target) {
        if (row.calendar_id && row.calendar_id !== target.calendar_id) throw new ExportFailure("unavailable")
        row = await setRow(supabase, owner, lease, { calendar_id: target.calendar_id })
      } else {
        const reserved = await provision(supabase, owner, row, token, subject)
        row = reserved.row
        await bindTarget(supabase, owner, row.calendar_id!, subject, reserved.marker)
        target = (await accountTarget(supabase, owner)).target
      }
      if (!target || target.calendar_id !== row.calendar_id) throw new ExportFailure("unavailable")
      const identity = await json(token, calendarPath(target.calendar_id))
      if (identity.id !== target.calendar_id || identity.description !== exportDescription(target.marker)) throw new ExportFailure("unavailable")
      row = await setRow(supabase, owner, lease, { enabled: true, bidirectional: true, last_synced_at: null, last_error: "partial", lease_until: null })
      return statusOf(row, permission)
    }
    if (!target || target.calendar_id !== row.calendar_id) throw new ExportFailure("unavailable")
    const done = await syncManaged(supabase, target, lease, (path, init) => api(token,path,init), () => requireCurrentMember(supabase,owner))
    const patch: Patch = done ? { last_synced_at: new Date().toISOString(), last_error: null } : { last_error: "partial" }
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
  if (!row?.enabled || !row.bidirectional) return
  await run(supabase, owner, "sync", getToken, true)
}

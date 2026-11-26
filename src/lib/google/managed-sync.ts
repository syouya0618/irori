import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database, Json } from "@/lib/types/database"
import type { GoogleTokenOwner } from "./token-store"
import { googleEventObservation, googleFields, managedSeriesId } from "./managed-events"
import { EXPORT_MARKER, EXPORT_SHARED_MARKER, EXPORT_SHARED_VALUE, exportDescription, type ExportRemoteEvent } from "@/lib/domain/google-calendar-export"
import { shiftYmd, todayJstString } from "@/lib/utils/date-jst"

type Db = SupabaseClient<Database>
type Target = Database["public"]["Tables"]["google_managed_calendars"]["Row"]
type Api = (path: string, init?: RequestInit) => Promise<Response>
type Wire = ExportRemoteEvent & { recurringEventId?: string }
type Lease = { calendar: string; lease: string; marker: string; api: Api; db: Db }
const columns = "calendar_id,household_id,user_id,google_account_id,marker,sync_token,page_token,window_start,window_end,scanned_on"

export async function accountTarget(db: Db, owner: GoogleTokenOwner) {
  const { data: connection, error } = await db.from("google_connections").select("google_account_id").eq("id",owner.connectionId)
    .eq("household_id",owner.householdId).eq("user_id",owner.userId).single()
  if (error || !connection) throw new Error("missing connection")
  const result = await db.from("google_managed_calendars").select(columns).eq("google_account_id",connection.google_account_id)
    .eq("household_id",owner.householdId).eq("user_id",owner.userId).maybeSingle()
  if (result.error) throw new Error("managed calendar unavailable")
  return { target: result.data, subject: connection.google_account_id }
}

export async function bindTarget(db: Db, owner: GoogleTokenOwner, id: string, subject: string, marker: string) {
  const { error } = await db.from("google_managed_calendars").upsert({ calendar_id: id, marker,
    household_id: owner.householdId, user_id: owner.userId, google_account_id: subject },{ onConflict: "calendar_id", ignoreDuplicates: true })
  if (error) throw new Error("calendar binding failed")
}

function pathFor(calendar: string, id?: string) {
  return "/calendars/" + encodeURIComponent(calendar) + "/events" + (id ? "/" + encodeURIComponent(id) : "")
}

async function exchange(ctx: Lease, id: string, item: Wire | null, cancelled: boolean) {
  const obs = item ? googleEventObservation(item,ctx.marker) : { state: cancelled ? "cancelled" : "missing", doc: null, legacy: null, series: null }
  const { data, error } = await ctx.db.rpc("google_managed_exchange", { p_calendar:ctx.calendar, p_lease:ctx.lease,
    p_remote:id, p_state:obs.state, p_doc:obs.doc, p_etag:item?.etag ?? null, p_legacy:obs.legacy,
    p_series:obs.series ? managedSeriesId(ctx.calendar,obs.series) : null })
  if (error || !data || typeof data !== "object" || Array.isArray(data) || typeof data.action !== "string") throw new Error("failed to persist event observation")
  return { action:data.action, doc:data.doc ?? null }
}

async function processEvent(ctx: Lease, id: string, listedCancelled=false) {
  const path = pathFor(ctx.calendar,id)
  const response = await ctx.api(path)
  let item: Wire | null = null
  if (response.ok) {
    item = await response.json() as Wire
    if (item?.id !== id) throw new Error("invalid event identity")
  } else if (![404,410].includes(response.status)) throw new Error("event lookup failed")
  const plan = await exchange(ctx,id,item,listedCancelled || response.status===410)
  if (plan.action==="none" || plan.action==="conflict") return
  const insert = plan.action==="insert"
  const remove = plan.action==="delete"
  if (!insert && !remove && plan.action!=="patch") throw new Error("unknown sync action")
  if (!insert && !item?.etag) throw new Error("missing conditional version")
  const fields = remove ? undefined : googleFields(plan.doc)
  const body = insert ? { ...fields, id, extendedProperties:{private:{[EXPORT_MARKER]:ctx.marker},shared:{[EXPORT_SHARED_MARKER]:EXPORT_SHARED_VALUE}}, reminders:{useDefault:false} } : fields
  // The DB plan is durable before issuing a request. On 409/412, loss of a
  // response, or a process restart the next pass reads this exact ID again.
  const saved = await ctx.api((insert ? pathFor(ctx.calendar) : path)+"?sendUpdates=none", {
    method:insert ? "POST" : remove ? "DELETE" : "PATCH",
    headers:insert ? {} : {"If-Match":item!.etag!},
    ...(remove ? {} : {body:JSON.stringify(body)}),
  })
  if ([409,412].includes(saved.status)) return
  if (!saved.ok) throw new Error("conditional write failed")
  const updated = remove ? null : await saved.json() as Wire
  if (!remove && updated?.id!==id) throw new Error("invalid mutation reply")
  await exchange(ctx,id,updated,remove)
}

export async function syncManaged(db: Db, target: Target, lease: string, api: Api, stillMember: () => Promise<void>) {
  const calendar = target.calendar_id
  const identity = await api("/calendars/"+encodeURIComponent(calendar))
  const metadata = identity.ok ? await identity.json() : null
  if (metadata?.id!==calendar || metadata.description!==exportDescription(target.marker)) throw new Error("destination identity changed")
  const ctx = { calendar, lease, marker:target.marker, api, db }
  const today = todayJstString()
  const refreshWindow = !target.page_token && target.scanned_on !== null && target.scanned_on <= shiftYmd(today,-7)
  const sync = refreshWindow ? null : target.sync_token
  const start = refreshWindow || !target.window_start ? shiftYmd(today,-90) : target.window_start
  const end = refreshWindow || !target.window_end ? shiftYmd(today,366) : target.window_end
  async function cursor(nextSync: string | null, page: string | null, scanned: string | null, items: {id:string;cancelled:boolean}[] = []) {
    const { error } = await db.rpc("google_managed_cursor", {p_calendar:calendar,p_lease:lease,p_sync:nextSync,p_page:page,p_start:start,p_end:end,p_scanned:scanned,p_items:items})
    if (error) throw new Error("cursor commit failed")
  }
  const params = new URLSearchParams({singleEvents:"true",showDeleted:"true",maxResults:"250"})
  if (sync) params.set("syncToken",sync)
  else {
    params.set("timeMin",start+"T00:00:00+09:00")
    params.set("timeMax",end+"T00:00:00+09:00")
  }
  if (target.page_token) params.set("pageToken",target.page_token)
  const response = await api(pathFor(calendar)+"?"+params.toString())
  if (response.status===410 && (sync || target.page_token)) {
    await cursor(null,null,null)
    return false
  }
  if (!response.ok) throw new Error("managed listing failed")
  const page = await response.json()
  const next = page?.nextPageToken
  const final = page?.nextSyncToken
  if (!Array.isArray(page?.items) || (next !== undefined && (typeof next!=="string" || !next || next===target.page_token)) ||
      (!next && (typeof final!=="string" || !final))) throw new Error("incomplete listing")
  const items = page.items.map((row: Wire) => {
    if (typeof row?.id!=="string" || !row.id) throw new Error("invalid event on page")
    return {id:row.id,cancelled:row.status==="cancelled"}
  })
  await cursor(next ? sync : final,next ?? null,sync ? target.scanned_on : next ? null : today,items)
  const [inbox, outbox] = await Promise.all([
    db.from("google_managed_inbox").select("remote_id,cancelled,queued_at").eq("calendar_id",calendar).order("queued_at").order("remote_id").limit(12),
    db.from("google_managed_events").select("remote_id").eq("calendar_id",calendar).eq("pending",true).order("queued_at").order("event_id").limit(12),
  ])
  if (inbox.error || outbox.error) throw new Error("queue unavailable")
  const jobs = new Map(inbox.data.map(item=>[item.remote_id,item]))
  const ids = new Set<string>()
  for (let i=0; i<Math.max(inbox.data.length,outbox.data.length); i++) {
    if (inbox.data[i]) ids.add(inbox.data[i].remote_id)
    if (outbox.data[i]) ids.add(outbox.data[i].remote_id)
  }
  const started=Date.now()
  let failure: unknown
  for (const id of ids) {
    await stillMember()
    const incoming=jobs.get(id)
    try {
      await processEvent(ctx,id,incoming?.cancelled)
      if (incoming) {
        const ack=await db.from("google_managed_inbox").delete().eq("calendar_id",calendar).eq("remote_id",id).eq("queued_at",incoming.queued_at)
        if (ack.error) throw new Error("inbox acknowledgement failed")
      }
    } catch (error) {
      failure=error
      const retry=new Date().toISOString()
      if (incoming) await db.from("google_managed_inbox").update({queued_at:retry}).eq("calendar_id",calendar).eq("remote_id",id).eq("queued_at",incoming.queued_at).throwOnError()
      await db.from("google_managed_events").update({queued_at:retry}).eq("calendar_id",calendar).eq("remote_id",id).eq("pending",true).throwOnError()
    }
    if (Date.now()-started > 15_000) break
  }
  if (failure) throw failure
  const [outstanding,received] = await Promise.all([
    db.from("google_managed_events").select("event_id",{head:true,count:"exact"}).eq("calendar_id",calendar).eq("pending",true),
    db.from("google_managed_inbox").select("remote_id",{head:true,count:"exact"}).eq("calendar_id",calendar),
  ])
  if (outstanding.error || received.error || outstanding.count===null || received.count===null) throw new Error("queue verification failed")
  return !next && outstanding.count===0 && received.count===0
}

export type ManagedConflict = { id: string; local: Json; google: Json; protected: boolean }

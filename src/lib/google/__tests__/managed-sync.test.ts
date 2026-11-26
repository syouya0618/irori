import { describe, expect, it, vi } from "vitest"
import { syncManaged } from "../managed-sync"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"
import { exportDescription } from "@/lib/domain/google-calendar-export"

const target = {calendar_id:"dedicated",household_id:"h",user_id:"u",marker:"owner",google_account_id:"subject",page_token:null,sync_token:"sync1",window_start:"2026-11-01",window_end:"2027-11-01",scanned_on:"2099-01-01"}
function fixture(incoming: {remote_id:string;cancelled:boolean;queued_at:string}[]=[], context:(id:string)=>object=()=>({})) {
  const ack=vi.fn()
  const retry=vi.fn()
  const rpc=vi.fn().mockResolvedValue({data:null,error:null})
  const finish = (data: unknown) => {
    const result = {data, count:0,error:null}
    const chain = {eq:()=>chain,order:()=>chain,limit:()=>result,throwOnError:()=>result,then:(resolve: (value: typeof result)=>unknown)=>resolve(result)}
    return chain
  }
  const db = {rpc:(name:string,args:{p_remote?:string})=>name==="google_managed_series_context" ? Promise.resolve({data:context(args.p_remote ?? ""),error:null}) : rpc(name,args), from:(table:string)=>({select:()=>finish(table==="google_managed_inbox"?incoming:[]),delete:()=>{ack(); return finish(null)},update:()=>{retry();return finish(null)}})}
  const api=vi.fn().mockResolvedValueOnce(Response.json({id:"dedicated",description:exportDescription("owner")}))
  return {rpc,api,ack,retry,db:db as unknown as SupabaseClient<Database>}
}
describe("managed sync worker",()=>{
  it("commits IDs with the next page token and keeps the same incremental query",async()=>{
    const {db,api,rpc}=fixture()
    api.mockResolvedValueOnce(Response.json({items:[{id:"g",status:"cancelled"}],nextPageToken:"page2"}))
    expect(await syncManaged(db,{...target,page_token:"page1"},"lease",api,async()=>{})).toBe(false)
    const query=new URL(api.mock.calls[1][0],"https://example.test").searchParams
    expect(query.get("syncToken")).toBe("sync1")
    expect(query.get("pageToken")).toBe("page1")
    expect(query.has("timeMin")).toBe(false)
    expect(rpc).toHaveBeenCalledWith("google_managed_cursor",expect.objectContaining({p_items:[{id:"g",cancelled:true}],p_sync:"sync1",p_page:"page2"}))
  })
  it("resets only the cursor on 410 and commits nothing on malformed input",async()=>{
    const expired=fixture()
    expired.api.mockResolvedValueOnce(new Response(null,{status:410}))
    expect(await syncManaged(expired.db,target,"lease",expired.api,async()=>{})).toBe(false)
    expect(expired.rpc.mock.calls).toHaveLength(1)
    expect(expired.rpc.mock.calls[0][1]).toMatchObject({p_sync:null,p_page:null,p_items:[]})
    const bad=fixture()
    bad.api.mockResolvedValueOnce(Response.json({items:[{}],nextSyncToken:"s2"}))
    await expect(syncManaged(bad.db,target,"lease",bad.api,async()=>{})).rejects.toThrow()
    expect(bad.rpc).not.toHaveBeenCalled()
  })
  it("conditionally patches an exact event and acknowledges the returned version",async()=>{
    const {db,api,rpc}=fixture([{remote_id:"g",cancelled:false,queued_at:"v"}])
    const wire={id:"g",etag:"v1",summary:"old",start:{date:"2026-11-26"},end:{date:"2026-11-27"}}
    api.mockResolvedValueOnce(Response.json({items:[],nextSyncToken:"s2"})).mockResolvedValueOnce(Response.json(wire))
      .mockResolvedValueOnce(Response.json({...wire,etag:"v2",summary:"new"}))
    rpc.mockResolvedValueOnce({error:null}).mockResolvedValueOnce({data:{action:"patch",doc:{title:"new",timing:{start:"2026-11-26",end:"2026-11-26"}}},error:null})
      .mockResolvedValueOnce({data:{action:"none"},error:null})
    expect(await syncManaged(db,target,"lease",api,async()=>{})).toBe(true)
    expect(api.mock.calls[3][1]).toMatchObject({method:"PATCH",headers:{"If-Match":"v1"}})
    expect(rpc.mock.calls[2][1]).toMatchObject({p_etag:"v2",p_doc:{title:"new"}})
  })
  it("retains a cancelled occurrence in the durable inbox until its parent decision",async()=>{
    const {db,api,rpc,ack,retry}=fixture([{remote_id:"child",cancelled:true,queued_at:"queued"}],id=>
      id==="child" ? {kind:"instance",master:"parent",bound:true,anchor:"2026-11-26"} : {kind:"master",series:"series",active:false})
    api.mockResolvedValueOnce(Response.json({items:[],nextSyncToken:"s2"}))
      .mockResolvedValueOnce(new Response(null,{status:410}))
      .mockResolvedValueOnce(Response.json({id:"parent",etag:"removed",status:"cancelled"}))
    rpc.mockResolvedValueOnce({error:null}).mockResolvedValueOnce({data:{action:"conflict"},error:null})
    await syncManaged(db,target,"lease",api,async()=>{})
    expect(ack).not.toHaveBeenCalled()
    expect(retry).toHaveBeenCalled()
    expect(rpc.mock.calls.filter(x=>x[0]==="google_managed_exchange").map(x=>x[1].p_remote)).toEqual(["parent"])
  })
  it("inserts a recurring master using the durable ID and its time zone",async()=>{
    const {db,api,rpc}=fixture([{remote_id:"s123",cancelled:false,queued_at:"queued"}],()=>({kind:"master",series:"series"}))
    const rule={lines:["RRULE:FREQ=WEEKLY;COUNT=3"],startZone:"Asia/Tokyo",endZone:"Asia/Tokyo"}
    const doc={title:"通院以外の予定",timing:{startAt:"2026-11-26T02:00:00.000Z",endAt:"2026-11-26T03:00:00.000Z"},rule}
    api.mockResolvedValueOnce(Response.json({items:[],nextSyncToken:"s2"}))
      .mockResolvedValueOnce(new Response(null,{status:404}))
      .mockResolvedValueOnce(Response.json({id:"s123",etag:"v1",summary:doc.title,recurrence:rule.lines,start:{dateTime:doc.timing.startAt,timeZone:rule.startZone},end:{dateTime:doc.timing.endAt,timeZone:rule.endZone}}))
    rpc.mockResolvedValueOnce({error:null}).mockResolvedValueOnce({data:{action:"insert",doc},error:null}).mockResolvedValueOnce({data:{action:"none"},error:null})
    await syncManaged(db,target,"lease",api,async()=>{})
    expect(api.mock.calls[3][1].method).toBe("POST")
    expect(JSON.parse(api.mock.calls[3][1].body)).toMatchObject({id:"s123",recurrence:rule.lines,start:{timeZone:"Asia/Tokyo"}})
    expect(rpc.mock.calls[2][1]).toMatchObject({p_master:true,p_etag:"v1",p_doc:doc})
  })
})

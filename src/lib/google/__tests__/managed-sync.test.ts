import { describe, expect, it, vi } from "vitest"
import { syncManaged } from "../managed-sync"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"
import { exportDescription } from "@/lib/domain/google-calendar-export"

const target = {calendar_id:"dedicated",household_id:"h",user_id:"u",marker:"owner",google_account_id:"subject",page_token:null,sync_token:"sync1",window_start:"2026-11-01",window_end:"2027-11-01",scanned_on:"2099-01-01"}
function fixture(incoming: {remote_id:string;cancelled:boolean;queued_at:string}[]=[]) {
  const rpc=vi.fn().mockResolvedValue({data:null,error:null})
  const finish = (data: unknown) => {
    const result = {data, count:0,error:null}
    const chain = {eq:()=>chain,order:()=>chain,limit:()=>result,then:(resolve: (value: typeof result)=>unknown)=>resolve(result)}
    return chain
  }
  const db = {rpc, from:(table:string)=>({select:()=>finish(table==="google_managed_inbox"?incoming:[]),delete:()=>finish(null)})}
  const api=vi.fn().mockResolvedValueOnce(Response.json({id:"dedicated",description:exportDescription("owner")}))
  return {rpc,api,db:db as unknown as SupabaseClient<Database>}
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
})

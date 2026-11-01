import { beforeEach,expect,it,vi } from "vitest"
import { GET } from "../route"
import { getBabyAuthContext } from "@/lib/supabase/child-context"
vi.mock("@/lib/supabase/child-context",()=>({getBabyAuthContext:vi.fn()}))
const child="e4000000-0000-4000-8000-000000000001",rpc=vi.fn()
beforeEach(()=>{vi.resetAllMocks();vi.mocked(getBabyAuthContext).mockResolvedValue({error:null,context:{supabase:{rpc},householdId:"synthetic-household",userId:"synthetic-user"}} as never)})
it("pins child and date range, checks completeness and disables caching",async()=>{
 rpc.mockResolvedValue({error:null,data:{child_id:child,complete:true,row_count:1,custom:[{value:false}]}})
 const r=await GET(new Request(`https://example.invalid/api/child-records-export?child=${child}&from=2026-01-01&to=2026-01-02`))
 expect(r.status).toBe(200);expect(r.headers.get("cache-control")).toBe("private, no-store");expect(r.headers.get("content-disposition")).toContain("attachment");expect(rpc).toHaveBeenCalledWith("export_child_records",{p_child:child,p_from:"2026-01-01",p_to:"2026-01-02"})
 expect((await r.json()).custom).toEqual([{value:false}])
})
it("rejects invalid scope/date before RPC, and denies viewer export",async()=>{
 expect((await GET(new Request("https://example.invalid/api/child-records-export?child=bad"))).status).toBe(400)
 expect((await GET(new Request(`https://example.invalid/api/child-records-export?child=${child}&from=2026-02-30`))).status).toBe(400)
 vi.mocked(getBabyAuthContext).mockResolvedValue({error:"denied",reason:"shared-only",context:null})
 expect((await GET(new Request(`https://example.invalid/api/child-records-export?child=${child}`))).status).toBe(403);expect(rpc).not.toHaveBeenCalled()
})
it("never returns a partial or mismatched export as success",async()=>{
 for(const data of [{child_id:child,complete:false},{child_id:"other-child",complete:true}]){rpc.mockResolvedValue({error:null,data});expect((await GET(new Request(`https://example.invalid/api/child-records-export?child=${child}`))).status).toBe(503)}
 rpc.mockResolvedValue({error:{code:"54000"},data:null});expect((await GET(new Request(`https://example.invalid/api/child-records-export?child=${child}`))).status).toBe(413)
})

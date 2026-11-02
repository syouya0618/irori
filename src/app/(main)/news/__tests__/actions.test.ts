import { beforeEach,expect,it,vi } from "vitest"
const {auth,admin,collect,revalidate}=vi.hoisted(()=>({auth:vi.fn(),admin:vi.fn(),collect:vi.fn(),revalidate:vi.fn()}))
vi.mock("@/lib/supabase/auth-context",()=>({getAuthContext:auth}))
vi.mock("@/lib/supabase/admin",()=>({createAdminClient:admin}))
vi.mock("@/lib/news/collect",()=>({collectRegionNews:collect}))
vi.mock("next/cache",()=>({revalidatePath:revalidate}))
import { refreshNews } from "../actions"
beforeEach(()=>{vi.resetAllMocks()})
it("denies unauthenticated callers before privileged public collection",async()=>{
 auth.mockResolvedValue({error:"認証されていません"})
 expect(await refreshNews()).toEqual({error:"認証されていません"});expect(admin).not.toHaveBeenCalled();expect(collect).not.toHaveBeenCalled()
})
function setup(region_key:string|null){
 const query={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data:{region_key},error:null})}
 auth.mockResolvedValue({error:null,context:{supabase:{from:()=>query},userId:"synthetic-user",householdId:"synthetic-family"}})
 return query
}
it("requires an allowed saved region and never accepts a caller-supplied feed",async()=>{
 setup("unknown");expect(await refreshNews()).toHaveProperty("error");expect(admin).not.toHaveBeenCalled()
})
it("collects only saved region with Push off, returns partial state and invalidates the list",async()=>{
 const query=setup("kakegawa"),db={synthetic:true};admin.mockReturnValue(db);collect.mockResolvedValue({status:"partial",fetched:2,failed:1})
 expect(await refreshNews()).toEqual({status:"partial",fetched:2});expect(collect).toHaveBeenCalledWith(db,"kakegawa",expect.any(Date));expect(query.eq).toHaveBeenCalledWith("user_id","synthetic-user");expect(revalidate).toHaveBeenCalledWith("/news")
})
it("configuration failures do not leak server credentials or errors",async()=>{
 setup("kakegawa");admin.mockImplementation(()=>{throw new Error("synthetic-private-message")})
 expect(JSON.stringify(await refreshNews())).not.toContain("synthetic-private-message")
})

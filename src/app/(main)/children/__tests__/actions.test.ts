import { beforeEach,expect,it,vi } from "vitest"
import { saveChild } from "../actions"
import { getAuthContext } from "@/lib/supabase/auth-context"
vi.mock("@/lib/supabase/auth-context",()=>({getAuthContext:vi.fn()}))
vi.mock("next/headers",()=>({cookies:vi.fn()}));vi.mock("next/cache",()=>({revalidatePath:vi.fn()}))
const id="e6000000-0000-4000-8000-000000000001",h="synthetic-household"
let row:Record<string,unknown>|null,lost:boolean,writes:number
const from=()=>{
 let op="read",values:Record<string,unknown>={}
 const filters:Record<string,unknown>={}
 const q={insert(v:Record<string,unknown>){op="insert";values=v;return q},update(v:Record<string,unknown>){op="update";values=v;return q},eq(k:string,v:unknown){filters[k]=v;return q},select(){if(op==="read")return q;writes++;if(op==="insert"){if(row)return Promise.resolve({data:null,error:{code:"23505"}});row={...values,updated_at:"2026-01-01T00:00:00.000001Z"};if(lost){lost=false;return Promise.resolve({data:null,error:{code:"network"}})}}else if(!row||Object.entries(filters).some(([k,v])=>row?.[k]!==v))return Promise.resolve({data:[],error:null});else row={...row,...values,updated_at:"2026-01-01T00:00:00.000002Z"};return Promise.resolve({data:[row],error:null})},async maybeSingle(){return {data:row&&Object.entries(filters).every(([k,v])=>row?.[k]===v)?row:null,error:null}}}
 return q
}
const form=()=>{const f=new FormData();for(const [k,v]of Object.entries({name:"synthetic sibling",birth_date:"2025-01-01",sex:"female",id:"",version:"",client_id:id,household_id:h,childId:id}))f.set(k,v);return f}
beforeEach(()=>{row=null;lost=false;writes=0;vi.mocked(getAuthContext).mockResolvedValue({error:null,context:{userId:"synthetic-user",householdId:h,supabase:{from}}} as never)})
it("a committed create with a lost response confirms the same id without a second child",async()=>{
 lost=true;const first=await saveChild(form());expect(first.failure).toBe("unknown");expect(row?.id).toBe(id)
 const second=await saveChild(form());expect(second).toMatchObject({success:true,replayed:true});expect(row?.name).toBe("synthetic sibling");expect(writes).toBe(2)
})
it("same-id content drift cannot overwrite a child, and changed household input cannot create elsewhere",async()=>{
 await saveChild(form());const changed=form();changed.set("name","synthetic changed");expect((await saveChild(changed)).conflict).toBe(true);expect(row?.name).toBe("synthetic sibling")
 const stale=form();stale.set("household_id","synthetic-other");const before=writes;expect((await saveChild(stale)).failure).toBe("rejected");expect(writes).toBe(before)
})
it("a stale edit only confirms identical current content; it cannot replace another update",async()=>{
 await saveChild(form());const edit=form();edit.set("id",id);edit.set("version","2020-01-01T00:00:00Z");expect((await saveChild(edit)).replayed).toBe(true)
 edit.set("name","synthetic stale edit");expect((await saveChild(edit)).conflict).toBe(true);expect(row?.name).toBe("synthetic sibling")
})
it("viewer/auth denial happens before a write",async()=>{
 vi.mocked(getAuthContext).mockResolvedValue({error:"denied",reason:"shared-only",context:null});expect((await saveChild(form())).failure).toBe("rejected");expect(writes).toBe(0)
})

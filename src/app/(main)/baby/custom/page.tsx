import { getChildContext } from "@/lib/supabase/child-context"
import { CustomView } from "@/components/baby/custom-view"
import { isClientId } from "@/lib/utils/client-id"
export default async function CustomPage({searchParams}:{searchParams:Promise<{q?:string;field?:string;page?:string;child?:string}>}){
 const params=await searchParams,{supabase,child,userId,householdId}=await getChildContext(params.child)
 const q=(params.q??"").slice(0,100),field=isClientId(params.field)?params.field:null,page=Math.max(0,Math.min(10000,Number.parseInt(params.page??"0",10)||0))
 let query=supabase.from("custom_records").select("*").eq("household_id",householdId).eq("child_id",child.id)
 if(q)query=query.ilike("search_text",`%${q.replace(/[\\%_]/g,"\\$&")}%`)
 if(field)query=query.eq("field_id",field)
 const [{data:fields,error:fe},{data:records,error:re}]=await Promise.all([
  supabase.from("custom_fields").select("*").eq("household_id",householdId).order("archived").order("created_at",{ascending:false}).limit(501),
  query.order("logged_at",{ascending:false}).order("id",{ascending:false}).range(page*100,page*100+100),
 ])
 if(fe||re)throw new Error("カスタム記録を取得できませんでした")
 return <CustomView nowIso={new Date().toISOString()} key={child.id} owner={{userId,householdId,childId:child.id}} childName={child.name??""} fields={(fields??[]).slice(0,500)} fieldsTruncated={(fields?.length??0)>500} records={(records??[]).slice(0,100)} hasMore={(records?.length??0)>100} query={q} fieldFilter={field??""} page={page}/>
}

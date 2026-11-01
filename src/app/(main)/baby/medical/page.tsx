import { getChildContext } from "@/lib/supabase/child-context"
import { MedicalView } from "@/components/baby/medical-view"
export default async function MedicalPage({searchParams}:{searchParams:Promise<{child?:string}>}){
 const {supabase,child,userId,householdId}=await getChildContext((await searchParams).child)
 const {data,error}=await supabase.from("medical_records").select("*").eq("household_id",householdId).eq("child_id",child.id).order("scheduled_date",{ascending:false}).limit(501)
 if(error)throw new Error("予防接種・健診を取得できませんでした")
 return <MedicalView key={child.id} owner={{userId,householdId,childId:child.id}} childName={child.name??""} records={(data??[]).slice(0,500)} truncated={(data?.length??0)>500}/>
}

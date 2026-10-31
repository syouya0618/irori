"use server"

import { cookies } from "next/headers"
import { revalidatePath } from "next/cache"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { isTimestamptzText } from "@/lib/domain/timestamptz-text"
import { isValidYmd,todayJstString } from "@/lib/utils/date-jst"
import { failureKindOfDbError,type CreateFailureKind } from "@/lib/domain/save-attempt"
import { isClientId } from "@/lib/utils/client-id"

export async function selectChild(id: string) {
  if (!isClientId(id)) return { error: "子どもの指定が不正です" }
  const auth = await getAuthContext()
  if (auth.error !== null) return { error: auth.error }
  const { data, error } = await auth.context.supabase.from("children").select("id")
    .eq("id", id).eq("household_id", auth.context.householdId).maybeSingle()
  if (error || !data) return { error: "子どもの情報を確認できませんでした" }
  ;(await cookies()).set("irori-child", id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 31536000 })
  revalidatePath("/", "layout")
  return { success: true }
}

type ChildSaveResult={error?:string;failure?:CreateFailureKind;conflict?:boolean;success?:true;updatedAt?:string;replayed?:true}
export async function saveChild(form:FormData):Promise<ChildSaveResult>{
 const auth=await getAuthContext();if(auth.error!==null)return {error:auth.error,failure:"rejected"}
 const name=String(form.get("name")??"").trim(),birthDate=String(form.get("birth_date")??""),id=String(form.get("id")??""),sex=String(form.get("sex")??""),version=String(form.get("version")??""),clientId=String(form.get("client_id")??"")
 if(!name||name.length>100||(id&&!isClientId(id))||(clientId&&!isClientId(clientId))||!["","female","male"].includes(sex))return {error:"入力を確認してください",failure:"rejected"}
 if(id&&!isTimestamptzText(version))return {error:"再読み込みして最新情報を確認してください",failure:"rejected"}
 if(birthDate&&(!isValidYmd(birthDate)||birthDate>todayJstString()))return {error:"生年月日を確認してください",failure:"rejected"}
 if(!id&&clientId&&form.get("household_id")!==auth.context.householdId)return {error:"世帯が変わりました。元の保存結果を確認してください",failure:"rejected"}
 const values={name,birth_date:birthDate||null,sex:sex||null},target=id||clientId
 const write=async()=>{
  if(id){const {data,error}=await auth.context.supabase.from("children").update(values).eq("id",id).eq("household_id",auth.context.householdId).eq("updated_at",version).select("id,updated_at");return {data,error}}
  const {data,error}=await auth.context.supabase.from("children").insert({...values,household_id:auth.context.householdId,...(clientId?{id:clientId}:{})}).select("id,updated_at");return {data,error}
 }
 const {data,error}=await write()
 if(target&&((error&&error.code==="23505")||(!error&&!data?.length))){
  const {data:row,error:re}=await auth.context.supabase.from("children").select("id,name,birth_date,sex,updated_at").eq("id",target).eq("household_id",auth.context.householdId).maybeSingle()
  if(re)return {error:"保存結果を確認できませんでした。同じ操作で確認してください",failure:"unknown"}
  if(row&&row.name===values.name&&row.birth_date===values.birth_date&&row.sex===values.sex){revalidatePath("/","layout");return {success:true,updatedAt:row.updated_at,replayed:true}}
  return {error:"同じ識別子の子ども情報が先に保存されています。一覧の最新情報を確認してください",failure:"conflict",conflict:true}
 }
 if(error||!data?.length)return {error:"保存結果を確認できませんでした。同じ操作で確認してください",failure:error?failureKindOfDbError(error):"unknown"}
 revalidatePath("/","layout");return {success:true,updatedAt:data[0].updated_at}
}

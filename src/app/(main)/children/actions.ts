"use server"

import { cookies } from "next/headers"
import { revalidatePath } from "next/cache"
import { getAuthContext } from "@/lib/supabase/auth-context"
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

export async function saveChild(form: FormData) {
  const auth = await getAuthContext()
  if (auth.error !== null) return { error: auth.error }
  const name = String(form.get("name") ?? "").trim()
  const birthDate = String(form.get("birth_date") ?? "")
  const id = String(form.get("id") ?? "")
  const sex = String(form.get("sex") ?? "")
  if (!name || name.length > 100 || (id && !isClientId(id)) || !["", "female", "male"].includes(sex)) return { error: "入力を確認してください" }
  if (birthDate && (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || Number.isNaN(Date.parse(birthDate + "T00:00:00Z")) || new Date(birthDate + "T00:00:00Z").toISOString().slice(0,10) !== birthDate)) return { error: "生年月日を確認してください" }
  const values = { name, birth_date: birthDate || null, sex: sex || null }
  const write = async () => {
    if (id) {
      const { data, error } = await auth.context.supabase.from("children").update(values).eq("id",id).eq("household_id",auth.context.householdId).select("id")
      return { data, error }
    }
    const { data, error } = await auth.context.supabase.from("children").insert({ ...values, household_id: auth.context.householdId }).select("id")
    return { data, error }
  }
  const { data, error } = await write()
  if (error || !data?.length) return { error: "保存できませんでした。入力は残っています" }
  revalidatePath("/", "layout")
  return { success: true }
}

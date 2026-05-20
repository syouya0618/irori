"use server"

import { revalidatePath } from "next/cache"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"

/**
 * Supabase Storage に 'eating-out-photos' バケットが必要です。
 * Supabase Dashboard またはマイグレーションで作成してください:
 *
 * INSERT INTO storage.buckets (id, name, public)
 * VALUES ('eating-out-photos', 'eating-out-photos', true);
 *
 * RLS ポリシー例:
 * CREATE POLICY "Authenticated users can upload eating-out photos"
 *   ON storage.objects FOR INSERT
 *   TO authenticated
 *   WITH CHECK (bucket_id = 'eating-out-photos');
 *
 * CREATE POLICY "Public read access for eating-out photos"
 *   ON storage.objects FOR SELECT
 *   TO public
 *   USING (bucket_id = 'eating-out-photos');
 */

interface SaveEatingOutLogInput {
  mealId: string
  restaurantName: string | null
  memo: string | null
  rating: number | null
  photoUrl: string | null
}

export async function saveEatingOutLog(input: SaveEatingOutLogInput) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  // 対象の meal が自分の世帯に属するか確認
  const { data: meal, error: mealError } = await supabase
    .from("meals")
    .select("household_id")
    .eq("id", input.mealId)
    .single()

  if (mealError) {
    logSupabaseError("eating-out", "meal ownership check failed", mealError, {
      mealId: input.mealId,
    })
  }

  if (!meal || meal.household_id !== householdId) {
    return { error: "この献立の外食記録を編集する権限がありません。" }
  }

  // UPSERT: meal_id で既存があれば更新、なければ挿入
  const { error } = await supabase
    .from("eating_out_logs")
    .upsert({
      meal_id: input.mealId,
      restaurant_name: input.restaurantName || null,
      memo: input.memo || null,
      rating: input.rating || null,
      photo_url: input.photoUrl || null,
    }, { onConflict: "meal_id" })

  if (error) {
    return { error: "外食記録の保存に失敗しました。" }
  }

  revalidatePath("/meals")
  return { error: null }
}

export async function uploadPhoto(formData: FormData) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error, url: null }
  const { supabase, userId } = result.context

  const file = formData.get("file") as File | null
  const mealId = formData.get("mealId") as string | null

  if (!file || !mealId) {
    return { error: "ファイルまたは献立IDが不足しています。", url: null }
  }

  // ファイルサイズ上限チェック (5MB)
  if (file.size > 5 * 1024 * 1024) {
    return { error: "ファイルサイズが大きすぎます（上限5MB）。", url: null }
  }

  const ext = file.name.split(".").pop() ?? "jpg"
  const filePath = `${userId}/${mealId}-${Date.now()}.${ext}`

  const { error: uploadError } = await supabase.storage
    .from("eating-out-photos")
    .upload(filePath, file, {
      cacheControl: "3600",
      upsert: false,
    })

  if (uploadError) {
    return { error: "写真のアップロードに失敗しました。", url: null }
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from("eating-out-photos").getPublicUrl(filePath)

  return { error: null, url: publicUrl }
}

export async function getEatingOutLog(mealId: string) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error, data: null }
  const { supabase } = result.context

  // 外食ログ未記録は正常系ゆえ maybeSingle
  const { data, error: logError } = await supabase
    .from("eating_out_logs")
    .select("id, restaurant_name, memo, rating, photo_url")
    .eq("meal_id", mealId)
    .maybeSingle()

  if (logError) {
    logSupabaseError("eating-out", "eating out log lookup failed", logError, {
      mealId,
    })
  }

  return { error: null, data }
}

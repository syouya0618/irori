"use server"

import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { getAppOrigin } from "@/lib/utils/app-origin"
import { isFutureJstDate } from "@/lib/utils/date-jst"
import { logSupabaseError } from "@/lib/supabase/log-error"
import {
  FEEDING_INTERVAL_DEFAULT,
  normalizeFeedingInterval,
} from "@/lib/domain/baby-feeding-interval"
import {
  DIGEST_TIME_NONE,
  isDigestTimeSlot,
} from "@/lib/domain/notification-digest"

export async function updateProfile(formData: FormData) {
  const displayName = formData.get("display_name")

  if (typeof displayName !== "string" || displayName.trim().length === 0) {
    return { error: "表示名を入力してください" }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId } = result.context

  // .update() は 0 行更新でも error: null を返す（RLS で弾かれた・行が無い場合も
  // 「成功」に見える）。.select("id") で更新行を要求し silent fail を防ぐ。
  // profiles は列 GRANT で UPDATE を display_name/avatar_url/default_page に
  // 限っており（20260603000001）、SELECT は revoke されておらず profiles_select
  // が `id = auth.uid()` を許すため、自分の行の returning は通る。
  const { data, error } = await supabase
    .from("profiles")
    .update({ display_name: displayName.trim() })
    .eq("id", userId)
    .select("id")

  if (error) {
    logSupabaseError("settings", "profile update failed", error, { userId })
    return { error: "プロフィールの更新に失敗しました" }
  }
  if (!data || data.length === 0) {
    return { error: "プロフィールの更新に失敗しました" }
  }

  return { success: true }
}

export async function generateInvite() {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId, householdId } = result.context

  const { data: invitation, error } = await supabase
    .from("invitations")
    .insert({
      household_id: householdId,
      invited_by: userId,
      role: "member",
    })
    .select("token")
    .single()

  if (error || !invitation) {
    return { error: "招待リンクの生成に失敗しました" }
  }

  const baseUrl = getAppOrigin()
  const inviteUrl = `${baseUrl}/invite/${invitation.token}`

  return { success: true, url: inviteUrl }
}

export async function approveUser(targetUserId: string) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase } = result.context

  const { error } = await supabase.rpc("approve_user", {
    target_user_id: targetUserId,
  })

  if (error) {
    if (error.message.includes("Only owners")) {
      return { error: "承認権限がありません" }
    }
    return { error: "承認に失敗しました" }
  }

  return { success: true }
}

import { VALID_PAGES, type ValidPage } from "@/lib/constants/pages"
import type { ItemCategory } from "@/lib/types/database"

const VALID_STOCK_CATEGORIES: ItemCategory[] = [
  "baby", "cleaning", "hygiene", "other_daily",
]

export async function updateDefaultPage(page: string) {
  if (!VALID_PAGES.includes(page as ValidPage)) {
    return { error: "無効なページ指定です" }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId } = result.context

  // 0 行更新を「成功」と偽らない（updateProfile と同じ理由）。
  const { data, error } = await supabase
    .from("profiles")
    .update({ default_page: page })
    .eq("id", userId)
    .select("id")

  if (error) {
    logSupabaseError("settings", "default page update failed", error, { userId })
    return { error: "設定の更新に失敗しました" }
  }
  if (!data || data.length === 0) {
    return { error: "設定の更新に失敗しました" }
  }

  return { success: true }
}

export async function updateAutoStockCategories(categories: ItemCategory[]) {
  // バリデーション: 全てが有効なカテゴリであること
  const valid = categories.every((c) => VALID_STOCK_CATEGORIES.includes(c))
  if (!valid) {
    return { error: "無効なカテゴリが含まれています" }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  // 0 行更新を「成功」と偽らない（別世帯・RLS 拒否は 0 行マッチになる）。
  const { data, error } = await supabase
    .from("households")
    .update({ auto_stock_categories: categories })
    .eq("id", householdId)
    .select("id")

  if (error) {
    logSupabaseError("settings", "auto stock categories update failed", error, {
      householdId,
    })
    return { error: "設定の更新に失敗しました" }
  }
  if (!data || data.length === 0) {
    return { error: "設定の更新に失敗しました" }
  }

  return { success: true }
}

export async function updateBabyProfile(formData: FormData) {
  const babyName = formData.get("baby_name")
  const babyBirthDate = formData.get("baby_birth_date")
  const feedingIntervalRaw = formData.get("feeding_interval_min")

  if (typeof babyName !== "string") {
    return { error: "名前を入力してください" }
  }

  // 授乳間隔（分）。未送信時は既定を維持。範囲外・不正値は明確に弾く。
  let feedingIntervalValue = FEEDING_INTERVAL_DEFAULT
  if (typeof feedingIntervalRaw === "string" && feedingIntervalRaw.trim() !== "") {
    const normalized = normalizeFeedingInterval(Number(feedingIntervalRaw))
    if (normalized === null) {
      return { error: "授乳間隔の値が不正です" }
    }
    feedingIntervalValue = normalized
  }

  let birthDateValue: string | null = null
  if (typeof babyBirthDate === "string" && babyBirthDate.trim() !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(babyBirthDate)) {
      return { error: "生年月日の形式が不正です" }
    }
    // JST 基準で未来日を拒否する。DB 側 CHECK（chk_baby_birth_date）は
    // CURRENT_DATE（UTC）基準のため単独では JST 当日を弾く窓があるが、
    // その是正（CHECK の JST 化）は I-09a の migration 管轄。本 PR は
    // アプリ層で JST 未来日を先に弾き、明確な文言を返す。
    if (isFutureJstDate(babyBirthDate)) {
      return { error: "誕生日には今日以前の日付を指定してください" }
    }
    birthDateValue = babyBirthDate
  }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  // 0 行更新を「成功」と偽らない（別世帯・RLS 拒否は 0 行マッチになる）。
  const { data, error } = await supabase
    .from("households")
    .update({
      baby_name: babyName.trim() || null,
      baby_birth_date: birthDateValue,
      feeding_interval_min: feedingIntervalValue,
    })
    .eq("id", householdId)
    .select("id")

  if (error) {
    logSupabaseError("settings", "baby profile update failed", error, {
      householdId,
    })
    // 23514 = CHECK 制約違反（chk_baby_birth_date）。DB の CURRENT_DATE は
    // UTC 基準のため、JST 00:00〜08:59 に当日を登録すると UTC ではまだ前日で
    // baby_birth_date <= CURRENT_DATE を満たさず弾かれる。汎用文言に化けさせず
    // 誕生日起因と分かる文言を返す（DB 側 CHECK の JST 化は I-09a 管轄）。
    if (error.code === "23514") {
      return { error: "誕生日には今日以前の日付を指定してください" }
    }
    return { error: "赤ちゃん情報の更新に失敗しました" }
  }
  if (!data || data.length === 0) {
    return { error: "赤ちゃん情報の更新に失敗しました" }
  }

  return { success: true }
}

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect("/login")
}

/**
 * Google カレンダーの購読トグル（`google_calendar_subscriptions.is_selected`）。
 *
 * ## 認証済みクライアントで撃つ（service role ではない）
 * D-1 の migration は authenticated へ
 * `GRANT UPDATE (is_selected)` と世帯スコープの UPDATE ポリシーを与えておる。
 * ゆえに**利用者が触ってよい唯一の列**であり、RLS が世帯分離を守る。
 * ここに service role を持ち込めば、その保証を自分で捨てることになる。
 *
 * ## 選択列を明示する理由
 * `sync_token` / `sync_lease_until` は**秘密**で authenticated の列 GRANT の外に
 * ある。`.select("*")` は 42501 で落ちる（migration の COMMENT が名指ししておる）。
 *
 * ## 既知の穴（D-5 の担当・計画書 §D-2「ミラー掃除（V9）」）
 * **購読を OFF にしても `calendar_events` のミラー行は消えぬ。** 計画書は
 * 「他に同一 `google_calendar_id` を選択中の購読が無い場合にのみ明示 DELETE」を
 * 要求しておるが、あれは `calendar_events` の google 行を所有する同期エンジン
 * （D-5）の関心事ゆえ本 PR では実装せぬ。現状 OFF 直後はカレンダーに古い予定が
 * 残る。**握り潰しではなく未実装として報告済み。**
 */
export async function updateGoogleCalendarSelection(
  subscriptionId: string,
  isSelected: boolean,
) {
  if (typeof subscriptionId !== "string" || subscriptionId.trim().length === 0) {
    return { error: "カレンダーの指定が不正です" }
  }
  if (typeof isSelected !== "boolean") {
    return { error: "選択状態の指定が不正です" }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  // 0 行更新を「成功」と偽らない（別世帯・RLS 拒否は 0 行マッチになる）。
  // household_id の明示 `.eq()` は RLS と二重になるが、ポリシーが将来緩んでも
  // 世帯を跨がぬようにする防御じゃ。
  const { data, error } = await supabase
    .from("google_calendar_subscriptions")
    .update({ is_selected: isSelected })
    .eq("id", subscriptionId)
    .eq("household_id", householdId)
    .select("id")

  if (error) {
    logSupabaseError(
      "settings",
      "google calendar selection update failed",
      error,
      { subscriptionId, householdId },
    )
    return { error: "カレンダーの設定に失敗しました" }
  }
  if (!data || data.length === 0) {
    return { error: "カレンダーの設定に失敗しました" }
  }

  return { success: true }
}

/**
 * 毎朝のまとめ（B-5）の時刻を保存する。`"none"` は無効（`digest_time = NULL`）。
 *
 * ## 認証済みクライアントで撃つ（service role ではない）
 * `notification_preferences` は**ユーザー単位**で、RLS は `user_id = auth.uid()`、
 * 列 GRANT は `(user_id, event_default_minutes, digest_time)` の INSERT/UPDATE を
 * 認めておる（20260808100002）。ゆえに認証済みクライアントで足り、service role を
 * 持ち込めばその保証を自分で捨てることになる。
 *
 * ## ⚠️ upsert のペイロードに `event_default_minutes` を足すな
 * PostgREST の upsert は **送った列だけ**を `ON CONFLICT DO UPDATE SET` に並べる。
 * ゆえに 2 列だけ送れば、予定作成時の既定値（B-2 が同じ行に持っておる）は
 * そのまま残る。「全部入りの行」を送る形へ直すと、まとめの時刻を変えるたびに
 * 予定通知の既定が黙って消える。
 *
 * ## ⚠️ 選択肢の正本は `DIGEST_TIME_SLOTS` 1 つじゃ
 * 画面が出す集合と、ここで許す集合を別々に書けば必ずずれる（画面から選べるのに
 * 保存できぬ、が最も気付きにくい）。同じ配列を見ること。
 */
export async function updateDigestTime(value: string) {
  const isNone = value === DIGEST_TIME_NONE
  if (!isNone && !isDigestTimeSlot(value)) {
    return { error: "無効な時刻です" }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId } = result.context

  // TIME 列は "07:00" を 07:00:00 として受ける（読み出しは "07:00:00" で返るゆえ、
  // 画面側は `parseDigestTimeHm` で "HH:MM" へ戻す — 往復の要じゃ）。
  const { data, error } = await supabase
    .from("notification_preferences")
    .upsert(
      { user_id: userId, digest_time: isNone ? null : value },
      { onConflict: "user_id" },
    )
    .select("user_id")

  if (error) {
    logSupabaseError("settings", "digest time update failed", error, { userId })
    return { error: "通知の設定に失敗しました" }
  }
  // 0 行を「成功」と偽らない（upsert が RLS で弾かれても error にはならぬ経路がある）。
  if (!data || data.length === 0) {
    return { error: "通知の設定に失敗しました" }
  }

  revalidatePath("/settings")
  return { success: true }
}

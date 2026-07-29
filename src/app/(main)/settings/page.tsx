import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { getVerifiedUser } from "@/lib/supabase/verified-user"
import { PUMPING_INTERVAL_DEFAULT } from "@/lib/domain/baby-pumping"
import { SettingsContent } from "./settings-content"

export default async function SettingsPage() {
  const supabase = await createClient()

  // layout でも認証チェック済みだが、settings は独自に再フェッチするため
  // DB error 経路を個別に防御する。判定源は proxy と同じ（食い違い＝無限リダイレクト）。
  const verified = await getVerifiedUser(supabase, "settings")

  if (!verified) {
    redirect("/login")
  }
  const { userId, email } = verified

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, display_name, avatar_url, household_id, role, default_page")
    .eq("id", userId)
    .single()

  if (profileError) {
    logSupabaseError("settings", "profile lookup failed", profileError, {
      userId,
    })
  }

  if (profileError || !profile) {
    // error boundary (error.tsx) に委ねる
    throw new Error("プロフィールの取得に失敗しました")
  }

  if (!profile.household_id) {
    redirect("/setup")
  }

  const { data: household, error: householdError } = await supabase
    .from("households")
    .select(
      "id, name, auto_stock_categories, baby_name, baby_birth_date, pumping_interval_min",
    )
    .eq("id", profile.household_id)
    .single()

  if (householdError) {
    logSupabaseError("settings", "household lookup failed", householdError, {
      householdId: profile.household_id,
    })
  }

  // ownerのみ: 承認待ちユーザー取得
  let pendingUsers: { id: string; display_name: string; email: string; created_at: string }[] = []
  if (profile.role === "owner") {
    const { data, error: pendingError } = await supabase.rpc("get_pending_approvals")
    if (pendingError) {
      logSupabaseError("settings", "pending approvals lookup failed", pendingError, {
        householdId: profile.household_id,
      })
    }
    pendingUsers = data ?? []
  }

  return (
    <SettingsContent
      profile={{
        id: profile.id,
        displayName: profile.display_name,
        avatarUrl: profile.avatar_url,
        role: profile.role,
        defaultPage: profile.default_page ?? "meals",
      }}
      household={
        household
          ? { id: household.id, name: household.name }
          : null
      }
      autoStockCategories={
        (household?.auto_stock_categories as string[] | null) ?? ["baby", "cleaning", "hygiene"]
      }
      babyProfile={{
        name: household?.baby_name ?? null,
        birthDate: household?.baby_birth_date ?? null,
        pumpingIntervalMin:
          household?.pumping_interval_min ?? PUMPING_INTERVAL_DEFAULT,
      }}
      email={email ?? ""}
      pendingUsers={pendingUsers}
    />
  )
}

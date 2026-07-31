import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { getVerifiedUser } from "@/lib/supabase/verified-user"
import { FEEDING_INTERVAL_DEFAULT } from "@/lib/domain/baby-feeding-interval"
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

  // household と pending approvals rpc は互いに依存しないため並列化する。
  // ただし get_pending_approvals は owner だけが必要とするクエリのため、
  // 無条件に Promise.all へ入れると owner 以外も毎回 rpc を叩くことになる
  // (権限のないユーザーへの不要なクエリ発行を防ぐ)。ゆえに三項演算子で
  // owner 以外は実クエリを発行しない Promise.resolve に差し替えてから並列化する。
  const [
    { data: household, error: householdError },
    { data: pendingData, error: pendingError },
  ] = await Promise.all([
    supabase
      .from("households")
      .select(
        "id, name, auto_stock_categories, baby_name, baby_birth_date, feeding_interval_min",
      )
      .eq("id", profile.household_id)
      .single(),
    profile.role === "owner"
      ? supabase.rpc("get_pending_approvals")
      : Promise.resolve({ data: null, error: null }),
  ])

  if (householdError) {
    logSupabaseError("settings", "household lookup failed", householdError, {
      householdId: profile.household_id,
    })
  }

  // ownerのみ: 承認待ちユーザー取得
  let pendingUsers: { id: string; display_name: string; email: string; created_at: string }[] = []
  if (profile.role === "owner") {
    if (pendingError) {
      logSupabaseError("settings", "pending approvals lookup failed", pendingError, {
        householdId: profile.household_id,
      })
    }
    pendingUsers = pendingData ?? []
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
        feedingIntervalMin:
          household?.feeding_interval_min ?? FEEDING_INTERVAL_DEFAULT,
      }}
      email={email ?? ""}
      pendingUsers={pendingUsers}
    />
  )
}

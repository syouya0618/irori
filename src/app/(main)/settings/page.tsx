import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { getVerifiedUser } from "@/lib/supabase/verified-user"
import { FEEDING_INTERVAL_DEFAULT } from "@/lib/domain/baby-feeding-interval"
import { SettingsContent } from "./settings-content"

/**
 * `?google=<notice>` は OAuth callback（`/api/google/oauth/callback`）が付ける。
 *
 * **サーバ側で読んで prop で渡す**のが要点じゃ: client の `useSearchParams()` に
 * すると Suspense 境界の要否がページの静的/動的判定に依存し、境界を忘れた瞬間
 * build が落ちるか CSR bailout になる。この page は cookie 経由の認証で既に
 * 動的レンダリングゆえ、searchParams を読んでも新たな代償は無い。
 *
 * Next.js 16 では `searchParams` は **Promise** じゃ（await 必須）。
 * 一次情報: node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md
 * > "Since the `searchParams` prop is a promise. You must use `async/await` or
 * >  React's `use` function to access the values."
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const supabase = await createClient()

  const resolvedSearchParams = await searchParams
  const googleParam = resolvedSearchParams.google
  // `?google=a&google=b` は配列で来る。文字列以外は「通知なし」へ退化させる
  // （カード側も未知コードは何も出さぬ二重の防御）。
  const googleNotice = typeof googleParam === "string" ? googleParam : null

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
    { data: googleConnections, error: googleConnectionsError },
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
    // Google 接続は**ユーザー単位**（夫婦が各自 1 つずつ持つ）。切断できるのは
    // 本人だけ（RLS の DELETE は user_id = auth.uid()）ゆえ、カードには自分の
    // 接続だけを出す。世帯の SELECT ポリシーは配偶者の接続も見せるが、
    // 触れぬものを並べても操作の混乱を招くだけじゃ。
    supabase
      .from("google_connections")
      .select(
        "id, google_email, connection_status, sync_status, last_error_kind, last_synced_at",
      )
      .eq("user_id", userId)
      .order("created_at"),
  ])

  if (googleConnectionsError) {
    logSupabaseError(
      "settings",
      "google connections lookup failed",
      googleConnectionsError,
      { userId },
    )
  }

  // 購読は接続にぶら下がる。接続が無ければ問い合わせぬ（往復を増やさぬ）。
  // **`select("*")` は使えぬ**: sync_token / sync_lease_until は authenticated の
  // 列 GRANT の外にあり 42501 で落ちる（D-1 migration の COMMENT が名指し）。
  const connectionIds = (googleConnections ?? []).map((c) => c.id)
  let googleSubscriptions:
    | {
        id: string
        connection_id: string
        google_calendar_id: string
        summary: string | null
        is_selected: boolean
      }[]
    | null = null
  if (connectionIds.length > 0) {
    const { data: subscriptions, error: subscriptionsError } = await supabase
      .from("google_calendar_subscriptions")
      .select("id, connection_id, google_calendar_id, summary, is_selected")
      .in("connection_id", connectionIds)
      .order("google_calendar_id")

    if (subscriptionsError) {
      logSupabaseError(
        "settings",
        "google calendar subscriptions lookup failed",
        subscriptionsError,
        { userId, connectionCount: connectionIds.length },
      )
    }
    googleSubscriptions = subscriptions
  }

  const googleConnectionViews = (googleConnections ?? []).map((connection) => ({
    id: connection.id,
    googleEmail: connection.google_email,
    connectionStatus: connection.connection_status,
    syncStatus: connection.sync_status,
    lastErrorKind: connection.last_error_kind,
    lastSyncedAt: connection.last_synced_at,
    calendars: (googleSubscriptions ?? [])
      .filter((s) => s.connection_id === connection.id)
      .map((s) => ({
        id: s.id,
        googleCalendarId: s.google_calendar_id,
        summary: s.summary,
        isSelected: s.is_selected,
      })),
  }))

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
      googleConnections={googleConnectionViews}
      googleNotice={googleNotice}
    />
  )
}

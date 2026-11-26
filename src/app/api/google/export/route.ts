import { getAuthContext } from "@/lib/supabase/auth-context"
import { AUTH_DENIAL_HTTP_STATUS } from "@/lib/auth/auth-denial-status"
import { createAdminClient } from "@/lib/supabase/admin"
import { getGoogleExportStatus, manageGoogleExport } from "@/lib/google/export-sync"
import { isClientId } from "@/lib/utils/client-id"
import { googleSharingReady, GOOGLE_SHARING_NOT_READY } from "@/lib/google/sharing-ready"

export const maxDuration = 60
export const runtime = "nodejs"

async function handle(connectionId: unknown, action?: "enable" | "sync" | "stop") {
  const auth = await getAuthContext()
  if (auth.error !== null) return Response.json({ error: auth.error }, { status: AUTH_DENIAL_HTTP_STATUS[auth.reason] })
  if (typeof connectionId !== "string" || !isClientId(connectionId)) {
    return Response.json({ error: "接続の指定が不正です" }, { status: 400 })
  }
  const { supabase, userId, householdId } = auth.context
  if (!(await googleSharingReady(supabase))) return notReady()
  // Owner-only, even though ordinary import metadata is readable by household members.
  const { data, error } = await supabase.from("google_connections").select("id")
    .eq("id", connectionId).eq("user_id", userId).eq("household_id", householdId).maybeSingle()
  if (error) return Response.json({ error: "接続を確認できませんでした" }, { status: 503 })
  if (!data) return Response.json({ error: "接続が見つかりません" }, { status: 404 })
  try {
    const admin = createAdminClient()
    const owner = { connectionId, userId, householdId }
    const status = action ? await manageGoogleExport(admin, owner, action) : await getGoogleExportStatus(admin, owner)
    return Response.json({ status }, { headers: { "Cache-Control": "private, no-store" } })
  } catch {
    // Never expose token material, Google API response bodies or DB details to the browser.
    return Response.json({ error: "共有の状態を確認できませんでした。もう一度お試しください。" }, { status: 503 })
  }
}

function notReady() {
  return Response.json({ error: GOOGLE_SHARING_NOT_READY, code: "sharing_not_ready" }, { status: 503, headers: { "Cache-Control": "private, no-store" } })
}

export async function GET(request: Request) {
  return handle(new URL(request.url).searchParams.get("connectionId"))
}

export async function POST(request: Request) {
  // Cross-site forms cannot satisfy JSON content-type. No permissive CORS.
  if (request.headers.get("sec-fetch-site") === "cross-site" ||
      !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "不正なリクエストです" }, { status: 403 })
  }
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "操作の指定が不正です" }, { status: 400 })
  }
  const { connectionId, action } = body as Record<string, unknown>
  if (action !== "enable" && action !== "sync" && action !== "stop") {
    return Response.json({ error: "操作の指定が不正です" }, { status: 400 })
  }
  return handle(connectionId, action)
}

/** Disconnect the owner's account from irori, not from Google's other apps.
 * The DB trigger rejects active syncs and removes only unshared import mirrors.
 * Google-side calendars and events are never deleted by this operation.
 */
export async function DELETE(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site" ||
      !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "不正なリクエストです" }, { status: 403 })
  }
  const auth = await getAuthContext()
  if (auth.error !== null) return Response.json({ error: auth.error }, { status: AUTH_DENIAL_HTTP_STATUS[auth.reason] })
  const body: unknown = await request.json().catch(() => null)
  const connectionId = body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).connectionId : null
  if (typeof connectionId !== "string" || !isClientId(connectionId)) {
    return Response.json({ error: "接続の指定が不正です" }, { status: 400 })
  }
  const { supabase, userId, householdId } = auth.context
  if (!(await googleSharingReady(supabase))) return notReady()
  const { data, error } = await supabase.from("google_connections").delete()
    .eq("id", connectionId).eq("user_id", userId).eq("household_id", householdId).select("id").maybeSingle()
  if (error?.code === "55P03") return Response.json({ error: "同期中です。少し時間をおいて再試行してください。" }, { status: 409 })
  if (error) return Response.json({ error: "接続を解除できませんでした。" }, { status: 503 })
  if (!data) return Response.json({ error: "接続が見つかりません" }, { status: 404 })
  return Response.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } })
}

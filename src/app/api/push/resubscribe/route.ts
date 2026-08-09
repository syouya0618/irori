import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import {
  isAllowedPushEndpoint,
  summarizeUserAgent,
} from "@/lib/domain/push-endpoint"

/**
 * 購読の**再登録**（B-4）。Service Worker と起動時の突き合わせが共に叩く。
 *
 * ## なぜ Server Action ではなく Route Handler か
 * `pushsubscriptionchange` は Service Worker のイベントじゃ。SW は React の
 * 実行文脈を持たぬゆえ Server Action を呼べぬ（RSC のプロトコルに乗らぬ）。
 * SW の `fetch` は同一オリジンなら cookie を運ぶため、**セッション認証の
 * Route Handler** が唯一の橋になる。B-1 の Server Action
 * （`settings/push-actions.ts`）はブラウザ側 UI 専用として残す。
 *
 * ## ⚠️ このパスを `isPublicRoute` へ足すな
 * `src/proxy.ts` の `isPublicRoute` は `/api/cron/` ただ一つで、あれは
 * 「cookie を持たぬ pg_net からの GET」ゆえの例外じゃ。ここは**誰の購読か**を
 * cookie でしか決められぬ。public にした瞬間、`auth.uid()` が NULL になり
 * `upsert_push_subscription` が 28000 で落ちる（＝ 恒久的に再登録できぬ）。
 *
 * ## ⚠️ 呼び出し側は `res.ok` を成功と読んではならぬ
 * proxy の承認ゲートはセッション切れを `/login` へ 307 する。fetch が既定で
 * それを追うと **HTML の 200** になり `res.ok` は true じゃ。ゆえにこの route は
 * 成功時に必ず `{"ok":true}` の JSON を返し、呼び出し側はその形を確かめる
 * （`public/sw.js` の `isResubscribeAccepted`、`lib/pwa/push-reconcile.ts`）。
 *
 * ## 冪等性
 * 中身は `upsert_push_subscription`（B-1）ただ 1 本ゆえ、何度呼んでも増えぬ。
 * 起動時の突き合わせが**同じ endpoint で呼び直す**のはこの性質に依る。
 */

// Supabase の SSR クライアント（cookie）と RPC を使う。web-push は呼ばぬ
// （ここは登録だけ。送信は cron の仕事じゃ）。
export const runtime = "nodejs"

interface ResubscribeInput {
  endpoint: string
  p256dh: string
  auth: string
  userAgent: string | null
  oldEndpoint: string | null
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

/**
 * 入力の検証。**B-1 の Server Action と同じ規則**を保つこと
 * （SSRF allowlist と DB の CHECK に合わせた長さ上限）。
 * 片方だけ緩めれば、緩い側が唯一の入口になる。
 */
function parseInput(raw: unknown): { input: ResubscribeInput } | { error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { error: "購読情報が不正です。" }
  }
  const source = raw as Record<string, unknown>
  const endpoint = readString(source, "endpoint")
  const p256dh = readString(source, "p256dh")
  const auth = readString(source, "auth")
  if (!endpoint || !p256dh || !auth) return { error: "購読情報が不足しています。" }

  // SSRF / open relay 対策。web-push は宛先を検証せず素直に撃つゆえ、
  // 登録の時点で allowlist に通しておくのが唯一の防御じゃ。
  if (!isAllowedPushEndpoint(endpoint)) {
    return { error: "この端末の通知サービスには対応していません。" }
  }
  // DB の CHECK と同じ上限（落ちる前にアプリ側で理由を出す）。
  if (endpoint.length > 2048) return { error: "購読情報が長すぎます。" }
  if (p256dh.length > 255 || auth.length > 255) {
    return { error: "購読情報が長すぎます。" }
  }

  const oldEndpointRaw = readString(source, "oldEndpoint")
  // 旧 endpoint は**掃除のためだけ**に使う。不正な値でも新しい登録は成立させる
  // （検証に落ちたら「掃除せぬ」へ退化する — 登録ごと失敗させては本末転倒じゃ）。
  const oldEndpoint =
    oldEndpointRaw &&
    oldEndpointRaw !== endpoint &&
    oldEndpointRaw.length <= 2048 &&
    isAllowedPushEndpoint(oldEndpointRaw)
      ? oldEndpointRaw
      : null

  return {
    input: {
      endpoint,
      p256dh,
      auth,
      userAgent: readString(source, "userAgent"),
      oldEndpoint,
    },
  }
}

export async function POST(request: Request) {
  const result = await getAuthContext()
  if (result.error !== null) {
    // 未認証・未承認は**再試行に値する**（セッションを取り直せば通る）。
    // ここで購読を消すような真似はせぬ。
    return new Response("Unauthorized", { status: 401 })
  }
  const { supabase, userId } = result.context

  let raw: unknown
  try {
    raw = await request.json()
  } catch (err) {
    console.error("[push-resubscribe] body を JSON として読めませんでした", {
      userId,
      message: err instanceof Error ? err.message : String(err),
    })
    return new Response("Bad Request", { status: 400 })
  }

  const parsed = parseInput(raw)
  if ("error" in parsed) {
    // ⚠️ endpoint はログに出さぬ（送信能力そのものゆえ）。理由だけ。
    console.error("[push-resubscribe] 購読情報の検証に失敗", {
      userId,
      reason: parsed.error,
    })
    return new Response("Bad Request", { status: 400 })
  }
  const { input } = parsed

  // 書込は SECURITY DEFINER RPC 1 本のみ（列 GRANT も RLS も INSERT を許さぬ）。
  // 共用端末で持ち主が変わった場合の付け替えも RPC 側が担う。
  const { error: rpcError } = await supabase.rpc("upsert_push_subscription", {
    p_endpoint: input.endpoint,
    p_p256dh: input.p256dh,
    p_auth: input.auth,
    // ⚠️ 省くと `ON CONFLICT ... SET user_agent = EXCLUDED.user_agent` が
    // 既存の端末名を NULL で潰し、設定カードが全部「不明な端末」になる。
    p_user_agent: summarizeUserAgent(input.userAgent),
  })
  if (rpcError) {
    logSupabaseError("push-resubscribe", "購読の再登録に失敗", rpcError, { userId })
    return new Response("Resubscribe failed", { status: 500 })
  }

  // 旧 endpoint の掃除は**登録の後**じゃ。先に消して登録に失敗すると、
  // ブラウザには生きた購読が在るのに DB には 1 行も無い状態が残る。
  //
  // ここが失敗しても **200 を返す** — 主の目的（新しい端末で通知が届くこと）は
  // 既に達しており、残った古い行は次の送信で 410 になって掃除される。
  if (input.oldEndpoint) {
    const { error: deleteError } = await supabase.rpc(
      "delete_my_push_subscription",
      { p_endpoint: input.oldEndpoint },
    )
    if (deleteError) {
      logSupabaseError(
        "push-resubscribe",
        "旧 endpoint の掃除に失敗（登録自体は成功）",
        deleteError,
        { userId },
      )
    }
  }

  // ⚠️ **必ず JSON で返す。** 呼び出し側は `res.ok` ではなくこの形を見る
  // （proxy の 307 → HTML 200 と区別する唯一の手段じゃ）。
  return Response.json({ ok: true })
}

"use server"

/**
 * Web Push の購読まわりの Server Action（B-1）。
 *
 * ⚠️ `"use server"` ファイルからは **async 関数以外を export してはならぬ**
 * （Turbopack が全 export を async 関数と期待し、定数を出すとビルドが壊れる。
 * `tsc --noEmit` では検出できず `next build` でのみ発覚する）。
 * 定数・型は `@/lib/domain/push-endpoint` 等の中立モジュールへ置く。
 *
 * ## service role を使わぬ設計
 *
 * `push_subscriptions` の `(endpoint, p256dh, auth)` は列 GRANT で
 * authenticated から隠してある。ゆえに「自分の購読を DB から読んで送る」には
 * service role が要るが、`admin.ts` の契約は Server Action を呼び出し元として
 * 認めておらぬ（OAuth callback / 同期エンジン / cron ハンドラの 3 つのみ）。
 *
 * → **クライアントが自分の購読を渡し、登録してから同じ宛先へ送る**形にした。
 * 所有権は「たった今 `upsert_push_subscription` で自分のものとして登録した」
 * ことで構成上保証される。DB からの読み出しが要らぬゆえ service role も要らぬ。
 * 配信ジョブ（B-3）は cron ハンドラゆえ、そちらでは正規に service role を使う。
 */

import { revalidatePath } from "next/cache"
import webpush from "web-push"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import {
  isAllowedPushEndpoint,
  summarizeUserAgent,
} from "@/lib/domain/push-endpoint"

interface SavePushSubscriptionInput {
  endpoint: string
  p256dh: string
  auth: string
  userAgent?: string | null
}

type ActionResult = { error: string | null }

/**
 * VAPID 設定。3 つ揃わねば null を返す（fail-closed）。
 *
 * ⚠️ 公開鍵は `NEXT_PUBLIC_VAPID_PUBLIC_KEY` **1 変数に統一する**。サーバ用と
 * クライアント用に 2 本持つと、食い違った時に**無音で全配信が落ちる**。
 * env は `?.trim()` で読む（ペースト時の末尾改行混入が過去 4 回再発しておる）。
 */
function readVapidConfig(): {
  publicKey: string
  privateKey: string
  subject: string
} | null {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim()
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim()
  const subject = process.env.VAPID_SUBJECT?.trim()
  if (!publicKey || !privateKey || !subject) return null
  return { publicKey, privateKey, subject }
}

function validateSubscriptionInput(
  input: SavePushSubscriptionInput,
): string | null {
  if (!input.endpoint || !input.p256dh || !input.auth) {
    return "購読情報が不足しています。"
  }
  // SSRF / open relay 対策。ここが唯一の防御ゆえ、登録の前に弾く。
  if (!isAllowedPushEndpoint(input.endpoint)) {
    return "この端末の通知サービスには対応していません。"
  }
  // DB の CHECK と同じ上限。落ちる前にアプリ側で理由を出す。
  if (input.endpoint.length > 2048) return "購読情報が長すぎます。"
  if (input.p256dh.length > 255 || input.auth.length > 255) {
    return "購読情報が長すぎます。"
  }
  return null
}

/**
 * 購読を登録し、その端末へテスト通知を 1 通送る。
 *
 * 登録と送信を 1 つの Action にまとめてあるのは、これが**通知が本当に届くかを
 * 確かめる唯一の手段**だからじゃ。設定画面で「有効にした」と表示しても、実際に
 * 端末へ届くかは送ってみるまで分からぬ（iOS はホーム画面 PWA 限定、権限は
 * ブラウザ設定で個別に切られうる）。押した人がその場で結果を見られる形にする。
 */
export async function savePushSubscriptionAndSendTest(
  input: SavePushSubscriptionInput,
): Promise<ActionResult> {
  const validationError = validateSubscriptionInput(input)
  if (validationError) return { error: validationError }

  const vapid = readVapidConfig()
  if (!vapid) {
    console.error("[push] VAPID env が未設定", {
      hasPublic: Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY),
      hasPrivate: Boolean(process.env.VAPID_PRIVATE_KEY),
      hasSubject: Boolean(process.env.VAPID_SUBJECT),
    })
    return { error: "通知の設定が未完了です（管理者に連絡してください）。" }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId } = result.context

  // 書込は SECURITY DEFINER RPC 1 本のみ（列 GRANT も RLS ポリシーも INSERT を
  // 許しておらぬ）。共用端末で持ち主が変わった場合の付け替えも RPC 側が担う。
  const { error: rpcError } = await supabase.rpc("upsert_push_subscription", {
    p_endpoint: input.endpoint,
    p_p256dh: input.p256dh,
    p_auth: input.auth,
    p_user_agent: summarizeUserAgent(input.userAgent),
  })
  if (rpcError) {
    logSupabaseError("push", "購読の登録に失敗", rpcError, { userId })
    return { error: "通知の登録に失敗しました。" }
  }

  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey)
  try {
    await webpush.sendNotification(
      {
        endpoint: input.endpoint,
        keys: { p256dh: input.p256dh, auth: input.auth },
      },
      JSON.stringify({
        title: "irori",
        body: "通知の準備ができました。",
        url: "/settings",
        tag: "push-test",
      }),
      // Apple は TTL ヘッダを必須とする（正の数）。
      { TTL: 60 },
    )
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "statusCode" in error
        ? (error as { statusCode?: number }).statusCode
        : undefined
    // ⚠️ ペイロードと endpoint 全体はログに出さぬ（endpoint は送信能力そのもの）。
    console.error("[push] テスト通知の送信に失敗", {
      status,
      userId,
      message: error instanceof Error ? error.message : String(error),
    })
    return {
      error: `登録はできましたが、テスト通知を送れませんでした（${status ?? "不明"}）。`,
    }
  }

  revalidatePath("/settings")
  return { error: null }
}

/**
 * サインアウト時に、この端末の購読を解除する。
 *
 * 購読は**ブラウザ単位**ゆえ、放置すると旧ユーザー宛の通知が新しい利用者の端末へ
 * 届く（`sw.js` の `PURGE_HOUSEHOLD_CACHES` が「1 台を複数ユーザーが使う」脅威を
 * 既に認めておるのと同じ筋）。ブラウザ側の `unsubscribe()` と対で呼ぶこと。
 *
 * **失敗してもサインアウトを止めてはならぬ**ゆえ、常に成功として返す
 * （購読が残っても、ブラウザ側で unsubscribe 済みなら送信は 410 になり B-4 が掃除する）。
 */
export async function unsubscribeCurrentDevice(
  endpoint: string,
): Promise<ActionResult> {
  if (!endpoint) return { error: null }

  const result = await getAuthContext()
  if (result.error !== null) return { error: null }
  const { supabase, userId } = result.context

  const { error } = await supabase.rpc("delete_my_push_subscription", {
    p_endpoint: endpoint,
  })
  if (error) {
    logSupabaseError("push", "サインアウト時の購読解除に失敗", error, { userId })
  }
  return { error: null }
}

/**
 * 自分の端末の登録を解除する。
 *
 * RLS の DELETE ポリシー（`user_id = auth.uid()`）が他人の行を守るため、
 * id だけ受け取れば足りる。0 行削除でも `error: null` が返る仕様ゆえ、
 * 削除できたことを `.select("id")` で確かめる。
 */
export async function deletePushSubscription(
  subscriptionId: string,
): Promise<ActionResult> {
  if (!subscriptionId) return { error: "端末が指定されていません。" }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId } = result.context

  const { data, error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("id", subscriptionId)
    // 列 GRANT ゆえ `select("*")` は落ちる。返す列は必ず明示する。
    .select("id")

  if (error) {
    logSupabaseError("push", "購読の解除に失敗", error, {
      userId,
      subscriptionId,
    })
    return { error: "通知の解除に失敗しました。" }
  }
  // `.delete()` は 0 行でも error: null を返す（既知の罠）。行数で確かめる。
  if (!data || data.length === 0) {
    return { error: "対象の端末が見つかりませんでした。" }
  }

  revalidatePath("/settings")
  return { error: null }
}

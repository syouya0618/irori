import { getAuthContext } from "@/lib/supabase/auth-context"
// 拒否理由 → HTTP status（UX-03）。401 はログインし直せば直る時だけ（PDF・JSON と同じ 1 表）
import { AUTH_DENIAL_HTTP_STATUS } from "@/lib/auth/auth-denial-status"
import { createAdminClient } from "@/lib/supabase/admin"
import { syncHousehold } from "@/lib/google/sync"

/**
 * 明示トリガ（計画書 §7 D-4「明示トリガ」）。設定カードの「今すぐ同期」から呼ぶ。
 *
 * ## 認可は **session**（`getAuthContext`）。`CRON_SECRET` は使わぬ
 * このパスは `/api/cron/` 配下ではないゆえ `src/proxy.ts` の承認ゲートを通る
 * ＝それが正しい。cron の secret をここでも受けると、secret を知る者が
 * 世帯を指定して同期を撃てるようになり、cron の防壁が横展開されてしまう。
 *
 * 世帯 ID は**リクエストから取らぬ**。`getAuthContext()` が返す
 * `householdId` だけを使う（body で受けると世帯跨ぎの同期を撃たれる）。
 *
 * ## 本文を一切読まぬのは意図じゃ（D-4 と D-5 の統合時の判断）
 * D-4 は当初この殻に `connectionId` の UUID 検証を持たせておったが、同期エンジン
 * （`syncHousehold`）は世帯単位でしか動かず、その値を消費する経路が無い。
 * **何も消費せぬ入力を検証するのは、受け付ける契約が在るかのように見せる分だけ
 * 有害じゃ**。「この接続だけ同期する」が要るようになった時に、エンジン側の対応と
 * 同じ PR で足すこと。
 */

// 世帯内の全接続 × 購読ぶんの Google 往復を直列に回すため既定より長く取る。
export const maxDuration = 60

export async function POST() {
  const result = await getAuthContext()
  if (result.error !== null) {
    // lookup-failed の真因は getAuthContext が構造化ログに残し済み。
    return new Response(result.error, {
      status: AUTH_DENIAL_HTTP_STATUS[result.reason],
    })
  }
  const { householdId } = result.context

  try {
    // 認可を通した**後**にのみ service role を生成する（`admin.ts` の契約）。
    const supabase = createAdminClient()
    const summary = await syncHousehold(supabase, householdId)
    return Response.json({ ok: true, summary })
  } catch (err) {
    console.error("[api-google-sync] 同期に失敗", {
      householdId,
      message: err instanceof Error ? err.message : String(err),
    })
    return new Response("Sync failed", { status: 500 })
  }
}

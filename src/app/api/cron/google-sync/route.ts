import { timingSafeEqual } from "node:crypto"
import { createAdminClient } from "@/lib/supabase/admin"
import { syncAllHouseholds } from "@/lib/google/sync"

/**
 * Google カレンダー同期の**バックストップ** cron（計画書 §7 D-4 / V8）。
 *
 * オンデマンド同期（`maybeScheduleSync`）はカレンダーページを開いた時だけ走る。
 * 誰も開かぬ日でも 1 日 1 回は差分を取り込むための保険じゃ。
 *
 * ## スケジュール（`vercel.json` は JSON ゆえコメントを書けぬ。仕様はここに置く）
 * `{ "path": "/api/cron/google-sync", "schedule": "0 21 * * *" }`
 * = **UTC 21:00 = JST 06:00**（朝いちで前日ぶんの差分が入っておる状態にする）。
 * **Hobby プランで毎時式（`0 * * * *`）はデプロイが失敗する**（1 日 1 回まで）。
 *
 * ## V8【致命的・実機検証済み】proxy と本ハンドラは**不可分**
 * `src/proxy.ts` の matcher は `/api/` を除外しておらず、Vercel Cron は
 * **cookie を持たぬ GET** を送る。ゆえに無印のままでは未認証と判定されて
 * `/login` へ 307 され、**このハンドラには一度も到達せぬ**（テストは緑・本番は
 * 100% 不発）。`proxy.ts` の `isPublicRoute` に `/api/cron/` を足すのと、
 * 下の fail-closed な `CRON_SECRET` 検証は、**必ず同じ変更で入れること**。
 * 片方だけ入れると cron が無認証で開く。
 *
 * 検証は Route Handler の直接 import では足りぬ（proxy を通らぬ）。dev サーバへ
 * `fetch(url, { redirect: "manual" })` して 307 が返らぬことを見よ。
 */

// service role クライアントと node:crypto を使うため Node.js ランタイム固定。
export const runtime = "nodejs"
/**
 * 世帯数 × 購読数ぶんの Google 往復を直列に回すため、既定より長く取る。
 * `SYNC_LEASE_MS`（120 秒）はこの値の倍で、走行中の実行を別実行が追い越さぬ
 * ようにしてある（`sync.ts` の定数注記）。
 */
export const maxDuration = 60

/**
 * `timingSafeEqual` は**長さ不一致で throw する**（`RangeError`）。
 * 先に長さを比較して短絡させること。長さの漏洩は許容する（秘密の長さは
 * 内容ではない）が、throw を catch し損ねて 500 を返すのは避ける。
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * Vercel Cron は **GET** を送る（POST だけ定義すると 405 で不発になる）。
 */
export async function GET(request: Request) {
  // env は `?.trim()` で防御（ペースト時の末尾改行混入が過去に 4 回再発）。
  const secret = process.env.CRON_SECRET?.trim()

  // fail-closed: 未設定なら**誰も通さぬ**。proxy の承認ゲートを意図的に外した
  // 経路ゆえ、ここが唯一の防壁じゃ。「未設定なら素通し」にすると cron URL を
  // 知る者が誰でも service role の同期を叩ける。
  if (!secret) {
    console.error("[cron-google-sync] CRON_SECRET 未設定のため拒否")
    return new Response("Unauthorized", { status: 401 })
  }

  const provided =
    request.headers.get("authorization")?.replace(/^Bearer\s+/, "") ?? ""
  if (!safeEqual(provided, secret)) {
    console.error("[cron-google-sync] CRON_SECRET が一致しません")
    return new Response("Unauthorized", { status: 401 })
  }

  try {
    // service role は認可を通した**後**にのみ生成する（`admin.ts` の契約 3）。
    const supabase = createAdminClient()
    const result = await syncAllHouseholds(supabase)
    console.log("[cron-google-sync] 同期完了", {
      households: result.households,
    })
    return Response.json({
      ok: true,
      households: result.households,
      summaries: result.summaries,
    })
  } catch (err) {
    // 握り潰さぬ。cron の失敗は誰も見ておらぬため、ログが唯一の証跡じゃ。
    console.error("[cron-google-sync] 同期に失敗", {
      message: err instanceof Error ? err.message : String(err),
    })
    return new Response("Sync failed", { status: 500 })
  }
}

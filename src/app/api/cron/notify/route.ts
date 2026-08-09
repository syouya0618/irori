import { timingSafeEqual } from "node:crypto"
import { createAdminClient } from "@/lib/supabase/admin"
import { deliverDueNotifications } from "@/lib/notifications/deliver"

/**
 * 通知の配信ジョブ（B-3）。**毎朝ダイジェスト（B-5）もこの 1 本が担う。**
 *
 * ダイジェストへ別の cron を足さぬのは、あれが「その日ぶんのキュー行を先に立てて
 * `scheduled_at <= now()` で拾う」形＝予定通知と同じ規律に乗っておるからじゃ
 * （`deliver.ts` の冒頭を見よ）。別経路にすれば、取りこぼしの拾い直しと
 * 二重通知の防止をもう一組作ることになる。
 *
 * ## スケジュールは `vercel.json` ではなく **pg_cron** じゃ
 * Vercel Hobby の cron は**1 日 1 回まで**で、5 分ごとの式はデプロイごと失敗する
 * （`google-sync` が 1 日 1 回なのはそれゆえ）。通知は 5 分粒度で回さねば
 * 「10 分前」が守れぬため、Supabase 側の pg_cron から `net.http_post` で叩く。
 * 登録手順は `docs/runbooks/notify-cron.md`（Vault の secret はローカルにも CI にも
 * 無いゆえ、migration にすると pgTAP で検証できぬ「緑でも赤でも意味を持たぬ」
 * テストが増えるだけになる）。
 *
 * ## secret は `CRON_SECRET` と**別値**にせよ
 * pg_net は Authorization ヘッダを **DB のキューテーブルに保存する**
 * （`net.http_request_queue` / `net._http_response`）。つまり Dashboard から
 * 読める場所に秘密が滞留する。`google-sync` と同じ値を使えば、その滞留 1 つで
 * 両方の cron が開く。→ `NOTIFY_CRON_SECRET`。
 *
 * ## V8【致命的・実機検証済み】proxy と本ハンドラは**不可分**
 * `src/proxy.ts` の matcher は `/api/` を除外しておらぬ。cookie を持たぬ GET は
 * 未認証と判定されて `/login` へ 307 され、**ハンドラに到達せぬ**（テストは緑・
 * 本番は 100% 不発）。`isPublicRoute` は既に `/api/cron/` を通しておるゆえ本 PR で
 * proxy へ手を入れる必要は無いが、**その一行に依存しておることは忘れるな** —
 * 恒久的な機械検査は `e2e/cron-routes-auth.spec.ts` が持つ。
 */

// service role クライアント・node:crypto・web-push（Node の crypto に依る）を使う。
export const runtime = "nodejs"
/**
 * 世帯数 × 購読数ぶんの push 往復を直列に回すため、既定より長く取る。
 * 1 通あたりのタイムアウトは 10 秒（`send-push.ts`）ゆえ、最悪でも 6 通で使い切る。
 * それでも取りこぼした行は**キューに残り次の実行が拾う** — 撃ちっぱなしにせず
 * キューにした甲斐がここに出る。
 */
export const maxDuration = 60

/**
 * `timingSafeEqual` は**長さ不一致で throw する**（`RangeError`）。
 * 先に長さを比較して短絡させること。
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * pg_net の `net.http_post` は **GET を送れる**が、既定は POST じゃ。
 * runbook は GET で登録する（`google-sync` と揃える）。POST だけを定義すると
 * 405 で無音の不発になるため、GET を必ず置く。
 */
export async function GET(request: Request) {
  // env は `?.trim()` で防御（ペースト時の末尾改行混入が過去 4 回再発）。
  const secret = process.env.NOTIFY_CRON_SECRET?.trim()

  // fail-closed: 未設定なら**誰も通さぬ**。proxy の承認ゲートを意図的に外した
  // 経路ゆえ、ここが唯一の防壁じゃ。
  //
  // ⚠️ `CRON_SECRET` への**フォールバックを足すな**。「未設定なら google-sync の
  // 値で通す」は親切に見えて、上に書いた鍵の分離を無言で無効化する。
  if (!secret) {
    console.error("[cron-notify] NOTIFY_CRON_SECRET 未設定のため拒否")
    return new Response("Unauthorized", { status: 401 })
  }

  const provided =
    request.headers.get("authorization")?.replace(/^Bearer\s+/, "") ?? ""
  if (!safeEqual(provided, secret)) {
    console.error("[cron-notify] NOTIFY_CRON_SECRET が一致しません")
    return new Response("Unauthorized", { status: 401 })
  }

  try {
    // service role は認可を通した**後**にのみ生成する（`admin.ts` の契約 3）。
    const supabase = createAdminClient()
    const result = await deliverDueNotifications(supabase)
    // ⚠️ 予定のタイトルも endpoint も出さぬ。数だけ。
    console.log("[cron-notify] 配信完了", {
      scheduled: result.scheduled,
      sent: result.sent,
      skipped: result.skipped,
      failed: result.failed,
    })
    return Response.json(result)
  } catch (err) {
    // 握り潰さぬ。cron の失敗は誰も見ておらぬため、ログが唯一の証跡じゃ。
    // （心拍は `deliverDueNotifications` の finally が既に書いておる。）
    console.error("[cron-notify] 配信に失敗", {
      message: err instanceof Error ? err.message : String(err),
    })
    return new Response("Notify failed", { status: 500 })
  }
}

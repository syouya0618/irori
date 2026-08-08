/**
 * Web Push の送信（サーバ側・B-3）。
 *
 * ⚠️ **ログに endpoint 全体とペイロードを出さぬこと。**
 * endpoint は VAPID 秘密鍵と併せて「その端末へ任意の通知を送る能力そのもの」じゃ
 * （B-1 の migration が列 GRANT から外しておるのと同じ理由）。ペイロードには
 * 予定のタイトルが載る — 家庭の予定名を Vercel のログへ落としてはならぬ。
 * ゆえにこのモジュールは**自分では一切ログを出さず**、呼び出し側へ
 * 「status と、host だけに丸めた宛先」を返す。
 */

import webpush, { WebPushError } from "web-push"

/** 送り先（`push_subscriptions` の秘密 3 列）。 */
export interface PushTarget {
  endpoint: string
  p256dh: string
  auth: string
}

export interface VapidConfig {
  publicKey: string
  privateKey: string
  subject: string
}

export type PushSendResult =
  | { ok: true }
  /**
   * `gone` は 404 / 410 — **購読が恒久的に消えた**という push サービスの宣言じゃ。
   * ここだけが購読を削除してよい合図で、他は全て再試行側へ倒す
   * （CLAUDE.md「再試行は広く、破棄は狭く」。401/403 を破棄側に混ぜると、
   * VAPID の設定ミス 1 つで全端末の購読が消し飛ぶ）。
   */
  | { ok: false; gone: boolean; status: number | null; message: string }

/**
 * VAPID 設定。3 つ揃わねば null（fail-closed）。
 *
 * ⚠️ 公開鍵は `NEXT_PUBLIC_VAPID_PUBLIC_KEY` **1 変数**じゃ。サーバ用と
 * クライアント用に 2 本持つと、食い違った時に**無音で全配信が落ちる**。
 * env は `?.trim()` で読む（ペースト時の末尾改行混入が過去 4 回再発しておる）。
 *
 * NOTE: `settings/push-actions.ts` にも同型の private な読み取りが在る。
 * あちらは `"use server"` ファイルゆえ**非 async の export を持てぬ**
 * （Turbopack が `next build` で落ちる）。共通化は B-1 側へ手を入れることになり
 * 「1 PR = 1 関心事」を割るため、本 PR では**意図的に据え置く**。
 * 変数名は 3 つとも同じゆえ、片方だけ直せば必ず気付く形にはなっておる。
 */
export function readVapidConfig(): VapidConfig | null {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim()
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim()
  const subject = process.env.VAPID_SUBJECT?.trim()
  if (!publicKey || !privateKey || !subject) return null
  return { publicKey, privateKey, subject }
}

/**
 * push サービスへの送信タイムアウト（ms）。
 *
 * 外部 API 呼び出しにタイムアウトは必須じゃ（CLAUDE.md）。cron の
 * `maxDuration` を 1 台の沈黙で食い潰させぬため、10 秒で切る。
 * web-push の `timeout` は**ソケットのタイムアウト**であって応答全体の期限では
 * ないが、push サービスの応答は数バイトゆえ実質の上限として働く。
 */
const PUSH_TIMEOUT_MS = 10_000

/**
 * 1 通送る。**例外を投げず結果を返す** — 1 台の失敗で世帯の残りを止めぬため。
 *
 * `vapidDetails` を**呼び出しごとに渡す**のは意図的じゃ。`setVapidDetails()` は
 * モジュールスコープの global を書き換えるゆえ、並行リクエストで競合しうる
 * （pdfmake の `setFonts()` で既に踏んだ轍。CLAUDE.md の既知の罠）。
 */
export async function sendPushNotification(
  target: PushTarget,
  vapid: VapidConfig,
  payload: unknown,
): Promise<PushSendResult> {
  try {
    await webpush.sendNotification(
      {
        endpoint: target.endpoint,
        keys: { p256dh: target.p256dh, auth: target.auth },
      },
      JSON.stringify(payload),
      {
        // Apple は TTL ヘッダを必須とする（正の数）。grace window と揃えて
        // 15 分: 端末が圏外の間に期限が切れても、遅れて雪崩れるより良い。
        TTL: 900,
        vapidDetails: vapid,
        timeout: PUSH_TIMEOUT_MS,
      },
    )
    return { ok: true }
  } catch (error) {
    // WebPushError は `endpoint` を**フィールドに持つ**。error をそのまま
    // 呼び出し側へ返すと、素直な `console.error(err)` で endpoint が漏れる。
    // ここで status と message だけに削ぎ落とす。
    if (error instanceof WebPushError) {
      return {
        ok: false,
        gone: error.statusCode === 404 || error.statusCode === 410,
        status: error.statusCode,
        message: error.message,
      }
    }
    return {
      ok: false,
      // 通信断・タイムアウトは**恒久的失敗ではない**。次の実行で再試行させる。
      gone: false,
      status: null,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

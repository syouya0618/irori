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
   * ここだけが購読を削除してよい合図で、他で購読を消してはならぬ
   * （CLAUDE.md「破棄は狭く」。401/403 を破棄側に混ぜると、VAPID の設定ミス
   * 1 つで全端末の購読が消し飛ぶ）。
   *
   * ⚠️ **「その配信行を再送するか」は別の判断じゃ** —— `gone` でないこと（＝
   * 購読を消さぬこと）は再送してよいことを意味せぬ。そちらは
   * {@link isProvenNotDelivered} が at-most-once の向きで決める。
   */
  | { ok: false; gone: boolean; status: number | null; message: string }

/**
 * ★ **購読を削除してよい status の allowlist（B-4）。**
 *
 * この集合の**外**に出た瞬間、被害は非対称に跳ね上がる:
 *   - 狭すぎた（漏らした）→ 死んだ購読が DB に残る。cron が毎回 1 回失敗し、
 *     `failure_count` が積み上がって設定カードに出る。**回復可能**。
 *   - 広すぎた（4xx を一括で恒久扱いにした）→ VAPID 設定ミスや一時的な認可
 *     エラー 1 つで**全端末の購読が消し飛び、通知が永久に止まる**。復旧には主が
 *     各端末を開いて登録し直すしかない。**不可逆**。
 *
 * ゆえにここは blocklist（`>= 400 && < 500` 等）で書いてはならぬ。
 * `send-push.test.ts` が **100..599 を総なめして集合そのものを** `{404, 410}` と
 * 突き合わせる（1 件ずつの見本テストでは blocklist への書き換えを捕まえられぬ）。
 *
 * RFC 8030 §7.3 は購読の失効を 404 / 410 で表すと定めており、実際の挙動も
 * FCM が 404 と 410 の両方を返す（410 だけに絞ると FCM の失効を取りこぼす）。
 *
 * ⚠️ **{@link isProvenNotDelivered}（行を再送するか）と混ぜるな。** あちらは
 * status の**有無**だけを見る別の判断で、この集合とは交わらぬ
 * —— 購読の生死と、その 1 通を再び送るかは別の問いじゃ。
 */
export const PUSH_GONE_STATUSES: ReadonlySet<number> = new Set([404, 410])

/**
 * ★ **再送してよいのは「確実に届いておらぬ」と証明できる失敗だけ**（at-most-once）。
 *
 * ## なぜ「怪しきは再送」ではなく「怪しきは落とす」なのか
 * 送信の失敗には**届いたか分からぬ**ものが在る（ソケットタイムアウト —— push
 * サービスは受理したのに応答だけが落ちた、が有りうる）。ここで再送に倒すと
 * 同じ通知が二度鳴る。**Safari は可視通知の雪崩で権限そのものを剥奪する**
 * （Apple 公式）ゆえ、重複は「1 通落とす」より高くつく —— 落ちるのはその 1 通
 * じゃが、剥奪されればその端末の通知が**全て**止まり、主が設定から入り直すまで
 * 戻らぬ。`claimAndSend` の docstring が最初から宣言しておる割り切りに、実装を
 * 揃えたものじゃ。
 *
 * ## 判定は allowlist の向き（証明の責は再送側に在る）
 * RFC 8030 §5 では push サービスは**受理を 2xx（201）で表す**。ゆえに status が
 * 返っておるということは、サービスが我々の要求を見て**明示的に拒んだ**という
 * ことじゃ ＝ 届いておらぬことの証明になる。status が無い（例外に status が
 * 付かぬ）失敗は「応答を一度も見ておらぬ」ゆえ証明が無い → 落とす。
 *
 * ⚠️ **DNS 解決失敗や `ECONNREFUSED` も、この向きでは道連れに落ちる。**
 * それらは実際には「確実に届いておらぬ」側じゃが、`PushSendResult` は今
 * Node のエラーコードを運んでおらぬゆえ、タイムアウトと**区別できぬ**。
 * 区別できぬものを再送側へ入れれば allowlist が blocklist に化ける。
 * コードを運んで取り戻すのは**意図して据え置く**（B-3 の関心事ではない）。
 *
 * ⚠️ **`>= 400` 等の範囲比較や「gone でなければ再送」に書き換えるな。** 後者は
 * denylist ゆえ、新しい失敗の形が増えるたび**既定で再送側へ落ちる**。
 */
export function isProvenNotDelivered(result: PushSendResult): boolean {
  if (result.ok) return false
  // `typeof` で見る。`result.status !== null` では、将来 undefined が混ざった時に
  // 「証明あり」へ倒れる（欠落は証明ではない）。
  return typeof result.status === "number"
}

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
        // ⚠️ **範囲比較で書き換えるな**（`>= 400 && < 500` は 401/403/429 を
        // 破棄側へ引きずり込む）。判定は allowlist の集合参照ただ 1 つに保つ。
        gone: PUSH_GONE_STATUSES.has(error.statusCode),
        status: error.statusCode,
        message: error.message,
      }
    }
    return {
      ok: false,
      // 購読は消さぬ（通信断・タイムアウトは購読の失効ではない）。
      gone: false,
      // ⚠️ **`status: null` は「応答を一度も見ておらぬ」の印じゃ。**
      // ここへ既定値の数字を置くな —— {@link isProvenNotDelivered} がこの null を
      // 「届いておらぬ証明が無い」と読んで再送を止めておる。数字を置けば、
      // 届いたか分からぬ通知が二度鳴る側へ黙って倒れる。
      status: null,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

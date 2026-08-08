/**
 * サインアウト時にこの端末の push 購読を畳む。
 *
 * 購読は**ブラウザ単位**ゆえ、放置すると旧ユーザー宛の通知が新しい利用者の端末へ
 * 届く。`sw.js` の `PURGE_HOUSEHOLD_CACHES`（世帯データ入りキャッシュの破棄）が
 * 「1 台を複数ユーザーが使う」脅威を既に認めておるのと同じ筋じゃ。
 *
 * ## 順序が load-bearing
 *
 * **サーバ側の解除を先に、ブラウザ側の `unsubscribe()` を後に**行う。
 * 逆にすると endpoint を失った後にサーバへ何を渡せばよいか分からなくなる。
 *
 * ## 失敗してもサインアウトを止めぬ
 *
 * 圏外・権限切れ等で落ちても握る。ブラウザ側の `unsubscribe()` さえ通れば
 * push サービス側の購読が消え、以後の送信は 410 になる（＝旧ユーザー宛の通知は
 * 新しい利用者へ届かぬ）。残った DB 行は B-4 の失効処理が掃除する。
 */
export async function unsubscribePushForSignOut(
  unsubscribeOnServer: (endpoint: string) => Promise<unknown>,
): Promise<void> {
  try {
    // `window` ではなく `globalThis` を見る。ページ文脈では両者は同一で、
    // こちらなら node のテストからも同じ経路を通せる（分岐が実装と食い違わぬ）。
    if (
      typeof navigator === "undefined" ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in globalThis)
    ) {
      return
    }
    const registration = await navigator.serviceWorker.getRegistration()
    if (!registration) return
    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) return

    // サーバが先。endpoint を失う前に消す。
    await unsubscribeOnServer(subscription.endpoint)
    await subscription.unsubscribe()
  } catch (err) {
    // サインアウトは止めぬ。理由は残す（握り潰し禁止）。
    console.warn("[push] サインアウト時の購読解除に失敗:", err)
  }
}

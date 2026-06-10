/**
 * Service Worker (public/sw.js) へのメッセージ送信ユーティリティ
 *
 * メッセージ type 定数は public/sw.js 側の文字列リテラルと手動同期すること
 * (sw.js は classic script のため import を共有できない)。
 */

/** documents / rsc キャッシュ (世帯データ入り) の破棄を指示するメッセージ type */
export const SW_MESSAGE_PURGE_HOUSEHOLD_CACHES = "PURGE_HOUSEHOLD_CACHES"

/** 最後にログインしたユーザー ID を保持する localStorage キー */
export const LAST_USER_ID_STORAGE_KEY = "irori-last-user-id"

/** SW からの ack を待つ上限。超過しても resolve し、ログアウト等をブロックしない */
const PURGE_ACK_TIMEOUT_MS = 1500

/**
 * SW に世帯データ入りキャッシュ (documents / rsc) の破棄を依頼する。
 *
 * - SW 未対応 / 未制御 (controller なし) なら即 resolve
 * - MessageChannel の ack か 1500ms タイムアウトで必ず resolve する
 *   (reject しない — 呼び出し元のログアウト処理を決してブロックしないため)
 */
export function purgeHouseholdCaches(): Promise<void> {
  return new Promise((resolve) => {
    if (
      typeof navigator === "undefined" ||
      !("serviceWorker" in navigator) ||
      !navigator.serviceWorker.controller
    ) {
      resolve()
      return
    }

    const channel = new MessageChannel()
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      channel.port1.close()
      resolve()
    }

    const timer = setTimeout(() => {
      console.warn("[sw-messages] purge の ack がタイムアウトしました (続行します)")
      settle()
    }, PURGE_ACK_TIMEOUT_MS)

    channel.port1.onmessage = settle

    try {
      navigator.serviceWorker.controller.postMessage(
        { type: SW_MESSAGE_PURGE_HOUSEHOLD_CACHES },
        [channel.port2]
      )
    } catch (err) {
      console.warn("[sw-messages] purge メッセージ送信に失敗:", err)
      settle()
    }
  })
}

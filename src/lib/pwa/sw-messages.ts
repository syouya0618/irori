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
 * 世帯データ入りキャッシュの名前。public/sw.js の `CACHE_NAMES.documents` /
 * `CACHE_NAMES.rsc`（`irori-<版>-documents` / `irori-<版>-rsc`）と同じ形じゃ。
 * 版を問わず拾うのは、CACHE_VERSION を上げた直後の旧版も前の世帯のデータゆえ。
 * 綻びは sw-logic.test.ts が CACHE_NAMES との一致を assert して殺しておる。
 */
const HOUSEHOLD_CACHE_NAME = /^irori-[^-]+-(documents|rsc)$/

/** static / images / precache・他アプリのキャッシュは false（個人データを持たぬ） */
export function isHouseholdCacheName(name: string): boolean {
  return HOUSEHOLD_CACHE_NAME.test(name)
}

/**
 * ページから Cache API を直に叩いて破棄する。CacheStorage は SW と同じ origin の
 * 保存領域ゆえ、SW が未制御（ハードリロード直後など）でも消せる。
 * 確かめられた時だけ true。Cache API が無い・投げた時は false。
 */
async function purgeFromPage(): Promise<boolean> {
  if (typeof caches === "undefined" || !caches) return false
  try {
    const names = await caches.keys()
    await Promise.all(
      names.filter(isHouseholdCacheName).map((name) => caches.delete(name)),
    )
    return true
  } catch (err) {
    console.warn("[sw-messages] ページからのキャッシュ破棄に失敗:", err)
    return false
  }
}

/**
 * SW に破棄を依頼し、`{ ok: true }` の ack を待つ（補助経路）。
 * 未制御・ack が ok でない・タイムアウト・送信失敗は false。reject はせぬ。
 */
function purgeViaServiceWorker(): Promise<boolean> {
  return new Promise((resolve) => {
    const controller =
      typeof navigator !== "undefined" && "serviceWorker" in navigator
        ? navigator.serviceWorker.controller
        : null
    if (!controller) {
      resolve(false)
      return
    }

    const channel = new MessageChannel()
    let settled = false
    const settle = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      channel.port1.close()
      resolve(ok)
    }

    const timer = setTimeout(() => {
      console.warn("[sw-messages] purge の ack がタイムアウトしました (続行します)")
      settle(false)
    }, PURGE_ACK_TIMEOUT_MS)

    // ack の中身を読む: SW は失敗時に { ok: false } を返す（届いたこと≠消えたこと）
    channel.port1.onmessage = (event: MessageEvent) => {
      const data: unknown = event.data
      settle(
        typeof data === "object" &&
          data !== null &&
          (data as { ok?: unknown }).ok === true,
      )
    }

    try {
      controller.postMessage({ type: SW_MESSAGE_PURGE_HOUSEHOLD_CACHES }, [
        channel.port2,
      ])
    } catch (err) {
      console.warn("[sw-messages] purge メッセージ送信に失敗:", err)
      settle(false)
    }
  })
}

/**
 * 世帯データ入りキャッシュ (documents / rsc) を破棄し、**破棄を確かめられたか**を返す。
 *
 * - ページからの直接破棄と SW への依頼を並べて走らせ、どちらかが確かめられれば true
 * - どちらも確かめられねば false（SW 未対応・未制御・ack 無し・Cache API の失敗）
 * - reject はせぬ（呼び出し元のログアウト処理を決してブロックしないため）
 *
 * ⚠️ 呼び出し側は **true の時だけ** LAST_USER_ID を消す／書き換えること。確かめずに
 * 消せば、破棄が空振りした時に次の利用者の CacheUserGuard まで黙り、前の世帯の
 * HTML / RSC がオフラインで読めたまま残る（P2-24）。
 */
export function purgeHouseholdCaches(): Promise<boolean> {
  return new Promise((resolve) => {
    let remaining = 2
    const report = (ok: boolean) => {
      if (ok) {
        // 先に確かめた方で足りる（SW の ack 待ちでログアウトを遅らせぬ）
        resolve(true)
        return
      }
      remaining -= 1
      if (remaining === 0) resolve(false)
    }
    purgeFromPage().then(report, () => report(false))
    purgeViaServiceWorker().then(report, () => report(false))
  })
}

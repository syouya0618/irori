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
 * 世帯キャッシュの持ち主を置くキャッシュとキー。public/sw.js の `CACHE_NAMES.meta` /
 * `CACHE_OWNER_KEY` と**手動同期**（綻びは sw-logic.test.ts が一致を assert して殺す）。
 * キーはネットワークへは出ぬ（Cache API のキーとしてだけ使う）。
 *
 * 持ち主の記録は「この端末で今オフライン閲覧を許す利用者」じゃ（CacheUserGuard が書き、
 * ログアウト・利用者の交代で消す）。SW は応答の主（→ CACHE_OWNER_RESPONSE_HEADER）が
 * この記録と一致する HTML / RSC だけを保存し、主が今の記録と一致する項目だけを配る。
 */
export const CACHE_OWNER_CACHE_NAME = "irori-meta"
export const CACHE_OWNER_KEY = "/__irori/cache-owner"

/**
 * 応答の主（検証済みの user id）を運ぶ応答ヘッダ。src/proxy.ts が承認ゲートを通った
 * 素通し応答にだけ載せる。public/sw.js の `CACHE_OWNER_HEADER` と**手動同期**。
 * 主をクライアントの記録から推すと、セッションが破棄なしで終わった後（他端末からの
 * サインアウト・失効）に次の利用者の着地 HTML が前の利用者の名で保存される — ゆえに
 * 主はサーバが決める。ヘッダの無い応答を SW は保存せぬ（fail-closed）。
 */
export const CACHE_OWNER_RESPONSE_HEADER = "x-irori-cache-owner"

/**
 * 世帯キャッシュの持ち主を今の利用者にする（CacheUserGuard が (main) に入るたびに呼ぶ）。
 * ページから Cache API を直に叩く（SW が未制御でも書ける）。書けた時だけ true。reject はせぬ。
 */
export async function setCacheOwner(userId: string): Promise<boolean> {
  if (typeof caches === "undefined" || !caches) return false
  try {
    const meta = await caches.open(CACHE_OWNER_CACHE_NAME)
    await meta.put(
      CACHE_OWNER_KEY,
      new Response(userId, { headers: { "content-type": "text/plain; charset=utf-8" } }),
    )
    return true
  } catch (err) {
    console.warn("[sw-messages] 世帯キャッシュの持ち主を書けず:", err)
    return false
  }
}

/**
 * 世帯キャッシュの持ち主の記録を消す（以後 SW は世帯キャッシュを保存も配信もせぬ）。
 * ログアウトの**成功**の直後に呼ぶ（settings-content / pending-content）。破棄
 * （purgeHouseholdCaches）は signOut の前に記録を消しておるが、signOut の往復の間に
 * 別タブが (main) を開き直すと、その CacheUserGuard は鍵（LAST_USER_ID）がまだ前の
 * 利用者ゆえ「同じ利用者」と見て破棄せず、持ち主を前の利用者へ**書き戻す**。成功の
 * redirect は Server Action の応答に乗る SPA 遷移で、SW の nav-passthrough（/login に
 * 着いた時に記録を消す経路）を通らぬゆえ、ここで消さねば記録が残る（独立レビュー r4）。
 * cookie はもう消えておるゆえ、新しい利用者の記録を誤って消すことは無い。
 * 消せた時だけ true。reject はせぬ。
 */
export async function clearCacheOwner(): Promise<boolean> {
  if (typeof caches === "undefined" || !caches) return false
  try {
    const meta = await caches.open(CACHE_OWNER_CACHE_NAME)
    await meta.delete(CACHE_OWNER_KEY)
    return true
  } catch (err) {
    console.warn("[sw-messages] 世帯キャッシュの持ち主の記録を消せず:", err)
    return false
  }
}

/**
 * ページから Cache API を直に叩いて破棄する。CacheStorage は SW と同じ origin の
 * 保存領域ゆえ、SW が未制御（ハードリロード直後など）でも消せる。
 * 持ち主の記録を**先に**消す（以後 SW は世帯キャッシュを保存も配信もせぬ）。消してから
 * 破棄するゆえ、破棄の最中・後に届いた前の利用者の応答は保存されず、残っても配られぬ。
 * 両方を確かめられた時だけ true。Cache API が無い・投げた時は false。
 */
async function purgeFromPage(): Promise<boolean> {
  if (typeof caches === "undefined" || !caches) return false
  try {
    const meta = await caches.open(CACHE_OWNER_CACHE_NAME)
    await meta.delete(CACHE_OWNER_KEY)
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
 * どちらの経路も、持ち主の記録を先に消してから破棄する（→ purgeFromPage）。
 *
 * - ページからの直接破棄と SW への依頼を並べて走らせ、どちらかが確かめられれば true
 * - どちらも確かめられねば false（SW 未対応・未制御・ack 無し・Cache API の失敗）
 * - **両方の決着を待ってから返す。** 先に確かめた方で返すと、走り続ける SW 側の「持ち主の
 *   記録の削除・破棄」が、呼び出し側（CacheUserGuard）が直後に書いた新しい持ち主と
 *   新しい項目を後から消しうる。SW の ack 待ちは PURGE_ACK_TIMEOUT_MS で打ち切るゆえ、
 *   ログアウトが遅れても高々その時間じゃ
 * - reject はせぬ（呼び出し元のログアウト処理を決してブロックしないため）
 *
 * ⚠️ 呼び出し側は **true の時だけ** LAST_USER_ID を消す／書き換えること。確かめずに
 * 消せば、破棄が空振りした時に次の利用者の CacheUserGuard まで黙り、前の世帯の
 * HTML / RSC がオフラインで読めたまま残る（P2-24）。
 */
export async function purgeHouseholdCaches(): Promise<boolean> {
  const [fromPage, viaServiceWorker] = await Promise.all([
    purgeFromPage().catch(() => false),
    purgeViaServiceWorker().catch(() => false),
  ])
  return fromPage || viaServiceWorker
}

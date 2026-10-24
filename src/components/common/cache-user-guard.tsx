"use client"

import { useEffect } from "react"
import {
  purgeHouseholdCaches,
  setCacheOwner,
  LAST_USER_ID_STORAGE_KEY,
} from "@/lib/pwa/sw-messages"
import { clearPersistedTimer } from "@/lib/domain/feeding-timer-storage"

/**
 * 別ユーザーでのログインを検知して世帯データ入り SW キャッシュを破棄する (render なし)。
 *
 * 同一端末でユーザー B がログインした際、ユーザー A の世帯の HTML / RSC キャッシュが
 * オフライン閲覧で漏れるのを防ぐ。(main) レイアウト配下でのみマウントされるため、
 * userId は常に認証済みユーザーの ID。
 *
 * あわせて世帯キャッシュの持ち主を今の利用者にする（setCacheOwner）。SW は持ち主のタグが
 * 一致する項目しか配らぬゆえ、破棄の後に届いた前の利用者の応答も、破棄に失敗して残った
 * 前の利用者の項目も、今の利用者には配られぬ。
 */
export function CacheUserGuard({ userId }: { userId: string }) {
  useEffect(() => {
    let cancelled = false

    const run = async () => {
      let previousUserId: string | null = null
      try {
        previousUserId = localStorage.getItem(LAST_USER_ID_STORAGE_KEY)
      } catch (err) {
        // localStorage 不可 (プライベートモード等) でも続行する
        console.warn("[cache-user-guard] localStorage 読み取りに失敗:", err)
      }

      let purged = true
      if (previousUserId && previousUserId !== userId) {
        // 前の利用者の授乳タイマーが端末に残っておれば消す（P3-08。タイマー側の持ち主
        // 判定と二重の防御 — 旧形式の保存は持ち主を持たぬため、ここでしか消えぬ）
        clearPersistedTimer()
        // purgeHouseholdCaches は reject しない (破棄を確かめられたかを boolean で返す)。
        // 持ち主の記録を先に消してから破棄する
        purged = await purgeHouseholdCaches()
      }

      // ログアウト等で (main) を離れた後に、持ち主を書き戻さぬ
      if (cancelled) return
      // 持ち主は破棄の成否に**従属させず**今の利用者へ書く。破棄に失敗した時こそ要る —
      // 書かねば持ち主の記録が前の利用者のまま残りうり、残った前の利用者の項目がタグ照合を
      // 素通りして今の利用者に配られる。書けば前の利用者の項目はタグが合わず配られぬ。
      if (!(await setCacheOwner(userId))) {
        console.warn(
          "[cache-user-guard] 世帯キャッシュの持ち主を書けず（この端末ではオフライン用に保存されぬ）",
        )
      }
      if (!purged) {
        // 確かめられぬまま鍵を今の ID へ書き換えれば、次のマウントでは「同じ利用者」に
        // 見えて二度と破棄を試みぬ。前の ID を残し、次のマウントで再び試みる (P2-24)。
        console.warn(
          "[cache-user-guard] 前の利用者のキャッシュ破棄を確認できず。前の ID を残して次回に再試行する",
        )
        return
      }

      if (cancelled) return
      try {
        localStorage.setItem(LAST_USER_ID_STORAGE_KEY, userId)
      } catch (err) {
        console.warn("[cache-user-guard] localStorage 書き込みに失敗:", err)
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [userId])

  return null
}

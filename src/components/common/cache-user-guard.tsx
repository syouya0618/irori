"use client"

import { useEffect } from "react"
import {
  purgeHouseholdCaches,
  LAST_USER_ID_STORAGE_KEY,
} from "@/lib/pwa/sw-messages"
import { clearPersistedTimer } from "@/lib/domain/feeding-timer-storage"

/**
 * 別ユーザーでのログインを検知して世帯データ入り SW キャッシュを破棄する (render なし)。
 *
 * 同一端末でユーザー B がログインした際、ユーザー A の世帯の HTML / RSC キャッシュが
 * オフライン閲覧で漏れるのを防ぐ。(main) レイアウト配下でのみマウントされるため、
 * userId は常に認証済みユーザーの ID。
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

      if (previousUserId && previousUserId !== userId) {
        // 前の利用者の授乳タイマーが端末に残っておれば消す（P3-08。タイマー側の持ち主
        // 判定と二重の防御 — 旧形式の保存は持ち主を持たぬため、ここでしか消えぬ）
        clearPersistedTimer()
        // purgeHouseholdCaches は reject しない (破棄を確かめられたかを boolean で返す)
        const purged = await purgeHouseholdCaches()
        if (!purged) {
          // 確かめられぬまま鍵を今の ID へ書き換えれば、次のマウントでは「同じ利用者」に
          // 見えて二度と破棄を試みぬ。前の ID を残し、次のマウントで再び試みる (P2-24)。
          console.warn(
            "[cache-user-guard] 前の利用者のキャッシュ破棄を確認できず。前の ID を残して次回に再試行する",
          )
          return
        }
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

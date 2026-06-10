"use client"

import { useEffect } from "react"
import {
  purgeHouseholdCaches,
  LAST_USER_ID_STORAGE_KEY,
} from "@/lib/pwa/sw-messages"

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
        // purgeHouseholdCaches は reject しない (ack or タイムアウトで必ず resolve)
        await purgeHouseholdCaches()
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

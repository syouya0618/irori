"use client"

import { useEffect } from "react"

/** public/sw.js の PREFIX と手動同期 */
const SW_CACHE_PREFIX = "irori-"

/**
 * Service Worker の登録・更新・開発時掃除を担う (render なし)。
 *
 * - production: /sw.js を登録し、タブが visible に戻るたびに update() を試みる
 *   (iOS PWA はプロセスが長期常駐し、自動更新チェックが走りにくいため)
 * - development: 既存の SW 登録と irori-* キャッシュを全削除する。
 *   `pnpm start` での検証後に同一オリジンの `next dev` が SW に汚染され、
 *   古いアセットを掴み続ける事故を防ぐ (必須の防御)。
 */
export function ServiceWorkerManager() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return

    if (process.env.NODE_ENV === "production") {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .catch((err) => {
          console.warn("[sw-manager] Service Worker の登録に失敗:", err)
        })

      const onVisibilityChange = () => {
        if (document.visibilityState !== "visible") return
        navigator.serviceWorker
          .getRegistration()
          .then((registration) => registration?.update())
          .catch((err) => {
            console.warn("[sw-manager] Service Worker の更新確認に失敗:", err)
          })
      }
      document.addEventListener("visibilitychange", onVisibilityChange)
      return () => {
        document.removeEventListener("visibilitychange", onVisibilityChange)
      }
    }

    // ── development: prod 検証で残った SW とキャッシュの掃除 ──
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) =>
        Promise.all(registrations.map((registration) => registration.unregister()))
      )
      .catch((err) => {
        console.warn("[sw-manager] dev: SW の unregister に失敗:", err)
      })

    if ("caches" in window) {
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((key) => key.startsWith(SW_CACHE_PREFIX))
              .map((key) => caches.delete(key))
          )
        )
        .catch((err) => {
          console.warn("[sw-manager] dev: キャッシュ削除に失敗:", err)
        })
    }
  }, [])

  return null
}

"use client"

import { useEffect, useRef } from "react"

/**
 * Screen Wake Lock API を使って画面点灯を維持する。
 * active=true で取得、false で解放。
 * タブ非表示で自動解放されるため、visibilitychange で再取得する。
 */
export function useWakeLock(active: boolean) {
  const lockRef = useRef<WakeLockSentinel | null>(null)

  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return

    let cancelled = false

    async function acquire() {
      try {
        const lock = await navigator.wakeLock.request("screen")
        if (cancelled) {
          lock.release()
          return
        }
        lockRef.current = lock
      } catch {
        // 権限拒否やバッテリーセーバー時は無視
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible" && !cancelled) {
        acquire()
      }
    }

    acquire()
    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      lockRef.current?.release()
      lockRef.current = null
    }
  }, [active])
}

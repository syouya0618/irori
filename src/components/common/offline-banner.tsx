"use client"

import { useSyncExternalStore } from "react"
import { WifiOff } from "lucide-react"

function subscribe(callback: () => void) {
  window.addEventListener("online", callback)
  window.addEventListener("offline", callback)
  return () => {
    window.removeEventListener("online", callback)
    window.removeEventListener("offline", callback)
  }
}

function getSnapshot() {
  return navigator.onLine
}

// SSR 時はオンライン扱い (バナー非表示) で hydration を安定させる
function getServerSnapshot() {
  return true
}

/**
 * オフライン時のみ画面上部に表示するバナー。
 * mount / unmount のみで切り替え (transition 系クラスは使わない)。
 */
export function OfflineBanner() {
  const isOnline = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  if (isOnline) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex justify-center px-4 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
      <div
        role="status"
        className="glass-subtle flex items-center gap-2 rounded-2xl px-4 py-2.5 shadow-lg shadow-black/[0.04]"
      >
        <WifiOff className="size-4 shrink-0 text-amber-600" aria-hidden="true" />
        <p className="text-xs font-medium text-foreground">
          オフラインです。表示中の内容は最新でない可能性があります
        </p>
      </div>
    </div>
  )
}

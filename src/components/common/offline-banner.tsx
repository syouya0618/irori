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

/** 1 行目（e2e/offline.spec.ts の OFFLINE_BANNER_TEXT と手動同期） */
export const OFFLINE_BANNER_TEXT = "オフラインです。表示中の内容は最新でない可能性があります"
/** 2 行目: できぬことを正直に（端末の通信表示はヒントにすぎぬことも言う） */
export const OFFLINE_BANNER_DETAIL =
  "この間は記録の保存や家族との共有ができません（端末の通信表示による判定です）"

/**
 * オフライン時のみ画面上部に表示するバナー。
 * mount / unmount のみで切り替え (transition 系クラスは使わない)。
 *
 * `navigator.onLine` は**ヒント**じゃ: false は「端末が通信できぬと言っておる」だけで、true でも
 * サーバへ届く保証は無い（captive portal・電波の弱い場所）。ゆえにバナーは false の時だけ出し、
 * 出ておらぬことを「保存できる」「同期済み」の根拠にせぬ（保存の確定はサーバの応答だけが示す）。
 * 認可の取消し（ログアウト・世帯からの除外）は圏外では検知できぬゆえ、ここでは触れぬ。
 */
export function OfflineBanner() {
  const isOnline = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  if (isOnline) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex justify-center px-4 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
      <div
        role="status"
        className="glass-subtle flex items-start gap-2 rounded-2xl px-4 py-2.5 shadow-lg shadow-black/[0.04]"
      >
        <WifiOff className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="flex flex-col gap-0.5">
          <p className="text-xs font-medium text-foreground">{OFFLINE_BANNER_TEXT}</p>
          <p className="text-xs text-muted-foreground">{OFFLINE_BANNER_DETAIL}</p>
        </div>
      </div>
    </div>
  )
}

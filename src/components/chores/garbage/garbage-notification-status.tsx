"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Bell, BellOff, ChevronRight, CircleHelp, Loader2 } from "lucide-react"
import {
  DEVICE_CHECK_TIMEOUT_MS,
  thisDeviceStateOf,
  type ThisDeviceState,
} from "@/lib/domain/push-device-state"

/**
 * ごみの前日通知に関わる、**この端末**の通知の状態（設定画面の通知カードと同じ判定）。
 *
 * - **ここでは権限を求めぬ**。権限の要求と端末の登録は、設定画面のボタンを利用者が押した時に
 *   だけ行う（開いただけで許可のダイアログを出さぬ）。ここは今の状態を言い、設定へ案内する
 * - 未対応 / 未許可 / 拒否 / 登録済みを区別して言う。「登録済み」でも**実際に届くことは保証
 *   せぬ**（端末側の設定・電波・OS の都合がある）旨を添える
 * - 通知は世帯の全員の登録済みの端末へ送られる（ごみだけの個人別の ON/OFF は無い）
 */
const STATE_TEXT: Record<ThisDeviceState, { title: string; body: string; ok: boolean | null }> = {
  checking: { title: "この端末の通知の状態を確認しています", body: "", ok: null },
  "check-failed": {
    title: "この端末の通知の状態を確認できませんでした",
    body: "画面を再読み込みするか、設定の「通知」で確かめてください。",
    ok: null,
  },
  unconfigured: {
    title: "通知の設定が未完了です",
    body: "このアプリの通知の準備ができていません。管理者に連絡してください。",
    ok: false,
  },
  unsupported: {
    title: "この開き方では通知を受け取れません",
    body: "iPhone の場合は、ホーム画面に追加してから開き直すと受け取れるようになります。",
    ok: false,
  },
  denied: {
    title: "この端末では通知が拒否されています",
    body: "ブラウザ（または端末）の設定から許可し直してください。このアプリからは戻せません。",
    ok: false,
  },
  "not-asked": {
    title: "この端末ではまだ通知を受け取っていません",
    body: "設定の「通知」で許可すると、この端末でも受け取れます。",
    ok: false,
  },
  "granted-unsubscribed": {
    title: "通知は許可済みですが、この端末はまだ登録されていません",
    body: "設定の「通知」でこの端末を登録すると、受け取れます。",
    ok: false,
  },
  subscribed: {
    title: "この端末は通知を受け取る登録が済んでいます",
    body: "実際に届くかは端末の設定や通信の状態にもよります。届き方は設定の「通知」の端末一覧で確かめられます。",
    ok: true,
  },
}

export function GarbageNotificationStatus() {
  const vapid = Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim())
  const [supported, setSupported] = useState<boolean | null>(null)
  const [permission, setPermission] = useState<NotificationPermission | null>(null)
  const [subscribedHere, setSubscribedHere] = useState(false)
  const [checkTimedOut, setCheckTimedOut] = useState(false)

  // setState は promise のコールバック内で呼ぶ（effect 本体での同期 setState を避ける）。
  // 読むだけ: `Notification.requestPermission()` も `pushManager.subscribe()` も呼ばぬ。
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      void Promise.resolve().then(() => setSupported(false))
      return
    }
    let cancelled = false
    // SW を登録できぬ環境では `ready` が解決せぬ。「確認しています」で固めぬ
    const timer = setTimeout(() => {
      if (!cancelled) setCheckTimedOut(true)
    }, DEVICE_CHECK_TIMEOUT_MS)
    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => {
        if (cancelled) return
        clearTimeout(timer)
        setSupported(true)
        setSubscribedHere(Boolean(subscription))
        setPermission(Notification.permission)
      })
      .catch(() => {
        clearTimeout(timer)
        if (!cancelled) setSupported(false)
      })
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  const state = thisDeviceStateOf({
    vapid,
    supported,
    denied: permission === "denied",
    permission,
    subscribedHere,
    checkTimedOut,
  })
  const text = STATE_TEXT[state]
  const Icon = text.ok === true ? Bell : text.ok === false ? BellOff : state === "checking" ? Loader2 : CircleHelp

  return (
    <div className="flex flex-col gap-2" data-testid="garbage-notification-status" data-state={state}>
      <p role="status" className="flex items-start gap-2 text-sm">
        <Icon
          size={16}
          aria-hidden="true"
          className={
            state === "checking"
              ? "mt-0.5 shrink-0 animate-spin text-muted-foreground"
              : "mt-0.5 shrink-0 text-muted-foreground"
          }
        />
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">{text.title}</span>
          {text.body && <span className="text-xs text-muted-foreground">{text.body}</span>}
        </span>
      </p>
      <p className="text-xs text-muted-foreground">
        ごみの前日の通知は、家族それぞれの登録済みの端末へ届きます。通知を受け取るかどうかは端末ごとに設定します。
      </p>
      <Link
        href="/settings"
        className="flex min-h-11 w-fit items-center gap-1 rounded-lg px-2 text-sm font-medium text-primary transition-colors duration-200 hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-ring"
      >
        設定の「通知」を開く
        <ChevronRight size={16} aria-hidden="true" />
      </Link>
    </div>
  )
}

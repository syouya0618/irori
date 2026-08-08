"use client"

/**
 * 通知（Web Push）の設定カード。
 *
 * ## この画面が背負っておる制約
 *
 * - **iOS はホーム画面に追加した PWA でしか Web Push が動かぬ**（Apple 公式:
 *   "iOS 16.4 or later: Home Screen web apps"）。Safari のタブでは `PushManager`
 *   自体が存在せぬため、「非対応」ではなく**開き方**の問題として案内する。
 * - **権限要求はユーザー操作のハンドラ内から即座に呼ぶ**（Apple 公式要件）。
 * - **`next dev` では動かぬ**。`service-worker-manager.tsx` は SW を
 *   `NODE_ENV === "production"` でしか登録せず、dev では既存登録を unregister する。
 *   検証は `pnpm build && pnpm start` か本番/preview で行うこと。
 * - **拒否された権限は JS から戻せぬ**。ブラウザ設定への案内を文章で出す。
 *
 * ## 登録と同時にテスト通知を送る理由
 *
 * 「有効にした」と表示しても、実際に端末へ届くかは送ってみるまで分からぬ
 * （権限はブラウザ設定で個別に切られうるし、iOS は開き方で挙動が変わる）。
 * 押した人がその場で結果を見られる形にする。
 */

import { useCallback, useEffect, useState, useTransition } from "react"
import { toast } from "sonner"
import { Bell, BellOff, Loader2, Smartphone, TriangleAlert } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  savePushSubscriptionAndSendTest,
  deletePushSubscription,
} from "@/app/(main)/settings/push-actions"
import { toastOfflineError } from "@/lib/utils/offline-error"

export interface PushDeviceView {
  id: string
  /** `summarizeUserAgent` の出力。取れなかった端末は null */
  userAgent: string | null
  createdAt: string
  lastSuccessAt: string | null
  failureCount: number
}

interface NotificationCardProps {
  devices: PushDeviceView[]
}

/** base64url の VAPID 公開鍵を `applicationServerKey` 用の Uint8Array へ変換する。 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(normalized)
  // ArrayBuffer を明示して包むのは型のため（素の `new Uint8Array(n)` は
  // `Uint8Array<ArrayBufferLike>` になり `BufferSource` へ代入できぬ）。
  const output = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}

function formatDate(iso: string): string {
  // 端末一覧の「いつ登録したか」ゆえ日付だけで足りる。
  const [ymd] = iso.split("T")
  const [, month, day] = ymd.split("-")
  return `${Number(month)}/${Number(day)}`
}

export function NotificationCard({ devices }: NotificationCardProps) {
  // 公開鍵はビルド時に埋まる（`NEXT_PUBLIC_` ゆえレンダー中に読んで安全）。
  // 未設定のまま subscribe すると、環境によっては購読が成立して「有効」に見えるのに
  // 送信が全て 403 になる ＝ **画面が嘘をつく**。ゆえに押させぬ。
  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim()

  const [supported, setSupported] = useState<boolean | null>(null)
  const [subscribedHere, setSubscribedHere] = useState(false)
  const [denied, setDenied] = useState(false)
  const [pending, startTransition] = useTransition()
  const [working, setWorking] = useState(false)

  // ⚠️ setState は **promise のコールバック内**で呼ぶ（effect 本体で同期的に呼ぶと
  // React Compiler の「effect 内の同期 setState」規則に触れる）。
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      Promise.resolve().then(() => setSupported(false))
      return
    }
    let cancelled = false
    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => {
        if (cancelled) return
        setSupported(true)
        setSubscribedHere(Boolean(subscription))
        setDenied(Notification.permission === "denied")
      })
      .catch(() => {
        if (!cancelled) setSupported(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleEnable = useCallback(async () => {
    if (!vapidPublicKey) return
    setWorking(true)
    try {
      // 権限要求はユーザー操作のハンドラ内から即座に（Apple 公式要件）。
      const permission = await Notification.requestPermission()
      if (permission !== "granted") {
        setDenied(permission === "denied")
        toast.error("通知が許可されませんでした。")
        return
      }

      const registration = await navigator.serviceWorker.ready
      const existing = await registration.pushManager.getSubscription()
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          // Safari は不可視 push を許さぬゆえ true 以外は受け付けられぬ。
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        }))

      const json = subscription.toJSON()
      const result = await savePushSubscriptionAndSendTest({
        endpoint: json.endpoint ?? "",
        p256dh: json.keys?.p256dh ?? "",
        auth: json.keys?.auth ?? "",
        userAgent: navigator.userAgent,
      })
      if (result.error) {
        toast.error(result.error)
        return
      }
      setSubscribedHere(true)
      setDenied(false)
      toast.success("この端末で通知を受け取れるようになりました。")
    } catch (error) {
      toastOfflineError("[notification-card] enable push", error)
    } finally {
      setWorking(false)
    }
  }, [vapidPublicKey])

  const handleDelete = useCallback((id: string) => {
    startTransition(async () => {
      const result = await deletePushSubscription(id)
      if (result.error) {
        toast.error(result.error)
        return
      }
      toast.success("この端末の通知を解除しました。")
    })
  }, [])

  return (
    <Card className="glass rounded-2xl shadow-lg shadow-black/[0.04]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell size={18} />
          通知
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          予定の時刻に、この端末へ通知を送れるようにします。
        </p>

        {!vapidPublicKey && (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" />
            通知の設定が未完了です（管理者に連絡してください）。
          </p>
        )}

        {supported === false && (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <BellOff size={16} className="mt-0.5 shrink-0" />
            この端末では通知を受け取れません。iPhone の場合は
            <strong>ホーム画面に追加してから</strong>
            開き直すと有効にできます。
          </p>
        )}

        {denied && (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <BellOff size={16} className="mt-0.5 shrink-0" />
            通知が拒否されています。ブラウザの設定から許可し直してください
            （このページからは戻せません）。
          </p>
        )}

        {vapidPublicKey && supported !== false && (
          <Button
            type="button"
            onClick={handleEnable}
            disabled={working}
            variant={subscribedHere ? "outline" : "default"}
            className="min-h-11 self-start"
          >
            {working ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                設定中…
              </>
            ) : (
              <>
                <Bell size={16} />
                {subscribedHere
                  ? "この端末へテスト通知を送る"
                  : "この端末で通知を受け取る"}
              </>
            )}
          </Button>
        )}

        {devices.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">
              通知を受け取る端末
            </p>
            <ul className="flex flex-col gap-1">
              {devices.map((device) => (
                <li
                  key={device.id}
                  className="flex items-center justify-between gap-2 rounded-xl bg-muted/40 px-3 py-2"
                >
                  <span className="flex min-w-0 items-center gap-2 text-sm">
                    <Smartphone size={14} className="shrink-0" />
                    <span className="truncate">
                      {device.userAgent ?? "不明な端末"}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {formatDate(device.createdAt)}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => handleDelete(device.id)}
                    aria-label={`${device.userAgent ?? "不明な端末"}の通知を解除`}
                    className="min-h-11 shrink-0"
                  >
                    解除
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

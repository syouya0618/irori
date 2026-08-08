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
import {
  Activity,
  Bell,
  BellOff,
  Loader2,
  Send,
  Smartphone,
  TriangleAlert,
} from "lucide-react"
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
import {
  clearPushOptOut,
  writePushOptOut,
} from "@/lib/pwa/push-reconcile"
import { toastOfflineError } from "@/lib/utils/offline-error"
import type { NotificationHealthView } from "@/lib/domain/notification-health"

export interface PushDeviceView {
  id: string
  /** `summarizeUserAgent` の出力。取れなかった端末は null */
  userAgent: string | null
  createdAt: string
  /** 「3分前」等の相対表記。**サーバで組む**（下の注記を見よ） */
  lastSuccessLabel: string | null
  lastFailureLabel: string | null
  failureCount: number
}

interface NotificationCardProps {
  devices: PushDeviceView[]
  /**
   * 配信パイプラインの診断（B-4）。
   *
   * ⚠️ **相対表記はサーバで確定させてある。** ここで `Date.now()` を読むと
   * SSR とハイドレーションで別の文字列になり得る（このページは cookie 依存で
   * 毎リクエスト描かれるゆえ、サーバで組んで困ることは無い）。
   */
  health: NotificationHealthView
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

/**
 * このブラウザが今持っておる購読。無ければ null。
 *
 * ⚠️ `navigator.serviceWorker.ready` を使わぬ。SW が 1 つも登録されておらぬ環境
 * （`next dev` は `ServiceWorkerManager` が unregister する）では**永久に解決せぬ**
 * promise になり、解除ボタンが黙って固まる。`getRegistration()` は未登録なら
 * undefined で解決する（`push-unsubscribe.ts` と同じ判断じゃ）。
 */
async function getCurrentSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null
  const registration = await navigator.serviceWorker.getRegistration()
  if (!registration) return null
  return registration.pushManager.getSubscription()
}

function formatDate(iso: string): string {
  // 端末一覧の「いつ登録したか」ゆえ日付だけで足りる。
  const [ymd] = iso.split("T")
  const [, month, day] = ymd.split("-")
  return `${Number(month)}/${Number(day)}`
}

/**
 * 診断の一言。**色ではなく文言で意味を運ぶ**（色だけに依存する表現は禁じ手じゃ）。
 * 平穏なら null —— 何も起きておらぬ時に警告を出すと、本当の警告が薄まる。
 */
function healthMessageOf(health: NotificationHealthView): string | null {
  // ⚠️ **「読めなかった」を最初に見る。** 心拍と最終配信のどちらが読めなくとも、
  // 画面は「止まっておる」とも「まだ走っておらぬ」とも言うてはならぬ。
  // 断言すれば、主は動いておる基盤を止めに行く。
  if (health.runState === "unknown" || health.deliveryState === "unknown") {
    return "配信の状況を取得できませんでした。通知が止まっているとは限りません。"
  }
  switch (health.runState) {
    case "never":
      return "通知の配信はまだ一度も実行されていません。"
    case "stale":
      return `配信の処理が${health.ranAtLabel ?? "しばらく前"}から動いていません。通知が届かない可能性があります。`
    case "failing":
      return `直近の配信で ${health.failedCount} 件の失敗がありました。`
    default:
      return null
  }
}

/** 端末ごとの一行。失敗が在れば**そちらを先に**見せる。 */
function deviceStatusOf(device: PushDeviceView): string {
  if (device.failureCount > 0) {
    const when = device.lastFailureLabel ? `・最終エラー ${device.lastFailureLabel}` : ""
    return `送信エラー ${device.failureCount}回${when}`
  }
  if (device.lastSuccessLabel) return `最終受信 ${device.lastSuccessLabel}`
  return "まだ届いていません"
}

export function NotificationCard({ devices, health }: NotificationCardProps) {
  // 公開鍵はビルド時に埋まる（`NEXT_PUBLIC_` ゆえレンダー中に読んで安全）。
  // 未設定のまま subscribe すると、環境によっては購読が成立して「有効」に見えるのに
  // 送信が全て 403 になる ＝ **画面が嘘をつく**。ゆえに押させぬ。
  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim()

  const [supported, setSupported] = useState<boolean | null>(null)
  const [subscribedHere, setSubscribedHere] = useState(false)
  const [denied, setDenied] = useState(false)
  const [pending, startTransition] = useTransition()
  const [working, setWorking] = useState(false)
  const healthMessage = healthMessageOf(health)

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
      // 主が改めて「受け取る」と言うたのじゃから、以前の解除の印は畳む。
      // 残したままにすると、この端末の購読が 410 で消えた時に突き合わせが
      // 復旧できなくなる（自分で新しい穴を開けることになる）。
      clearPushOptOut()
      setSubscribedHere(true)
      setDenied(false)
      toast.success("この端末で通知を受け取れるようになりました。")
    } catch (error) {
      toastOfflineError("[notification-card] enable push", error)
    } finally {
      setWorking(false)
    }
  }, [vapidPublicKey])

  /**
   * 端末の解除。
   *
   * ## ⚠️ 行を消すだけでは解除にならぬ
   * ブラウザの購読が生きたままなら、起動時の突き合わせ
   * （`PushSubscriptionReconciler`）が同じ endpoint を登録し直し、**主が切った
   * はずの通知が戻る**（しかも `failure_count = 0` の健康な顔でな）。ゆえに
   * サインアウト経路（`push-unsubscribe.ts`）と**同じ順序** —— サーバ削除が先、
   * ブラウザの `unsubscribe()` が後 —— を踏む。
   *
   * どの行がこのブラウザの購読かは endpoint でしか分からず、その列は GRANT の
   * 外じゃ。ゆえに endpoint を**渡して**、一致したかだけを受け取る。
   */
  const handleDelete = useCallback((id: string) => {
    startTransition(async () => {
      // endpoint を失う前に掴んでおく（消した後では二度と取れぬ）。
      const subscription = await getCurrentSubscription().catch((err) => {
        console.warn("[notification-card] 現在の購読を取得できず:", err)
        return null
      })

      const result = await deletePushSubscription(id, subscription?.endpoint ?? null)
      if (result.error) {
        toast.error(result.error)
        return
      }

      if (result.deletedCurrentDevice && subscription) {
        // 印が先。`unsubscribe()` は圏外や権限で落ちうるゆえ、落ちた時に
        // 突き合わせを止められるのはこの印だけじゃ。
        writePushOptOut(subscription.endpoint)
        try {
          await subscription.unsubscribe()
        } catch (err) {
          // 解除自体は成立しておる（行は消えた）。握り潰さず理由を残す。
          console.warn("[notification-card] ブラウザ側の購読解除に失敗:", err)
        }
        // 「テスト通知を送る」表示のまま購読が無い、を作らぬ。
        setSubscribedHere(false)
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
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-2 text-sm">
                      <Smartphone size={14} className="shrink-0" aria-hidden="true" />
                      <span className="truncate">
                        {device.userAgent ?? "不明な端末"}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {formatDate(device.createdAt)}
                      </span>
                    </span>
                    {/* B-1 で列は在ったが誰も読んでおらなんだ failure_count を出す。
                        端末ごとの失敗は「1 台だけ死んでおる」を切り分ける唯一の手がかりじゃ。 */}
                    <span className="text-xs text-muted-foreground">
                      {deviceStatusOf(device)}
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

        {/* ── 配信の状況（診断・B-4）──────────────────────────────
            ⚠️ **「最終実行」と「最終配信」は必ず並べて出す。** 片方だけでは
            「パイプラインが止まった」と「送るものが無かった」を区別できぬ。
            前者は cron の心拍（送るものが無くとも進む）、後者は MAX(sent_at)
            （静かな週は進まぬ）ゆえ、2 つ揃って初めて意味を成す。 */}
        <div className="flex flex-col gap-1.5 rounded-xl bg-muted/40 px-3 py-2">
          <p className="text-xs font-medium text-muted-foreground">配信の状況</p>
          <dl className="flex flex-col gap-1 text-sm">
            <div className="flex items-center justify-between gap-2">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <Activity size={14} className="shrink-0" aria-hidden="true" />
                最終実行
              </dt>
              <dd>
                {/* 「取得できませんでした」と「まだありません」は別物じゃ
                    （前者は診断の故障・後者は pg_cron 未登録）。混ぜぬこと。 */}
                {health.runState === "unknown"
                  ? "取得できませんでした"
                  : health.runState === "never"
                    ? "まだありません"
                    : (health.ranAtLabel ?? "不明")}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <Send size={14} className="shrink-0" aria-hidden="true" />
                最終配信
              </dt>
              <dd>
                {health.deliveryState === "unknown"
                  ? "取得できませんでした"
                  : health.deliveryState === "never"
                    ? "まだありません"
                    : (health.lastSentLabel ?? "不明")}
              </dd>
            </div>
          </dl>
          {healthMessage && (
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              {healthMessage}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

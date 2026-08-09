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
  Sunrise,
  TriangleAlert,
} from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  savePushSubscriptionAndSendTest,
  deletePushSubscription,
} from "@/app/(main)/settings/push-actions"
import { updateDigestTime } from "@/app/(main)/settings/actions"
import {
  DIGEST_TIME_DEFAULT,
  DIGEST_TIME_NONE,
  DIGEST_TIME_OPTIONS,
  parseDigestTimeHm,
} from "@/lib/domain/notification-digest"
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
  /**
   * 毎朝のまとめの時刻（B-5）。**"HH:MM" へ正規化済み**（DB は "07:00:00" で返す）。
   * null = 送らない。
   */
  digestTime: string | null
  /**
   * まとめの設定を**読めなかった**。`digestTime === null` と混ぜてはならぬ —
   * 前者は「分からぬ」、後者は「送らないと決まっておる」じゃ。
   */
  digestTimeUnknown: boolean
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

/**
 * Select に出す選択肢。
 *
 * ⚠️ **保存済みの値が選択肢に無いときは、その値を足して見せる。** `digest_time` は
 * DB では任意の TIME を許す（SQL から直に入れた 07:13）うえ、B-5 で提示する帯を
 * 朝（05:00〜10:00）へ絞ったゆえ、**昨日まで選べた 12:00 も今は選択肢の外**じゃ。
 *
 * ⚠️ **失われるのは「一覧に出ること」であって、トリガの表示ではない（実測）。**
 * base-ui の `Select.Value` は `items` に一致が無いとき**生の値をそのまま描く**
 * （このリポジトリの版で計測。空欄にはならぬ）。ゆえに:
 *   * トリガの文字だけを見るテストでは、この配慮を消しても**緑のまま**になる
 *   * 実際に壊れるのは**開いた時**じゃ —— 今の設定が一覧のどこにも無く、印も
 *     付かぬ。主は「一覧に無い ＝ 設定が消えた」と読んで選び直し、**本人の意図
 *     でなく毎朝の時刻が動く**
 * ゆえに回帰は `notification-card-digest.test.tsx` が**開いて option を数える**
 * 形で固定しておる。トリガの表示だけを見る assert に戻すな。
 *
 * （なお `parseDigestTimeHm` を落として "07:00:00" が来た場合は、その生の値が
 * トリガへ出るゆえ完全一致の assert で捕まる —— あちらは別の検出器じゃ。）
 */
function digestItemsFor(current: string): { value: string; label: string }[] {
  if (DIGEST_TIME_OPTIONS.some((option) => option.value === current)) {
    return DIGEST_TIME_OPTIONS
  }
  return [...DIGEST_TIME_OPTIONS, { value: current, label: current }]
}

export function NotificationCard({
  devices,
  health,
  digestTime,
  digestTimeUnknown,
}: NotificationCardProps) {
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
  // 保存の往復を待たずに選択を映す（失敗したら元へ戻す）。既定は「送らない」 —
  // 主が自ら選ぶまで毎朝の通知は出さぬ、が B-5 の約束じゃ。
  //
  // ⚠️ **ここでも正規化を通す。** ページ側が既に "HH:MM" へ均しておるが、DB の
  // TIME は "07:00:00" で返る値ゆえ、上流の 1 箇所が抜けると Select に
  // **"07:00:00" がそのまま出る**（base-ui は一致せぬ値を生のまま描く。実測）。
  // 見慣れぬ表記は「壊れておる」と読まれ、しかもその値は Server Action の
  // allowlist の外じゃ。同じ純関数を二度通すだけの安さでこの階層でも塞げる
  // （値は同じゆえ真値源は増えぬ）。
  const [digestChoice, setDigestChoice] = useState(
    parseDigestTimeHm(digestTime) ?? DIGEST_TIME_NONE,
  )
  const [digestSaving, setDigestSaving] = useState(false)

  /**
   * この利用者に**まとめを届けられる先が在るか**。
   *
   * 配信側は `subscriptions.filter(row => digestTimes.has(row.user_id))` が空なら
   * その日の行すら立てぬ（`deliver.ts` の `expandDigests`）。ゆえに購読が 1 つも
   * 無い利用者に「毎朝 07:00 にお届けします」と言えば**画面が嘘をつく** ——
   * VAPID 未設定でボタンを消しておるのと同じ筋じゃ。
   *
   * ⚠️ **判定は `devices`（＝この利用者の全端末）で行う。`supported` / `denied` で
   * 判定するな。** あれは**この**ブラウザの話ゆえ、「ノートパソコンで時刻を選び、
   * iPhone で受け取る」という真っ当な使い方を誤って塞ぐ（`page.tsx` の
   * `push_subscriptions` は `.eq("user_id", userId)` のみで端末を絞っておらぬ）。
   * `subscribedHere` を or で足すのは、登録直後（`devices` は再描画までサーバの
   * 古い値）に「届かぬ」と偽らぬためじゃ。
   */
  const digestReachable = devices.length > 0 || subscribedHere

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
   * 毎朝のまとめの時刻を変える（B-5）。
   *
   * 表示は先に動かし、失敗したら**必ず巻き戻す** —— 保存できておらぬ設定が
   * 保存済みに見える嘘を残さぬためじゃ（google-calendar-card と同じ作法）。
   */
  const handleDigestChange = useCallback(
    async (next: string) => {
      const previous = digestChoice
      if (next === previous) return
      setDigestChoice(next)
      setDigestSaving(true)
      try {
        const result = await updateDigestTime(next)
        if (result.error) {
          setDigestChoice(previous)
          toast.error(result.error)
          return
        }
        // ⚠️ **届く先が無いときに「お届けします」と言うてはならぬ。** 保存は
        // 本当に成功しておる（設定は残る）ゆえ、成功として伝えつつ届かぬ理由を
        // 添える。ここを 1 文に戻すと、購読ゼロの主は毎朝待ち続け、原因を
        // cron や通知基盤の故障と読む（診断表示は健康を示すゆえ切り分けが詰む）。
        toast.success(
          next === DIGEST_TIME_NONE
            ? "毎朝のまとめを止めました。"
            : digestReachable
              ? `毎朝 ${next} にまとめをお届けします。`
              : `毎朝 ${next} に設定しました。通知を受け取る端末がないため、まだ届きません。`,
        )
      } catch (error) {
        // reject は「サーバーへ届いてすらおらぬ」＝ result.error より確実に未反映。
        setDigestChoice(previous)
        toastOfflineError("[notification-card] updateDigestTime", error)
      } finally {
        setDigestSaving(false)
      }
    },
    [digestChoice, digestReachable],
  )

  /**
   * 端末を一覧から外す。
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
   *
   * ## ★ ゆえに「解除」と名乗れるのは**自分の端末だけ**じゃ
   * `unsubscribe()` を呼べるのは自分のブラウザに対してだけで、配偶者の端末や
   * 手放した古い端末のブラウザには手が届かぬ。行を消しても**その端末が次に
   * アプリを開いた瞬間、突き合わせが冪等に登録し直す**（サーバ側に失効テーブルを
   * 置けば止められるが、主の裁定で**作らぬ**と決まった）。
   *
   * ゆえに名前は「一覧から外す」じゃ。**この画面から出来ることを、出来る通りに
   * 呼ぶ。** 戻り値の `deletedCurrentDevice` が自端末か他端末かを分けるゆえ、
   * 成功の文言もそこで分ける —— 他端末に「解除しました」と言えば、戻ってきた時に
   * 主は「解除が効かぬ」と読み、通知基盤の故障を疑って追えぬ道へ入る。
   */
  const handleDelete = useCallback((id: string) => {
    startTransition(async () => {
      // ⚠️ block の**先頭**が try であること（`scripts/check-transition-reject-guard.py`
      // が機械で固定しておる）。startTransition 内の未処理 reject は
      // **最寄りの error boundary へ bubble し、設定画面ごと落とす**。
      try {
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
      // ⚠️ **自端末と他端末で文言を分ける。** 自端末は印 + `unsubscribe()` と対に
      // してあるゆえ「解除しました」は真じゃが、他端末では**嘘**になる
      // （その端末が開けば戻る）。分けられるのは `deletedCurrentDevice` が
      // サーバから 1 ビット返っておるおかげで、これを捨てて 1 文に戻せば
      // どちらかが必ず嘘になる。
      toast.success(
        result.deletedCurrentDevice
          ? "この端末の通知を解除しました。"
          : "一覧から外しました（その端末で再度開くと戻ります）。",
      )
      } catch (err) {
        toastOfflineError("[notification-card] deletePushSubscription", err)
      }
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
                    // 端末ごとに一意（`getByRole` が割れぬこと・端末名を必ず含む）。
                    // 「通知を解除」とは名乗らぬ —— 他端末のブラウザには手が届かず、
                    // その端末が開けば突き合わせが登録し直すゆえ、この画面が
                    // 出来るのは一覧から外すことまでじゃ。
                    aria-label={`${device.userAgent ?? "不明な端末"}を一覧から外す`}
                    className="min-h-11 shrink-0"
                  >
                    一覧から外す
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── 毎朝のまとめ（B-5）────────────────────────────────
            その日の予定を 1 通にまとめて送る。**既定は無効**（主が自ら選ぶまで
            出さぬ）。予定の無い日は送らぬゆえ、静かな日に無意味な通知は来ぬ。 */}
        <div className="flex flex-col gap-2">
          <Label
            htmlFor="digest-time"
            className="flex items-center gap-1.5 text-sm font-medium"
          >
            <Sunrise size={14} className="shrink-0" aria-hidden="true" />
            毎朝のまとめ
          </Label>
          <p className="text-xs text-muted-foreground">
            その日の予定を、指定した時刻にまとめて 1 通お知らせします
            （予定がない日は送りません）。
          </p>
          <Select
            items={digestItemsFor(digestChoice)}
            value={digestChoice}
            onValueChange={(value) => void handleDigestChange(value as string)}
            disabled={digestSaving || digestTimeUnknown}
          >
            {/* ⚠️ **`h-11` ではなく `min-h-11` じゃ。** プリミティブ側が
                `data-[size=default]:h-8` を持っており、修飾子つきのそれと素の
                `h-11` は tailwind-merge の別キーゆえ**両方が残る** — そして CSS の
                詳細度は属性セレクタを伴う変種が勝つ（32px になる）。`min-height` なら
                どちらが勝っても 44px を下回らぬ。カレンダーの通知 Select が
                `h-11` なのは閉じたシートの中で実測されぬためで、こちらは
                /settings に常時出るゆえ `e2e/touch-targets.spec.ts` の対象じゃ。 */}
            <SelectTrigger
              id="digest-time"
              aria-label="毎朝のまとめを送る時刻"
              className="min-h-11 w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {digestItemsFor(digestChoice).map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* ⚠️ **届かぬことを画面に出す**（toast は消えるゆえ、それだけでは足りぬ）。
              購読が 1 つも無い利用者には配信側が行すら立てぬ ＝ 時刻が選ばれておっても
              毎朝何も来ぬ。「07:00 に設定済み」の顔だけを残せば、主は通知基盤の
              故障を疑って追えぬ道へ入る。**Select は塞がぬ** —— 時刻は利用者ごとの
              設定ゆえ、受け取る端末を後から足す順序（ノートで選び、iPhone で受ける）を
              妨げてはならぬ。 */}
          {digestChoice !== DIGEST_TIME_NONE && !digestReachable && (
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              通知を受け取る端末がないため、この時刻に設定してもまだ届きません。
              先にこの端末（または受け取りたい端末）で通知を受け取れるようにしてください。
            </p>
          )}
          {/* ── 既定の時刻へ 1 タップで入る導線 ────────────────────────
              ⚠️ **Select の初期選択を 07:00 にはせぬ。** DB が NULL のとき Select が
              07:00 を選んで見えれば「設定しておらぬのに設定済みに見える」＝ 画面が
              嘘をつき、主は毎朝来ぬ通知を待つ（B-5 が意図して避けた形じゃ）。
              「既定は 7 時」を満たすのはこのボタンで、**押されて初めて保存される**
              ゆえ opt-in は保たれる。

              ⚠️ 出す条件は**プロップではなく state**（`digestChoice`）で見る。
              プロップは `revalidatePath` の再描画まで古いままゆえ、保存した直後に
              導線が残って二度押しを誘う。state で見れば、主が自ら「送らない」へ
              戻した時にも再び出る —— それは**本当に未設定**ゆえ正しい。 */}
          {digestChoice === DIGEST_TIME_NONE && !digestTimeUnknown && (
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleDigestChange(DIGEST_TIME_DEFAULT)}
              disabled={digestSaving}
              className="min-h-11 self-start"
            >
              <Sunrise size={16} />
              {`${DIGEST_TIME_DEFAULT} で始める`}
            </Button>
          )}
          {/* ⚠️ **「読めなかった」を「送らない」と描かぬ**（B-4 の診断と同じ筋）。
              取得に失敗しておるのに選択肢を触らせると、主の 1 クリックが
              「知らぬ間に設定を上書きした」ことになる。ゆえに理由を出して止める。 */}
          {digestTimeUnknown && (
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              まとめの設定を取得できませんでした。今の設定は変更できません
              （送られていないとは限りません）。
            </p>
          )}
          {digestSaving && (
            <p className="text-xs text-muted-foreground">保存しています…</p>
          )}
        </div>

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

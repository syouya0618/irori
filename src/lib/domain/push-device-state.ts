/**
 * **この端末**の通知の状態の判定。ブラウザの権限（許可）と購読（登録）は別物ゆえ分けて言う。
 * 実際に届いたか（配信）は設定画面の端末一覧の「最終受信」が担う。
 *
 * 設定画面の通知カード（`components/settings/notification-card.tsx`）と、ごみの画面の通知の状態
 * （`components/chores/garbage/garbage-notification-status.tsx`）が同じ判定を使う。境界指令を
 * 持たぬ中立モジュール（純関数と型だけ）。
 */
export type ThisDeviceState =
  | "checking" // 確認中
  | "check-failed" // 確認が期限内に終わらなんだ（SW の準備が解決せぬ等）
  | "unconfigured" // 管理者の設定（VAPID）が無い
  | "unsupported" // この開き方では使えぬ（iOS の Safari タブ等）
  | "denied" // 権限が拒否されておる
  | "not-asked" // まだ許可しておらぬ
  | "granted-unsubscribed" // 許可はあるが、このアプリへの登録が無い
  | "subscribed" // 登録済み

export function thisDeviceStateOf(p: {
  vapid: boolean
  supported: boolean | null
  denied: boolean
  permission: NotificationPermission | null
  subscribedHere: boolean
  checkTimedOut: boolean
}): ThisDeviceState {
  if (!p.vapid) return "unconfigured"
  if (p.supported === false) return "unsupported"
  if (p.supported === null) return p.checkTimedOut ? "check-failed" : "checking"
  if (p.denied || p.permission === "denied") return "denied"
  if (p.subscribedHere) return "subscribed"
  if (p.permission === "granted") return "granted-unsubscribed"
  return "not-asked"
}

/** この端末の確認（SW の準備待ち）の期限。過ぎたら「確認できなかった」へ倒す。 */
export const DEVICE_CHECK_TIMEOUT_MS = 10_000

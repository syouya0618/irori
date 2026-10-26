"use client"

import { useState, useTransition, type ReactNode } from "react"
import { unstable_rethrow } from "next/navigation"
import { toast } from "sonner"
import {
  ChevronRight,
  Home,
  LogOut,
  Loader2,
  TriangleAlert,
} from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { signOut } from "@/app/(main)/settings/actions"
import { unsubscribeCurrentDevice } from "@/app/(main)/settings/push-actions"
import { unsubscribePushForSignOut } from "@/lib/pwa/push-unsubscribe"
import {
  purgeHouseholdCaches,
  setCacheOwner,
  clearCacheOwner,
  LAST_USER_ID_STORAGE_KEY,
} from "@/lib/pwa/sw-messages"
import { clearPersistedTimer } from "@/lib/domain/feeding-timer-storage"
// startTransition 内の未処理 reject は error boundary へ bubble する（詳細は
// offline-error.ts）。圏外サインアウトで設定画面ごと落ちないよう握ってトーストへ倒す。
// 文言は「ログアウトできなかった」と明示するため、ログだけ共通の helper を使う。
import { logOfflineError } from "@/lib/utils/offline-error"
import { ProfileCard } from "@/components/settings/profile-card"
import { InviteCard } from "@/components/settings/invite-card"
import { ApprovalCard, type PendingUser } from "@/components/settings/approval-card"
import { DefaultPageCard } from "@/components/settings/default-page-card"
import { BabyProfileCard } from "@/components/settings/baby-profile-card"
import { ExportCard } from "@/components/settings/export-card"
import {
  NotificationCard,
  type PushDeviceView,
} from "@/components/settings/notification-card"
import {
  GoogleCalendarCard,
  type GoogleConnectionView,
} from "@/components/settings/google-calendar-card"
import { ThemeCard } from "@/components/settings/theme-card"
import { HelpCard, type HelpCardFeedback } from "@/components/settings/help-card"
import type { HouseholdRole } from "@/lib/types/database"
import type { NotificationHealthView } from "@/lib/domain/notification-health"

interface SettingsContentProps {
  profile: {
    id: string
    displayName: string
    avatarUrl: string | null
    role: HouseholdRole
    defaultPage: string
  }
  household: {
    id: string
    name: string
  } | null
  email: string
  /** インスタンスの運用者か（P1-02）。承認カードの可否は**これだけ**で決まる（世帯の役割ではない）。 */
  isAppOperator: boolean
  /** 承認待ち（運用者のみ）。null = 運用者だが一覧を**読めなかった**（＝0 件とは限らぬ）。 */
  pendingUsers: PendingUser[] | null
  /** null = 世帯を**読めなかった**（＝空欄とは限らぬ・P2-31）。 */
  babyProfile: {
    name: string | null
    birthDate: string | null
    feedingIntervalMin: number
  } | null
  /** 自分の Google カレンダー接続（0 件なら未接続）。 */
  googleConnections: GoogleConnectionView[]
  /** OAuth callback が付ける `?google=` の値。未知コードはカード側が無視する。 */
  googleNotice: string | null
  /** 通知を受け取る端末（本人のみ・秘密列は含まぬ） */
  pushDevices: PushDeviceView[]
  /** 配信パイプラインの診断（B-4）。相対表記はサーバで確定済み。 */
  pushHealth: NotificationHealthView
  /** 毎朝のまとめの時刻（B-5）。**"HH:MM" へ正規化済み**。null = 送らない。 */
  digestTime: string | null
  /** まとめの設定を**読めなかった**（＝「送らない」とは限らぬ）。 */
  digestTimeUnknown: boolean
  /** Google 接続を**読めなかった**（＝未接続とは限らぬ）。 */
  googleConnectionsUnknown?: boolean
  /** 通知の端末一覧を**読めなかった**（＝端末が無いとは限らぬ）。 */
  pushDevicesUnknown?: boolean
  /** 要望・改善提案の件数（ヘルプのカードに添える）。読めなかった件数は null */
  feedback?: HelpCardFeedback
}

/** 要確認の 1 件（画面の先頭にまとめ、該当のカードへ飛べるようにする）。 */
interface AttentionItem {
  key: string
  text: string
  href: string
}

/**
 * 画面の先頭に出す「要確認」。**実際に手を打つべきもの**だけを拾う —— 平穏な状態や
 * 単なる未設定まで並べると、本当の警告が埋もれる。判定は各カードと同じ向き:
 * Google の接続は「active 以外は全て要注意」（denylist・enum drift 防御）。
 */
function attentionItems(p: {
  household: SettingsContentProps["household"]
  googleConnections: GoogleConnectionView[]
  googleConnectionsUnknown: boolean
  pushDevices: PushDeviceView[]
  pushHealth: NotificationHealthView
  isAppOperator: boolean
  pendingUsers: PendingUser[] | null
  feedback?: HelpCardFeedback
}): AttentionItem[] {
  const items: AttentionItem[] = []
  // 要望への返信・状態の更新（投稿者が見ておらぬもの）。アプリ内が正本ゆえ、Push が
  // 届かなかった端末でもここで気付ける。
  const unseen = p.feedback?.unseenUpdates ?? null
  if (unseen !== null && unseen > 0) {
    items.push({
      key: "feedback-updates",
      text: `送った要望に更新が ${unseen} 件あります`,
      href: "#settings-help",
    })
  }
  if (!p.household) {
    items.push({ key: "household", text: "世帯の情報を取得できませんでした", href: "#settings-family" })
  }
  if (p.googleConnectionsUnknown) {
    items.push({
      key: "google-unknown",
      text: "Google カレンダーの接続状態を確認できませんでした",
      href: "#settings-google",
    })
  } else if (p.googleConnections.some((c) => c.connectionStatus !== "active")) {
    items.push({
      key: "google-reauth",
      text: "Google カレンダーの再接続が必要です",
      href: "#settings-google",
    })
  } else if (p.googleConnections.some((c) => c.lastErrorKind !== null)) {
    items.push({
      key: "google-error",
      text: "Google カレンダーの同期でエラーが出ています",
      href: "#settings-google",
    })
  }
  if (p.pushHealth.runState === "stale" || p.pushHealth.runState === "failing") {
    items.push({
      key: "push-health",
      text: "通知の配信に問題が起きている可能性があります",
      href: "#settings-notification",
    })
  }
  if (p.pushDevices.some((d) => d.failureCount > 0)) {
    items.push({
      key: "push-device",
      text: "通知を送れていない端末があります",
      href: "#settings-notification",
    })
  }
  if (p.isAppOperator) {
    if (p.pendingUsers === null) {
      items.push({
        key: "approval-unknown",
        text: "承認待ちの一覧を取得できませんでした",
        href: "#settings-operator",
      })
    } else if (p.pendingUsers.length > 0) {
      items.push({
        key: "approval",
        text: `承認待ちが ${p.pendingUsers.length} 人います`,
        href: "#settings-operator",
      })
    }
    const inboxUnread = p.feedback?.inboxUnread ?? null
    if (inboxUnread !== null && inboxUnread > 0) {
      items.push({
        key: "feedback-inbox",
        text: `要望の受信箱に未読が ${inboxUnread} 件あります`,
        href: "#settings-help",
      })
    }
  }
  return items
}

/** 設定のまとまり。見出し（h2）で区切り、カードの並びを利用目的で揃える。 */
function SettingsSection({
  id,
  title,
  description,
  titleHidden = false,
  children,
}: {
  id: string
  title: string
  description?: string
  /**
   * カードが 1 枚で、その題名が見出しと同じことを言う区画では見出しを画面に出さぬ
   * （読み上げと見出しの移動には残す）。同じ語を 2 度並べて縦を食わせぬ。
   */
  titleHidden?: boolean
  children: ReactNode
}) {
  const headingId = `${id}-heading`
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="flex scroll-mt-4 flex-col gap-3"
    >
      {titleHidden ? (
        <h2 id={headingId} className="sr-only">
          {title}
        </h2>
      ) : (
        <div className="flex flex-col gap-0.5 px-1">
          <h2 id={headingId} className="text-sm font-semibold text-muted-foreground">
            {title}
          </h2>
          {description && (
            <p className="text-xs text-muted-foreground">{description}</p>
          )}
        </div>
      )}
      {children}
    </section>
  )
}

const roleLabels: Record<HouseholdRole, string> = {
  owner: "オーナー",
  member: "メンバー",
  viewer: "閲覧者",
}

const SIGN_OUT_FAILED_MESSAGE =
  "ログアウトできませんでした。電波の良い場所でもう一度お試しください"

/** 鍵（前の利用者 ID）を消す。破棄の確認と signOut の成功の**両方**を見た後でのみ呼ぶ。 */
function clearLastUserId() {
  try {
    localStorage.removeItem(LAST_USER_ID_STORAGE_KEY)
  } catch (err) {
    console.warn("[settings] localStorage の削除に失敗:", err)
  }
}

/**
 * 端末に残る授乳タイマーの計測を消す（P3-08）。signOut が成功した時だけ呼ぶ —
 * 圏外で signOut が reject した時に消すと、利用者は同じまま計測だけが失われる。
 * 別の利用者がログインした時の保険は CacheUserGuard とタイマーの持ち主判定が担う。
 */
function clearDeviceTimer() {
  clearPersistedTimer()
}

/**
 * ログアウトの要求がサーバへ届かなかった（通信断で reject）時、破棄（purgeHouseholdCaches）で
 * 先に消した世帯キャッシュの持ち主を今の利用者へ戻す。セッションは残っておるゆえ利用者は
 * 同じまま使い続け、戻さねば (main) を開き直すまでオフライン用の保存が止まったままになる。
 * 前の利用者の項目は破棄済みで、残っておっても次の利用者の CacheUserGuard が持ち主の交代
 * として破棄し直す（鍵は残しておる）。`{ error }` が返った時は戻さぬ（→ handleSignOut）。
 */
function restoreCacheOwner(userId: string) {
  void setCacheOwner(userId)
}

export function SettingsContent({
  profile,
  household,
  email,
  isAppOperator,
  pendingUsers,
  babyProfile,
  googleConnections,
  googleNotice,
  pushDevices,
  pushHealth,
  digestTime,
  digestTimeUnknown,
  googleConnectionsUnknown = false,
  pushDevicesUnknown = false,
  feedback,
}: SettingsContentProps) {
  const [, startTransition] = useTransition()
  const [isSigningOut, setIsSigningOut] = useState(false)
  // ログアウトは押し間違いの代償が大きい（メールで入り直し・この端末の通知が止まる）ゆえ確認を挟む
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const attention = attentionItems({
    household,
    googleConnections,
    googleConnectionsUnknown,
    pushDevices,
    pushHealth,
    isAppOperator,
    pendingUsers,
    feedback,
  })

  const handleSignOut = () => {
    setIsSigningOut(true)
    // 鍵（LAST_USER_ID）を消してよいのは「破棄を確かめた」かつ「signOut が成功した」
    // 時だけじゃ（F2 / P2-24）。破棄の直後・signOut の前に消すと、圏外で signOut が
    // reject した時に鍵だけが消え、利用者は同じまま残る。SW は同じ世帯の HTML / RSC を
    // 再び保存し、後で別の利用者がログインしても CacheUserGuard は前の ID が無い
    // （＝初回）と見て破棄せぬ。鍵を残しておけば guard が持ち主の交代として破棄する。
    // transition の本体は try で始める（check-transition-reject-guard.py の契約）ゆえ、
    // 押下ごとの状態はここで持つ。
    let purged = false
    startTransition(async () => {
      try {
        // 世帯キャッシュ破棄は signOut() より前に行う（redirect の後は実行保証がない）。
        // 購読はブラウザ単位ゆえ、放置すると旧ユーザー宛の通知が
        // 次の利用者の端末へ届く。キャッシュ破棄と同じ理由で先に畳む。
        await unsubscribePushForSignOut(unsubscribeCurrentDevice)
        purged = await purgeHouseholdCaches()
        if (!purged) {
          // 破棄を確かめられぬまま鍵を消せば、次の利用者の CacheUserGuard まで黙り、
          // 前の世帯の HTML / RSC がオフラインで読めたまま残る (P2-24)。
          // 鍵を残せば次のログインで guard が破棄を試み直す。ログアウトは止めぬ。
          console.warn(
            "[settings] 世帯キャッシュの破棄を確認できず。LAST_USER_ID を残す",
          )
        }
        const result = await signOut()
        // 成功は redirect（下の catch へ reject として届く）。解決して返ったのは失敗の結果
        // だけじゃ（PR #235 P2）。成功の後処理はせぬ: 鍵（LAST_USER_ID）も端末の計測も残し、
        // 押し直せるように戻す。鍵を残せば、後で別の利用者がログインした時に CacheUserGuard が
        // 持ち主の交代として破棄し直せる。
        // 世帯キャッシュの持ち主は戻さぬ: auth-js は失効に失敗した時も端末のセッションを
        // 消してから error を返すゆえ、ここに来た端末は実質ログアウト済みのことが多い。戻すと
        // 破棄に失敗して残った項目が再び配られる（独立レビュー r2）。まだログイン中なら、
        // 次に (main) を開いた時に CacheUserGuard が書き直す。
        setIsSigningOut(false)
        toast.error(result.error)
      } catch (err) {
        // catch 先頭で必ず: signOut() の redirect("/login") 内部エラーは
        // フレームワークへ再送出する（握り潰すと遷移が死ぬ）。
        // signOut の**成功**はクライアントでは reject として届く — Server Action の
        // redirect は action の promise を redirect エラーで reject する
        // (node_modules/next/dist/client/components/router-reducer/reducers/
        //  server-action-reducer.js の `if (redirectLocation !== undefined)` 節)。
        // ゆえに unstable_rethrow が投げ返した時（＝成功）だけ鍵を消してから返す。
        try {
          unstable_rethrow(err)
        } catch (frameworkSignal) {
          clearDeviceTimer()
          if (purged) clearLastUserId()
          // 持ち主の記録を改めて消す。破棄で先に消してあるが、signOut の往復の間に別タブが
          // (main) を開き直しておれば、その guard が（鍵はまだこの利用者ゆえ）持ち主を書き
          // 戻しておる。成功の redirect は SPA 遷移で SW の /login 経路を通らぬゆえ、ここで
          // 消さねば、破棄に失敗して残った項目が未ログインの端末で配られる（独立レビュー r4）。
          // 待たぬ（遷移を遅らせぬ）。cookie はもう消えておるゆえ、新しい利用者の記録は消さぬ
          void clearCacheOwner()
          throw frameworkSignal
        }
        // ここへ来たのは本物の失敗（圏外など）。鍵は残す（上記）。
        restoreCacheOwner(profile.id)
        // 圏外 reject でボタンが押せないまま固まるのを防ぐ（永久ローディング対策）。
        setIsSigningOut(false)
        logOfflineError("[settings-content] purgeHouseholdCaches/signOut", err)
        toast.error(SIGN_OUT_FAILED_MESSAGE)
      }
    })
  }

  return (
    <div className="flex flex-col gap-6 px-4 pt-12 pb-8">
      <h1 className="text-xl font-bold">設定</h1>

      {/* 要確認（手を打つべきものだけ）。各カードの中にも同じ状態が出ておるが、長い画面の
          下の方で起きておる問題に気づけるよう先頭へ集める */}
      {attention.length > 0 && (
        <section
          aria-labelledby="settings-attention-heading"
          className="flex flex-col gap-2 rounded-2xl bg-primary/10 px-4 py-3 ring-1 ring-primary/20"
        >
          <h2
            id="settings-attention-heading"
            className="flex items-center gap-2 text-sm font-semibold text-primary"
          >
            <TriangleAlert size={16} aria-hidden="true" />
            確認が必要な項目
          </h2>
          <ul className="flex flex-col">
            {attention.map((item) => (
              <li key={item.key}>
                <a
                  href={item.href}
                  className="touch-target -mx-2 flex items-center justify-between gap-2 rounded-lg px-2 text-sm text-foreground transition-colors duration-200 hover:bg-primary/10"
                >
                  {item.text}
                  <ChevronRight size={16} className="shrink-0 text-primary" aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <SettingsSection id="settings-you" title="あなたと赤ちゃん">
        <ProfileCard profile={profile} email={email} />
        <BabyProfileCard initialProfile={babyProfile} />
      </SettingsSection>

      <SettingsSection
        id="settings-family"
        title="家族・世帯"
      >
        <Card className="glass">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Home size={18} aria-hidden="true" />
              世帯
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {/* ⚠️ 読めなかった世帯を「世帯名未設定」と描かぬ（P2-31・赤ちゃん情報と同じ筋） */}
            {household ? (
              <p className="text-sm font-medium">
                {household.name || "世帯名未設定"}
              </p>
            ) : (
              <p
                role="alert"
                className="flex items-start gap-2 text-sm text-muted-foreground"
              >
                <TriangleAlert
                  size={16}
                  className="mt-0.5 shrink-0 text-destructive"
                  aria-hidden="true"
                />
                世帯の情報を取得できませんでした
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              あなたの役割: {roleLabels[profile.role]}
            </p>
          </CardContent>
        </Card>
        <InviteCard />
      </SettingsSection>

      <SettingsSection id="settings-google" title="Google カレンダー連携" titleHidden>
        <GoogleCalendarCard
          connections={googleConnections}
          notice={googleNotice}
          connectionsUnknown={googleConnectionsUnknown}
        />
      </SettingsSection>

      <SettingsSection id="settings-notification" title="通知と端末" titleHidden>
        <NotificationCard
          devices={pushDevices}
          health={pushHealth}
          digestTime={digestTime}
          digestTimeUnknown={digestTimeUnknown}
          devicesUnknown={pushDevicesUnknown}
        />
      </SettingsSection>

      <SettingsSection id="settings-data" title="データの書き出し" titleHidden>
        <ExportCard />
      </SettingsSection>

      <SettingsSection id="settings-display" title="表示">
        <ThemeCard />
        <DefaultPageCard defaultPage={profile.defaultPage} />
      </SettingsSection>

      {/* 承認管理（インスタンスの運用者のみ・P1-02）。世帯の owner であることは根拠にせぬ
          —— 相互に信頼せぬ他世帯の新規登録者を見せることになる。読めなかった時（null）は
          「読めなかった」を描き、0 件の時は従来どおり出さぬ */}
      {isAppOperator && (pendingUsers === null || pendingUsers.length > 0) && (
        <SettingsSection
          id="settings-operator"
          title="運用者の管理"
        >
          <ApprovalCard pendingUsers={pendingUsers} />
        </SettingsSection>
      )}

      <SettingsSection id="settings-help" title="ヘルプとアカウント">
        <HelpCard feedback={feedback} />

        <Separator />

        {/* ログアウトの確認。handleSignOut（破棄 → signOut の順序・鍵の扱い）は一切変えず、
            押す前に 1 段だけ挟む */}
        {confirmSignOut || isSigningOut ? (
          <div
            role="group"
            aria-labelledby="sign-out-confirm-title"
            aria-describedby="sign-out-confirm-desc"
            className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"
          >
            <p id="sign-out-confirm-title" className="text-sm font-medium">
              この端末からログアウトしますか？
            </p>
            <p id="sign-out-confirm-desc" className="text-xs text-muted-foreground">
              この端末への通知は届かなくなり、端末に保存した表示用のデータも消えます。
              もう一度使うときはログインし直してください。
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirmSignOut(false)}
                disabled={isSigningOut}
                autoFocus
                className="flex-1 cursor-pointer"
              >
                キャンセル
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={handleSignOut}
                disabled={isSigningOut}
                className="flex-1 cursor-pointer"
              >
                {isSigningOut ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <LogOut size={16} />
                )}
                {isSigningOut ? "ログアウト中…" : "ログアウトする"}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="lg"
            onClick={() => setConfirmSignOut(true)}
            className="cursor-pointer text-destructive hover:text-destructive"
          >
            <LogOut size={16} />
            ログアウト
          </Button>
        )}
      </SettingsSection>
    </div>
  )
}

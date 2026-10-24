"use client"

import { useState, useTransition } from "react"
import { unstable_rethrow } from "next/navigation"
import { toast } from "sonner"
import {
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
import { HelpCard } from "@/components/settings/help-card"
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
}: SettingsContentProps) {
  const [, startTransition] = useTransition()
  const [isSigningOut, setIsSigningOut] = useState(false)

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

      {/* プロフィール */}
      <ProfileCard profile={profile} email={email} />

      {/* 世帯情報 */}
      <Card className="glass">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Home size={18} />
            世帯
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
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
            </div>
          </div>
        </CardContent>
      </Card>

      {/* デフォルトページ */}
      <DefaultPageCard defaultPage={profile.defaultPage} />

      {/* 赤ちゃん情報 */}
      <BabyProfileCard initialProfile={babyProfile} />

      {/* Google カレンダー連携 */}
      <GoogleCalendarCard
        connections={googleConnections}
        notice={googleNotice}
      />

      {/* 通知（Web Push） */}
      <NotificationCard
        devices={pushDevices}
        health={pushHealth}
        digestTime={digestTime}
        digestTimeUnknown={digestTimeUnknown}
      />

      {/* 記録エクスポート */}
      <ExportCard />

      {/* テーマ */}
      <ThemeCard />

      {/* 使い方ツアー再表示 */}
      <HelpCard />

      {/* 招待 */}
      <InviteCard />

      {/* 承認管理（インスタンスの運用者のみ・P1-02）。世帯の owner であることは根拠にせぬ
          —— 相互に信頼せぬ他世帯の新規登録者を見せることになる。読めなかった時（null）は
          「読めなかった」を描き、0 件の時は従来どおり出さぬ */}
      {isAppOperator && (pendingUsers === null || pendingUsers.length > 0) && (
        <ApprovalCard pendingUsers={pendingUsers} />
      )}

      {/* ログアウト */}
      <Separator />

      <Button
        type="button"
        variant="ghost"
        size="lg"
        onClick={handleSignOut}
        disabled={isSigningOut}
        className="cursor-pointer text-destructive hover:text-destructive"
      >
        {isSigningOut ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <LogOut size={16} />
        )}
        ログアウト
      </Button>
    </div>
  )
}

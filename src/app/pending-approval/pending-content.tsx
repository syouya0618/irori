"use client"

import { useState, useRef, useEffect } from "react"
import { useRouter, unstable_rethrow } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Loader2, Clock, LogOut, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { signOut } from "./actions"
import { purgeHouseholdCaches, clearCacheOwner } from "@/lib/pwa/sw-messages"
import { clearPersistedTimer } from "@/lib/domain/feeding-timer-storage"
// 注意: ここは startTransition ではなくプレーンな async onClick ゆえ、reject は
// error boundary へ bubble せず **無言の unhandled rejection** になる（機序が別）。
// 症状は同じ「無言で失敗 + ボタンが固まる」ため同じトーストへ倒す。
import { toastOfflineError } from "@/lib/utils/offline-error"

export function PendingContent({
  approvalStatus,
  allowCachePurge,
}: {
  /**
   * "pending" = page.tsx が profiles を読めて `is_approved === false` と確かめた。
   * "unconfirmed" = 読めなんだ・本人を確かめられなんだ・承認済みだった。proxy は
   * profiles の一過性の取得失敗でも承認済みの世帯員をここへ送るゆえ、「承認待ち」と
   * 断定せぬ（F1 / F3 / REG-05）。
   */
  approvalStatus: "pending" | "unconfirmed"
  /**
   * 世帯キャッシュの破棄を許すか。承認待ち・世帯なしと**サーバが確かめた**時だけ true。
   * 既定値を持たせぬ（渡し忘れた呼び出し元で無条件の破棄が黙って戻らぬように）。
   */
  allowCachePurge: boolean
}) {
  const router = useRouter()
  const [isChecking, setIsChecking] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  // P2-24: 承認待ち・世帯なしと**サーバが確かめた**利用者なら、この端末に残る世帯
  // キャッシュは前の利用者のものじゃ。CacheUserGuard は (main) にしか居らぬため、前の
  // 利用者のログアウトで破棄が空振りしておれば、/offline →「育児ページへ」の経路で
  // 前の世帯の記録が読めてしまう。ここでも破棄を試みる。
  // ⚠️ 「ここに居る = 承認待ち・世帯なし」ではない。proxy は profiles の一過性の取得
  // 失敗でも承認済みの世帯員をここへ送る（F1 / F3 / REG-05）。その時に破棄すれば本人の
  // オフライン用スナップショットを消すゆえ、可否は page.tsx の確認結果に従う。
  // LAST_USER_ID には触れぬ（鍵の持ち主は (main) の CacheUserGuard。残しておけば
  // 承認後に (main) へ入った時、guard が持ち主の交代として改めて破棄を試みる）。
  useEffect(() => {
    if (!allowCachePurge) return
    void purgeHouseholdCaches().then((purged) => {
      if (!purged) {
        console.warn("[pending-content] 前の利用者の世帯キャッシュ破棄を確認できず")
      }
    })
  }, [allowCachePurge])

  function handleCheck() {
    setIsChecking(true)
    router.refresh()
    timerRef.current = setTimeout(() => setIsChecking(false), 1500)
  }

  async function handleSignOut() {
    setIsSigningOut(true)
    try {
      const result = await signOut()
      // 成功は redirect（下の catch へ reject として届く）。解決して返ったのは失敗の結果
      // だけじゃ（PR #235 P2）。計測は消さず、押し直せるように戻す
      setIsSigningOut(false)
      toast.error(result.error)
    } catch (err) {
      // signOut の成功は redirect の reject として届く（settings-content と同じ機序）。
      // 端末に残る授乳タイマー（P3-08）を消すのは**成功した時だけ**: 承認済みの世帯員も
      // profiles の一過性の取得失敗でここへ送られうる（export-card の注記と同じ F1 / F3）。
      // その利用者が圏外でログアウトに失敗した時に消すと、ログインしたまま計測だけ失う
      // （レビュー P3-9）。
      // catch 先頭で必ず: signOut() の redirect("/login") 内部エラーは
      // フレームワークへ再送出する（握り潰すと遷移が死ぬ）。
      try {
        unstable_rethrow(err)
      } catch (frameworkSignal) {
        clearPersistedTimer()
        // 承認済みの世帯員がここへ送られてログアウトした時、別タブの (main) の guard が
        // 往復の間に持ち主を書き戻しておりうる（settings-content と同じ機序・独立レビュー r4）。
        // 成功ゆえ cookie は消えておる。待たぬ
        void clearCacheOwner()
        throw frameworkSignal
      }
      // ここへ来たのは本物の失敗（圏外など）。計測は残す。
      // 圏外 reject でボタンが固まったままにしない。
      setIsSigningOut(false)
      toastOfflineError("[pending-content] signOut", err)
    }
  }

  return (
    <div className="bg-hearth flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="glass rounded-2xl p-6 text-center shadow-lg shadow-black/[0.04]">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10">
            <Clock className="size-6 text-primary" aria-hidden="true" />
          </div>

          {approvalStatus === "pending" ? (
            <>
              {/* 見出しの文言は e2e（approval-gate.spec.ts）が名前で掴む。変えるなら両方を */}
              <h2 className="text-lg font-semibold text-foreground">
                承認待ち
              </h2>
              {/* ⚠️ 承認は世帯への参加ではない（P2-26 / P1-02）。承認するのはこのアプリの
                  管理者（運用者）で、承認されると**自分の世帯を作れる**だけじゃ。家族の世帯へは
                  招待リンクで入る（proxy は未承認でも /invite/ を通し、受諾が承認も付ける）。
                  「承認を待てば家族の世帯に入れる」と読める文言は、世帯を二つに割る誘因になる */}
              <p className="mt-2 text-sm text-muted-foreground">
                このアプリの管理者が登録を承認すると、自分の世帯をつくって使い始められます。
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                ご家族の世帯に参加する場合は、承認を待つ必要はありません。世帯のメンバーに招待リンクを送ってもらい、このアカウントのままリンクを開いてください。
              </p>
            </>
          ) : (
            <>
              {/* 承認済みの世帯員が一過性の取得失敗でここへ来ることがある。「承認待ち」と
                  断定せず、確認ボタン（router.refresh で proxy を通し直す）へ導く */}
              <h2 className="text-lg font-semibold text-foreground">
                承認状態を確認できませんでした
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                通信が不安定な可能性があります。少し待ってから「承認状態を確認」を押してください。
              </p>
            </>
          )}

          <div className="mt-6 flex flex-col gap-3">
            <Button
              onClick={handleCheck}
              disabled={isChecking}
              className="min-h-11 w-full rounded-lg text-base font-semibold"
            >
              {isChecking ? (
                <>
                  <Loader2 className="animate-spin" />
                  確認中...
                </>
              ) : (
                <>
                  <RefreshCw className="size-4" />
                  承認状態を確認
                </>
              )}
            </Button>

            <Button
              variant="ghost"
              onClick={handleSignOut}
              disabled={isSigningOut}
              className="min-h-11 w-full rounded-lg text-muted-foreground"
            >
              {isSigningOut ? (
                <Loader2 className="animate-spin" />
              ) : (
                <LogOut className="size-4" />
              )}
              ログアウト
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { markFeedbackSeen } from "@/app/(main)/feedback/actions"
import { useVisibilityRefetch } from "@/lib/hooks/use-visibility-refetch"
import { logOfflineError } from "@/lib/utils/offline-error"

/**
 * 開いた要望を既読にし、タブ復帰で最新の状態を取り直す（描画は持たぬ）。
 *
 * - 既読は**マウントの後**に書く。Server Component の描画中に書くと、先読みや再描画で
 *   「見ておらぬのに既読」になりうる
 * - タブ復帰（visibilitychange / focus）でも既読を書き直してから画面を取り直す。開いたまま
 *   運用者の更新が来た時、それを画面で見た上で未読の印を消すため
 * - 失敗は利用者の操作ではないゆえトーストを出さず、ログだけ残す（握り潰さぬ）
 *
 * Server Action の呼び出しは fetch と違い中断できぬ。古い応答が新しい画面を上書きする
 * 心配は無い（返り値を画面へ書かぬ）ゆえ、AbortController は持たぬ。
 */
export function FeedbackSeenMarker({ feedbackId }: { feedbackId: string }) {
  const router = useRouter()

  useEffect(() => {
    markFeedbackSeen(feedbackId).catch((err: unknown) => {
      logOfflineError("[feedback-seen-marker] markFeedbackSeen", err)
    })
  }, [feedbackId])

  useVisibilityRefetch(() => {
    markFeedbackSeen(feedbackId)
      .catch((err: unknown) => {
        logOfflineError("[feedback-seen-marker] markFeedbackSeen", err)
      })
      .finally(() => router.refresh())
  })

  return null
}

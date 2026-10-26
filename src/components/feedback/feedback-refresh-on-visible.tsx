"use client"

import { useRouter } from "next/navigation"
import { useVisibilityRefetch } from "@/lib/hooks/use-visibility-refetch"

/**
 * 一覧・受信箱をタブ復帰で取り直す（描画は持たぬ）。
 *
 * 要望の表は Realtime に載せておらぬ（migration の明文宣言）。開いたまま運用者が状態を
 * 変えた時は、アプリへ戻った瞬間に画面を揃える —— Push が届かぬ端末でも、アプリ内の
 * 表示が正本として追いつく経路じゃ。
 */
export function FeedbackRefreshOnVisible() {
  const router = useRouter()
  useVisibilityRefetch(() => router.refresh())
  return null
}

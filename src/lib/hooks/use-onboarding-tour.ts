"use client"

import { useCallback, useEffect, useState } from "react"

/**
 * 使い方ツアーの表示状態を管理するフック。
 *
 * 既読判定は localStorage（端末単位）で行う。migration 不要・server round-trip
 * ゼロで軽量なため、2 人家族用途にはこれで十分。cross-device 永続が要件化したら
 * profiles テーブルへ has_seen_tour 列を足す upgrade path を取る。
 *
 * localStorage は必ず useEffect で読む。useState 初期化子で読むと SSR（空）と
 * client（表示）で hydration mismatch になるため。
 */

// コンテンツを更新したら v2 に上げると、既読ユーザーにも再度表示できる。
const TOUR_SEEN_KEY = "irori:tour-seen:v1"

/** 設定画面などからツアー再表示を要求するイベント名。 */
export const OPEN_TOUR_EVENT = "irori:open-tour"

function hasSeenTour(): boolean {
  try {
    return localStorage.getItem(TOUR_SEEN_KEY) === "1"
  } catch {
    // プライベートモード等で localStorage 不可 → 既読扱いにして邪魔しない
    return true
  }
}

function markTourSeen(): void {
  try {
    localStorage.setItem(TOUR_SEEN_KEY, "1")
  } catch {
    // 記録できなくても致命ではない（毎回出るが機能は損なわれない）
  }
}

/** 設定画面などから呼ぶ。マウント済みの OnboardingTour を再度開く。 */
export function reopenOnboardingTour(): void {
  window.dispatchEvent(new Event(OPEN_TOUR_EVENT))
}

export function useOnboardingTour() {
  const [open, setOpen] = useState(false)

  // 初回のみ既読判定。未読なら自動表示。localStorage は SSR で読めないため
  // 初期化子ではなく effect で読む（hydration mismatch 回避）。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage の既読判定で初回のみ表示
    if (!hasSeenTour()) setOpen(true)
  }, [])

  // 設定からの再表示イベントを購読
  useEffect(() => {
    const handler = () => setOpen(true)
    window.addEventListener(OPEN_TOUR_EVENT, handler)
    return () => window.removeEventListener(OPEN_TOUR_EVENT, handler)
  }, [])

  // 閉じる時点で既読フラグを立てる（スキップ・完了のいずれでも）
  const dismiss = useCallback(() => {
    markTourSeen()
    setOpen(false)
  }, [])

  return { open, dismiss }
}

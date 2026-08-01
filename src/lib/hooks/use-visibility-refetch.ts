"use client"

import { useEffect, useRef } from "react"

/**
 * タブ復帰（`visibilitychange` で visible になった時）と `focus` で `cb` を呼ぶ。
 *
 * **なぜ必要か**: Supabase Realtime の DELETE は、フィルタ付き購読では構造的に
 * 配信されない（公式 docs: "You can't filter Delete events when tracking Postgres
 * Changes"。`REPLICA IDENTITY FULL` にしても RLS 有効テーブルでは old が PK のみ）。
 * さらに postgres_changes 自体が本番で間欠不達（issue #92）。ゆえに
 * 「相手が消した行が自分の画面から消えない」等は復帰時 refetch でしか回収できぬ。
 *
 * **このフックがやらないこと（意図的な境界）**: 世代ガード・`AbortController`・
 * 日付や月の窓の絞り込みといった**画面固有の防御はコールバック側に残す**。
 * ここはリスナの張り外しだけを担う中立な部品じゃ（防御をフックへ吸い上げると、
 * 画面ごとに異なる stale 判定を一つの形へ押し込めて防御が薄くなる）。
 *
 * `cb` は ref に退避して `useEffect` の deps を空にする。呼び出し側が
 * `useCallback` を付け忘れても再購読が暴れない（毎レンダーで addEventListener /
 * removeEventListener が走らない）ようにするため。
 */
export function useVisibilityRefetch(cb: () => void): void {
  const cbRef = useRef(cb)
  useEffect(() => {
    cbRef.current = cb
  }, [cb])

  useEffect(() => {
    const onVisible = () => {
      // focus 経由でも「表示されている」ことを一律で確認する。バックグラウンドの
      // タブが focus イベントを受ける経路（別ウィンドウ操作等）で無駄に叩かない。
      if (document.visibilityState !== "visible") return
      cbRef.current()
    }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", onVisible)
    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", onVisible)
    }
  }, [])
}

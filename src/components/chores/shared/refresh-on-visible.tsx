"use client"

import { useEffect, useRef } from "react"
import { useVisibilityRefetch } from "@/lib/hooks/use-visibility-refetch"
import { CHORES_REFRESH_MESSAGES, useChoresRefresh } from "./use-chores-refresh"

/** 定期再取得の下限（ms）。これより短い指定はここまで延ばす（Server の再描画を叩き続けぬ）。 */
export const REFRESH_POLL_MIN_MS = 10_000

/**
 * 他の端末（家族）の変更を取り込む薄い部品。家事の表は Realtime に載せておらぬゆえ、反映は
 * 「この画面へ戻ったとき」と、`pollMs` を渡した画面では「開いている間の定期再取得」だけじゃ。
 *
 * その反映タイミングを**文で示す**（即時に同期されると誤解させぬ）。`showNote={false}` で文を
 * 出さず取り込みだけ行える（更新できなんだ時の理由は、その場合も出す）。
 *
 * 取り直しは `useChoresRefresh`（`router.refresh()` を直に呼ばぬ。圏外・サーバーへ届かぬ時は
 * 直前の表示を保つ）。自動の取り直しは、保存の送信中・入力の途中・シートが開いている間は
 * 見送る（`refresh-gate.ts`）。画面が自分で「今は止めたい」と分かる時は `paused` を渡す。
 * 「今すぐ更新」は利用者の操作ゆえ見送らぬ。
 */
export function RefreshOnVisible({
  pollMs,
  showNote = true,
  paused = false,
}: {
  /** 表示中の定期再取得の間隔（ms）。省略すれば復帰時だけ */
  pollMs?: number
  showNote?: boolean
  /** true の間、自動の取り直しを見送る（未保存の入力が在る等） */
  paused?: boolean
}) {
  const { refresh, notice } = useChoresRefresh()
  const interval = pollMs !== undefined && pollMs > 0 ? Math.max(pollMs, REFRESH_POLL_MIN_MS) : undefined
  const auto = () => refresh("auto", { paused })
  useVisibilityRefetch(auto, interval)

  // 回線が戻った時にも取り直す（「オフラインのため更新していません」を出したままにせぬ）
  const autoRef = useRef(auto)
  useEffect(() => {
    autoRef.current = auto
  })
  useEffect(() => {
    const onOnline = () => {
      if (document.visibilityState === "visible") autoRef.current()
    }
    window.addEventListener("online", onOnline)
    return () => window.removeEventListener("online", onOnline)
  }, [])

  const manual = (
    <button
      type="button"
      onClick={() => refresh("manual")}
      className="touch-target shrink-0 cursor-pointer rounded-lg px-2 font-medium text-primary transition-colors duration-200 hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-ring"
    >
      今すぐ更新
    </button>
  )
  const reason = notice && (
    <p role="status" className="text-xs text-foreground">
      {CHORES_REFRESH_MESSAGES[notice]}
      {notice === "held" && "「今すぐ更新」で読み直せます。"}
    </p>
  )

  if (!showNote) {
    if (!notice) return null
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1">{reason}</div>
        {manual}
      </div>
    )
  }
  const timing =
    interval === undefined
      ? "この画面に戻ったとき"
      : `この画面に戻ったときと、開いている間は約${Math.round(interval / 1000)}秒ごと`
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <p className="flex-1">ほかの端末での変更は、{timing}に反映されます。</p>
        {manual}
      </div>
      {reason}
    </div>
  )
}

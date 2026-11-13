"use client"

import { AlertCircle, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CHORES_REFRESH_MESSAGES, useChoresRefresh } from "./use-chores-refresh"

/**
 * 区画の取得失敗。「読めなかった」を「ありません」と言い換えぬための表示じゃ
 * （`{what}がないとは限りません` まで言う）。画面全体が読めぬ時は `KeepLastGood` へ。
 *
 * 再読込は既定で `useChoresRefresh`（Server Component が取得する画面向け。圏外・サーバーへ
 * 届かぬ時は画面を保ち、理由を出す）。クライアントで取り直す画面は `onRetry` を渡す。
 */
export function SectionError({
  what,
  onRetry,
}: {
  /** 読めなかったもの（例: 「買い物リスト」） */
  what: string
  onRetry?: () => void
}) {
  const { refresh, notice } = useChoresRefresh()
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm"
    >
      <p className="flex items-start gap-2 text-destructive">
        <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          {what}を読み込めませんでした。{what}がないとは限りません。
        </span>
      </p>
      <Button
        type="button"
        variant="outline"
        className="cursor-pointer"
        onClick={() => (onRetry ? onRetry() : refresh("manual"))}
      >
        <RotateCw size={16} aria-hidden="true" />
        もう一度読み込む
      </Button>
      {!onRetry && notice && notice !== "held" && <p className="text-foreground">{CHORES_REFRESH_MESSAGES[notice]}</p>}
    </div>
  )
}

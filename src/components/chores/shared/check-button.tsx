"use client"

import { Check, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * 1 タップの完了・購入チェック（`role="checkbox"`）。
 *
 * - 押下領域は要素そのものが 44x44px（`size-11`）。素の `<input type="checkbox">` は箱が小さく、
 *   実測の 44px 検査（e2e/touch-targets.spec.ts）に通らぬゆえ、button で作る
 * - 状態は `aria-checked` と**チェックの印**で示す（色だけに頼らぬ）
 * - キーボード: button ゆえ Tab で届き、Space / Enter で切り替わる
 * - 値は持たぬ（制御部品）。保存の結果が出るまでの表示は呼び出し側が決め、送信中は `busy` を渡す
 */
export function CheckButton({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  busy = false,
  describedBy,
  className,
}: {
  checked: boolean
  onCheckedChange: (next: boolean) => void
  /** 読み上げ名（例: 「牛乳を購入済みにする」ではなく対象名「牛乳」。状態は aria-checked が伝える） */
  label: string
  disabled?: boolean
  /** 送信中。印の代わりに回転を出し、押下は受けぬ */
  busy?: boolean
  describedBy?: string
  className?: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-xl transition-colors duration-200 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex size-6 items-center justify-center rounded-md border-2 transition-colors duration-200",
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground bg-background text-muted-foreground",
        )}
      >
        {busy ? (
          <Loader2 size={14} className="animate-spin" />
        ) : checked ? (
          <Check size={16} strokeWidth={3} />
        ) : null}
      </span>
    </button>
  )
}

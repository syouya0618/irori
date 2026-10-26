import {
  CircleCheck,
  CircleHelp,
  CircleSlash,
  Inbox,
  Lightbulb,
  Wrench,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { feedbackStatusLabel, type FeedbackStatus } from "@/lib/domain/feedback"

const STATUS_ICONS: Record<FeedbackStatus, LucideIcon> = {
  received: Inbox,
  considering: Lightbulb,
  in_progress: Wrench,
  released: CircleCheck,
  declined: CircleSlash,
}

/**
 * 要望の状態の印（文字 + アイコン。色だけで示さぬ）。
 *
 * - 「反映済み」の塗り（主色）は `released` が**証拠付きで**真の時だけ。状態が released でも
 *   証拠が欠ければ中立の「状態を確認中」へ倒す（DB の CHECK が許さぬ形じゃが、画面は
 *   推測で「反映済み」を描かぬ）
 * - 文字を載せる帯に `bg-primary/10 text-primary` は使わぬ（4.15:1 で 4.5:1 に届かぬ。
 *   DESIGN_SYSTEM.md）。主色の塗りは `bg-primary text-primary-foreground`（4.92:1）
 */
export function FeedbackStatusBadge({
  status,
  released,
  className,
}: {
  status: FeedbackStatus | null
  /** 証拠（本番確認の時刻と SHA）が揃った released か（`releaseOf()` の結果） */
  released: boolean
  className?: string
}) {
  const effective: FeedbackStatus | null =
    status === "released" && !released ? null : status
  const Icon = effective ? STATUS_ICONS[effective] : CircleHelp
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-sm font-medium",
        effective === "released"
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-foreground ring-1 ring-border ring-inset",
        className,
      )}
    >
      <Icon size={14} aria-hidden="true" />
      {feedbackStatusLabel(effective)}
    </span>
  )
}

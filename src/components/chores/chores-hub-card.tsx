import type { ReactNode } from "react"
import Link from "next/link"
import { ChevronRight, type LucideIcon } from "lucide-react"

/**
 * 家事ハブ（/chores）の入口カード。アイコン + 名称 + 一行説明 + 任意の「今日の要約」。
 *
 * 境界指令を持たぬ（Server Component の page がアイコンと要約を渡せる）。
 *
 * `summary` はカード全体がリンクの中に入るゆえ、**文と装飾だけ**を渡すこと（ボタン・リンクを
 * 入れ子にせぬ）。要約を読めなかった時は「ありません」ではなく「確認できませんでした」等を渡す。
 */
export function ChoresHubCard({
  href,
  icon: Icon,
  title,
  description,
  summary,
}: {
  href: string
  icon: LucideIcon
  title: string
  description: string
  summary?: ReactNode
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      className="glass flex min-h-11 items-center gap-3 rounded-2xl px-4 py-4 shadow-lg shadow-black/[0.04] transition-colors duration-200 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span
        aria-hidden="true"
        className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/10"
      >
        <Icon size={22} className="text-primary" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-base font-semibold">{title}</span>
        <span className="text-sm text-muted-foreground">{description}</span>
        {summary != null && (
          <span data-slot="chores-hub-summary" className="mt-1 text-sm font-medium break-words">
            {summary}
          </span>
        )}
      </span>
      <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-muted-foreground" />
    </Link>
  )
}

import Link from "next/link"
import { ChevronRight } from "lucide-react"
import type { FeedbackListItem } from "@/lib/domain/feedback-view"
import { FeedbackStatusBadge } from "@/components/feedback/feedback-status-badge"

/**
 * 要望の一覧（投稿者の一覧・運用者の受信箱の共用）。
 * 1 行全体が押下領域（44px 以上）。目印は文字で示す（色だけで示さぬ）。
 */
export function FeedbackList({
  items,
  label,
}: {
  items: FeedbackListItem[]
  /** 一覧の読み上げ名 */
  label: string
}) {
  return (
    <ul
      aria-label={label}
      className="glass flex flex-col divide-y divide-border overflow-clip rounded-2xl shadow-lg shadow-black/[0.04]"
    >
      {items.map((item) => (
        <li key={item.id}>
          <Link
            href={item.href}
            className="flex min-h-11 items-center gap-3 px-4 py-3 transition-colors duration-200 hover:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <p className="line-clamp-2 text-base font-medium break-words">
                {item.title}
              </p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                <FeedbackStatusBadge status={item.status} released={item.released} />
                {item.marker && (
                  <span className="inline-flex items-center gap-1 font-semibold text-foreground">
                    <span aria-hidden="true" className="size-2 rounded-full bg-primary" />
                    {item.marker}
                  </span>
                )}
                {item.submitterName && <span>{item.submitterName}</span>}
                <span>{item.metaLabel}</span>
              </div>
            </div>
            <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-muted-foreground" />
          </Link>
        </li>
      ))}
    </ul>
  )
}

"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { segmentCn } from "@/lib/utils/segment-cn"

export interface SegmentLinkItem {
  href: string
  label: string
}

function isUnder(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`)
}

/**
 * 今の path に当たる項目の href。複数が当たる時（`/chores/meals` と `/chores/meals/plan`）は
 * 最も長い href を採る（親が子の画面でも現在地に見えぬよう）。どれにも当たらねば null。
 */
export function activeSegmentHref(pathname: string, items: readonly SegmentLinkItem[]): string | null {
  let best: string | null = null
  for (const { href } of items) {
    if (isUnder(pathname, href) && (best === null || href.length > best.length)) best = href
  }
  return best
}

/**
 * 下位 route 間の切替（タブ部品の代替）。見た目は `segmentCn`、現在地は塗り + `aria-current="page"`。
 *
 * 項目は 2〜5 個を想定（320px 幅で 1 項目 44px 以上を保てる数）。ラベルは短い名詞にする。
 */
export function SegmentLinks({
  items,
  label,
  className,
}: {
  items: readonly SegmentLinkItem[]
  /** nav の名前（例: 「ごはんの画面」） */
  label: string
  className?: string
}) {
  const pathname = usePathname() ?? ""
  const active = activeSegmentHref(pathname, items)
  return (
    <nav aria-label={label} className={className}>
      <div className="flex gap-1 rounded-xl bg-muted/50 p-1">
        {items.map((item) => {
          const isActive = item.href === active
          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                segmentCn(isActive),
                "flex min-w-11 items-center justify-center text-center focus-visible:outline-2 focus-visible:outline-ring",
              )}
            >
              {item.label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}

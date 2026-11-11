"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { SlidersHorizontal } from "lucide-react"

import { activeSegmentHref } from "@/components/chores/shared/segment-links"
import { cn } from "@/lib/utils"
import { segmentCn } from "@/lib/utils/segment-cn"

import { MEAL_HIDDEN_SEGMENTS, MEAL_SEGMENTS, MEALS_SETTINGS_HREF } from "./meal-routes"

const ALL_SEGMENTS = [...MEAL_SEGMENTS, ...MEAL_HIDDEN_SEGMENTS]

/** 今の path が属する、ごはんの下位 route の href（切替に並べない設定・レシピを含む）。 */
function useActiveMealHref(): string | null {
  const pathname = usePathname() ?? ""
  return activeSegmentHref(pathname, ALL_SEGMENTS)
}

/**
 * ごはんの下位 5 画面の切替。
 *
 * 見た目と現在地の示し方は家事共通の `SegmentLinks` と同じ（`segmentCn` の塗り +
 * `aria-current="page"`）。共通部品をそのまま使わない理由は 2 つ:
 * - 設定・レシピの画面では、どの項目も現在地にしない（共通部品は最も近い親の「今夜」を現在地にする）。
 * - 「今あるもので」が長く、320px 幅で 5 項目を 1 行に等分すると 1 項目の文字が 3 行に割れる。
 *   ここは項目を文字幅で並べ、入りきらない分を次の行へ送る（項目の中では折り返さない）。
 */
export function MealsNav({ className }: { className?: string }) {
  const active = useActiveMealHref()
  return (
    <nav aria-label="ごはんの画面" className={className}>
      <div className="flex flex-wrap gap-1 rounded-xl bg-muted/50 p-1">
        {MEAL_SEGMENTS.map((item) => {
          const isActive = item.href === active
          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                segmentCn(isActive),
                "flex min-w-11 flex-auto items-center justify-center text-center whitespace-nowrap focus-visible:outline-2 focus-visible:outline-ring",
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

/** ごはんの設定への入口（44px のアイコンリンク）。設定の画面では現在地として示す。 */
export function MealsSettingsLink({ className }: { className?: string }) {
  const isActive = useActiveMealHref() === MEALS_SETTINGS_HREF
  return (
    <Link
      href={MEALS_SETTINGS_HREF}
      prefetch={false}
      aria-label="ごはんの設定"
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "glass flex size-11 shrink-0 items-center justify-center rounded-2xl shadow-lg shadow-black/[0.04] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-ring",
        isActive ? "text-primary" : "text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      <SlidersHorizontal size={20} strokeWidth={isActive ? 2.5 : 2} aria-hidden="true" />
    </Link>
  )
}

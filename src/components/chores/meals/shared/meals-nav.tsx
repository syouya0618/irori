"use client"

import { Suspense } from "react"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { ChevronLeft, SlidersHorizontal } from "lucide-react"

import { activeSegmentHref } from "@/components/chores/shared/segment-links"
import { cn } from "@/lib/utils"
import { segmentCn } from "@/lib/utils/segment-cn"
import { scheduleReturnHref } from "@/components/chores/meals/schedule/schedule-query"

import {
  MEAL_HIDDEN_SEGMENTS,
  MEAL_SEGMENTS,
  MEALS_BASE_HREF,
  MEALS_MEMO_HREF,
  MEALS_NOW_HREF,
  MEALS_PLAN_HREF,
  MEALS_PANTRY_HREF,
  MEALS_RECIPES_HREF,
  MEALS_SETTINGS_HREF,
  MEALS_SHOPPING_HREF,
} from "./meal-routes"

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
  const current =
    active === MEALS_PLAN_HREF || active === MEALS_NOW_HREF
      ? MEALS_BASE_HREF
      : active === MEALS_SHOPPING_HREF
        ? MEALS_MEMO_HREF
        : active
  return (
    <nav aria-label="ごはんの画面" className={className}>
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-muted/50 p-1">
        {MEAL_SEGMENTS.map((item) => {
          const isActive = item.href === current
          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                segmentCn(isActive),
                "flex min-h-11 min-w-0 items-center justify-center rounded-lg px-2 text-center text-xs whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-ring sm:text-sm",
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

function MealBackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} prefetch={false} aria-label={label}
      className="absolute left-0 top-0 flex size-11 items-center justify-center rounded-xl text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
      <ChevronLeft size={20} aria-hidden="true" />
    </Link>
  )
}

/** 詳細編集のURLにある開始日を保持し、同じ週の一覧へ戻す。 */
function PlanBackLink() {
  const params = useSearchParams()
  return <MealBackLink href={scheduleReturnHref(params.get("start"))} label="週間スケジュールへ戻る" />
}

/** 承認済みカンプに合わせたごはん専用ヘッダー。戻る導線と設定はタップ領域を維持する。 */
export function MealsHeader() {
  const pathname = usePathname() ?? ""
  const active = useActiveMealHref()
  const title =
    active === MEALS_PANTRY_HREF ? "冷蔵庫の在庫" :
    active === MEALS_NOW_HREF ? "料理の候補" :
    active === MEALS_MEMO_HREF || active === MEALS_SHOPPING_HREF ? "メモ" :
    active === MEALS_SETTINGS_HREF ? "ごはんの設定" :
    active === MEALS_RECIPES_HREF ? "料理の詳細" :
    pathname.startsWith(MEALS_PLAN_HREF) ? "献立の詳細" : "スケジュール"

  return (
    <header className="relative flex flex-col items-center gap-1 pb-1" data-testid="meals-header">
      {active === MEALS_PLAN_HREF ? (
        <Suspense fallback={<MealBackLink href={MEALS_BASE_HREF} label="週間スケジュールへ戻る" />}>
          <PlanBackLink />
        </Suspense>
      ) : (
        <MealBackLink href="/chores" label="家事" />
      )}
      <Link href={MEALS_BASE_HREF} prefetch={false} aria-label="irori ごはんのトップ"
        className="inline-flex min-h-11 items-center justify-center rounded-lg px-2 text-[24px] font-extrabold tracking-[-0.065em] leading-none text-primary focus-visible:outline-2 focus-visible:outline-ring">
        irori
      </Link>
      <h1 className="text-lg font-bold leading-tight text-foreground">{title}</h1>
      <MealsSettingsLink className="absolute top-0 right-0" />
    </header>
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

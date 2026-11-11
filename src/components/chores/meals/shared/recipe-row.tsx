import type { ReactNode } from "react"
import Link from "next/link"

import type { DishVerdict } from "@/lib/meals/exclusions"
import type { Sufficiency } from "@/lib/meals/pantry-match"
import { dishRoleLabel, formatMinutes } from "@/lib/meals/server/format"
import type { PlanEntry } from "@/lib/meals/types"
import { cn } from "@/lib/utils"

import { OriginLabel, PinnedMark, SufficiencyMark, VerdictMark } from "./meal-marks"

export interface RecipeRowProps {
  /** 料理名（カタログのレシピ名、または手動料理の名前）。 */
  title: string
  /** 料理区分（主菜・副菜・汁物・主食）。未知の値は「料理」と出す。 */
  role?: string
  /** 調理時間の目安（分）。手動料理など時間を持たない料理は渡さない（「時間不明」と出さない）。 */
  minutes?: number | null
  /** 献立の枠を作った経路。提案の一覧など経路を持たない行では渡さない。 */
  origin?: PlanEntry["origin"]
  /** 必須除外の判定。`ok` は印を出さない。 */
  verdict?: DishVerdict
  /** 在庫との突き合わせ。作り終えた枠・材料の無い手動料理は null（印を出さない）。 */
  sufficiency?: Sufficiency | null
  pinned?: boolean
  /** レシピ詳細への href。渡すと料理名がリンクになる（行全体はリンクにしない — 行内に操作を置ける）。 */
  href?: string
  /** 右端に置く操作（44px 以上の部品）。 */
  trailing?: ReactNode
  /** 行の下に置く補足（不足分・理由・操作など）。 */
  children?: ReactNode
  className?: string
}

/**
 * 料理 1 件の行。料理名・区分・時間・出所・除外や要確認の印・在庫の充足を、同じ並びで出す。
 *
 * 境界指令を持たない（Server Component からも Client Component からも描ける）。
 * カードの枠は持たない（呼び出し側が `glass` のカードや一覧の中に置く）。
 */
export function RecipeRow({
  title,
  role,
  minutes,
  origin,
  verdict,
  sufficiency,
  pinned = false,
  href,
  trailing,
  children,
  className,
}: RecipeRowProps) {
  const hasMeta = role !== undefined || minutes !== undefined || origin !== undefined || pinned
  const hasMarks = (sufficiency !== undefined && sufficiency !== null) || (verdict !== undefined && verdict !== "ok")
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          {hasMeta && (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              {role !== undefined && <span>{dishRoleLabel(role)}</span>}
              {minutes !== undefined && <span>{formatMinutes(minutes)}</span>}
              {origin !== undefined && <OriginLabel origin={origin} />}
              {pinned && <PinnedMark />}
            </p>
          )}
          {href !== undefined ? (
            <Link
              href={href}
              prefetch={false}
              className="inline-flex min-h-11 min-w-11 items-center rounded-lg text-base font-medium break-words underline decoration-border underline-offset-4 transition-colors duration-200 hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
            >
              {title}
            </Link>
          ) : (
            <p className="text-base font-medium break-words">{title}</p>
          )}
        </div>
        {trailing != null && <div className="flex shrink-0 items-center gap-1">{trailing}</div>}
      </div>
      {hasMarks && (
        <div className="flex flex-wrap items-center gap-1.5">
          {sufficiency !== undefined && sufficiency !== null && <SufficiencyMark level={sufficiency} />}
          {verdict !== undefined && <VerdictMark verdict={verdict} />}
        </div>
      )}
      {children}
    </div>
  )
}

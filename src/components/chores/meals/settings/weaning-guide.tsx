import { ChevronDown } from "lucide-react"

import { MealNotice } from "@/components/chores/meals/shared/meal-notices"
import type { GuidanceSourceView } from "@/lib/meals/server/views"

import { GuidanceSources } from "../basics/guidance-sources"

export interface WeaningGuideStage {
  id: string
  label: string
  ageLabel: string
  texture: string
}

/**
 * 離乳の段階の一般案内（出典つき）。**個別のレシピの対応とは別**であることを本文で言う。
 *
 * - データ（段階名・月齢の目安・調理形態・注記・出典）は Server Component がカタログから渡す。
 *   ここで文を足さない・言い換えない（生成 AI にも書かせない）。
 * - 開閉は `<details>`（JavaScript なしで動く。見出しの行は 44px）。
 * - 境界指令を持たない（Server Component から描き、設定画面の Client Component へ差し込む）。
 */
export function WeaningGuide({
  stages,
  notes,
  sources,
}: {
  stages: readonly WeaningGuideStage[]
  notes: readonly string[]
  sources: readonly GuidanceSourceView[]
}) {
  return (
    <details className="group rounded-xl border border-border/60 bg-background/40">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-3 text-sm font-medium transition-colors duration-200 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <span>離乳の段階の一般的な目安（{stages.length}段階）</span>
        <ChevronDown size={18} className="shrink-0 group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="flex flex-col gap-3 px-3 pb-3">
        <ul className="flex flex-col gap-2">
          {stages.map((stage) => (
            <li key={stage.id} data-testid="weaning-stage" className="flex flex-col text-sm">
              <span className="font-medium">
                {stage.label}（{stage.ageLabel}）
              </span>
              <span className="break-words text-muted-foreground">{stage.texture}</span>
            </li>
          ))}
        </ul>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {notes.map((note) => (
            <li key={note} className="break-words">
              {note}
            </li>
          ))}
        </ul>
        <GuidanceSources sources={sources} />
        <MealNotice kind="childGuidance" />
      </div>
    </details>
  )
}

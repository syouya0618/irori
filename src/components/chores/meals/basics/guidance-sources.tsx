import { ExternalLink } from "lucide-react"

import type { GuidanceSourceView } from "@/lib/meals/server/views"

/**
 * 案内の出典の一覧（文書名・発行者・根拠の箇所・確認日）。
 *
 * - リンクは 44px の押下領域を持つ（文中の短いリンクにしない）。新しいタブで開くことを読み上げにも伝える。
 * - 出典表に無い ID は呼び出し側（`views.ts`）が落としている。ここで出典を作らない。
 * - 境界指令を持たない（Server Component からも Client Component からも描ける）。
 */
export function GuidanceSources({
  sources,
  label = "出典",
}: {
  sources: readonly GuidanceSourceView[]
  label?: string
}) {
  if (sources.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <ul className="flex flex-col gap-1">
        {sources.map((source) => (
          <li key={source.id} data-testid="guidance-source" className="flex flex-col text-xs text-muted-foreground">
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 min-w-11 items-center gap-1 rounded-lg text-sm text-foreground underline decoration-border underline-offset-4 transition-colors duration-200 hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">{source.title}</span>
              <ExternalLink size={14} className="shrink-0" aria-hidden="true" />
              <span className="sr-only">（新しいタブで開きます）</span>
            </a>
            <span className="break-words">
              {source.publisher}・{source.pages}・確認日 {source.confirmedOn}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

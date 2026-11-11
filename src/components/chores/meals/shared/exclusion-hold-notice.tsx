import Link from "next/link"
import { AlertCircle, ChevronRight, CircleHelp } from "lucide-react"

import { TEXT_LINK } from "@/components/chores/meals/plan/link-styles"
import { MEALS_SETTINGS_HREF } from "@/components/chores/meals/shared/meal-routes"
import type { ExclusionNoticeView } from "@/lib/meals/server/views"

/** 判定できないアレルギーの登録があるのに、サーバーの文が届いていないときの文（名前は挙げられない）。 */
const HOLD_FALLBACK_TEXT =
  "判定できないアレルギーの登録があるため、料理の原材料を確かめられず、献立を確定できません。設定で一覧から選び直すと、該当する料理だけを外して確定できます。"

/**
 * 判定できない「使わない食材」の登録が、献立・提案へどう効いているかの知らせ
 * （今あるもので・献立・今夜・レシピ詳細で同じ表示）。
 *
 * - アレルギー × 判定できない（`holdsAutoConfirm`）: 該当する料理を見分けられないので、全料理が原材料の
 *   確認待ち（未確認）になり、**献立を確定できない**（自動でも手でも。`confirmDinnerPlan` と 1 品の追加が
 *   未確認の料理を拒む）。「自動では」と弱めて言わない。なぜ止まっているかと、直す場所を言う。
 * - 苦手 × 判定できない: 献立は止めないが、**何も除外されていない**。除外できているように見せない。
 *
 * 境界指令を持たない（Server Component からも Client Component からも描ける）。読み込み時から在る表示
 * なので alert にはしない（開くたびに読み上げが割り込まないように）。該当が無ければ何も描かない。
 */
export function ExclusionHoldNotice({ notice }: { notice: ExclusionNoticeView | null | undefined }) {
  if (notice === null || notice === undefined) return null
  const holds = notice.holdsAutoConfirm === true
  const noEffect = (notice.undetermined ?? []).filter((item) => item.effect === "no_effect")
  if (!holds && noEffect.length === 0) return null
  const noEffectNames = [...new Set(noEffect.map((item) => item.label))].map((label) => `「${label}」`).join("")

  return (
    <div
      data-testid="exclusion-hold"
      className="flex flex-col items-start gap-2 rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-foreground"
    >
      {holds && (
        <p className="flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
          <span className="min-w-0 break-words">
            <span className="font-semibold">献立を確定できません。</span>
            {notice.holdMessage ?? HOLD_FALLBACK_TEXT}
          </span>
        </p>
      )}
      {noEffect.length > 0 && (
        <p className="flex items-start gap-2">
          <CircleHelp size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 break-words">
            判定できない苦手の登録{noEffectNames}では、何も除外されていません。設定で一覧から選ぶか、食材名で登録し直してください。
          </span>
        </p>
      )}
      <Link href={MEALS_SETTINGS_HREF} prefetch={false} className={TEXT_LINK}>
        使わない食材の設定を開く
        <ChevronRight size={16} aria-hidden="true" />
      </Link>
    </div>
  )
}

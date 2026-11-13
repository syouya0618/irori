import Link from "next/link"
import {
  AlertCircle,
  CalendarDays,
  ChevronRight,
  CircleAlert,
  CookingPot,
  Refrigerator,
  ShoppingCart,
  type LucideIcon,
} from "lucide-react"

import { OUTLINE_LINK } from "@/components/chores/meals/plan/link-styles"
import { planHref, planStartBounds } from "@/components/chores/meals/plan/plan-query"
import { ExclusionHoldNotice } from "@/components/chores/meals/shared/exclusion-hold-notice"
import {
  MEALS_NOW_HREF,
  MEALS_PLAN_HREF,
  MEALS_SHOPPING_HREF,
} from "@/components/chores/meals/shared/meal-routes"
import { RefreshOnVisible } from "@/components/chores/shared/refresh-on-visible"
import { SectionError } from "@/components/chores/shared/section-error"
import { PLAN_STATUS_LABELS, formatMealDate, formatMealDateShort } from "@/lib/meals/server/format"
import type { TonightSummary } from "@/lib/meals/server/plan-views"
import type { PlanConflictView } from "@/lib/meals/server/settings-requests"
import { shiftYmd } from "@/lib/utils/date-jst"

const DINNER_STATE_TEXT: Readonly<Record<TonightSummary["dinner"]["state"], string>> = {
  none: "今日の夕食は、まだ決まっていません。",
  proposed: "提案中です。まだ確定していません（買い物リストには入っていません）。",
  confirmed: "確定済みです。",
  cooked: "作りました。",
  skipped: "今日は作りませんでした。",
}

/** 警告に名前を出す料理の数（残りは件数で言う）。 */
const CONFLICT_PREVIEW = 3

function ActionCard({
  href,
  icon: Icon,
  title,
  description,
}: {
  href: string
  icon: LucideIcon
  title: string
  description: string
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      className="glass flex min-h-20 items-center gap-3 rounded-2xl px-4 py-4 shadow-lg shadow-black/[0.04] transition-colors duration-200 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span aria-hidden="true" className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/10">
        <Icon size={24} className="text-primary" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-base font-semibold">{title}</span>
        <span className="text-sm text-muted-foreground">{description}</span>
      </span>
      <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-muted-foreground" />
    </Link>
  )
}

export interface TonightViewProps {
  /** 今日の献立とまだ買うものの件数。読めなかったときは null（「献立なし」「0 件」と偽らない）。 */
  summary: TonightSummary | null
  /** 今日以降の献立のうち、使わない食材の設定に当たる・原材料を確かめられない料理。 */
  conflicts: PlanConflictView[]
  /** 読めなかった献立の枠の数（0 でなければ、衝突を全部は確かめられていない）。 */
  unreadableEntries: number
}

/**
 * 今夜（/chores/meals）。今日の夕食の状態、主な 2 つの操作、まだ買うものの件数、
 * 使わない食材の設定との衝突の警告を出す。
 *
 * 境界指令を持たない（Server Component として描く。保存の操作は持たない）。
 * 読めなかった区画は「読み込めませんでした」と出し、主な 2 つの操作は読めなくても使える。
 */
export function TonightView({ summary, conflicts, unreadableEntries }: TonightViewProps) {
  const first = conflicts[0]
  const conflictHref =
    first === undefined || summary === null
      ? MEALS_PLAN_HREF
      : planHref(
          // 開始日に選べる範囲を越える日は、その日が 7 日の表示の最後になる開始日へ寄せる
          first.date <= planStartBounds(summary.today).max ? first.date : shiftYmd(first.date, -6),
          summary.today,
        )

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-labelledby="tonight-dinner-heading"
        className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"
      >
        <h2 id="tonight-dinner-heading" className="flex items-center gap-2 text-base font-semibold">
          <CookingPot size={18} aria-hidden="true" className="shrink-0 text-primary" />
          今日の夕食
        </h2>
        {summary === null ? (
          <SectionError what="今日の献立" />
        ) : (
          <>
            <p className="text-xs text-muted-foreground">{formatMealDate(summary.today)}</p>
            <p className="text-sm" data-testid="tonight-state">
              {DINNER_STATE_TEXT[summary.dinner.state] ?? DINNER_STATE_TEXT.none}
            </p>
            {summary.dinner.dishes.length > 0 && (
              <ul className="flex flex-col gap-2">
                {summary.dinner.dishes.map((dish) => (
                  <li key={dish.id} className="flex flex-col gap-1">
                    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-xs text-muted-foreground">{dish.roleLabel}</span>
                      <span className="min-w-0 text-base font-medium break-words">{dish.title}</span>
                      {dish.status !== summary.dinner.state && (
                        <span className="text-xs text-muted-foreground">（{PLAN_STATUS_LABELS[dish.status] ?? ""}）</span>
                      )}
                    </p>
                    {(dish.ageWarnings ?? []).map((warning) => (
                      // 年齢の制約（1 歳未満のはちみつ等）。料理は外さない — 献立・レシピ詳細と同じ注意を出す
                      <p
                        key={`${warning.childId}-${warning.ingredientName}`}
                        role="note"
                        data-testid="tonight-age-warning"
                        className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-foreground"
                      >
                        <CircleAlert size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
                        <span className="min-w-0 break-words">{warning.text}</span>
                      </p>
                    ))}
                  </li>
                ))}
              </ul>
            )}
            {summary.ageRulesChecked === false && summary.dinner.dishes.length > 0 && (
              <p className="text-sm" data-testid="tonight-age-unchecked">
                お子さんの年齢についての注意（1 歳未満のはちみつ等）は、確認できていません。料理のレシピを開いて確認してください。
              </p>
            )}
            <Link href={MEALS_PLAN_HREF} prefetch={false} className={`${OUTLINE_LINK} self-start`}>
              {summary.dinner.state === "none"
                ? "献立を作る"
                : summary.dinner.state === "proposed"
                  ? "献立を見て確定する"
                  : "献立を見る・記録する"}
            </Link>
          </>
        )}
      </section>

      {/* 判定できない「使わない食材」の登録のために、料理を自動では確定していない／何も除外できていない */}
      <ExclusionHoldNotice notice={summary?.exclusions} />

      {(conflicts.length > 0 || unreadableEntries > 0) && (
        <section
          aria-labelledby="tonight-conflict-heading"
          className="flex flex-col gap-2 rounded-2xl border border-destructive/30 bg-destructive/10 p-4"
        >
          <h2 id="tonight-conflict-heading" className="flex items-start gap-2 text-sm font-semibold">
            <AlertCircle size={18} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
            使わない食材の設定と、献立が重なっています
          </h2>
          {conflicts.length > 0 && (
            <>
              <p className="text-sm">
                使わない食材を含む、または原材料を確かめられない料理が {conflicts.length} 品あります。
                勝手には置き換えていません。献立の画面で選び直してください。
              </p>
              <ul className="flex list-disc flex-col gap-0.5 pl-5 text-sm">
                {conflicts.slice(0, CONFLICT_PREVIEW).map((conflict) => (
                  <li key={conflict.entryId} className="break-words">
                    {formatMealDateShort(conflict.date)} {conflict.title}
                    {conflict.pinned && "（固定）"}
                  </li>
                ))}
                {conflicts.length > CONFLICT_PREVIEW && <li>ほか {conflicts.length - CONFLICT_PREVIEW} 品</li>}
              </ul>
            </>
          )}
          {unreadableEntries > 0 && (
            <p className="text-sm">
              表示できない献立の記録が {unreadableEntries} 件あるため、すべては確かめられていません。
            </p>
          )}
          <Link href={conflictHref} prefetch={false} className={`${OUTLINE_LINK} self-start`}>
            献立で選び直す
          </Link>
        </section>
      )}

      <nav aria-label="ごはんの主な操作" className="flex flex-col gap-3">
        <ActionCard
          href={MEALS_NOW_HREF}
          icon={Refrigerator}
          title="今あるもので作る"
          description="登録した食材から、今日作れる料理を探します"
        />
        <ActionCard
          href={MEALS_PLAN_HREF}
          icon={CalendarDays}
          title="1 週間の献立を作る"
          description="1〜7 日分を、ワンタッチで作ります"
        />
      </nav>

      <section
        aria-labelledby="tonight-shopping-heading"
        className="glass flex flex-col gap-2 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"
      >
        <h2 id="tonight-shopping-heading" className="flex items-center gap-2 text-base font-semibold">
          <ShoppingCart size={18} aria-hidden="true" className="shrink-0 text-primary" />
          買い物
        </h2>
        {summary === null ? (
          <SectionError what="買い物リスト" />
        ) : (
          <p className="text-sm" data-testid="tonight-to-buy">
            {summary.toBuyCount > 0 ? (
              <>
                まだ買うものが <span className="text-base font-semibold">{summary.toBuyCount}</span> 件あります。
              </>
            ) : (
              "まだ買うものはありません。"
            )}
          </p>
        )}
        <Link href={MEALS_SHOPPING_HREF} prefetch={false} className={`${OUTLINE_LINK} self-start`}>
          買い物リストを見る
        </Link>
      </section>

      <RefreshOnVisible />
    </div>
  )
}

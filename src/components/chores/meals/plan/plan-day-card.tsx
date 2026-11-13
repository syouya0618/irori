"use client"

import {
  AlertCircle,
  CircleAlert,
  CircleDashed,
  Ellipsis,
  Lock,
  LockOpen,
  PenLine,
  Plus,
  RefreshCw,
  ShoppingCart,
} from "lucide-react"

import { mealRecipeHref } from "@/components/chores/meals/shared/meal-routes"
import { RecipeRow } from "@/components/chores/meals/shared/recipe-row"
import { Button } from "@/components/ui/button"
import type { DinnerDayView, DinnerEntryView } from "@/lib/meals/server/plan-views"
import { cn } from "@/lib/utils"

const STATUS_TONE: Readonly<Record<DinnerEntryView["status"], string>> = {
  proposed: "bg-muted text-foreground ring-1 ring-border ring-inset",
  confirmed: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  cooked: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  skipped: "bg-muted text-muted-foreground ring-1 ring-border ring-inset",
}

/** 提案・確定の枠（差し替え・固定・移動ができる）。 */
function isActive(entry: DinnerEntryView): boolean {
  return entry.status === "proposed" || entry.status === "confirmed"
}

export interface PlanDayCardProps {
  day: DinnerDayView
  /** 世帯の設定の人数（料理の人数がこれと違えば、その旨を添える）。 */
  householdServings?: number
  /** 新しい操作を受けられない（保存中・確認待ち・希望の読み取り中）。 */
  disabled: boolean
  onTogglePin: (entry: DinnerEntryView) => void
  onReplaceDish: (entry: DinnerEntryView) => void
  onReplaceDay: (day: DinnerDayView) => void
  onCooked: (entry: DinnerEntryView) => void
  onSkipped: (entry: DinnerEntryView) => void
  /** 1 品の操作（移動・材料・評価など）を開く。 */
  onOpenEntry: (entry: DinnerEntryView) => void
  onAddCustom: (day: DinnerDayView) => void
}

/**
 * 1 日ぶんの献立のカード。
 *
 * 料理ごとに、区分・時間・出所（自動 / AI 補助 / 手動）・固定の印・在庫の充足・使わない食材との衝突を
 * 同じ並びで出す（色だけで区別しない）。固定した料理は差し替えの釦を止め、理由を文で言う。
 * 足りない区分は、理由と一緒に「不足」として出す（除外を破って埋めていない）。
 */
export function PlanDayCard({
  day,
  householdServings,
  disabled,
  onTogglePin,
  onReplaceDish,
  onReplaceDay,
  onCooked,
  onSkipped,
  onOpenEntry,
  onAddCustom,
}: PlanDayCardProps) {
  const headingId = `plan-day-${day.date}`
  const replaceable = day.entries.some((entry) => isActive(entry) && !entry.pinned)
  const canRecord = day.isToday || day.isPast

  return (
    <li>
      <section
        aria-labelledby={headingId}
        data-testid="plan-day"
        data-date={day.date}
        className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"
      >
        <h3 id={headingId} className="text-base font-semibold">
          {day.label}
        </h3>

        {day.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">この日の献立はまだありません。</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {day.entries.map((entry) => (
              <li
                key={entry.id}
                data-testid="plan-entry"
                className="flex flex-col gap-2 border-t border-border/60 pt-3 first:border-t-0 first:pt-0"
              >
                <RecipeRow
                  title={entry.title}
                  role={entry.role}
                  minutes={entry.minutes ?? undefined}
                  origin={entry.origin}
                  pinned={entry.pinned}
                  sufficiency={entry.stock?.level ?? null}
                  verdict={entry.conflict?.verdict ?? "ok"}
                  href={entry.recipeId !== null ? mealRecipeHref(entry.recipeId) : undefined}
                >
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-medium",
                        STATUS_TONE[entry.status] ?? STATUS_TONE.proposed,
                      )}
                    >
                      {entry.statusLabel}
                    </span>
                    <span>
                      {entry.servings}人分
                      {/* 設定の人数と違う、これから作る料理（買い物はこの料理の人数で計算している） */}
                      {householdServings !== undefined && isActive(entry) && !day.isPast && entry.servings !== householdServings && (
                        <span data-testid="plan-servings-differs">（設定は{householdServings}人分）</span>
                      )}
                    </span>
                  </p>

                  {(entry.ageWarnings ?? []).map((warning) => (
                    // 年齢の制約（1 歳未満のはちみつ等）。料理は外さない・置き換えない — 注意として示す。
                    // 読み込み時から在る表示ゆえ alert にしない
                    <p
                      key={`${warning.childId}-${warning.ingredientName}`}
                      role="note"
                      data-testid="plan-age-warning"
                      className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-foreground"
                    >
                      <CircleAlert size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
                      <span className="min-w-0 break-words">{warning.text}</span>
                    </p>
                  ))}

                  {entry.stock !== null && (entry.stock.missing.length > 0 || entry.stock.toCheck.length > 0) && (
                    <ul className="flex flex-col gap-0.5 text-sm text-muted-foreground">
                      {entry.stock.missing.map((line) => (
                        <li key={`missing:${line.name}`} className="break-words">
                          買い足し: {line.name}（{line.detail}）
                        </li>
                      ))}
                      {entry.stock.toCheck.map((line) => (
                        <li key={`check:${line.name}`} className="break-words">
                          要確認: {line.name}（{line.detail}）
                        </li>
                      ))}
                    </ul>
                  )}

                  {entry.conflict !== null && (
                    // 読み込み時から在る表示ゆえ alert にしない（開くたびに読み上げが割り込まないように）
                    <p data-testid="plan-conflict" className="flex items-start gap-2 text-sm text-foreground">
                      <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
                      <span className="min-w-0 break-words">
                        {entry.conflict.message}
                        {entry.pinned && isActive(entry) && " 固定を解除すると差し替えられます。"}
                      </span>
                    </p>
                  )}

                  {entry.groceryUncomputed && (
                    <div className="flex flex-col items-start gap-1 text-sm">
                      <p className="flex items-start gap-2">
                        <ShoppingCart size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span>
                          {entry.isCustom
                            ? "材料が未登録のため、買い物の自動計算の対象外です。"
                            : "一覧に無い料理のため、買い物の自動計算の対象外です。"}
                        </span>
                      </p>
                      {entry.isCustom && (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={disabled}
                          aria-label={`${entry.title}の材料を追加`}
                          onClick={() => onOpenEntry(entry)}
                        >
                          <PenLine aria-hidden="true" />
                          材料を追加
                        </Button>
                      )}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    {isActive(entry) && (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          aria-pressed={entry.pinned}
                          aria-label={entry.pinned ? `${entry.title}の固定を解除` : `${entry.title}を固定する`}
                          disabled={disabled}
                          onClick={() => onTogglePin(entry)}
                        >
                          {entry.pinned ? <LockOpen aria-hidden="true" /> : <Lock aria-hidden="true" />}
                          {entry.pinned ? "固定を解除" : "固定する"}
                        </Button>
                        {!day.isPast && (
                          <Button
                            type="button"
                            variant="outline"
                            aria-label={`${entry.title}を差し替え`}
                            // 固定した料理は差し替えない（外すのは明示の解除だけ）
                            disabled={disabled || entry.pinned}
                            onClick={() => onReplaceDish(entry)}
                          >
                            <RefreshCw aria-hidden="true" />
                            {entry.conflict !== null ? "選び直す" : "差し替え"}
                          </Button>
                        )}
                        {canRecord && (
                          <>
                            <Button
                              type="button"
                              aria-label={`${entry.title}を「作った」にする`}
                              disabled={disabled}
                              onClick={() => onCooked(entry)}
                            >
                              作った
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              aria-label={`${entry.title}を「作らなかった」にする`}
                              disabled={disabled}
                              onClick={() => onSkipped(entry)}
                            >
                              作らなかった
                            </Button>
                          </>
                        )}
                      </>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label={
                        entry.status === "cooked" ? `${entry.title}の食材と評価を開く` : `${entry.title}の操作を開く`
                      }
                      onClick={() => onOpenEntry(entry)}
                    >
                      <Ellipsis aria-hidden="true" />
                      {entry.status === "cooked" ? "食材と評価" : isActive(entry) ? "移動・その他" : "記録を見る"}
                    </Button>
                  </div>
                </RecipeRow>
              </li>
            ))}
          </ul>
        )}

        {day.missingRoles.length > 0 && (
          <ul aria-label={`${day.label}の不足している料理`} className="flex flex-col gap-1">
            {day.missingRoles.map((missing) => (
              <li key={missing.role} data-testid="plan-gap" className="flex items-start gap-2 text-sm">
                <CircleDashed size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span>
                  <span className="font-medium">{missing.roleLabel}が不足: </span>
                  {missing.message}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap gap-2">
          {!day.isPast && day.entries.length > 0 && (
            <Button
              type="button"
              variant="outline"
              aria-label={`${day.label}の献立を差し替え`}
              disabled={disabled || !replaceable}
              onClick={() => onReplaceDay(day)}
            >
              <RefreshCw aria-hidden="true" />
              この日を差し替え
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            aria-label={`${day.label}に料理を手で追加`}
            disabled={disabled}
            onClick={() => onAddCustom(day)}
          >
            <Plus aria-hidden="true" />
            料理を手で追加
          </Button>
        </div>
        {!day.isPast && day.entries.length > 0 && !replaceable && (
          <p className="text-xs text-muted-foreground">
            この日は固定した料理・作った料理だけのため、差し替えるものがありません。
          </p>
        )}
      </section>
    </li>
  )
}

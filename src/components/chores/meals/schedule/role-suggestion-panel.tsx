"use client"

import { useState, useTransition } from "react"
import { AlertCircle, Check, Loader2, Plus, Sparkles } from "lucide-react"

import {
  suggestMealRole,
  type MealRoleCandidate,
  type SuggestMealRoleResult,
} from "@/app/(main)/chores/meals/suggestions/actions"
import { MealPhoto } from "@/components/chores/meals/shared/meal-photo"
import { Button } from "@/components/ui/button"
import {
  addedDishStatus,
  firstFreePosition,
  type DinnerRequest,
} from "@/lib/meals/server/plan-requests"
import type { DinnerDayView } from "@/lib/meals/server/plan-views"
import type { DishRole } from "@/lib/meals/types"
import { newClientId } from "@/lib/utils/client-id"

const ROLES: readonly { role: DishRole; label: string; icon: string }[] = [
  { role: "main", label: "主菜", icon: "🍳" },
  { role: "side", label: "副菜", icon: "🥗" },
  { role: "staple", label: "主食", icon: "🍚" },
  { role: "soup", label: "汁物", icon: "🍲" },
]

const STOCK_LABEL = {
  ready: { text: "在庫で作れそう", tone: "text-emerald-800 dark:text-emerald-300" },
  check: { text: "分量の確認が必要", tone: "text-amber-800 dark:text-amber-300" },
  buy: { text: "買い足しが必要", tone: "text-muted-foreground" },
} as const

export function RoleSuggestionPanel({
  day,
  revision,
  disabled,
  onAdd,
}: {
  day: DinnerDayView
  revision: number
  disabled: boolean
  /** 1品の採用だけが保存を行い、既存の版ガード・結果不明保護を通す。 */
  onAdd: (request: DinnerRequest) => boolean
}) {
  const [result, setResult] = useState<SuggestMealRoleResult | null>(null)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const activeRoles = new Set(day.entries.filter((entry) => entry.status !== "skipped").map((entry) => entry.role))
  const available = ROLES.filter(({ role }) => !activeRoles.has(role))
  const firstPosition = firstFreePosition(day.entries)

  function suggest(role: DishRole) {
    if (disabled || pending || day.isPast) return
    setError(null)
    setResult(null)
    startTransition(async () => {
      try {
        const next = await suggestMealRole({ date: day.date, role, expectedRevision: revision })
        setResult(next)
      } catch {
        setResult({ ok: false, reason: "unavailable", message: "提案を読み込めませんでした。もう一度お試しください。" })
      }
    })
  }

  function adopt(candidate: MealRoleCandidate) {
    if (disabled || pending || result?.ok !== true) return
    if (result.revision !== revision || activeRoles.has(candidate.role)) {
      setError("献立が更新されています。最新の内容を読み直してから、選び直してください。")
      return
    }
    if (firstPosition === null) {
      setError("この日の料理の枠がいっぱいです。献立を確認してください。")
      return
    }
    const request: DinnerRequest = {
      op: "add_recipe",
      id: newClientId(),
      expectedRevision: result.revision,
      date: day.date,
      recipeId: candidate.recipeId,
      role: candidate.role,
      position: firstPosition,
      servings: day.entries.find((entry) => entry.status === "proposed" || entry.status === "confirmed")?.servings ?? 2,
      status: addedDishStatus(day.entries),
      onlyIfRoleMissing: true,
    }
    if (onAdd(request)) setResult(null)
  }

  if (day.isPast || available.length === 0) return null

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-3" aria-label="足りない料理を提案" data-testid="role-suggestions">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 shrink-0 text-primary" size={18} aria-hidden="true" />
        <div>
          <h3 className="text-sm font-semibold">あと一品、提案する</h3>
          <p className="mt-1 text-xs text-muted-foreground">選んだ種類だけ候補を出します。見るだけでは献立は変わりません。</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="提案する料理の種類">
        {available.map(({ role, label, icon }) => (
          <Button
            key={role}
            type="button"
            variant="outline"
            disabled={disabled || pending}
            aria-pressed={result?.ok === true && result.role === role}
            className="min-h-11 justify-start gap-2 bg-card px-3 text-sm"
            onClick={() => suggest(role)}
          >
            <span aria-hidden="true">{icon}</span>{label}を提案
          </Button>
        ))}
      </div>
      {pending && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="animate-spin" size={16} aria-hidden="true" />食材と好みを確認中…</p>}
      {result?.ok === false && <p role="alert" className="flex items-start gap-2 text-sm"><AlertCircle size={16} className="shrink-0" aria-hidden="true" />{result.message}</p>}
      {error && <p role="alert" className="text-sm">{error}</p>}
      {result?.ok === true && (
        <div className="flex flex-col gap-2" aria-label="提案された料理" data-testid="role-suggestion-results">
          <p className="text-xs text-muted-foreground">提案は{result.choices.length}品。採用した料理だけ追加します。</p>
          {result.choices.length === 0 && <p className="text-sm">安全に提案できる料理がありません。食材・使わない食材の設定をご確認ください。</p>}
          {result.choices.map((candidate) => {
            const stock = STOCK_LABEL[candidate.stock]
            return (
              <div key={candidate.recipeId} className="flex min-w-0 items-center gap-2 rounded-xl border border-border bg-card p-2">
                <MealPhoto recipeId={candidate.recipeId} fallback="🍽️" className="size-12" />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium">{candidate.title}</p>
                  <p className="text-xs text-muted-foreground">{candidate.minutes}分の目安</p>
                  <p className={`text-xs ${stock.tone}`}>{stock.text}</p>
                  {candidate.missingNames.length > 0 && <p className="text-xs text-muted-foreground break-words">買い足し：{candidate.missingNames.join("、")}</p>}
                  {candidate.checkNames.length > 0 && <p className="text-xs text-muted-foreground break-words">確認：{candidate.checkNames.join("、")}</p>}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || pending || firstPosition === null}
                  className="min-h-11 shrink-0 px-2"
                  aria-label={`${candidate.title}を献立へ追加`}
                  onClick={() => adopt(candidate)}
                ><Plus size={16} aria-hidden="true" />採用</Button>
              </div>
            )
          })}
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Check size={14} aria-hidden="true" />
            既存の料理は残し、他の端末が先に変更した場合は上書きしません。
          </p>
        </div>
      )}
    </section>
  )
}

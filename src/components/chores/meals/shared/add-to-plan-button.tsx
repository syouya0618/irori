"use client"

import { createContext, useContext, useId, useState } from "react"
import Link from "next/link"
import { AlertCircle, CalendarPlus, CircleCheck, Loader2 } from "lucide-react"

import { NATIVE_SELECT, OUTLINE_LINK, TEXT_LINK } from "@/components/chores/meals/plan/link-styles"
import { planHref } from "@/components/chores/meals/plan/plan-query"
import { Button } from "@/components/ui/button"
import { dishRoleLabel } from "@/lib/meals/server/format"
import type { DishRole } from "@/lib/meals/types"

import type { AddToPlanDay, AddToPlanSlots } from "./add-to-plan-data"

/**
 * 「献立に入れる」の釦と、その文脈（R48）。
 *
 * 保存の手順（`useChoreSave`・Server Action）は `add-to-plan.tsx` の `AddToPlanProvider` が持つ。
 * ここは Server Action を import しない — 表示だけの Server Component（今あるもので・レシピ詳細）が
 * この釦を置いても、保存のモジュールを巻き込まない。Provider の外では何も描かない。
 */

/** 「献立に入れる」の結果（最後に送った料理の釦のそばに出す）。 */
export interface AddToPlanResult {
  recipeId: string
  date: string
  tone: "status" | "alert"
  text: string
  details: string[]
}

export interface AddToPlanApi {
  slots: AddToPlanSlots
  /** 新しい操作を受けられない（読込前・送信中・確認待ち）。 */
  blocked: boolean
  /** 送信中の料理（釦に送信中の印を出す）。 */
  sendingRecipeId: string | null
  result: AddToPlanResult | null
  /** 受け付けたら true。 */
  add: (recipeId: string, title: string, role: DishRole, date: string) => boolean
}

export const AddToPlanContext = createContext<AddToPlanApi | null>(null)

function dishText(day: AddToPlanDay): string {
  return day.dishes
    .map((dish) => `${dish.roleLabel}「${dish.title}」（${dish.statusLabel}${dish.pinned ? "・固定" : ""}）`)
    .join("、")
}

/**
 * 料理 1 品の「献立に入れる」。`AddToPlanProvider` の外（献立を読めなかった画面など）では何も描かない。
 *
 * 入れる日を選ぶ（既定は今日 = 今夜）。その日に料理が在っても**足せる**（在る料理・固定枠はそのまま残し、
 * 置き換えない。何が残るかを押す前に見せる）。同じ料理が既に在る日・10 品で埋まった日には足さない。
 */
export function AddToPlanButton({ recipeId, title, role }: { recipeId: string; title: string; role: DishRole }) {
  const api = useContext(AddToPlanContext)
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  if (api === null) return null

  const { slots } = api
  const date = picked !== null && slots.days.some((day) => day.date === picked) ? picked : slots.today
  const day = slots.days.find((candidate) => candidate.date === date)
  const result = api.result !== null && api.result.recipeId === recipeId ? api.result : null
  const sending = api.sendingRecipeId === recipeId
  const already = day !== undefined && day.dishes.some((dish) => dish.recipeId === recipeId)
  const full = day !== undefined && day.nextPosition === null
  const dayHref = planHref(date, slots.today)

  return (
    <div data-testid="add-to-plan" className="flex flex-col items-start gap-2">
      <Button
        type="button"
        variant="outline"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${title}を献立に入れる`}
        onClick={() => setOpen((value) => !value)}
      >
        <CalendarPlus aria-hidden="true" />
        献立に入れる
      </Button>

      {open && day !== undefined && (
        <div
          id={panelId}
          role="group"
          aria-label={`${title}を献立に入れる日`}
          className="flex w-full flex-col items-start gap-2 rounded-xl border border-border/60 bg-muted/40 p-3"
        >
          <label htmlFor={`${panelId}-date`} className="text-sm font-medium">
            入れる日
          </label>
          <select
            id={`${panelId}-date`}
            className={NATIVE_SELECT}
            value={date}
            onChange={(event) => setPicked(event.target.value)}
          >
            {slots.days.map((option) => (
              <option key={option.date} value={option.date}>
                {option.label}
                {option.dishes.length > 0 ? `（献立あり・${option.dishes.length}品）` : "（献立なし）"}
              </option>
            ))}
          </select>

          {slots.unreadableEntries > 0 ? (
            <>
              <p className="text-sm break-words">
                表示できない献立の記録が {slots.unreadableEntries} 件あるため、空いている枠を確かめられません。ここからは入れられません。献立の画面で確認してください。
              </p>
              <Link href={dayHref} prefetch={false} className={OUTLINE_LINK}>
                献立の画面を開く
              </Link>
            </>
          ) : already ? (
            <>
              <p className="text-sm break-words">この料理は、すでにこの日の献立に入っています。</p>
              <Link href={dayHref} prefetch={false} className={OUTLINE_LINK}>
                献立の画面でこの日を開く
              </Link>
            </>
          ) : full ? (
            <>
              <p className="text-sm break-words">
                この日は料理が {day.dishes.length} 品あり、これ以上は足せません。献立の画面で整理してください。
              </p>
              <Link href={dayHref} prefetch={false} className={OUTLINE_LINK}>
                献立の画面でこの日を開く
              </Link>
            </>
          ) : (
            <>
              {day.dishes.length > 0 ? (
                <p data-testid="add-to-plan-keeps" className="text-sm break-words">
                  この日の献立（{dishText(day)}）はそのまま残し、「{title}」を{dishRoleLabel(role)}として足します（固定）。
                </p>
              ) : (
                <p className="text-sm break-words">
                  「{title}」を、この日の献立に固定して入れます。ほかの区分は、献立の画面で作れます。
                </p>
              )}
              <p className="text-sm break-words text-muted-foreground">
                {day.addStatus === "confirmed"
                  ? "この日は確定済みのため、確定として足し、材料を買い物リストへ入れます。"
                  : "提案として足します。確定すると、材料が買い物リストに入ります。"}
              </p>
              <Button type="button" disabled={api.blocked} onClick={() => api.add(recipeId, title, role, date)}>
                {sending && <Loader2 className="animate-spin" aria-hidden="true" />}
                この日の献立に入れる
              </Button>
            </>
          )}
        </div>
      )}

      {result !== null && (
        <div className="flex flex-col items-start gap-1" data-testid="add-to-plan-result">
          {result.tone === "alert" ? (
            <p role="alert" className="flex items-start gap-2 text-sm text-foreground">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
              <span className="min-w-0 break-words">{result.text}</span>
            </p>
          ) : (
            <p role="status" className="flex items-start gap-2 text-sm text-foreground">
              <CircleCheck
                size={16}
                className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400"
                aria-hidden="true"
              />
              <span className="min-w-0 break-words">{result.text}</span>
            </p>
          )}
          {result.details.length > 0 && (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
              {result.details.map((detail) => (
                <li key={detail} className="break-words">
                  {detail}
                </li>
              ))}
            </ul>
          )}
          <Link href={planHref(result.date, slots.today)} prefetch={false} className={TEXT_LINK}>
            献立の画面で確認する
          </Link>
        </div>
      )}
    </div>
  )
}

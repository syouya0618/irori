"use client"

import { useRef, useState, type ReactNode } from "react"
import { AlertCircle, CircleCheck } from "lucide-react"

import {
  OTHER_SCREEN_SAVE_TEXTS,
  isMealRequest,
  runMealRequest,
  type MealRequest,
  type MealSaveSuccess,
} from "@/components/chores/meals/plan/meal-request"
import { conflictTextOfDinner } from "@/components/chores/meals/plan/plan-labels"
import { PendingChoreNotice } from "@/components/chores/shared/pending-chore-notice"
import { useChoreSave, type ChoreSaveOutcome } from "@/components/chores/shared/use-chore-save"
import type { ChoreOwner } from "@/lib/domain/chore-pending"
import { formatMealDateShort } from "@/lib/meals/server/format"
import { isDinnerRequest, type DinnerRequest, type DinnerSaveSuccess } from "@/lib/meals/server/plan-requests"
import type { DishRole } from "@/lib/meals/types"
import { newClientId } from "@/lib/utils/client-id"

import { AddToPlanContext, type AddToPlanResult } from "./add-to-plan-button"
import type { AddToPlanSlots } from "./add-to-plan-data"

/** この画面の「献立に入れる」が送った要求か（料理と日付と、足した状態）。 */
interface AddedDish {
  recipeId: string
  date: string
  /** 足した料理の状態。以前の作成（`generate`）で送った控えは null。 */
  status: "proposed" | "confirmed" | null
}

/**
 * 要求から、入れた料理と日付を読む。`add_recipe` が今の形。`generate`（その日 1 日・1 品の固定）は、
 * この版より前に送って結果不明のまま端末に残った控えを確かめ直すときのために読む。
 */
function addedDishOf(request: DinnerRequest): AddedDish | null {
  if (request.op === "add_recipe") return { recipeId: request.recipeId, date: request.date, status: request.status }
  if (request.op !== "generate" || request.days !== 1 || request.constraints === null) return null
  const pin = request.constraints.pins[0]
  return request.constraints.pins.length === 1 && pin !== undefined ? { recipeId: pin.recipeId, date: pin.date, status: null } : null
}

/**
 * 「献立に入れる」（R48）の保存の手順を、画面に 1 つだけ持つ。
 *
 * 今あるもので・レシピ詳細から、選んだ料理を今夜（または選んだ日）の献立へ**足す**。入れた料理は献立の枠に
 * なるので、献立の画面で「作った」→ 食材の更新 → 評価へ進める。
 *
 * - 送るのは 1 品の追加（`add_recipe`。2026-11-11 ④）。その日に料理が在っても、在る料理・固定枠はそのまま残す
 *   （作り直し・差し替えはしない）。足す位置・その日の状態・人数は、**最初の押下で要求に固定する**
 *   （結果不明の確かめ直しが同じ内容を送る。位置を計算し直すと、成立した追加が conflict に化ける）。
 * - 保存は `useChoreSave`（操作 ID と内容を送信の前に固定・結果不明は同じ操作で確認・自動再送なし）。
 *   別の端末が先にその日を変えていたら（枠が埋まった・状態が変わった・同じ料理が入った）、サーバーは上書きせず
 *   conflict を返す。使わない食材の設定は、サーバーが足す直前に検証する。
 * - 釦（`AddToPlanButton`）は、この中のどこに置いてもよい（Server Component の子でもよい）。
 */
export function AddToPlanProvider({
  owner,
  slots,
  children,
}: {
  owner: ChoreOwner
  slots: AddToPlanSlots
  children: ReactNode
}) {
  const [result, setResult] = useState<AddToPlanResult | null>(null)
  const [otherNotice, setOtherNotice] = useState<{ text: string; tone: "status" | "alert" } | null>(null)
  // 送った料理の名前（応答の文に使う。応答には料理名が無い）
  const titlesRef = useRef<Map<string, string> | null>(null)

  function onOutcome(outcome: ChoreSaveOutcome<MealRequest, MealSaveSuccess>) {
    const request = outcome.payload
    const added = isDinnerRequest(request) ? addedDishOf(request) : null
    if (added === null) {
      // ほかの画面で結果不明になった操作を、この画面から確かめ直した
      if (outcome.kind === "rejected") setOtherNotice({ text: outcome.error, tone: "alert" })
      else if (outcome.kind === "unknown") setOtherNotice(null)
      else {
        const conflict = outcome.status === "conflict"
        setOtherNotice({
          text: conflict ? OTHER_SCREEN_SAVE_TEXTS.conflict : OTHER_SCREEN_SAVE_TEXTS.saved,
          tone: conflict ? "alert" : "status",
        })
      }
      return
    }
    const target = { recipeId: added.recipeId, date: added.date }
    const title = titlesRef.current?.get(added.recipeId) ?? "料理"
    const dateLabel = formatMealDateShort(added.date)
    if (outcome.kind === "rejected") {
      setResult({ ...target, tone: "alert", text: outcome.error, details: [] })
      return
    }
    if (outcome.kind === "unknown") {
      // 結果不明。入れたとも入れていないとも言わない（控えの一覧から同じ操作で確かめ直す）
      setResult(null)
      return
    }
    // 献立の要求には献立の Action が応える（`runMealRequest` の振り分け）
    const saved = outcome.result as DinnerSaveSuccess
    if (outcome.status === "conflict") {
      setResult({ ...target, tone: "alert", text: conflictTextOfDinner(saved), details: saved.notices })
      return
    }
    if ((saved.rejectedPins ?? []).length > 0) {
      // 以前の作成（generate）の控え: 作成は成立したが、選んだ料理は固定されなかった（入ったと言わない）
      setResult({ ...target, tone: "alert", text: `「${title}」は、${dateLabel}の献立に入れられませんでした。`, details: saved.notices })
      return
    }
    const details = [...saved.notices]
    if (saved.grocery && !saved.grocery.ok) details.push(saved.grocery.message)
    const text =
      added.status === "confirmed"
        ? `「${title}」を${dateLabel}の献立に入れました（固定・確定）。確定済みの日のため、材料を買い物リストへ入れました。`
        : added.status === "proposed"
          ? `「${title}」を${dateLabel}の献立に入れました（固定・提案）。献立の画面で、確定・「作った」の記録ができます。`
          : `「${title}」を${dateLabel}の献立に入れました（固定）。献立の画面で、確定・「作った」の記録ができます。`
    setResult({ ...target, tone: "status", text, details })
  }

  const save = useChoreSave<MealRequest, MealSaveSuccess>({
    owner,
    kind: "meal",
    // ごはんの全画面の操作を受ける（ほかの画面で結果不明になった操作も、ここから確かめ直せる）
    run: runMealRequest,
    isPayload: isMealRequest,
    onOutcome,
  })

  function add(recipeId: string, title: string, role: DishRole, date: string): boolean {
    const day = slots.days.find((candidate) => candidate.date === date)
    // 読めない枠が在る・埋まった日・同じ料理が在る日には送らない（釦も出していないが、ここでも止める）
    if (day === undefined || slots.unreadableEntries > 0 || day.nextPosition === null) return false
    if (day.dishes.some((dish) => dish.recipeId === recipeId)) return false
    setResult(null)
    setOtherNotice(null)
    titlesRef.current ??= new Map()
    titlesRef.current.set(recipeId, title)
    // 最初の押下で、足す枠の ID・位置・状態・人数と、読んだ献立の版を固定する（再送は同じ内容。版は、確かめ直しの
    // 間に別の端末が消した料理を蘇らせないためにサーバーが比べる）
    const request: DinnerRequest = {
      op: "add_recipe",
      id: newClientId(),
      expectedRevision: slots.revision,
      date,
      recipeId,
      role,
      position: day.nextPosition,
      servings: slots.servings,
      status: day.addStatus,
    }
    return save.send(request, `「${title}」を${formatMealDateShort(date)}の献立へ追加`) !== null
  }

  const sending = save.pending.find((entry) => entry.phase === "sending")?.payload
  const sendingDish = sending !== undefined && isDinnerRequest(sending) ? addedDishOf(sending) : null
  const shown = otherNotice ?? (save.message && result === null ? { text: save.message, tone: save.messageTone } : null)

  return (
    <AddToPlanContext.Provider
      value={{ slots, blocked: save.blocked, sendingRecipeId: sendingDish?.recipeId ?? null, result, add }}
    >
      {shown !== null &&
        (shown.tone === "alert" ? (
          <p role="alert" className="flex items-start gap-2 text-sm text-foreground">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
            <span className="min-w-0 break-words">{shown.text}</span>
          </p>
        ) : (
          <p role="status" className="flex items-start gap-2 text-sm text-foreground">
            <CircleCheck size={16} className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
            <span className="min-w-0 break-words">{shown.text}</span>
          </p>
        ))}
      <PendingChoreNotice save={save} showMessage={false} />
      {children}
    </AddToPlanContext.Provider>
  )
}

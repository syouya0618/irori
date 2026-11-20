"use client"

import { useRef, useState } from "react"
import Link from "next/link"
import { AlertCircle, Check, NotebookPen, Plus, Trash2 } from "lucide-react"

import { MEALS_SHOPPING_HREF } from "@/components/chores/meals/shared/meal-routes"
import {
  isMealRequest,
  runMealRequest,
  type MealRequest,
  type MealSaveSuccess,
} from "@/components/chores/meals/plan/meal-request"
import { labelOfGroceryRequest } from "@/components/chores/meals/shopping/shopping-labels"
import { PendingChoreNotice } from "@/components/chores/shared/pending-chore-notice"
import { RefreshOnVisible } from "@/components/chores/shared/refresh-on-visible"
import { useChoreSave, type ChoreSaveOutcome } from "@/components/chores/shared/use-chore-save"
import { Button } from "@/components/ui/button"
import type { ChoreOwner } from "@/lib/domain/chore-pending"
import {
  isGroceryRequest,
  isSaveGroceryManualItemRequest,
  type GroceryRequest,
  type GroceryPurchaseInput,
} from "@/lib/meals/server/plan-requests"
import type { ShoppingItemView, ShoppingView } from "@/lib/meals/server/plan-views"
import { newClientId } from "@/lib/utils/client-id"

import { displayFreeMemo, encodeFreeMemo, FREE_MEMO_TEXT_MAX } from "./memo-text"

const POLL_MS = 60_000

/** 元の買い物リストの手動項目をノートとして見せる。別テーブルへの二重保存はしない。 */
export function MemoView({ owner, view }: { owner: ChoreOwner; view: ShoppingView }) {
  const [draft, setDraft] = useState("")
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const pendingText = useRef<string | null>(null)
  const all = [...view.sections.flatMap((group) => group.items), ...view.purchased, ...view.notNeeded]
  const notes = all.filter((item) => item.origin === "manual")
  const automated = all.filter((item) => item.origin === "auto" && item.state === "to_buy")
  const sortedNotes = [...notes].sort((a, b) => Number(a.state === "purchased") - Number(b.state === "purchased"))
  const nameOf = (id: string) => all.find((item) => item.id === id)?.name ?? ""

  function onOutcome(outcome: ChoreSaveOutcome<MealRequest, MealSaveSuccess>) {
    if (outcome.kind === "unknown") {
      setNotice(null)
      return
    }
    if (outcome.kind === "rejected") {
      setNotice({ text: outcome.error, error: true })
      pendingText.current = null
      setSubmitting(false)
      return
    }
    if (outcome.status === "conflict") {
      setNotice({ text: "家族の端末で先に更新されました。最新の内容を確認してやり直してください。", error: true })
      pendingText.current = null
      setSubmitting(false)
      return
    }
    if (isGroceryRequest(outcome.payload) && outcome.payload.op === "manual_item") {
      if (pendingText.current === displayFreeMemo({ name: outcome.payload.name, note: outcome.payload.note }).text) setDraft("")
      pendingText.current = null
    }
    setSubmitting(false)
    setConfirmDelete(null)
    setNotice({ text: "保存しました。家族の買い物リストにも反映されます。", error: false })
  }

  const save = useChoreSave<MealRequest, MealSaveSuccess>({
    owner,
    kind: "meal",
    run: runMealRequest,
    isPayload: isMealRequest,
    onOutcome,
  })

  function send(request: GroceryRequest): boolean {
    if (save.blocked) return false
    setNotice(null)
    return save.send(request, labelOfGroceryRequest(request, nameOf)) !== null
  }

  function saveDraft() {
    const text = draft.trim()
    if (!text || save.blocked || pendingText.current !== null) return
    const encoded = encodeFreeMemo(text)
    if (!encoded.ok) {
      setNotice({ text: encoded.error, error: true })
      return
    }
    const req = {
      id: newClientId(),
      version: null,
      ...encoded.fields,
      quantity: null,
      unit: null,
      section: "other",
    }
    if (!isSaveGroceryManualItemRequest(req)) {
      setNotice({ text: "このメモは保存できません。少し短く分けてください。", error: true })
      return
    }
    if (send({ op: "manual_item", ...req })) { pendingText.current = text; setSubmitting(true) }
  }

  function purchaseOf(item: ShoppingItemView, checked: boolean): GroceryPurchaseInput {
    if (!item.numeric) return { kind: "check", checked }
    return checked
      ? { kind: "full" }
      : { kind: "amount", amount: item.restockedAmount + item.consumedAmount }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="meals-memo">
      <section aria-label="買い物メモ" className="rounded-2xl border border-border/70 bg-card px-4 pb-5 pt-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <p className="flex items-center gap-1.5 font-medium">
            <NotebookPen size={16} aria-hidden="true" />
            買い物・気になること
          </p>
          {save.saving || save.blocked || submitting ? (
            <span role="status">保存・確認中</span>
          ) : draft.trim() !== "" ? (
            <span>入力中（保存を押すか、入力欄を離れると確定）</span>
          ) : (
            <span role="status" className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
              <Check size={14} aria-hidden="true" />
              保存済み
            </span>
          )}
        </div>

        {notice !== null && (
          <p role={notice.error ? "alert" : "status"} className="mb-2 flex items-start gap-2 text-sm">
            {notice.error ? <AlertCircle className="shrink-0 text-destructive" size={16} aria-hidden="true" /> : <Check className="shrink-0" size={16} aria-hidden="true" />}
            {notice.text}
          </p>
        )}

        <ul className="flex flex-col divide-y divide-border/50" data-testid="memo-list">
          {sortedNotes.map((item) => {
            const checked = item.state === "purchased"
            const displayed = displayFreeMemo({ name: item.name, note: item.note })
            return (
              <li key={item.id} className="flex min-h-14 items-center gap-2 py-1">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  aria-label={`${item.name}を${checked ? "未購入" : "購入済み"}にする`}
                  disabled={save.blocked}
                  onClick={() => send({
                    op: "purchase",
                    id: item.id,
                    version: item.version,
                    purchase: purchaseOf(item, !checked),
                  })}
                  className={`flex size-11 shrink-0 items-center justify-center rounded-xl focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 ${checked ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"}`}
                >
                  <span className={`flex size-5 items-center justify-center rounded border-2 ${checked ? "border-emerald-700 bg-emerald-700 text-white dark:border-emerald-300 dark:bg-emerald-300 dark:text-black" : "border-muted-foreground"}`}>
                    {checked && <Check size={15} aria-hidden="true" />}
                  </span>
                </button>
                <span className={`min-w-0 flex-1 whitespace-pre-wrap break-words text-base ${checked ? "text-muted-foreground line-through" : ""}`}>
                  {displayed.text}
                  {displayed.legacyNote && <span className="block text-xs text-muted-foreground">{displayed.legacyNote}</span>}
                </span>
                {confirmDelete === item.id ? (
                  <span className="flex gap-1">
                    <Button type="button" variant="destructive" size="sm" disabled={save.blocked} onClick={() => send({ op: "delete", id: item.id, version: item.version })}>削除</Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>戻る</Button>
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={`${item.name}を削除する`}
                    disabled={save.blocked}
                    onClick={() => setConfirmDelete(item.id)}
                    className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground/70 focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <Trash2 size={17} aria-hidden="true" />
                  </button>
                )}
              </li>
            )
          })}
        </ul>

        {notes.length === 0 && view.unreadableItems === 0 && (
          <p className="py-5 text-sm text-muted-foreground">牛乳、キッチンペーパーなど、思いついたものを気軽に書いてくりゃれ。</p>
        )}

        <form
          className="mt-1 flex items-center gap-2 border-t border-border/50 pt-3"
          onSubmit={(event) => {
            event.preventDefault()
            saveDraft()
          }}
        >
          <label htmlFor="shopping-memo-entry" className="sr-only">買い物メモを追加</label>
          <textarea
            id="shopping-memo-entry"
            rows={2}
            autoComplete="off"
            value={draft}
            disabled={save.blocked}
            aria-describedby="shopping-memo-help"
            onChange={(event) => { setDraft(event.target.value); setNotice(null) }}
            onBlur={saveDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                saveDraft()
              }
            }}
            placeholder="＋ 買うもの・気になることを自由に書く"
            className="min-h-20 min-w-0 flex-1 resize-y rounded-xl bg-transparent px-2 py-2 text-base leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
          <Button type="submit" variant="outline" size="icon" disabled={!draft.trim() || save.blocked} aria-label="書いたメモを保存">
            <Plus size={18} aria-hidden="true" />
          </Button>
        </form>
        <p id="shopping-memo-help" className="pt-1 text-xs text-muted-foreground">
          1件{FREE_MEMO_TEXT_MAX}文字まで。改行も使えます。保存は入力欄を離すか、保存ボタンを押すか、Ctrl/⌘＋Enter。
        </p>
      </section>

      {view.unreadableItems > 0 && (
        <p role="alert" className="rounded-xl border border-destructive/30 px-3 py-2 text-sm">
          表示できない買い物の記録が{view.unreadableItems}件あります。削除されたわけではありません。
        </p>
      )}
      {automated.length > 0 && (
        <details className="rounded-xl border border-border/70 bg-card p-3">
          <summary className="cursor-pointer py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
            献立から計算された買い物（{automated.length}件）
          </summary>
          <p className="py-2 text-xs text-muted-foreground">自動計算された買い物と、自由に書いたメモは別々に保持しています。</p>
          <ul className="flex flex-col gap-2">
            {automated.map((item) => (
              <li key={item.id} className="flex justify-between gap-2 border-t border-border/50 py-2 text-sm">
                <span className="break-words">{item.name}</span>
                <span className="shrink-0 text-muted-foreground">{item.remainingText ?? item.requiredText}</span>
              </li>
            ))}
          </ul>
          <Link href={MEALS_SHOPPING_HREF} className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline">
            詳細な買い物リストを開く
          </Link>
        </details>
      )}
      <p className="px-1 text-xs text-muted-foreground">
        メモをチェックしても、冷蔵庫の在庫は自動では増えません。保存したメモは家族と共有されます。
      </p>
      <PendingChoreNotice save={save} />
      <RefreshOnVisible pollMs={POLL_MS} paused={draft.trim() !== "" || confirmDelete !== null} />
    </div>
  )
}

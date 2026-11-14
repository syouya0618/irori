"use client"

import { useRef, useState } from "react"
import Link from "next/link"
import { AlertCircle, ChevronRight, CircleCheck, Loader2, Plus, RefreshCw, ShoppingCart, Trash2 } from "lucide-react"

import { OUTLINE_LINK, PRIMARY_LINK, TEXT_LINK } from "@/components/chores/meals/plan/link-styles"
import {
  OTHER_SCREEN_SAVE_TEXTS,
  isMealRequest,
  runMealRequest,
  type MealRequest,
  type MealSaveSuccess,
} from "@/components/chores/meals/plan/meal-request"
import { planHref, planStartBounds } from "@/components/chores/meals/plan/plan-query"
import { MealNotice } from "@/components/chores/meals/shared/meal-notices"
import { MEALS_PANTRY_HREF, MEALS_PLAN_HREF, MEALS_SETTINGS_HREF } from "@/components/chores/meals/shared/meal-routes"
import { EmptyState } from "@/components/chores/shared/empty-state"
import { PendingChoreNotice } from "@/components/chores/shared/pending-chore-notice"
import { RefreshOnVisible } from "@/components/chores/shared/refresh-on-visible"
import { useChoreSave, type ChoreSaveOutcome } from "@/components/chores/shared/use-chore-save"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { ChoreOwner } from "@/lib/domain/chore-pending"
import {
  groceryAutoHoldMessage,
  isGroceryRequest,
  type GroceryPurchaseInput,
  type GroceryRequest,
  type GrocerySaveSuccess,
} from "@/lib/meals/server/plan-requests"
import type { ShoppingItemView, ShoppingView as ShoppingViewData } from "@/lib/meals/server/plan-views"
import { roundAmount } from "@/lib/meals/units"
import { newClientId } from "@/lib/utils/client-id"
import { shiftYmd } from "@/lib/utils/date-jst"

import { ShoppingItemPanel } from "./shopping-item-panel"
import { ShoppingItemRow } from "./shopping-item-row"
import {
  conflictTextOfGrocery,
  labelOfGroceryRequest,
  purchaseProgressText,
  successTextOfGroceryRequest,
} from "./shopping-labels"
import { ShoppingManualForm } from "./shopping-manual-form"

/** 表示中の定期再取得の間隔（家族の購入チェックを取り込む）。 */
const POLL_MS = 30_000

export interface ShoppingViewProps {
  owner: ChoreOwner
  view: ShoppingViewData
}

interface Notice {
  text: string
  tone: "status" | "alert"
  details: string[]
}

/**
 * 開いているシート。`seq` は開くたびに変わる通し番号 — 保存の応答が「どのシートから送った操作か」を
 * 見分けるのに使う（同じ項目を開き直したシートも、別のシートとして扱う）。
 */
type SheetState =
  | { kind: "item"; itemId: string; restockFirst: boolean; seq: number }
  | { kind: "manual"; seq: number }
  | null

/** 押した直後の購入済みの印。項目の版が変わったら（サーバーの値が届いたら）使わない。 */
type Optimistic = Record<string, { checked: boolean; version: string }>

/**
 * 買い物リストの画面。
 *
 * - まだ買うものを売場ごとに並べ、購入済みは下へ送る。献立から不要になった項目（購入・メモの
 *   記録があるので残っている）は別に出し、削除できる。
 * - 購入チェックは楽観更新（押した瞬間に印を付ける）。保存できなかった・結果が分からないときは
 *   印を戻し、理由か「同じ操作で確認」を出す。保存中は次の操作を受けない（二重に送らない）。
 * - **購入チェックと「在庫へ追加」は別の操作**。購入済みにしても食材（在庫）は増えない。
 * - 保存は `useChoreSave`（操作 ID と内容を送信の前に固定・自動再送なし）。項目の版を送り、
 *   家族が先に変えていたら上書きしない。
 * - 保存の応答でシートを閉じるのは、**そのシートから送った操作の応答のときだけ**。一覧のチェックを
 *   押した後に開いた別のシート（打ちかけのメモ）を、先の操作の応答で閉じない。
 */
export function ShoppingView({ owner, view }: ShoppingViewProps) {
  const [notice, setNotice] = useState<Notice | null>(null)
  const [sheet, setSheet] = useState<SheetState>(null)
  const [optimistic, setOptimistic] = useState<Optimistic>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const sheetSeqRef = useRef(0)
  // 送信中の操作を送ったシートの通し番号（シートの外から送った操作・控えの確かめ直しは null）
  const originSheetRef = useRef<number | null>(null)

  const toBuy = view.sections.flatMap((group) => group.items)
  const all = [...toBuy, ...view.purchased, ...view.notNeeded]
  const nameOf = (itemId: string) => all.find((item) => item.id === itemId)?.name ?? ""

  function openItemSheet(itemId: string, restockFirst: boolean) {
    sheetSeqRef.current += 1
    setSheet({ kind: "item", itemId, restockFirst, seq: sheetSeqRef.current })
  }

  function openManual() {
    sheetSeqRef.current += 1
    setSheet({ kind: "manual", seq: sheetSeqRef.current })
  }

  /**
   * 応答が属するシートだけを閉じる。`onOutcome` は送信時点の描画の値を見るので、今のシートは
   * 更新関数の引数（最新の state）から読む。
   */
  function closeOriginSheet() {
    const origin = originSheetRef.current
    if (origin === null) return
    setSheet((current) => (current !== null && current.seq === origin ? null : current))
  }

  function rollback(request: GroceryRequest) {
    if (request.op !== "purchase") return
    setOptimistic((prev) => {
      const { [request.id]: _removed, ...rest } = prev
      void _removed
      return rest
    })
  }

  function onOutcome(outcome: ChoreSaveOutcome<MealRequest, MealSaveSuccess>) {
    const request = outcome.payload
    if (!isGroceryRequest(request)) {
      // ほかの画面（献立・食材・設定）で結果不明になった操作を、この画面から確かめ直した
      if (outcome.kind === "rejected") {
        setNotice({ text: outcome.error, tone: "alert", details: [] })
      } else if (outcome.kind === "unknown") {
        setNotice(null)
      } else {
        const conflict = outcome.status === "conflict"
        setNotice({
          text: conflict ? OTHER_SCREEN_SAVE_TEXTS.conflict : OTHER_SCREEN_SAVE_TEXTS.saved,
          tone: conflict ? "alert" : "status",
          details: [],
        })
      }
      return
    }
    if (outcome.kind === "rejected") {
      // 保存されていないと確定。印を戻し、理由を出す（シートは開いたまま）
      rollback(request)
      setNotice({ text: outcome.error, tone: "alert", details: [] })
      return
    }
    if (outcome.kind === "unknown") {
      // 結果不明。確定と偽らず印を戻し、控えの一覧（同じ操作で確認）を見せる。
      // 閉じるのは、その操作を送ったシートだけ（別のシートの入力は消さない）
      rollback(request)
      closeOriginSheet()
      setNotice(null)
      return
    }
    const { status } = outcome
    // 買い物の要求には買い物の Action が応える（`runMealRequest` の振り分け）
    const result = outcome.result as GrocerySaveSuccess
    closeOriginSheet()
    if (request.op === "delete") setConfirmDelete(null)
    if (status === "conflict") {
      rollback(request)
      setNotice({ text: conflictTextOfGrocery(result), tone: "alert", details: result.notices })
      return
    }
    const details = [...result.notices]
    if (result.grocery && !result.grocery.ok) details.push(result.grocery.message)
    setNotice({ text: successTextOfGroceryRequest(request, nameOf), tone: "status", details })
  }

  const save = useChoreSave<MealRequest, MealSaveSuccess>({
    owner,
    kind: "meal",
    // ごはんの全画面の操作を受ける（ほかの画面で結果不明になった操作も、ここから確かめ直せる）
    run: runMealRequest,
    isPayload: isMealRequest,
    onOutcome,
  })

  /**
   * 操作を送る。受け付けたら true。`fromSheet` は、開いているシートの中から送ったとき true
   * （応答でそのシートを閉じる）。一覧から送った操作は、後から開いたシートを閉じない。
   */
  function send(request: GroceryRequest, fromSheet = false): boolean {
    setNotice(null)
    const accepted = save.send(request, labelOfGroceryRequest(request, nameOf)) !== null
    if (accepted) originSheetRef.current = fromSheet && sheet !== null ? sheet.seq : null
    return accepted
  }
  const sendFromSheet = (request: GroceryRequest) => send(request, true)
  // 控えの確かめ直しは、どのシートからの操作でもない（応答でシートを閉じない）
  const pendingSave = {
    ...save,
    retry: (entry: Parameters<typeof save.retry>[0]) => {
      originSheetRef.current = null
      save.retry(entry)
    },
  }

  function isChecked(item: ShoppingItemView): boolean {
    const pressed = optimistic[item.id]
    return pressed !== undefined && pressed.version === item.version ? pressed.checked : item.state === "purchased"
  }

  function togglePurchase(item: ShoppingItemView, next: boolean) {
    const purchase: GroceryPurchaseInput = item.numeric
      ? next
        ? { kind: "full" }
        : // 取り消しは「買った量の合計を、在庫へ足した量 + 作った料理に使った量まで戻す」（どちらも消せない事実。
          // 合計で送るので、作った料理に使った分を消さない）
          { kind: "amount", amount: roundAmount(item.restockedAmount + item.consumedAmount) }
      : { kind: "check", checked: next }
    if (send({ op: "purchase", id: item.id, version: item.version, purchase })) {
      setOptimistic((prev) => ({ ...prev, [item.id]: { checked: next, version: item.version } }))
    }
  }

  const sendingPurchase = save.pending.find((entry) => entry.phase === "sending" && entry.payload.op === "purchase")
  const busyItemId =
    sendingPurchase !== undefined && sendingPurchase.payload.op === "purchase" ? sendingPurchase.payload.id : null

  const shown: Notice | null =
    notice ?? (save.message ? { text: save.message, tone: save.messageTone, details: [] } : null)
  const message =
    shown === null ? null : (
      <div className="flex flex-col gap-2" data-testid="shopping-notice">
        {shown.tone === "alert" ? (
          <p role="alert" className="flex items-start gap-2 text-sm text-foreground">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
            <span className="min-w-0 break-words">{shown.text}</span>
          </p>
        ) : (
          <p role="status" className="flex items-start gap-2 text-sm text-foreground">
            <CircleCheck
              size={16}
              className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400"
              aria-hidden="true"
            />
            <span className="min-w-0 break-words">{shown.text}</span>
          </p>
        )}
        {shown.details.length > 0 && (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
            {shown.details.map((detail) => (
              <li key={detail} className="break-words">
                {detail}
              </li>
            ))}
          </ul>
        )}
      </div>
    )

  const openItem = sheet?.kind === "item" ? all.find((item) => item.id === sheet.itemId) : undefined
  const sheetOpen = openItem !== undefined || sheet?.kind === "manual"
  const isEmpty = all.length === 0
  const startMax = planStartBounds(view.today).max

  const renderRow = (item: ShoppingItemView) => (
    <ShoppingItemRow
      key={item.id}
      item={item}
      checked={isChecked(item)}
      busy={busyItemId === item.id}
      disabled={save.blocked}
      expanded={expanded[item.id] === true}
      onCheckedChange={(next) => togglePurchase(item, next)}
      onToggleSources={() => setExpanded((prev) => ({ ...prev, [item.id]: prev[item.id] !== true }))}
      onOpen={() => openItemSheet(item.id, false)}
      onOpenRestock={() => openItemSheet(item.id, true)}
      needsRecheck={view.autoHold !== null && item.origin === "auto"}
    />
  )

  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="shopping-to-buy-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="shopping-to-buy-heading" className="text-base font-semibold">
            まだ買うもの（{view.toBuyCount}件）
          </h2>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={save.blocked}
              onClick={() => send({ op: "sync", operationId: newClientId() })}
            >
              <RefreshCw aria-hidden="true" />
              献立から更新
            </Button>
            <Button type="button" variant="outline" disabled={save.blocked} onClick={openManual}>
              <Plus aria-hidden="true" />
              項目を追加
            </Button>
          </div>
        </div>

        {view.stale && (
          <p className="flex items-start gap-2 text-sm" data-testid="shopping-stale">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
            <span>
              献立か食材が変わっていて、このリストは古い可能性があります。「献立から更新」を押すと計算し直します（購入の記録・メモ・手動の項目は消えません）。
            </span>
          </p>
        )}

        {view.autoHold !== null && (
          // 判定できないアレルギーの登録のために、自動の更新を止めている。リストは止める前のまま（消していない）
          <div
            data-testid="shopping-auto-hold"
            className="flex flex-col items-start gap-2 rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-foreground"
          >
            <p className="flex items-start gap-2">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
              <span className="min-w-0 break-words">
                <span className="font-semibold">要再確認</span>
                <span className="block">{groceryAutoHoldMessage(view.autoHold.labels)}</span>
              </span>
            </p>
            <Link href={MEALS_SETTINGS_HREF} prefetch={false} className={TEXT_LINK}>
              使わない食材の設定を開く
              <ChevronRight size={16} aria-hidden="true" />
            </Link>
          </div>
        )}

        {view.exclusionsUnreadable && (
          <p role="alert" className="flex items-start gap-2 text-sm text-foreground" data-testid="shopping-exclusions-unreadable">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
            <span>
              使わない食材の設定を読めないため、献立と照らせていません。当たる料理の材料を入れないよう、「献立から更新」も止めています。少し待ってから再読み込みしてください。
            </span>
          </p>
        )}

        {isEmpty ? (
          <EmptyState
            icon={ShoppingCart}
            // 読めない項目が在るときに「まだありません」と言わない（在る項目を無いと偽らない）
            title={view.unreadableItems > 0 ? "表示できる項目がありません" : "買い物リストはまだありません"}
            description={
              view.autoHold !== null
                ? // 止めている間は確定も拒まれる。「確定を押すと並ぶ」とは言わない
                  "判定できないアレルギーの登録を設定で選び直すまで、献立を確定できず、材料は自動では並びません。手動で項目を足すことはできます。"
                : "献立を作って「この献立で確定」を押すと、必要な材料がここに並びます。手動で項目を足すこともできます。"
            }
          >
            <Link href={MEALS_PLAN_HREF} prefetch={false} className={PRIMARY_LINK}>
              献立を作る
            </Link>
          </EmptyState>
        ) : view.sections.length === 0 ? (
          <p className="glass flex items-center gap-2 rounded-2xl px-4 py-4 text-sm shadow-lg shadow-black/[0.04]">
            <CircleCheck size={18} className="shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
            まだ買うものはありません。
          </p>
        ) : (
          view.sections.map((group) => {
            const headingId = `shopping-section-${group.section}`
            return (
              <section
                key={group.section}
                aria-labelledby={headingId}
                data-testid="shopping-section"
                className="glass flex flex-col rounded-2xl px-3 py-3 shadow-lg shadow-black/[0.04]"
              >
                <h3 id={headingId} className="px-1 text-sm font-semibold text-muted-foreground">
                  {group.label}
                </h3>
                <ul className="flex flex-col divide-y divide-border/60">{group.items.map(renderRow)}</ul>
              </section>
            )
          })
        )}
      </section>

      {save.saving && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          保存しています…
        </p>
      )}
      {!sheetOpen && message}
      <PendingChoreNotice save={pendingSave} showMessage={false} />

      {view.unreadableItems > 0 && (
        <p role="alert" className="flex items-start gap-2 text-sm text-foreground">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
          <span>表示できない項目が {view.unreadableItems} 件あります。項目は消えていません。</span>
        </p>
      )}

      {view.heldDishes.length > 0 && (
        <section
          aria-labelledby="shopping-held-heading"
          data-testid="shopping-held"
          className="glass flex flex-col gap-2 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"
        >
          <h2 id="shopping-held-heading" className="text-base font-semibold">
            使わない食材の設定に当たる料理
          </h2>
          <p className="text-sm text-muted-foreground">
            {view.autoHold !== null ? (
              // 自動の更新を止めている間は「入れていない」と言えない（止める前のリストに材料が残りうる）
              <>
                次の料理は使わない食材の設定に当たります: {view.heldDishes.map((dish) => dish.title).join("、")}。買い物リストの自動の更新を止めているため、材料がリストに残っていることがあります。献立の画面で選び直してください。
              </>
            ) : view.stale ? (
              // リストが古い間（除外を足した後、更新の前）も「入れていない」とは言えない（保存済みのリストに残りうる）
              <>
                次の料理は使わない食材の設定に当たります: {view.heldDishes.map((dish) => dish.title).join("、")}。このリストは古い可能性があり、材料がリストに残っていることがあります。「献立から更新」を押すと、まだ買っていない分を外します。献立はそのままです。
              </>
            ) : (
              <>
                使わない食材の設定に当たるため、次の料理の材料は入れていません:{" "}
                {view.heldDishes.map((dish) => dish.title).join("、")}。献立はそのままです。献立の画面で選び直すと、計算に入ります。
              </>
            )}
          </p>
          <ul className="flex flex-col gap-2">
            {view.heldDishes.map((dish) => (
              <li key={dish.entryId} className="flex flex-col items-start gap-1">
                <p className="text-sm break-words">
                  <span className="font-medium">
                    {dish.dateLabel} {dish.title}
                  </span>
                  <span className="block text-muted-foreground">{dish.message}</span>
                </p>
                <Link
                  href={planHref(dish.date <= startMax ? dish.date : shiftYmd(dish.date, -6), view.today)}
                  prefetch={false}
                  aria-label={`${dish.dateLabel} ${dish.title}を献立の画面で選び直す`}
                  className={OUTLINE_LINK}
                >
                  献立で選び直す
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.uncomputed.length > 0 && (
        <section
          aria-labelledby="shopping-uncomputed-heading"
          className="glass flex flex-col gap-2 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"
        >
          <h2 id="shopping-uncomputed-heading" className="text-base font-semibold">
            自動計算に入っていない料理
          </h2>
          <p className="text-sm text-muted-foreground">
            次の料理の材料は、このリストに入っていません。献立の画面で材料を足すと、計算に入ります。
          </p>
          <ul className="flex flex-col gap-2">
            {view.uncomputed.map((dish) => (
              <li key={dish.entryId} className="flex flex-col items-start gap-1">
                <p className="text-sm break-words">
                  <span className="font-medium">
                    {dish.dateLabel} {dish.title}
                  </span>
                  <span className="block text-muted-foreground">{dish.message}</span>
                </p>
                <Link
                  href={planHref(dish.date <= startMax ? dish.date : shiftYmd(dish.date, -6), view.today)}
                  prefetch={false}
                  aria-label={`${dish.dateLabel} ${dish.title}の材料を献立の画面で追加`}
                  className={OUTLINE_LINK}
                >
                  {dish.reason === "no_ingredients" ? "材料を追加する" : "献立で確認する"}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.purchased.length > 0 && (
        <section
          aria-labelledby="shopping-purchased-heading"
          className="glass flex flex-col rounded-2xl px-3 py-3 shadow-lg shadow-black/[0.04]"
        >
          <h2 id="shopping-purchased-heading" className="px-1 text-base font-semibold">
            購入済み（{view.purchased.length}件）
          </h2>
          <p className="px-1 text-sm text-muted-foreground">
            購入済みにしただけでは、食材（在庫）は増えません。家に置いたら「在庫へ追加」を押してください。
          </p>
          <ul className="flex flex-col divide-y divide-border/60">{view.purchased.map(renderRow)}</ul>
        </section>
      )}

      {view.notNeeded.length > 0 && (
        <section
          aria-labelledby="shopping-not-needed-heading"
          className="glass flex flex-col gap-2 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"
        >
          <h2 id="shopping-not-needed-heading" className="text-base font-semibold">
            献立からは不要になった項目（{view.notNeeded.length}件）
          </h2>
          <p className="text-sm text-muted-foreground">
            献立が変わって要らなくなりましたが、購入やメモの記録があるので残しています。要らなければ削除できます。
          </p>
          <ul className="flex flex-col gap-3">
            {view.notNeeded.map((item) => {
              const progress = purchaseProgressText(item)
              return (
                <li key={item.id} data-testid="shopping-not-needed" className="flex flex-col gap-2">
                  <p className="text-sm break-words">
                    <span className="font-medium">{item.name}</span>
                    {progress !== null && <span className="text-muted-foreground">（{progress}）</span>}
                    {item.note !== null && <span className="block text-muted-foreground">メモ: {item.note}</span>}
                  </p>
                  {confirmDelete === item.id ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-sm text-muted-foreground">
                        購入の記録とメモも消えます。在庫は変わりません。
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="destructive"
                          disabled={save.blocked}
                          aria-label={`${item.name}を削除する`}
                          onClick={() => send({ op: "delete", id: item.id, version: item.version })}
                        >
                          削除する
                        </Button>
                        <Button type="button" variant="outline" onClick={() => setConfirmDelete(null)}>
                          やめる
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        aria-label={`${item.name}を削除`}
                        onClick={() => setConfirmDelete(item.id)}
                      >
                        <Trash2 aria-hidden="true" />
                        削除
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        aria-label={`${item.name}の詳細を開く`}
                        onClick={() => openItemSheet(item.id, true)}
                      >
                        詳細・在庫へ追加
                      </Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {view.stapleAssumed.length > 0 && (
        <p className="text-xs text-muted-foreground">
          常備品として買い物に出していない食材: {view.stapleAssumed.join("、")}
        </p>
      )}

      <nav aria-label="関連する画面" className="flex flex-wrap gap-2">
        <Link href={MEALS_PLAN_HREF} prefetch={false} className={TEXT_LINK}>
          献立を見る
        </Link>
        <Link href={MEALS_PANTRY_HREF} prefetch={false} className={TEXT_LINK}>
          食材（在庫）を見る
        </Link>
      </nav>

      <MealNotice kind="groceryEstimate" />
      {/* 削除の確認を開いている間は、自動の取り直しを見送る（釦だけで変わる state は自動では検出されない） */}
      <RefreshOnVisible pollMs={POLL_MS} paused={confirmDelete !== null} />

      <Sheet
        open={sheetOpen}
        onOpenChange={(open) => {
          if (!open) setSheet(null)
        }}
      >
        <SheetContent side="bottom" className="max-h-[85dvh] overflow-hidden rounded-t-2xl safe-bottom">
          {openItem !== undefined && (
            <>
              <SheetHeader className="pr-14 pb-0">
                <SheetTitle className="break-words [overflow-wrap:anywhere]">{openItem.name}</SheetTitle>
                <SheetDescription>量の調整・メモ・売場・在庫へ追加ができます。</SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4">
                {message}
                <ShoppingItemPanel
                  // 開き直したシートは作り直す（前に開いた時の入力を持ち越さない）
                  key={`${openItem.id}:${sheet?.seq ?? 0}`}
                  item={openItem}
                  restockFirst={sheet?.kind === "item" && sheet.restockFirst}
                  disabled={save.blocked}
                  saving={save.saving}
                  send={sendFromSheet}
                  onClose={() => setSheet(null)}
                />
              </div>
            </>
          )}
          {sheet?.kind === "manual" && (
            <>
              <SheetHeader className="pr-14 pb-0">
                <SheetTitle>項目を追加</SheetTitle>
                <SheetDescription>献立に無いものを、手動で買い物リストへ足します。</SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4">
                {message}
                <ShoppingManualForm
                  editing={null}
                  disabled={save.blocked}
                  saving={save.saving}
                  onSubmit={sendFromSheet}
                  onCancel={() => setSheet(null)}
                />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

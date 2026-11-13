"use client"

import { useId, useState } from "react"
import { PackagePlus } from "lucide-react"

import { ChangedElsewhereNotice } from "@/components/chores/meals/basics/changed-elsewhere-notice"
import { NATIVE_SELECT } from "@/components/chores/meals/plan/link-styles"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { STORE_SECTIONS } from "@/lib/meals/catalog/sections"
import { formatQuantityJa } from "@/lib/meals/server/format"
import { GROCERY_NOTE_MAX, type GroceryRequest } from "@/lib/meals/server/plan-requests"
import type { ShoppingItemView } from "@/lib/meals/server/plan-views"
import { roundAmount } from "@/lib/meals/units"
import { newClientId } from "@/lib/utils/client-id"

import { purchaseProgressText } from "./shopping-labels"
import { ShoppingManualForm } from "./shopping-manual-form"

type Send = (request: GroceryRequest) => boolean

function parsePositive(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === "") return null
  const value = Number(trimmed)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * 買った量（合計）の調整。数量で追える項目だけ。
 *
 * 入れるのも送るのも**買った事実の合計**（作った料理に使った分を含む）。画面の「残り」や、これからの料理に
 * 充てられる量を合計として送らない — 送ると、作った料理に使った分を買い戻したことになり、取り消しで二重に戻る。
 * 触るまでは項目の今の値を映す。**入力を始めた時点の版を固定して送る** — 入力の途中で項目の版が進んだら
 * （家族が買った量を記録した等）、古い入力に新しい版を付けて送らず、保存を止めて知らせる。
 */
function PurchasedAmountForm({ item, disabled, send }: { item: ShoppingItemView; disabled: boolean; send: Send }) {
  const inputId = useId()
  const [draft, setDraft] = useState<{ version: string; amount: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const amount = draft?.amount ?? String(item.purchasedAmount)
  const changedElsewhere = draft !== null && draft.version !== item.version
  const floor = roundAmount(item.restockedAmount + item.consumedAmount)

  function submit() {
    // 釦は無効にしてあるが、ここでも止める
    if (changedElsewhere) return
    const trimmed = amount.trim()
    const value = Number(trimmed)
    if (trimmed === "" || !Number.isFinite(value) || value < 0) {
      setError("買った量を、0 以上の数で入力してください。")
      return
    }
    if (value < item.restockedAmount) {
      setError("在庫へ追加した量より少なくはできません。")
      return
    }
    if (value < floor) {
      const floorText = item.unit === null ? String(floor) : formatQuantityJa({ amount: floor, unit: item.unit })
      setError(`作った料理に使った量と在庫へ追加した量の合計（${floorText}）より少なくはできません。`)
      return
    }
    setError(null)
    send({
      op: "purchase",
      id: item.id,
      // 版は入力を始めた時点のもの（触っていなければ、表示している今の値と同じ版）
      version: draft?.version ?? item.version,
      purchase: { kind: "amount", amount: value },
    })
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">買った量を調整</h3>
      {changedElsewhere && (
        <ChangedElsewhereNotice
          what="この項目"
          ownChangePossible
          onReload={() => {
            setDraft(null)
            setError(null)
          }}
        />
      )}
      <p className="text-sm text-muted-foreground">
        これまでに買った合計の量を入れます（作った料理に使った分も含めます）。必要量が後から増えても、料理を作っても、買った量は書き換えません。
      </p>
      {item.consumedAmount > 0 && item.unit !== null && (
        <p className="text-sm">
          うち作った料理に使用: {formatQuantityJa({ amount: item.consumedAmount, unit: item.unit })}
          （その料理の「作った」を取り消すと、これからの料理に充て直します）
        </p>
      )}
      <label htmlFor={inputId} className="text-sm font-medium">
        買った量（合計・{item.unitLabel}）
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          value={amount}
          inputMode="decimal"
          autoComplete="off"
          className="h-11 min-w-0 flex-1"
          onChange={(event) => {
            const next = event.target.value
            setDraft((prev) => ({ version: prev?.version ?? item.version, amount: next }))
            setError(null)
          }}
        />
        <span className="shrink-0 text-sm">{item.unitLabel}</span>
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={disabled || changedElsewhere}
        onClick={submit}
      >
        買った量を保存
      </Button>
    </section>
  )
}

/**
 * メモと売場（自動の項目用。献立からの計算し直しでは消えない）。
 * 買った量と同じく、入力を始めた時点の版を固定して送る。
 */
function MetaForm({ item, disabled, send }: { item: ShoppingItemView; disabled: boolean; send: Send }) {
  const formId = useId()
  const [draft, setDraft] = useState<{ version: string; note: string; section: string } | null>(null)
  const note = draft?.note ?? item.note ?? ""
  // 空 = 売場を変えない／食材の既定へ戻す
  const section = draft?.section ?? (item.sectionOverridden ? item.section : "")
  const changedElsewhere = draft !== null && draft.version !== item.version
  const change = (patch: { note?: string; section?: string }) =>
    setDraft((prev) => ({ version: prev?.version ?? item.version, note, section, ...patch }))
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">メモと売場</h3>
      {changedElsewhere && <ChangedElsewhereNotice what="この項目" ownChangePossible onReload={() => setDraft(null)} />}
      <label htmlFor={`${formId}-note`} className="text-sm font-medium">
        メモ
      </label>
      <Textarea
        id={`${formId}-note`}
        value={note}
        maxLength={GROCERY_NOTE_MAX}
        placeholder="例: 特売の日に"
        onChange={(event) => change({ note: event.target.value })}
      />
      <label htmlFor={`${formId}-section`} className="text-sm font-medium">
        売場
      </label>
      <select
        id={`${formId}-section`}
        className={NATIVE_SELECT}
        value={section}
        onChange={(event) => change({ section: event.target.value })}
      >
        <option value="">{item.sectionOverridden ? "食材の既定の売場に戻す" : `既定のまま（${item.sectionLabel}）`}</option>
        {STORE_SECTIONS.map((def) => (
          <option key={def.id} value={def.id}>
            {def.label}
          </option>
        ))}
      </select>
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={disabled || changedElsewhere}
        onClick={() => {
          if (changedElsewhere) return
          send({
            op: "meta",
            id: item.id,
            // 版は入力を始めた時点のもの
            version: draft?.version ?? item.version,
            note: note.trim() === "" ? null : note.trim(),
            section: section === "" ? null : section,
          })
        }}
      >
        メモと売場を保存
      </Button>
    </section>
  )
}

/**
 * 在庫へ追加。**購入チェックとは別の操作** — 買ったものを家に置いて、確認した量だけを食材（在庫）へ
 * 足す。作る在庫の行 ID は送る時に 1 回だけ採番し、同じ操作の再送では二重に足さない。
 * 量で追える購入は「買った量 − 追加済みの量」まで。追加済みの分は釦を出さない。
 */
function RestockForm({ item, disabled, send }: { item: ShoppingItemView; disabled: boolean; send: Send }) {
  const inputId = useId()
  const numericPurchase = item.purchasedAmount > 0
  const restockable = item.restockableAmount ?? 0
  const [amount, setAmount] = useState(numericPurchase && restockable > 0 ? String(restockable) : "")
  const [error, setError] = useState<string | null>(null)
  const bought = numericPurchase || item.checked
  const done = numericPurchase ? restockable <= 0 : item.restockCount > 0

  function submit() {
    let quantity: number | null = null
    if (item.unit !== null) {
      const value = parsePositive(amount)
      if (numericPurchase) {
        if (value === null) {
          setError("在庫へ足す量を、0 より大きい数で入力してください。")
          return
        }
        if (value > restockable) {
          setError("買った量を超えて在庫へ追加することはできません。買った量を直してから追加してください。")
          return
        }
        quantity = value
      } else if (amount.trim() !== "") {
        if (value === null) {
          setError("量は 0 より大きい数で入力してください。分からなければ空欄にしてください。")
          return
        }
        quantity = value
      }
    }
    setError(null)
    send({ op: "restock", groceryId: item.id, version: item.version, pantryItemId: newClientId(), quantity })
  }

  return (
    <section className="flex flex-col gap-2" data-testid="restock-section">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <PackagePlus size={16} aria-hidden="true" className="shrink-0" />
        在庫へ追加
      </h3>
      <p className="text-sm text-muted-foreground">
        購入チェックとは別の操作です。購入済みにしただけでは、食材（在庫）は増えません。家に置いて確認した量だけを、ここから 1 度だけ在庫へ足します。
      </p>
      {item.restockCount > 0 && (
        <p className="text-sm">
          在庫へ追加済み: {item.restockCount} 回
          {item.unit !== null && item.restockedAmount > 0
            ? `（合計 ${formatQuantityJa({ amount: item.restockedAmount, unit: item.unit })}）`
            : ""}
        </p>
      )}
      {!bought ? (
        <p className="text-sm">購入済みにすると、在庫へ追加できます。</p>
      ) : done ? (
        <p className="text-sm">
          {item.consumedAmount > 0
            ? "買った分は、作った料理に使ったか、すでに在庫へ追加済みです。"
            : "買った分は、すべて在庫へ追加済みです。"}
        </p>
      ) : (
        <>
          {item.unit !== null && (
            <>
              <label htmlFor={inputId} className="text-sm font-medium">
                {numericPurchase
                  ? `在庫へ足す量（${item.unitLabel}・最大 ${formatQuantityJa({ amount: restockable, unit: item.unit })}）`
                  : `在庫へ足す量（${item.unitLabel}・任意）`}
              </label>
              <div className="flex items-center gap-2">
                <Input
                  id={inputId}
                  value={amount}
                  inputMode="decimal"
                  autoComplete="off"
                  className="h-11 min-w-0 flex-1"
                  onChange={(event) => {
                    setAmount(event.target.value)
                    setError(null)
                  }}
                />
                <span className="shrink-0 text-sm">{item.unitLabel}</span>
              </div>
            </>
          )}
          {item.unit === null && <p className="text-sm">この項目は量を追えないため、数量不明の食材として追加します。</p>}
          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="button" className="self-start" disabled={disabled} onClick={submit}>
            <PackagePlus aria-hidden="true" />
            在庫へ追加
          </Button>
        </>
      )}
    </section>
  )
}

function DeleteSection({ item, disabled, send }: { item: ShoppingItemView; disabled: boolean; send: Send }) {
  const [confirming, setConfirming] = useState(false)
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">削除</h3>
      {confirming ? (
        <>
          <p className="text-sm text-muted-foreground">
            「{item.name}」を買い物リストから削除します。購入の記録とメモも消えます。在庫は変わりません。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="destructive"
              disabled={disabled}
              onClick={() => send({ op: "delete", id: item.id, version: item.version })}
            >
              削除する
            </Button>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
              やめる
            </Button>
          </div>
        </>
      ) : (
        <Button type="button" variant="outline" className="self-start" onClick={() => setConfirming(true)}>
          この項目を削除
        </Button>
      )}
    </section>
  )
}

/**
 * 買い物の 1 項目の詳細（下シートの中身）: 量の内訳、買った量の調整、メモと売場、在庫へ追加、削除。
 * 自動の項目は名前と必要量を変えられない（献立から計算する）。手動の項目は全部を編集できる。
 */
export function ShoppingItemPanel({
  item,
  restockFirst = false,
  disabled,
  saving,
  send,
  onClose,
}: {
  item: ShoppingItemView
  /** 「在庫へ追加」から開いたとき。在庫へ追加の区画を先頭に出す。 */
  restockFirst?: boolean
  disabled: boolean
  saving: boolean
  send: Send
  onClose: () => void
}) {
  const progress = purchaseProgressText(item)
  // 自動の項目は、献立から不要になったものだけ消せる（必要な項目は DB も拒む）
  const deletable = item.origin === "manual" || item.state === "not_needed"
  const restock = <RestockForm key={`restock:${item.version}`} item={item} disabled={disabled} send={send} />

  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">種類</dt>
        <dd>{item.origin === "manual" ? "手動で追加した項目" : "献立から自動で作った項目"}</dd>
        <dt className="text-muted-foreground">売場</dt>
        <dd>{item.sectionLabel}</dd>
        {item.requiredText !== "" && (
          <>
            <dt className="text-muted-foreground">必要な量</dt>
            <dd>{item.requiredText}</dd>
          </>
        )}
        {progress !== null && (
          <>
            <dt className="text-muted-foreground">購入</dt>
            <dd>{progress}</dd>
          </>
        )}
      </dl>
      {item.needsStockCheck && (
        <p className="text-sm">
          家にある量が登録されていないため、在庫は差し引いていません。家にある量を確認してから買ってください。
        </p>
      )}

      {restockFirst && restock}

      {/*
        量・メモ・手動の項目のフォームは、版が進んでも作り直さない（入力を黙って消さない）。
        入力を始めた時点の版を固定して送り、版が進んだら保存を止めて知らせる（各フォーム）。
      */}
      {item.numeric && item.state !== "not_needed" && <PurchasedAmountForm item={item} disabled={disabled} send={send} />}

      {item.origin === "manual" ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">内容を変更</h3>
          <ShoppingManualForm editing={item} disabled={disabled} saving={saving} onSubmit={send} onCancel={onClose} />
        </section>
      ) : (
        <MetaForm item={item} disabled={disabled} send={send} />
      )}

      {!restockFirst && restock}

      {deletable && <DeleteSection item={item} disabled={disabled} send={send} />}
    </div>
  )
}

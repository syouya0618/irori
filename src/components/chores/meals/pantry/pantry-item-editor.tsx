"use client"

import { useId, useState } from "react"
import { Check, Loader2, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PANTRY_STATUS_LABELS, PANTRY_STORAGE_LABELS } from "@/lib/meals/server/format"
import {
  PANTRY_DATE_MIN,
  PANTRY_EXPIRES_MAX,
  PANTRY_INPUT_MESSAGES,
  PANTRY_NAME_MAX,
  PANTRY_STORAGES,
  savePantryItemIssue,
  type PantryItemFields,
} from "@/lib/meals/server/pantry-requests"
import type { PantryStatus, PantryStorage, UnitId } from "@/lib/meals/types"
import { cn } from "@/lib/utils"
import { segmentCn } from "@/lib/utils/segment-cn"

import { NATIVE_SELECT_CLASS, chipClass } from "../basics/field-classes"
import {
  PANTRY_STATUS_ORDER,
  PANTRY_UNIT_OPTIONS,
  amountTextOf,
  isPantryUnit,
  parseAmountText,
  quantityInputOf,
} from "./pantry-fields"
import { genericFixText, type PantryItemView } from "./pantry-item-view"

/**
 * 食材 1 件の編集フォーム（名前・数量・単位・状態・早く使いたい・保管場所・期限・最終確認日・削除）。
 *
 * - 保存はここでは行わない。内容を組み立てて `onSubmit` へ渡す（親が ID と開いた時点の版を付けて送る）。
 * - 名前を変えたら、食材の一覧との結び付きを外して送る（サーバーが新しい名前で照合し直す。
 *   前の食材に結び付いたまま名前だけが変わるのを避ける）。
 * - 数量の空欄は「数量不明」。期限の空欄は「期限なし」。
 * - `<form action>` を使わない（React 19 の自動リセットで入力が消えないよう、onSubmit で受ける）。
 */
export function PantryItemEditor({
  item,
  today,
  disabled,
  saving,
  onSubmit,
  onDelete,
  onCancel,
}: {
  item: PantryItemView
  /** サーバーの今日（JST）。最終確認日の上限。 */
  today: string
  disabled: boolean
  saving: boolean
  /** 受け付けたら true（塞がれていれば false。入力は残す）。 */
  onSubmit: (fields: PantryItemFields) => boolean
  onDelete: () => void
  onCancel: () => void
}) {
  const formId = useId()
  const initialQuantity = quantityInputOf(item.quantity)
  const [name, setName] = useState(item.name)
  const [amountText, setAmountText] = useState(amountTextOf(item.quantity))
  const [unit, setUnit] = useState<UnitId>(initialQuantity?.unit ?? "piece")
  const [status, setStatus] = useState<PantryStatus>(item.status)
  const [useSoon, setUseSoon] = useState(item.useSoon)
  const [storage, setStorage] = useState<PantryStorage | null>(item.storage)
  const [expiresOn, setExpiresOn] = useState(item.expiresOn ?? "")
  const [confirmedOn, setConfirmedOn] = useState(item.confirmedOn)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const nameId = `${formId}-name`
  const amountId = `${formId}-amount`
  const unitId = `${formId}-unit`
  const storageId = `${formId}-storage`
  const expiresId = `${formId}-expires`
  const confirmedId = `${formId}-confirmed`
  const errorId = `${formId}-error`

  function submit() {
    const trimmedName = name.trim()
    const amount = parseAmountText(amountText)
    if (!amount.ok) {
      setError(amount.message)
      return
    }
    if (confirmedOn > today) {
      setError("最終確認日は、今日までの日付を選んでください。")
      return
    }
    const fields: PantryItemFields = {
      // 名前を変えたら照合し直す。一覧に無い ID（古い記録）も名前から解決し直す
      ingredientId: trimmedName === item.name && item.catalogName !== null ? item.ingredientId : null,
      name: trimmedName,
      quantity: amount.amount === null ? null : { amount: amount.amount, unit },
      status,
      useSoon,
      storage,
      expiresOn: expiresOn === "" ? null : expiresOn,
      confirmedOn,
    }
    const issue = savePantryItemIssue({ id: item.id, version: item.version, item: fields })
    if (issue !== null) {
      setError(PANTRY_INPUT_MESSAGES[issue])
      return
    }
    setError(null)
    onSubmit(fields)
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!disabled) submit()
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className="text-sm font-medium">
          名前
        </label>
        <Input
          id={nameId}
          className="h-11"
          value={name}
          maxLength={PANTRY_NAME_MAX * 2}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => {
            setName(event.target.value)
            setError(null)
          }}
        />
        {item.generic !== null ? (
          // 総称は「数えています」と言わない（部位・種類が分からず、材料に数えていない）
          <p data-testid="pantry-editor-generic" className="text-sm break-words text-foreground">
            「{item.catalogName ?? item.name}」は総称です。部位・種類が分からないため、提案・献立・買い物の材料に数えていません。
            {genericFixText(item.generic.examples)}
            名前を変えると、保存するときに食材の一覧と照合し直します。
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {item.catalogName === null
              ? "食材の一覧にない名前です。提案の材料には数えません。名前を直すと、保存するときに一覧と照合します。"
              : `食材の一覧の「${item.catalogName}」として数えています。名前を変えると、保存するときに照合し直します。`}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={amountId} className="text-sm font-medium">
            数量
          </label>
          <Input
            id={amountId}
            className="h-11"
            inputMode="decimal"
            placeholder="空欄 = 数量不明"
            value={amountText}
            onChange={(event) => {
              setAmountText(event.target.value)
              setError(null)
            }}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={unitId} className="text-sm font-medium">
            単位
          </label>
          <select
            id={unitId}
            className={NATIVE_SELECT_CLASS}
            value={unit}
            onChange={(event) => {
              if (isPantryUnit(event.target.value)) setUnit(event.target.value)
            }}
          >
            {PANTRY_UNIT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <p id={`${formId}-status`} className="text-sm font-medium">
          状態
        </p>
        <div role="group" aria-labelledby={`${formId}-status`} className="flex gap-1 rounded-xl bg-muted/50 p-1">
          {PANTRY_STATUS_ORDER.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={status === value}
              onClick={() => setStatus(value)}
              className={cn(
                segmentCn(status === value),
                "inline-flex cursor-pointer items-center justify-center gap-1 focus-visible:outline-2 focus-visible:outline-ring",
              )}
            >
              {status === value && <Check size={14} className="shrink-0" aria-hidden="true" />}
              {PANTRY_STATUS_LABELS[value]}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        aria-pressed={useSoon}
        onClick={() => setUseSoon((value) => !value)}
        className={cn(chipClass(useSoon), "w-fit")}
      >
        {useSoon && <Check size={14} className="shrink-0" aria-hidden="true" />}
        早く使いたい
      </button>

      <div className="flex flex-col gap-1">
        <label htmlFor={storageId} className="text-sm font-medium">
          保管場所（任意）
        </label>
        <select
          id={storageId}
          className={NATIVE_SELECT_CLASS}
          value={storage ?? ""}
          onChange={(event) => {
            const value = event.target.value
            setStorage(PANTRY_STORAGES.find((candidate) => candidate === value) ?? null)
          }}
        >
          <option value="">選ばない</option>
          {PANTRY_STORAGES.map((value) => (
            <option key={value} value={value}>
              {PANTRY_STORAGE_LABELS[value]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={expiresId} className="text-sm font-medium">
          期限（任意）
        </label>
        <div className="flex items-center gap-2">
          <Input
            id={expiresId}
            type="date"
            className="h-11 min-w-0 flex-1"
            min={PANTRY_DATE_MIN}
            max={PANTRY_EXPIRES_MAX}
            value={expiresOn}
            onChange={(event) => {
              setExpiresOn(event.target.value)
              setError(null)
            }}
          />
          {expiresOn !== "" && (
            <Button type="button" variant="outline" onClick={() => setExpiresOn("")}>
              期限なし
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">期限を過ぎた食材は、提案の材料に数えません。</p>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={confirmedId} className="text-sm font-medium">
          最終確認日
        </label>
        <div className="flex items-center gap-2">
          <Input
            id={confirmedId}
            type="date"
            className="h-11 min-w-0 flex-1"
            min={PANTRY_DATE_MIN}
            max={today}
            value={confirmedOn}
            onChange={(event) => {
              setConfirmedOn(event.target.value)
              setError(null)
            }}
          />
          {confirmedOn !== today && (
            <Button type="button" variant="outline" onClick={() => setConfirmedOn(today)}>
              今日にする
            </Button>
          )}
        </div>
      </div>

      {error && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={disabled}>
          {saving && <Loader2 className="animate-spin" aria-hidden="true" />}
          保存
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          閉じる
        </Button>
      </div>

      <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
        {confirmingDelete ? (
          <>
            <p className="text-sm text-muted-foreground">
              この食材を一覧から削除します。使い切っただけなら、状態を「使い切った」にすると一覧に残せます。
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="destructive"
                disabled={disabled}
                onClick={() => {
                  setConfirmingDelete(false)
                  onDelete()
                }}
              >
                削除する
              </Button>
              <Button type="button" variant="outline" onClick={() => setConfirmingDelete(false)}>
                やめる
              </Button>
            </div>
          </>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="self-start"
            disabled={disabled}
            onClick={() => setConfirmingDelete(true)}
          >
            <Trash2 aria-hidden="true" />
            この食材を削除
          </Button>
        )}
      </div>
    </form>
  )
}

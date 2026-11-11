"use client"

import { useId, useState } from "react"

import { ChangedElsewhereNotice } from "@/components/chores/meals/basics/changed-elsewhere-notice"
import { NATIVE_SELECT } from "@/components/chores/meals/plan/link-styles"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { STORE_SECTIONS } from "@/lib/meals/catalog/sections"
import {
  GROCERY_NAME_MAX,
  GROCERY_NOTE_MAX,
  isSaveGroceryManualItemRequest,
  type GroceryRequest,
} from "@/lib/meals/server/plan-requests"
import type { ShoppingItemView } from "@/lib/meals/server/plan-views"
import type { UnitId } from "@/lib/meals/types"
import { UNIT_LABELS } from "@/lib/meals/units"
import { newClientId } from "@/lib/utils/client-id"

/** 数量を持てる単位（「適量」「少々」は量を追えないので、手動項目では選ばせない）。 */
const QUANTITY_UNITS = (Object.keys(UNIT_LABELS) as UnitId[]).filter(
  (unit) => unit !== "to_taste" && unit !== "pinch",
)

interface Fields {
  name: string
  quantity: string
  unit: UnitId | ""
  section: string
  note: string
}

function fieldsOf(editing: ShoppingItemView | null): Fields {
  return {
    name: editing?.name ?? "",
    quantity: editing !== null && editing.requiredAmount !== null ? String(editing.requiredAmount) : "",
    unit: editing?.unit ?? "",
    section: editing?.section ?? "other",
    note: editing?.note ?? "",
  }
}

/**
 * 手動で足す項目の追加・編集フォーム。
 *
 * 数量は任意（入れるなら単位も要る。数量だけ・単位だけの片方は送らない）。手動の項目は、
 * 献立からの計算し直しでは消えない。行 ID は送信の時に 1 回だけ作る（編集は既存の ID と版）。
 *
 * ## 編集は「入力を始めた時点の版」を送る
 * 触るまでは項目の今の値を映す。最初に触った時点の版を入力と一緒に固定し、送る版もそれにする。
 * 入力の途中で項目の版が進んでも（定期の再取得・ほかの操作の応答）、古い入力に新しい版を付けて送らない
 * （付けると版の照合が素通りし、家族の変更を古い入力で黙って巻き戻す）。保存を止めて知らせる。
 */
export function ShoppingManualForm({
  editing,
  disabled,
  saving,
  onSubmit,
  onCancel,
}: {
  /** 編集する手動項目。null なら新規。 */
  editing: ShoppingItemView | null
  disabled: boolean
  saving: boolean
  /** 受け付けたら true。 */
  onSubmit: (request: GroceryRequest) => boolean
  onCancel: () => void
}) {
  const formId = useId()
  // 入力と、入力を始めた時点の版（新規は null）。触るまでは null = 項目の今の値を映す
  const [draft, setDraft] = useState<{ version: string | null; fields: Fields } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fields = draft?.fields ?? fieldsOf(editing)
  const { name, quantity, unit, section, note } = fields
  const changedElsewhere = draft !== null && editing !== null && draft.version !== editing.version

  function change(patch: Partial<Fields>) {
    setDraft((prev) => ({
      version: prev !== null ? prev.version : (editing?.version ?? null),
      fields: { ...(prev?.fields ?? fields), ...patch },
    }))
    setError(null)
  }

  function submit() {
    // 釦は無効にしてあるが、Enter での送信もここで止める
    if (changedElsewhere) return
    const trimmedName = name.trim()
    if (trimmedName === "") {
      setError("名前を入力してください。")
      return
    }
    const quantityText = quantity.trim()
    let amount: number | null = null
    if (quantityText !== "") {
      amount = Number(quantityText)
      if (!Number.isFinite(amount) || amount <= 0) {
        setError("数量は 0 より大きい数で入力してください。数量が要らなければ空欄にしてください。")
        return
      }
      if (unit === "") {
        setError("数量を入れるときは、単位も選んでください。")
        return
      }
    } else if (unit !== "") {
      setError("単位を選ぶときは、数量も入力してください。数量が要らなければ単位を「なし」にしてください。")
      return
    }
    const trimmedNote = note.trim()
    const body = {
      id: editing?.id ?? newClientId(),
      // 版は入力を始めた時点のもの（触っていなければ、表示している今の値と同じ版）
      version: draft !== null ? draft.version : (editing?.version ?? null),
      name: trimmedName,
      quantity: amount,
      unit: amount === null || unit === "" ? null : unit,
      section,
      note: trimmedNote === "" ? null : trimmedNote,
    }
    if (!isSaveGroceryManualItemRequest(body)) {
      setError("入力内容を確認してください。")
      return
    }
    setError(null)
    onSubmit({ op: "manual_item", ...body })
  }

  const nameId = `${formId}-name`
  const quantityId = `${formId}-quantity`
  const unitId = `${formId}-unit`
  const sectionId = `${formId}-section`
  const noteId = `${formId}-note`
  const errorId = `${formId}-error`

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!disabled) submit()
      }}
    >
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
      <div className="flex flex-col gap-2">
        <label htmlFor={nameId} className="text-sm font-medium">
          名前
        </label>
        <Input
          id={nameId}
          value={name}
          maxLength={GROCERY_NAME_MAX}
          autoComplete="off"
          placeholder="例: キッチンペーパー"
          className="h-11"
          aria-invalid={error !== null && name.trim() === "" ? true : undefined}
          aria-describedby={error !== null ? errorId : undefined}
          onChange={(event) => change({ name: event.target.value })}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-2">
          <label htmlFor={quantityId} className="text-sm font-medium">
            数量（任意）
          </label>
          <Input
            id={quantityId}
            value={quantity}
            inputMode="decimal"
            autoComplete="off"
            className="h-11"
            onChange={(event) => change({ quantity: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor={unitId} className="text-sm font-medium">
            単位
          </label>
          <select
            id={unitId}
            className={NATIVE_SELECT}
            value={unit}
            onChange={(event) => change({ unit: event.target.value as UnitId | "" })}
          >
            <option value="">なし</option>
            {QUANTITY_UNITS.map((value) => (
              <option key={value} value={value}>
                {UNIT_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={sectionId} className="text-sm font-medium">
          売場
        </label>
        <select
          id={sectionId}
          className={NATIVE_SELECT}
          value={section}
          onChange={(event) => change({ section: event.target.value })}
        >
          {STORE_SECTIONS.map((def) => (
            <option key={def.id} value={def.id}>
              {def.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={noteId} className="text-sm font-medium">
          メモ（任意）
        </label>
        <Textarea
          id={noteId}
          value={note}
          maxLength={GROCERY_NOTE_MAX}
          placeholder="例: いつもの銘柄"
          onChange={(event) => change({ note: event.target.value })}
        />
      </div>

      {error !== null && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={disabled || changedElsewhere}>
          {saving ? "保存しています…" : editing === null ? "この項目を追加" : "変更を保存"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          やめる
        </Button>
      </div>
    </form>
  )
}

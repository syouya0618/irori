"use client"

import { useId, useState } from "react"
import { Plus, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DISH_ROLE_LABELS_JA } from "@/lib/meals/server/format"
import {
  CUSTOM_DISH_INGREDIENT_NAME_MAX,
  CUSTOM_DISH_INGREDIENTS_MAX,
  CUSTOM_DISH_TITLE_MAX,
  isSaveCustomDishRequest,
  type CustomIngredientInput,
  type SaveCustomDishRequest,
} from "@/lib/meals/server/plan-requests"
import type { DishRole, UnitId } from "@/lib/meals/types"
import { UNIT_LABELS } from "@/lib/meals/units"
import { newClientId } from "@/lib/utils/client-id"

import { NATIVE_SELECT } from "./link-styles"
import type { CustomIngredientView } from "./plan-types"

const ROLE_ORDER: readonly DishRole[] = ["main", "side", "soup", "staple"]
const UNIT_ORDER = Object.keys(UNIT_LABELS) as UnitId[]

function isNonNumericUnit(unit: UnitId): boolean {
  return unit === "to_taste" || unit === "pinch"
}

interface Row {
  key: string
  name: string
  amount: string
  unit: UnitId
}

function rowsOf(ingredients: readonly CustomIngredientView[]): Row[] {
  return ingredients.map((ingredient, index) => ({
    key: `saved-${index}`,
    name: ingredient.name,
    amount: ingredient.amount === null ? "" : String(ingredient.amount),
    unit: ingredient.unit,
  }))
}

/**
 * 手動料理（一覧に無い料理）の追加・編集フォーム。
 *
 * - 材料は任意。**材料を登録しない料理は、買い物の自動計算の対象外**になることを、入力の横で言う。
 * - 材料の名前は、サーバーが食材の一覧へ解決する（解決できない名前は保存せず、理由を返す。
 *   似た名前へ勝手に寄せない）。量は「この料理の人数ぶん」。
 * - 行 ID は送信の時に 1 回だけ作る（編集は既存の ID と版）。日付と区分は編集では変えない
 *   （日付は「移動」で変える）。
 */
export function PlanCustomDishForm({
  editing,
  date,
  dateLabel,
  disabled,
  saving,
  onSubmit,
  onCancel,
}: {
  /** 編集する料理。null なら新規。 */
  editing: { id: string; version: string; title: string; role: DishRole; ingredients: CustomIngredientView[] } | null
  date: string
  dateLabel: string
  disabled: boolean
  saving: boolean
  /** 受け付けたら true（塞がれていれば false。入力は残す）。 */
  onSubmit: (request: { op: "custom_dish" } & SaveCustomDishRequest) => boolean
  onCancel: () => void
}) {
  const formId = useId()
  const [title, setTitle] = useState(editing?.title ?? "")
  const [role, setRole] = useState<DishRole>(editing?.role ?? "main")
  const [rows, setRows] = useState<Row[]>(() => rowsOf(editing?.ingredients ?? []))
  const [serial, setSerial] = useState(0)
  const [error, setError] = useState<string | null>(null)

  function patchRow(key: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)))
    setError(null)
  }

  function addRow() {
    if (rows.length >= CUSTOM_DISH_INGREDIENTS_MAX) return
    setRows((prev) => [...prev, { key: `new-${serial}`, name: "", amount: "", unit: "g" }])
    setSerial((value) => value + 1)
  }

  function submit() {
    const trimmedTitle = title.trim()
    if (trimmedTitle === "") {
      setError("料理名を入力してください。")
      return
    }
    const ingredients: CustomIngredientInput[] = []
    for (const row of rows) {
      const name = row.name.trim()
      // 名前も量も空の行は、入力しなかった行として捨てる
      if (name === "" && row.amount.trim() === "") continue
      if (name === "") {
        setError("材料の名前を入力してください。")
        return
      }
      if (isNonNumericUnit(row.unit)) {
        ingredients.push({ name, amount: null, unit: row.unit })
        continue
      }
      const amount = Number(row.amount)
      if (row.amount.trim() === "" || !Number.isFinite(amount) || amount <= 0) {
        setError(`「${name}」の量を、0 より大きい数で入力してください（分からなければ単位を「適量」に）。`)
        return
      }
      ingredients.push({ name, amount, unit: row.unit })
    }
    const request: { op: "custom_dish" } & SaveCustomDishRequest = {
      op: "custom_dish",
      id: editing?.id ?? newClientId(),
      version: editing?.version ?? null,
      date,
      role,
      title: trimmedTitle,
      ingredients: ingredients.length > 0 ? ingredients : null,
    }
    const { op: _op, ...body } = request
    void _op
    if (!isSaveCustomDishRequest(body)) {
      setError("入力内容を確認してください。")
      return
    }
    setError(null)
    onSubmit(request)
  }

  const titleId = `${formId}-title`
  const roleId = `${formId}-role`
  const errorId = `${formId}-error`
  const hasIngredient = rows.some((row) => row.name.trim() !== "")

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!disabled) submit()
      }}
    >
      <p className="text-sm text-muted-foreground">
        {dateLabel}の料理として保存します。手で入れた料理は固定になり、献立の作り直しで消えません。
      </p>
      <div className="flex flex-col gap-2">
        <label htmlFor={titleId} className="text-sm font-medium">
          料理名
        </label>
        <Input
          id={titleId}
          value={title}
          maxLength={CUSTOM_DISH_TITLE_MAX}
          autoComplete="off"
          placeholder="例: おでん"
          className="h-11"
          aria-invalid={error !== null && title.trim() === "" ? true : undefined}
          aria-describedby={error !== null ? errorId : undefined}
          onChange={(event) => {
            setTitle(event.target.value)
            setError(null)
          }}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={roleId} className="text-sm font-medium">
          区分
        </label>
        <select
          id={roleId}
          className={NATIVE_SELECT}
          value={role}
          // 区分と日付は、保存済みの料理では変えない（サーバーも拒む）
          disabled={editing !== null}
          onChange={(event) => setRole(event.target.value as DishRole)}
        >
          {ROLE_ORDER.map((value) => (
            <option key={value} value={value}>
              {DISH_ROLE_LABELS_JA[value]}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">材料（任意）</legend>
        <p className="text-sm text-muted-foreground">
          {hasIngredient
            ? "量はこの料理の人数ぶんで入れてください。食材の一覧に無い名前は保存できません。"
            : "材料を登録しない料理は、買い物の自動計算の対象外になります。材料を足すと計算に入ります。"}
        </p>
        {rows.length > 0 && (
          <ul className="flex flex-col gap-3">
            {rows.map((row, index) => (
              <li key={row.key} className="flex flex-col gap-2 rounded-xl border border-border/60 p-2">
                <Input
                  aria-label={`材料 ${index + 1} の名前`}
                  value={row.name}
                  maxLength={CUSTOM_DISH_INGREDIENT_NAME_MAX}
                  autoComplete="off"
                  placeholder="例: 大根"
                  className="h-11"
                  onChange={(event) => patchRow(row.key, { name: event.target.value })}
                />
                <div className="flex items-center gap-2">
                  <Input
                    aria-label={`材料 ${index + 1} の量`}
                    value={isNonNumericUnit(row.unit) ? "" : row.amount}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="量"
                    className="h-11 min-w-0 flex-1"
                    disabled={isNonNumericUnit(row.unit)}
                    onChange={(event) => patchRow(row.key, { amount: event.target.value })}
                  />
                  <select
                    aria-label={`材料 ${index + 1} の単位`}
                    className={`${NATIVE_SELECT} w-28 shrink-0`}
                    value={row.unit}
                    onChange={(event) => patchRow(row.key, { unit: event.target.value as UnitId })}
                  >
                    {UNIT_ORDER.map((unit) => (
                      <option key={unit} value={unit}>
                        {UNIT_LABELS[unit]}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`材料 ${index + 1} を外す`}
                    onClick={() => {
                      setRows((prev) => prev.filter((item) => item.key !== row.key))
                      setError(null)
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <Button
          type="button"
          variant="outline"
          className="self-start"
          disabled={rows.length >= CUSTOM_DISH_INGREDIENTS_MAX}
          onClick={addRow}
        >
          <Plus aria-hidden="true" />
          材料を足す
        </Button>
      </fieldset>

      {error !== null && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={disabled}>
          {saving ? "保存しています…" : editing === null ? "この料理を追加" : "変更を保存"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          やめる
        </Button>
      </div>
    </form>
  )
}

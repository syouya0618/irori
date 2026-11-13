/**
 * 食材の入力欄と送る内容の変換（C-21 / C-27 / C-42）。
 * 空欄を 0 や「十分ある」にしない。数えない単位（適量・少々）を在庫の数量にしない。
 */
import { describe, expect, it } from "vitest"

import { isSavePantryItemRequest } from "@/lib/meals/server/pantry-requests"
import type { StoredPantryItem } from "@/lib/meals/server/rows"

import {
  PANTRY_UNIT_OPTIONS,
  amountTextOf,
  fieldsOfPantryItem,
  isPantryUnit,
  parseAmountText,
  quantityInputOf,
} from "../pantry-fields"
import { toPantryItemView, toPantryItemViews } from "../pantry-item-view"

const TODAY = "2026-11-11"
const VERSION = "2026-11-11T01:02:03.123456+00:00"
const ID = "f1000000-0000-4000-8000-000000000001"

function stored(over: Partial<StoredPantryItem> = {}): StoredPantryItem {
  return {
    id: ID,
    ingredientId: "onion",
    name: "玉ねぎ",
    quantity: { amount: 2, unit: "piece" },
    status: "have",
    useSoon: false,
    storage: "pantry",
    expiresOn: null,
    confirmedOn: "2026-11-10",
    version: VERSION,
    ...over,
  }
}
const nameOf = (id: string) => (id === "onion" ? "玉ねぎ" : undefined)

describe("parseAmountText", () => {
  it("空欄・空白だけは「数量不明」（0 にしない）", () => {
    expect(parseAmountText("")).toEqual({ ok: true, amount: null })
    expect(parseAmountText("  　")).toEqual({ ok: true, amount: null })
  })

  it("半角・全角の数字と小数を読み、小数 2 桁へ丸める", () => {
    expect(parseAmountText("2")).toEqual({ ok: true, amount: 2 })
    expect(parseAmountText("３００")).toEqual({ ok: true, amount: 300 })
    expect(parseAmountText("１．５")).toEqual({ ok: true, amount: 1.5 })
    expect(parseAmountText("0.126")).toEqual({ ok: true, amount: 0.13 })
  })

  it("数字でない文字・負の数・0・単位つきの文字は読まない（推測で数にしない）", () => {
    for (const text of ["たくさん", "-1", "0", "0.001", "2個", "1/2", "1e3", "１２３４５６７８９０"]) {
      expect(parseAmountText(text).ok, text).toBe(false)
    }
  })
})

describe("単位の選択肢", () => {
  it("数えられる単位だけを選ばせる（適量・少々は在庫の数量にしない）", () => {
    const values = PANTRY_UNIT_OPTIONS.map((option) => option.value)
    expect(values).toContain("g")
    expect(values).toContain("piece")
    expect(values).not.toContain("to_taste")
    expect(values).not.toContain("pinch")
    expect(isPantryUnit("ml")).toBe(true)
    expect(isPantryUnit("to_taste")).toBe(false)
    expect(isPantryUnit("箱")).toBe(false)
  })
})

describe("quantityInputOf / amountTextOf", () => {
  it("量を持つ数量はそのまま、量を持たない・数えない単位は数量不明", () => {
    expect(quantityInputOf({ amount: 2, unit: "piece" })).toEqual({ amount: 2, unit: "piece" })
    expect(quantityInputOf(null)).toBeNull()
    expect(quantityInputOf({ amount: null, unit: "to_taste" })).toBeNull()
    expect(quantityInputOf({ amount: 1, unit: "pinch" })).toBeNull()
    expect(amountTextOf({ amount: 1.5, unit: "kg" })).toBe("1.5")
    expect(amountTextOf(null)).toBe("")
  })
})

describe("toPantryItemView（期限・確認の古さ・一覧との結び付き）", () => {
  it("期限は当日まで使え、前日以前は期限切れ。3 日以内は「近い」", () => {
    const expiry = (expiresOn: string | null) => toPantryItemView(stored({ expiresOn }), TODAY, nameOf).expiry
    expect(expiry(null)).toBe("none")
    expect(expiry("2026-11-10")).toBe("expired")
    expect(expiry("2026-11-11")).toBe("soon")
    expect(expiry("2026-11-14")).toBe("soon")
    expect(expiry("2026-11-15")).toBe("fresh")
  })

  it("確認の古さは保管場所ごとの日数で決まる（冷蔵 7 日・常温 60 日）", () => {
    const stale = (over: Partial<StoredPantryItem>) => toPantryItemView(stored(over), TODAY, nameOf).stale
    expect(stale({ storage: "fridge", confirmedOn: "2026-11-04" })).toBe(false)
    expect(stale({ storage: "fridge", confirmedOn: "2026-11-03" })).toBe(true)
    expect(stale({ storage: "pantry", confirmedOn: "2026-11-03" })).toBe(false)
    expect(stale({ storage: null, confirmedOn: "2026-11-03" })).toBe(true)
  })

  it("一覧へ解決できていない食材・一覧に無い ID の食材は、表示名を持たない", () => {
    const views = toPantryItemViews(
      [stored(), stored({ ingredientId: null, name: "謎の葉" }), stored({ ingredientId: "retired_item" })],
      TODAY,
      nameOf,
    )
    expect(views.map((view) => view.catalogName)).toEqual(["玉ねぎ", null, null])
  })
})

describe("fieldsOfPantryItem", () => {
  it("一覧の 1 行を、そのまま送れる内容へ写す", () => {
    const fields = fieldsOfPantryItem(toPantryItemView(stored({ useSoon: true, expiresOn: "2026-11-20" }), TODAY, nameOf))
    expect(fields).toEqual({
      ingredientId: "onion",
      name: "玉ねぎ",
      quantity: { amount: 2, unit: "piece" },
      status: "have",
      useSoon: true,
      storage: "pantry",
      expiresOn: "2026-11-20",
      confirmedOn: "2026-11-10",
    })
    expect(isSavePantryItemRequest({ id: ID, version: VERSION, item: fields })).toBe(true)
  })

  it("一覧に無い ID の食材は、結び付きを外して送る（サーバーが名前で照合し直す）", () => {
    const fields = fieldsOfPantryItem(toPantryItemView(stored({ ingredientId: "retired_item" }), TODAY, nameOf))
    expect(fields.ingredientId).toBeNull()
    // 対照: 一覧に在る ID は保つ
    expect(fieldsOfPantryItem(toPantryItemView(stored(), TODAY, nameOf)).ingredientId).toBe("onion")
  })

  it("量を持たない数量の食材も、送れる形（数量不明）になる", () => {
    const fields = fieldsOfPantryItem(toPantryItemView(stored({ quantity: { amount: null, unit: "to_taste" } }), TODAY, nameOf))
    expect(fields.quantity).toBeNull()
    expect(isSavePantryItemRequest({ id: ID, version: VERSION, item: fields })).toBe(true)
  })
})

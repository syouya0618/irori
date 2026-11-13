import { describe, expect, it } from "vitest"

import {
  buildIngredientIndex,
  foldName,
  parseBulkInput,
  parseIngredientLine,
  parseQuantityText,
  resolveIngredientId,
  splitBulkNames,
} from "../normalize"
import type { IngredientDef } from "../types"
import { INGREDIENTS, q } from "./fixtures"

describe("foldName（照合用の正規化）", () => {
  it.each([
    ["ﾄﾏﾄ", "トマト"],
    ["鶏 もも肉", "鶏もも肉"],
    ["鶏　もも肉", "鶏もも肉"],
    ["キヤベツ", "キャベツ"],
    ["タマネギ", "たまねぎ"],
    ["ＭＩＬＫ", "milk"],
    ["オリーブ・オイル", "オリーブオイル"],
  ])("%s と %s を同じ形へ畳む", (a, b) => {
    expect(foldName(a)).toBe(foldName(b))
  })

  it("漢字とかなの表記ゆれは畳まない（辞書の別名で持つ）", () => {
    expect(foldName("玉ねぎ")).not.toBe(foldName("たまねぎ"))
  })
})

describe("resolveIngredientId（C-22: 正規化後の完全一致だけ）", () => {
  it.each([
    ["玉ねぎ", "onion"],
    ["たまねぎ", "onion"],
    ["タマネギ", "onion"],
    ["玉葱", "onion"],
    ["人参", "carrot"],
    ["ﾄﾏﾄ", "tomato"],
    ["鶏 もも肉", "chicken_thigh"],
    ["たまご", "egg"],
    ["ハチミツ", "honey"],
    ["蜂蜜", "honey"],
    ["豚バラ", "pork_belly"],
    ["豚骨", "tonkotsu"],
  ])("表示名・別名に一致する「%s」→ %s", (name, id) => {
    expect(resolveIngredientId(name, INGREDIENTS)).toBe(id)
  })

  it("旧欠陥 (b) の回帰: 「豚」は「豚骨」「豚バラ」「豚肉」のどれにも解決しない", () => {
    expect(resolveIngredientId("豚", INGREDIENTS)).toBeNull()
    // 対照: 完全一致なら解決する
    expect(resolveIngredientId("豚肉", INGREDIENTS)).toBe("pork")
  })

  it("旧欠陥 (b) の回帰: 「ツナ」は「まぐろ」に解決しない（別名に持つツナ缶へだけ解決する）", () => {
    expect(resolveIngredientId("ツナ", INGREDIENTS)).toBe("tuna_can")
    expect(resolveIngredientId("ツナ", INGREDIENTS)).not.toBe("tuna")
    expect(resolveIngredientId("まぐろ", INGREDIENTS)).toBe("tuna")
  })

  it.each([
    ["もも", "鶏もも肉の一部"],
    ["玉ねぎドレッシング", "玉ねぎを含む加工品"],
    ["トマトケチャップ", "トマトを含む加工品"],
    ["トマト缶", "トマトの加工品"],
    ["ごま油", "辞書に無い油"],
    ["長ねぎの青い部分", "ねぎを含む長い名前"],
    ["牛乳石鹸", "牛乳を含む別物"],
    ["卵豆腐", "卵と豆腐を含む別物"],
  ])("旧欠陥 (b) の回帰: 部分一致しない「%s」（%s）は未解決", (name) => {
    expect(resolveIngredientId(name, INGREDIENTS)).toBeNull()
  })

  it("空文字・空白だけは未解決", () => {
    expect(resolveIngredientId("", INGREDIENTS)).toBeNull()
    expect(resolveIngredientId("　 ", INGREDIENTS)).toBeNull()
  })

  it("辞書の中で同じ名前が 2 つの食材に当たるときは、推測で選ばず未解決にする", () => {
    const dict: IngredientDef[] = [
      { id: "a", name: "ねぎ", aliases: [], section: "vegetable", allergens: [], allergenInfo: "known" },
      { id: "b", name: "青ねぎ", aliases: ["ネギ"], section: "vegetable", allergens: [], allergenInfo: "known" },
    ]
    const index = buildIngredientIndex(dict)
    expect(resolveIngredientId("ねぎ", index)).toBeNull()
    expect(index.ambiguousNames.get(foldName("ねぎ"))).toEqual(["a", "b"])
    // 対照: 衝突していない名前は解決する
    expect(resolveIngredientId("青ねぎ", index)).toBe("b")
  })

  it("配列でも索引でも同じ結果", () => {
    const index = buildIngredientIndex(INGREDIENTS)
    expect(resolveIngredientId("醤油", index)).toBe(resolveIngredientId("醤油", INGREDIENTS))
  })
})

describe("数量の緩い解釈", () => {
  it.each([
    ["2個", q(2, "piece")],
    ["200ml", q(200, "ml")],
    ["200ML", q(200, "ml")],
    ["１．５L", q(1.5, "l")],
    ["300g", q(300, "g")],
    ["1kg", q(1, "kg")],
    ["1/2本", q(0.5, "stalk")],
    ["大さじ2", q(2, "tbsp")],
    ["小さじ1/2", q(0.5, "tsp")],
    ["カップ1", q(1, "cup")],
    ["1丁", q(1, "block")],
    ["3枚", q(3, "sheet")],
    ["1束", q(1, "bunch")],
    ["2切れ", q(2, "slice")],
    ["1パック", q(1, "pack")],
    ["少々", q(null, "pinch")],
    ["適量", q(null, "to_taste")],
  ])("%s", (text, expected) => {
    expect(parseQuantityText(text)).toEqual(expected)
  })

  it.each(["300", "たくさん", "0個", "-1個", "2個入り", "玉ねぎ2個", ""])(
    "数量として解釈できない「%s」は null",
    (text) => {
      expect(parseQuantityText(text)).toBeNull()
    },
  )

  it("「玉ねぎ 2個」「牛乳200ml」を名前と数量へ分ける", () => {
    expect(parseIngredientLine("玉ねぎ 2個")).toEqual({ name: "玉ねぎ", quantity: q(2, "piece"), quantityText: "2個" })
    expect(parseIngredientLine("牛乳200ml")).toEqual({ name: "牛乳", quantity: q(200, "ml"), quantityText: "200ml" })
    expect(parseIngredientLine("サラダ油 大さじ1")).toEqual({
      name: "サラダ油",
      quantity: q(1, "tbsp"),
      quantityText: "大さじ1",
    })
  })

  it("数量が無ければ名前だけ（数量 null）", () => {
    expect(parseIngredientLine("卵")).toEqual({ name: "卵", quantity: null, quantityText: null })
  })

  it("単位に見える文字で終わる名前を数量と誤解しない（ツナ缶・食パン 1 枚ではない）", () => {
    expect(parseIngredientLine("ツナ缶")).toEqual({ name: "ツナ缶", quantity: null, quantityText: null })
    expect(parseIngredientLine("ツナ缶2缶")).toEqual({ name: "ツナ缶", quantity: q(2, "can"), quantityText: "2缶" })
  })
})

describe("まとめ入力の分割（C-21 の入力部分）", () => {
  it("改行・読点・空白で分け、数量だけの語は直前の名前に付ける", () => {
    const { items, truncated } = parseBulkInput("玉ねぎ 2個、牛乳200ml\n卵 豚こま 300g　にんじん")
    expect(truncated).toBe(false)
    expect(items).toEqual([
      { name: "玉ねぎ", quantity: q(2, "piece"), quantityText: "2個" },
      { name: "牛乳", quantity: q(200, "ml"), quantityText: "200ml" },
      { name: "卵", quantity: null, quantityText: null },
      { name: "豚こま", quantity: q(300, "g"), quantityText: "300g" },
      { name: "にんじん", quantity: null, quantityText: null },
    ])
  })

  it("空白で割れた数量（「2 個」「大さじ 2」）も 1 件として読む", () => {
    expect(parseBulkInput("玉ねぎ 2 個").items).toEqual([
      { name: "玉ねぎ", quantity: q(2, "piece"), quantityText: "2個" },
    ])
    expect(parseBulkInput("しょうゆ 大さじ 2").items).toEqual([
      { name: "しょうゆ", quantity: q(2, "tbsp"), quantityText: "大さじ2" },
    ])
  })

  it("単位の無い数字は数量にせず、確認用に原文を残す（数量 null）", () => {
    expect(parseBulkInput("豚こま 300").items).toEqual([
      { name: "豚こま", quantity: null, quantityText: "300" },
    ])
  })

  it("空の入力・区切りだけの入力は 0 件", () => {
    expect(parseBulkInput("").items).toEqual([])
    expect(parseBulkInput("、、\n　 ,").items).toEqual([])
  })

  it("100 件を超えたら打ち切り、切り捨てたことを返す", () => {
    const text = Array.from({ length: 120 }, (_, i) => `食材${i}`).join("\n")
    const result = parseBulkInput(text)
    expect(result.items).toHaveLength(100)
    expect(result.truncated).toBe(true)
  })

  it("名前だけの一覧は、表記ゆれの重複を 1 つにまとめる", () => {
    expect(splitBulkNames("トマト、ﾄﾏﾄ 卵\nたまご")).toEqual(["トマト", "卵", "たまご"])
  })
})

describe("R26 換算できない数え方（合・株・ケース）と、後ろに付く「カップ」", () => {
  it("まとめ入力: 数量の語を別の食材にせず、直前の名前の数量の原文として残す（換算できないものは数量不明のまま）", () => {
    expect(parseBulkInput("米 2合、牛乳 1カップ、しめじ 1株、卵 1ケース").items).toEqual([
      { name: "米", quantity: null, quantityText: "2合" },
      { name: "牛乳", quantity: q(1, "cup"), quantityText: "1カップ" },
      { name: "しめじ", quantity: null, quantityText: "1株" },
      { name: "卵", quantity: null, quantityText: "1ケース" },
    ])
    // 名前だけの一覧にも数量の語が混ざらない
    expect(splitBulkNames("米 2合、しめじ 1株")).toEqual(["米", "しめじ"])
  })

  it("空白なし（牛乳1カップ・米2合）でも、名前と数量へ分ける", () => {
    expect(parseIngredientLine("牛乳1カップ")).toEqual({ name: "牛乳", quantity: q(1, "cup"), quantityText: "1カップ" })
    expect(parseIngredientLine("水2カップ")).toEqual({ name: "水", quantity: q(2, "cup"), quantityText: "2カップ" })
    expect(parseIngredientLine("米2合")).toEqual({ name: "米", quantity: null, quantityText: "2合" })
    expect(parseBulkInput("牛乳1カップ 米2合").items.map((item) => item.name)).toEqual(["牛乳", "米"])
  })

  it("空白で割れた数量（「2 合」「1 カップ」）も 1 件として読む", () => {
    expect(parseBulkInput("米 2 合").items).toEqual([{ name: "米", quantity: null, quantityText: "2合" }])
    expect(parseBulkInput("牛乳 1 カップ").items).toEqual([{ name: "牛乳", quantity: q(1, "cup"), quantityText: "1カップ" }])
  })

  it("数量だけの文字列: 「1カップ」は読める。換算できない「2合」は数量にしない（捏造しない）", () => {
    expect(parseQuantityText("1カップ")).toEqual(q(1, "cup"))
    expect(parseQuantityText("1/2カップ")).toEqual(q(0.5, "cup"))
    expect(parseQuantityText("2合")).toBeNull()
    expect(parseQuantityText("1株")).toBeNull()
  })

  it("対照: 数字で始まる名前・数え方に見える文字で終わる名前は、食材のまま残す", () => {
    expect(parseBulkInput("卵 3色団子").items).toEqual([
      { name: "卵", quantity: null, quantityText: null },
      { name: "3色団子", quantity: null, quantityText: null },
    ])
    expect(parseIngredientLine("かつお節")).toEqual({ name: "かつお節", quantity: null, quantityText: null })
    expect(parseIngredientLine("カップ麺 2個")).toEqual({ name: "カップ麺", quantity: q(2, "piece"), quantityText: "2個" })
    // 直前の名前が既に数量を持つなら、次の語は付けない（別の行のまま = 確認画面で見える）
    expect(parseBulkInput("米 2kg 2合").items).toEqual([
      { name: "米", quantity: q(2, "kg"), quantityText: "2kg" },
      { name: "2合", quantity: null, quantityText: null },
    ])
  })
})

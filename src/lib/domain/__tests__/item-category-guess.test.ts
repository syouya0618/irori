import { describe, it, expect } from "vitest"
import { guessItemCategory } from "../item-category-guess"

describe("guessItemCategory", () => {
  it.each([
    ["トマト", "vegetable"],
    ["きゅうり", "vegetable"],
    ["りんご", "fruit"],
    ["バナナ", "fruit"],
    ["鶏むね肉", "meat"],
    ["豚バラ", "meat"],
    ["さけ切り身", "fish"],
    ["牛乳", "dairy"],
    ["プレーンヨーグルト", "dairy"],
    ["たまご", "egg"],
    ["食パン", "grain"],
    ["讃岐うどん", "grain"],
    ["醤油", "seasoning"],
    ["マヨネーズ", "seasoning"],
    ["冷凍餃子", "frozen"],
    ["チョコレート", "snack_food"],
    ["紙おむつ", "baby"],
    ["離乳食パウチ", "baby"],
    ["食器用洗剤", "cleaning"],
    ["トイレットペーパー", "hygiene"],
    ["歯ブラシ", "hygiene"],
  ])("「%s」→ %s", (name, expected) => {
    expect(guessItemCategory(name)).toBe(expected)
  })

  it("該当キーワードが無ければ other_food にフォールバック", () => {
    expect(guessItemCategory("謎の新商品ZZZ")).toBe("other_food")
  })

  it("空文字・空白のみは other_food", () => {
    expect(guessItemCategory("")).toBe("other_food")
    expect(guessItemCategory("   ")).toBe("other_food")
  })

  it("全角/半角・大文字小文字を正規化してマッチ（NFKC）", () => {
    // 半角カナ「ﾄﾏﾄ」も野菜に寄せる
    expect(guessItemCategory("ﾄﾏﾄ")).toBe("vegetable")
  })

  it("牛乳は dairy、粉ミルクは baby（より具体的なキーワードを優先）", () => {
    expect(guessItemCategory("牛乳")).toBe("dairy")
    expect(guessItemCategory("粉ミルク")).toBe("baby")
  })
})

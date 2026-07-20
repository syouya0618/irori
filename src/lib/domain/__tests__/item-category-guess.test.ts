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

  // レシート主流のカタカナ品名を fold でひらがな/漢字キーワードへ寄せる
  describe("カタカナ品名の fold 照合", () => {
    it.each([
      ["タマゴ", "egg"],
      ["ギュウニュウ", "dairy"],
      ["ハクサイ", "vegetable"],
      ["ダイコン", "vegetable"],
      ["ニンジン", "vegetable"],
      ["ホウレンソウ", "vegetable"],
      ["サケ切身", "fish"],
      ["トリムネ", "meat"],
      ["コメ", "grain"],
    ])("「%s」→ %s", (name, expected) => {
      expect(guessItemCategory(name)).toBe(expected)
    })
  })

  // OCR が字間に混ぜる偽スペースを除去して照合する
  describe("OCR 偽スペース耐性", () => {
    it.each([
      ["牛 乳", "dairy"],
      ["トイレット ペーパー", "hygiene"],
    ])("「%s」→ %s", (name, expected) => {
      expect(guessItemCategory(name)).toBe(expected)
    })
  })

  // OCR が小書き仮名を大書きで読む「キヤベツ」等を「キャベツ」と同一視する
  describe("小書き仮名の正規化", () => {
    it.each([
      ["キヤベツ", "vegetable"],
      ["キユウリ", "vegetable"],
    ])("「%s」→ %s", (name, expected) => {
      expect(guessItemCategory(name)).toBe(expected)
    })
  })

  // 短いキーワードの部分一致誤爆を最長一致で解消する
  describe("最長一致による誤爆解消", () => {
    it.each([
      // 「たこ」を含むが「ぶた」と同長 → 表順で meat が勝つ
      ["ブタコマ", "meat"],
      ["コクサンブタコマギレ", "meat"],
      ["豚コマ", "meat"],
      // 「いか」より長い「すいか」が勝つ
      ["スイカ", "fruit"],
      // 「ミルク」単独を廃したので baby ではなく snack_food（チョコ）
      ["ミルクチョコレート", "snack_food"],
    ])("「%s」→ %s", (name, expected) => {
      expect(guessItemCategory(name)).toBe(expected)
    })
  })

  // 追加語彙の正例
  describe("追加語彙", () => {
    it.each([
      ["ぶり", "fish"],
      ["ブリの照り焼き", "fish"],
      ["さんま", "fish"],
      ["かつお", "fish"],
      ["たら", "fish"],
      ["サーモン", "fish"],
      ["アボカド", "vegetable"],
      ["とりささみ", "meat"],
    ])("「%s」→ %s", (name, expected) => {
      expect(guessItemCategory(name)).toBe(expected)
    })

    // 追加した短語が無関係語へ食い込まないことを固定（fold 後に部分一致しない）
    it("「ストロベリー」は meat/fish に誤爆しない（とり/ぶり を含まない）", () => {
      expect(guessItemCategory("ストロベリー")).not.toBe("meat")
      expect(guessItemCategory("ストロベリー")).not.toBe("fish")
    })
  })

  // ミルク単独廃止により、牛乳系/コーヒー用ミルクを baby に誤分類しない
  describe("ミルク系の非 baby 判定", () => {
    it.each([["メグミルク"], ["コーヒーミルク"]])(
      "「%s」は baby ではない",
      (name) => {
        expect(guessItemCategory(name)).not.toBe("baby")
      },
    )
  })

  // 冷凍優先を廃し最長一致へ移行したことによる挙動変更を固定（PR 本文で明記）
  describe("冷凍は最長一致で食材カテゴリに寄る", () => {
    it.each([
      ["冷凍うどん", "grain"],
      ["冷凍ブロッコリー", "vegetable"],
      // 品目を認識できない冷凍食品は frozen のまま
      ["冷凍餃子", "frozen"],
    ])("「%s」→ %s", (name, expected) => {
      expect(guessItemCategory(name)).toBe(expected)
    })
  })
})

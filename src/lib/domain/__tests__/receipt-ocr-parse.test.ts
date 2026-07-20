import { describe, it, expect } from "vitest"
import { parseReceiptText } from "../receipt-ocr-parse"

describe("parseReceiptText", () => {
  it("空文字 → 空配列", () => {
    expect(parseReceiptText("")).toEqual([])
  })

  it("典型的なスーパーのレシートから商品名だけを抽出する", () => {
    const raw = [
      "イオン ○○店",
      "2026/07/16 15:30",
      "レジ 03  責 12",
      "----------------",
      "牛乳            ￥198",
      "食パン          ￥248",
      "鶏むね肉        ￥380 ※",
      "小計           ￥826",
      "消費税(8%)      ￥66",
      "合計           ￥892",
      "お預り         ￥1000",
      "お釣り         ￥108",
      "ポイント        12P",
    ].join("\n")

    const items = parseReceiptText(raw)
    expect(items.map((i) => i.name)).toEqual(["牛乳", "食パン", "鶏むね肉"])
  })

  it("末尾の価格・税マーク（※ * 内 外 軽）を名前から除去する", () => {
    const raw = ["トマト  298円 ※", "たまご  ＊ 218"].join("\n")
    const items = parseReceiptText(raw)
    expect(items.map((i) => i.name)).toEqual(["トマト", "たまご"])
  })

  it("数量表記（3個 / ×2 / 2コ）を抽出し名前から外す", () => {
    const raw = ["トマト 3個 ￥298", "ヨーグルト ×2 ￥216"].join("\n")
    const items = parseReceiptText(raw)
    expect(items).toEqual([
      { name: "トマト", quantity: 3 },
      { name: "ヨーグルト", quantity: 2 },
    ])
  })

  it("合計・小計・税・お預り・お釣り・点数などの非商品行を除外する", () => {
    const raw = [
      "小計 500",
      "合計 540",
      "内消費税等 40",
      "お預かり 1000",
      "おつり 460",
      "点数 3点",
      "現金",
      "クレジット",
    ].join("\n")
    expect(parseReceiptText(raw)).toEqual([])
  })

  it("日付・時刻・電話番号・店舗ヘッダ等の行を除外する", () => {
    const raw = [
      "2026年7月16日(木)",
      "10:05",
      "TEL 03-1234-5678",
      "領収書",
      "No.12345",
    ].join("\n")
    expect(parseReceiptText(raw)).toEqual([])
  })

  it("全角英数字を NFKC 正規化してから処理する", () => {
    const raw = "トマト　　２９８円" // 全角スペース・全角数字
    const items = parseReceiptText(raw)
    expect(items).toEqual([{ name: "トマト", quantity: null }])
  })

  it("価格の無い商品名だけの行も商品として拾う", () => {
    const raw = "キャベツ"
    expect(parseReceiptText(raw)).toEqual([{ name: "キャベツ", quantity: null }])
  })

  // --- 実レシート由来の回帰（監査 repro） ---

  it("「税込」付きの商品行を巻き込まず商品として拾う", () => {
    const raw = "牛乳 198 税込\n食パン 248 税込"
    const items = parseReceiptText(raw)
    expect(items.map((i) => i.name)).toEqual(["牛乳", "食パン"])
  })

  it("行内の（税込）表記を除去して商品名を残す", () => {
    expect(parseReceiptText("コーラ(税込)108")).toEqual([
      { name: "コーラ", quantity: null },
    ])
  })

  it("「税込 1,234」単独の集計行は数字のみ残り除外される", () => {
    expect(parseReceiptText("税込 1,234")).toEqual([])
  })

  it("「(税込108円)」の括弧内税注記を丸ごと除去し閉じ括弧を残さない", () => {
    expect(parseReceiptText("ポテト(税込108円)")).toEqual([
      { name: "ポテト", quantity: null },
    ])
  })

  it("対応の揃った括弧は商品名の一部として残す", () => {
    expect(parseReceiptText("ミックスナッツ(小) 128")).toEqual([
      { name: "ミックスナッツ(小)", quantity: null },
    ])
  })

  it("価格除去で空になった括弧ペアを商品名に残さない", () => {
    expect(parseReceiptText("ポテト(108円)")).toEqual([
      { name: "ポテト", quantity: null },
    ])
  })

  it("「レジ袋」は商品として残し「レジ NN」ヘッダは除外する", () => {
    expect(parseReceiptText("レジ袋 5")).toEqual([{ name: "レジ袋", quantity: null }])
    expect(parseReceiptText("レジ 03  責 12")).toEqual([])
  })

  it("行頭の「店内調理〜」は商品として残し行末「〇〇店」は除外する", () => {
    const items = parseReceiptText("店内調理 のり弁当 398")
    expect(items).toHaveLength(1)
    expect(items[0].name).toContain("のり弁当")
    expect(parseReceiptText("イオン ○○店")).toEqual([])
  })

  it("数量×単価（2X198 / 3コX98）は × の前の数を数量にする", () => {
    expect(parseReceiptText("ジャガイモ 2X198")).toEqual([
      { name: "ジャガイモ", quantity: 2 },
    ])
    expect(parseReceiptText("トマト 3コX98 294")).toEqual([
      { name: "トマト", quantity: 3 },
    ])
  })

  it("単価側の数（198）を数量として拾わない", () => {
    const items = parseReceiptText("ジャガイモ 2X198")
    expect(items[0].quantity).toBe(2)
    expect(items[0].quantity).not.toBe(198)
  })

  it("密着価格（ハクサイ498）は価格だけ落として名前を残す", () => {
    expect(parseReceiptText("ハクサイ498")).toEqual([
      { name: "ハクサイ", quantity: null },
    ])
  })

  it("単位付きの数（555ml）は価格と誤判定せず保持する", () => {
    const items = parseReceiptText("い・ろ・は・す555ml")
    expect(items).toHaveLength(1)
    expect(items[0].name).toContain("555ml")
    expect(items[0].quantity).toBeNull()
  })

  it("行頭の部門コード（123456）を除去して商品名を残す", () => {
    expect(parseReceiptText("123456 ハクサイ")).toEqual([
      { name: "ハクサイ", quantity: null },
    ])
  })

  it("記号ゴミ（| 「 」 ☆）を除去して商品名を残す", () => {
    expect(parseReceiptText("|「牛乳」☆")).toEqual([
      { name: "牛乳", quantity: null },
    ])
    expect(parseReceiptText("☆牛乳 ¥238軽")).toEqual([
      { name: "牛乳", quantity: null },
    ])
  })

  it("軽減税率・買上計・字間スペースの合計行を除外する", () => {
    expect(parseReceiptText("(軽減税率対象商品)")).toEqual([])
    expect(parseReceiptText("お買上計 1,234")).toEqual([])
    expect(parseReceiptText("合 計 1,234")).toEqual([])
  })
})

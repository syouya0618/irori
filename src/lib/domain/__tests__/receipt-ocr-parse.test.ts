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
})

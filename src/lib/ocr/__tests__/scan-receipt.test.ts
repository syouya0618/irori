import { describe, it, expect } from "vitest"
import { fitWithinLongEdge, describeScanPhase } from "@/lib/ocr/scan-receipt"

describe("fitWithinLongEdge（クラウド送信前の縮小サイズ計算）", () => {
  it("長辺が上限を超える landscape は長辺基準で縮小する", () => {
    expect(fitWithinLongEdge(3200, 2400, 1600)).toEqual({
      width: 1600,
      height: 1200,
    })
  })
  it("長辺が上限を超える portrait も長辺基準で縮小する", () => {
    expect(fitWithinLongEdge(2400, 3200, 1600)).toEqual({
      width: 1200,
      height: 1600,
    })
  })
  it("上限以下は拡大せずそのまま返す", () => {
    expect(fitWithinLongEdge(800, 600, 1600)).toEqual({ width: 800, height: 600 })
  })
  it("ちょうど上限はそのまま返す", () => {
    expect(fitWithinLongEdge(1600, 1600, 1600)).toEqual({
      width: 1600,
      height: 1600,
    })
  })
  it("不正値(NaN)はそのまま返す（クラッシュしない）", () => {
    expect(fitWithinLongEdge(Number.NaN, 100, 1600)).toEqual({
      width: Number.NaN,
      height: 100,
    })
  })
})

describe("describeScanPhase（認識前フェーズの日本語ラベル）", () => {
  it("言語辞書のダウンロードは辞書メッセージ", () => {
    expect(describeScanPhase("loading language traineddata")).toBe(
      "辞書を読み込み中…",
    )
  })
  it("その他の初期化フェーズは準備中", () => {
    expect(describeScanPhase("initializing api")).toBe("準備中…")
    expect(describeScanPhase("loading tesseract core")).toBe("準備中…")
    expect(describeScanPhase("initializing tesseract")).toBe("準備中…")
  })
})

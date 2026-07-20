import { describe, it, expect } from "vitest"
import { fitWithinPixelBudget, describeScanPhase } from "@/lib/ocr/scan-receipt"

describe("fitWithinPixelBudget（クラウド送信前の総画素キャップ縮小）", () => {
  it("総画素が上限以下なら縮小しない（長尺レシートも幅を保つ）", () => {
    // 800×4800 = 3.84MP ≤ 4MP。長辺キャップ時の幅 267px から改善し 800px を維持する
    expect(fitWithinPixelBudget(800, 4800, 4_000_000)).toEqual({
      width: 800,
      height: 4800,
    })
  })
  it("総画素が上限を超える写真は総画素基準・アスペクト維持で縮小する", () => {
    // 3024×4032 = 12.19MP → 4MP 以下へ。長辺キャップ(1200×1600=1.92MP)より高精細
    const { width, height } = fitWithinPixelBudget(3024, 4032, 4_000_000)
    expect(width * height).toBeLessThanOrEqual(4_000_000)
    // アスペクト比 3024:4032 = 0.75 を保つ（丸め誤差 ±0.01 内）
    expect(width / height).toBeCloseTo(3024 / 4032, 2)
  })
  it("極端な長尺(10MP)も総画素上限まで縮小する（worst-case・幅は狭くなるが許容）", () => {
    const { width, height } = fitWithinPixelBudget(500, 20000, 4_000_000)
    expect(width * height).toBeLessThanOrEqual(4_000_000)
  })
  it("上限以下は拡大せずそのまま返す", () => {
    expect(fitWithinPixelBudget(800, 600, 4_000_000)).toEqual({
      width: 800,
      height: 600,
    })
  })
  it("不正値(NaN)はそのまま返す（クラッシュしない）", () => {
    expect(fitWithinPixelBudget(Number.NaN, 100, 4_000_000)).toEqual({
      width: Number.NaN,
      height: 100,
    })
  })
  it("0 はそのまま返す（0除算・0サイズを作らない）", () => {
    expect(fitWithinPixelBudget(0, 100, 4_000_000)).toEqual({
      width: 0,
      height: 100,
    })
  })
  it("Infinity はそのまま返す（クラッシュしない）", () => {
    expect(
      fitWithinPixelBudget(Number.POSITIVE_INFINITY, 100, 4_000_000),
    ).toEqual({
      width: Number.POSITIVE_INFINITY,
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
